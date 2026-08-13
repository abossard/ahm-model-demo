import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import psycopg
from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.mgmt.cloudhealth import CloudHealthMgmtClient
from azure.monitor.opentelemetry import configure_azure_monitor
from azure.storage.queue import QueueClient
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode
from starlette.datastructures import MutableHeaders

import agent_proxy
import inventory
import reports
from config import (
    AGENT_ERROR_SECURITY_POLICY,
    AGENT_MAX_BODY_BYTES,
    AGENT_PROXY_CONCURRENCY,
    AGENT_WEB_ORIGIN,
    CANONICAL_SIGNAL_NAME,
    CLOUDHEALTH_API_VERSION,
    PARENT_SECURITY_POLICY,
    REASON_PRESETS,
    UI_DIST_DIR,
    copilot_enabled,
    require_runtime_config,
)
from dto import (
    entity_dto,
    field,
    history_items,
    scalar,
    signal_history_dto,
    transition_dto,
)
from errors import (
    agent_error,
    error_response,
    invalid_format_response,
    operation_id,
    sdk_error_response,
    validation_error,
)
from journey import as_html


RUNTIME_SCOPE = require_runtime_config(os.environ)

CLIENT_ID = os.environ.get("AZURE_CLIENT_ID", "").strip() or None
QUEUE_URL = os.environ["QUEUE_URL"]
POSTGRES_HOST = os.environ["POSTGRES_HOST"]
POSTGRES_DATABASE = os.environ.get("POSTGRES_DATABASE", "demo")
POSTGRES_USER = os.environ["POSTGRES_USER"]
SUBSCRIPTION_ID = RUNTIME_SCOPE["subscription_id"]
RESOURCE_GROUP = RUNTIME_SCOPE["resource_group"]
MODEL_NAME = RUNTIME_SCOPE["model_name"]

credential = DefaultAzureCredential(managed_identity_client_id=CLIENT_ID)
configure_azure_monitor(
    connection_string=os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
    credential=credential,
    enable_live_metrics=False,
)

logger = logging.getLogger("ahm-demo")
logger.setLevel(logging.INFO)
tracer = trace.get_tracer("ahm-demo")
queue_client = QueueClient.from_queue_url(QUEUE_URL, credential=credential)
health_client = CloudHealthMgmtClient(
    credential,
    SUBSCRIPTION_ID,
    api_version=CLOUDHEALTH_API_VERSION,
)
_agent_proxy_slots = threading.BoundedSemaphore(AGENT_PROXY_CONCURRENCY)

_AGENT_METHODS = ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]


def _agent_client_factory():
    return httpx.Client(
        timeout=httpx.Timeout(connect=2.0, read=210.0, write=10.0, pool=1.0),
        limits=httpx.Limits(
            max_connections=AGENT_PROXY_CONCURRENCY,
            max_keepalive_connections=AGENT_PROXY_CONCURRENCY,
        ),
        follow_redirects=False,
        trust_env=False,
    )


def enqueue_event(event):
    with tracer.start_as_current_span("Azure Queue enqueue", kind=SpanKind.PRODUCER) as span:
        span.set_attribute("messaging.system", "azure.storage.queue")
        span.set_attribute("messaging.destination.name", "requests")
        span.set_attribute("server.address", QUEUE_URL.split("/")[2])
        span.set_attribute("demo.request_id", event["request_id"])
        result = queue_client.send_message(json.dumps(event, separators=(",", ":")))
        return {
            "request_id": event["request_id"],
            "message_id": result.id,
            "created_at": event["created_at"],
        }


def insert_event_and_count(event):
    token = credential.get_token(
        "https://ossrdbms-aad.database.windows.net/.default"
    ).token
    with tracer.start_as_current_span(
        "PostgreSQL insert and count", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("db.system", "postgresql")
        span.set_attribute("db.namespace", POSTGRES_DATABASE)
        span.set_attribute("server.address", POSTGRES_HOST)
        span.set_attribute("demo.request_id", event["request_id"])
        with psycopg.connect(
            host=POSTGRES_HOST,
            dbname=POSTGRES_DATABASE,
            user=POSTGRES_USER,
            password=token,
            sslmode="require",
            connect_timeout=15,
        ) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO request_events(request_id, created_at, payload)
                    VALUES (%s, %s, %s::jsonb)
                    """,
                    (
                        event["request_id"],
                        event["created_at"],
                        json.dumps(event["payload"], separators=(",", ":")),
                    ),
                )
                cursor.execute("SELECT count(*) FROM request_events")
                return cursor.fetchone()[0]


def peek_queue_head():
    with tracer.start_as_current_span("Azure Queue peek", kind=SpanKind.CONSUMER) as span:
        span.set_attribute("messaging.system", "azure.storage.queue")
        span.set_attribute("messaging.destination.name", "requests")
        span.set_attribute("server.address", QUEUE_URL.split("/")[2])
        message = next(iter(queue_client.peek_messages(max_messages=1)), None)
        if message is None:
            return None
        content = json.loads(message.content)
        return {
            "label": "oldest visible / best-effort FIFO",
            "message_id": message.id,
            "request_id": content.get("request_id"),
            "created_at": content.get("created_at"),
            "dequeue_count": message.dequeue_count,
        }


def run_request_journey(current_span, response_format, method, path):
    if response_format not in ("html", "json"):
        current_span.set_attribute("http.response.status_code", 400)
        return invalid_format_response()
    request_id = str(uuid.uuid4())
    event = {
        "request_id": request_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "payload": {"path": path, "method": method},
    }
    current_span.set_attribute("demo.request_id", request_id)
    current_span.set_attribute("http.request.method", method)
    current_span.set_attribute("url.path", path)
    try:
        just_enqueued = enqueue_event(event)
        row_count = insert_event_and_count(event)
        queue_head = peek_queue_head()
        result = {
            "request_id": request_id,
            "just_enqueued": just_enqueued,
            "queue_head": queue_head,
            "row_count": row_count,
        }
        logger.info("request journey completed", extra={"request_id": request_id})
        if response_format == "json":
            response = JSONResponse(result)
        else:
            response = HTMLResponse(as_html(result))
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Operation-ID"] = operation_id()
        current_span.set_attribute("http.response.status_code", 200)
        return response
    except Exception as error:
        current_span.record_exception(error)
        current_span.set_status(Status(StatusCode.ERROR, type(error).__name__))
        current_span.set_attribute("http.response.status_code", 503)
        logger.error(
            "request journey failed request_id=%s error_type=%s",
            request_id,
            type(error).__name__,
        )
        current = operation_id()
        response = JSONResponse(
            {
                "request_id": request_id,
                "operation_id": current,
                "status": "failed",
                "error": type(error).__name__,
            },
            status_code=503,
        )
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Operation-ID"] = current
        return response


async def _proxy_agent(request, agent_path):
    if not copilot_enabled(os.environ):
        return error_response(
            404,
            "agent_disabled",
            "Health copilot is disabled.",
            False,
        )
    raw_path = request.scope.get("raw_path")
    raw_path = raw_path.decode("latin-1") if raw_path is not None else request.url.path
    if not agent_proxy.request_is_unambiguous(raw_path):
        return validation_error(
            "invalid_agent_path",
            "The agent path is not supported.",
        )

    kind = agent_proxy.path_kind(agent_path)
    if kind is None:
        return error_response(
            404,
            "agent_path_not_found",
            "The agent path is not available.",
            False,
        )
    allowed_methods = (
        {"GET", "HEAD"}
        if kind in {"document", "asset"}
        else {"GET", "HEAD", "POST", "PATCH", "DELETE"}
    )
    if request.method not in allowed_methods:
        return error_response(
            405,
            "agent_method_not_allowed",
            "The agent method is not supported.",
            False,
        )

    content_length_header = request.headers.get("content-length")
    content_length = (
        int(content_length_header) if content_length_header is not None else None
    )
    if content_length is not None and content_length > AGENT_MAX_BODY_BYTES:
        return error_response(
            413,
            "agent_request_too_large",
            "The agent request is too large.",
            False,
        )
    has_body = content_length not in (None, 0)
    if request.method in {"GET", "HEAD"} and has_body:
        return validation_error(
            "agent_body_not_allowed",
            "This agent request cannot include a body.",
        )
    if has_body:
        mimetype = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if mimetype != "application/json":
            return error_response(
                415,
                "agent_content_type_not_supported",
                "Agent request bodies must be JSON.",
                False,
            )
    if (
        request.method in {"POST", "PATCH"}
        and content_length is None
        and request.headers.get("transfer-encoding")
    ):
        return error_response(
            411,
            "agent_content_length_required",
            "A bounded agent request length is required.",
            False,
        )

    body = await request.body() if has_body else None

    if not _agent_proxy_slots.acquire(blocking=False):
        return agent_error(503, "agent_proxy_saturated", True)

    suffix = f"/{agent_path}" if agent_path else ""
    upstream_url = f"{AGENT_WEB_ORIGIN}/agent{suffix}"
    query = request.url.query
    if query:
        upstream_url += f"?{query}"
    request_headers = agent_proxy.filter_request_headers(
        request.headers.items(), request.headers.getlist("connection")
    )
    client = _agent_client_factory()
    upstream = None
    try:
        upstream_request = client.build_request(
            request.method,
            upstream_url,
            headers=request_headers,
            content=body if has_body else None,
        )
        upstream = client.send(upstream_request, stream=True)
    except httpx.PoolTimeout:
        client.close()
        _agent_proxy_slots.release()
        return agent_error(503, "agent_proxy_saturated", True)
    except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
        client.close()
        _agent_proxy_slots.release()
        return agent_error(502, "agent_web_unavailable", True)
    except Exception as error:
        logger.warning("agent proxy setup failed error_type=%s", type(error).__name__)
        client.close()
        _agent_proxy_slots.release()
        return agent_error(502, "agent_web_unavailable", True)

    headers = agent_proxy.filter_response_headers(
        upstream.headers.multi_items(),
        upstream.headers.get_list("connection"),
    )
    if 300 <= upstream.status_code < 400:
        location = agent_proxy.safe_agent_location(
            upstream_url,
            upstream.headers.get("Location"),
            AGENT_WEB_ORIGIN,
        )
        if location is None:
            upstream.close()
            client.close()
            _agent_proxy_slots.release()
            return agent_error(502, "agent_redirect_rejected", False)
        headers.append(("Location", location))

    if request.method == "HEAD":
        upstream.close()
        client.close()
        _agent_proxy_slots.release()
        response = Response(status_code=upstream.status_code)
        response.raw_headers = [
            (name.encode("latin-1"), value.encode("latin-1"))
            for name, value in headers
        ]
        return response

    def stream_upstream():
        try:
            for chunk in upstream.iter_raw(chunk_size=None):
                if chunk:
                    yield chunk
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
            logger.warning("agent proxy stream ended before completion")
        finally:
            upstream.close()
            client.close()
            _agent_proxy_slots.release()

    response = StreamingResponse(
        stream_upstream(),
        status_code=upstream.status_code,
    )
    response.raw_headers = [
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in headers
    ]
    return response


def _serve_shell():
    return HTMLResponse((UI_DIST_DIR / "index.html").read_text(encoding="utf-8"))


app = FastAPI()


class SecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        is_agent = path == "/agent" or path.startswith("/agent/")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message["headers"])
                if is_agent:
                    if "content-security-policy" not in headers:
                        headers["content-security-policy"] = AGENT_ERROR_SECURITY_POLICY
                else:
                    headers["content-security-policy"] = PARENT_SECURITY_POLICY
                    headers["cache-control"] = "no-store"
                headers["x-content-type-options"] = "nosniff"
                headers["referrer-policy"] = "no-referrer"
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityHeadersMiddleware)


@app.get("/")
async def index(request: Request):
    response_formats = request.query_params.getlist("format")
    if not response_formats:
        return _serve_shell()
    if len(response_formats) != 1 or response_formats[0] not in ("json", "html"):
        return invalid_format_response()
    response_format = response_formats[0]
    with tracer.start_as_current_span("GET /", kind=SpanKind.SERVER) as span:
        return run_request_journey(span, response_format, "GET", "/")


@app.post("/api/demo-request")
async def demo_request():
    with tracer.start_as_current_span(
        "POST /api/demo-request", kind=SpanKind.SERVER
    ) as span:
        return run_request_journey(span, "json", "POST", "/api/demo-request")


@app.get("/api/health-models")
async def health_models():
    with tracer.start_as_current_span("healthmodel.catalog", kind=SpanKind.CLIENT) as span:
        span.set_attribute("cloudhealth.operation", "catalog.read")
        models = inventory.list_models(health_client, RESOURCE_GROUP, MODEL_NAME)
        span.set_attribute("cloudhealth.model_count", len(models))
        return JSONResponse(
            {
                "models": models,
                "default": {"resourceGroup": RESOURCE_GROUP, "name": MODEL_NAME},
            }
        )


def _selected_model(request):
    return inventory.resolve_selection(
        request.query_params,
        lambda: inventory.list_models(health_client, RESOURCE_GROUP, MODEL_NAME),
        RESOURCE_GROUP,
        MODEL_NAME,
    )


@app.get("/api/health-model")
async def health_model(request: Request):
    selection, rejected = _selected_model(request)
    if rejected:
        return validation_error(
            rejected, "The requested Health Model is not available to this app."
        )
    resource_group, model_name = selection
    with tracer.start_as_current_span("healthmodel.read", kind=SpanKind.CLIENT) as span:
        span.set_attribute("cloudhealth.operation", "inventory.read")
        span.set_attribute("cloudhealth.model", model_name)
        try:
            return JSONResponse(
                inventory.read_inventory(health_client, resource_group, model_name)
            )
        except HttpResponseError as error:
            return sdk_error_response(error, "inventory.read")


@app.get("/api/entities/{entity_name:path}")
async def entity_detail(entity_name: str, request: Request):
    if set(request.query_params) - set(inventory.SELECTOR_KEYS):
        return validation_error(
            "unsupported_query", "History selection is server controlled."
        )
    selection, rejected = _selected_model(request)
    if rejected:
        return validation_error(
            rejected, "The requested Health Model is not available to this app."
        )
    selected_group, selected_model = selection
    with tracer.start_as_current_span(
        "healthmodel.history", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("cloudhealth.operation", "entity.history")
        span.set_attribute("cloudhealth.entity", entity_name)
        span.set_attribute("cloudhealth.model", selected_model)
        try:
            current = inventory.find_current_entity(
                health_client,
                selected_group,
                selected_model,
                entity_name,
            )
            if current is None:
                return error_response(
                    404,
                    "entity_not_found",
                    "The entity is no longer present.",
                    False,
                )
            exact = health_client.entities.get(
                selected_group, selected_model, entity_name
            )
            end_at = datetime.now(timezone.utc)
            start_at = end_at - timedelta(days=7)
            history_body = {
                "startAt": start_at,
                "endAt": end_at,
                "top": 20,
            }
            signal_body = {
                "signalName": CANONICAL_SIGNAL_NAME,
                "startAt": start_at,
                "endAt": end_at,
                "top": 20,
            }
            history = health_client.entities.get_history(
                selected_group, selected_model, entity_name, history_body
            )
            try:
                signal_history = health_client.entities.get_signal_history(
                    selected_group,
                    selected_model,
                    entity_name,
                    signal_body,
                )
                signal_items = history_items(signal_history)
            except HttpResponseError as error:
                status = getattr(error, "status_code", None) or getattr(
                    getattr(error, "response", None), "status_code", None
                )
                if status != 404:
                    raise
                signal_items = []
            entity_payload = entity_dto(exact, [], [])
            current_signal = next(
                (
                    item
                    for item in entity_payload["signals"]
                    if item["name"] == CANONICAL_SIGNAL_NAME
                ),
                None,
            )
            return JSONResponse(
                {
                    "entity": entity_payload,
                    "observedAt": end_at.isoformat().replace("+00:00", "Z"),
                    "transitions": [
                        transition_dto(item)
                        for item in history_items(history)
                    ],
                    "canonicalSignal": {
                        "name": CANONICAL_SIGNAL_NAME,
                        "current": current_signal,
                        "history": [
                            signal_history_dto(item)
                            for item in signal_items
                        ],
                    },
                }
            )
        except HttpResponseError as error:
            return sdk_error_response(error, "entity.history")


@app.post("/api/entities/{entity_name:path}/health-reports")
async def ingest_health_report(entity_name: str, request: Request):
    mimetype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if mimetype != "application/json":
        return validation_error(
            "json_required", "Health reports require a JSON request.", 415
        )
    try:
        body = await request.json()
    except Exception:
        body = None
    invalid = reports.validate_report_body(body)
    if invalid:
        return validation_error(*invalid)
    selection, rejected = _selected_model(request)
    if rejected:
        return validation_error(
            rejected, "The requested Health Model is not available to this app."
        )
    selected_group, selected_model = selection
    with tracer.start_as_current_span(
        "healthmodel.report", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("cloudhealth.operation", "entity.report")
        span.set_attribute("cloudhealth.entity", entity_name)
        span.set_attribute("cloudhealth.model", selected_model)
        try:
            current = inventory.find_current_entity(
                health_client, selected_group, selected_model, entity_name
            )
            if current is None:
                return error_response(
                    404,
                    "entity_not_found",
                    "The entity is no longer present.",
                    False,
                )
            current_state = scalar(
                field(
                    field(current, "properties"),
                    "health_state",
                    "healthState",
                )
            )
            if current_state == "Deleted":
                return error_response(
                    409,
                    "entity_not_reportable",
                    "Deleted entities cannot receive reports.",
                    False,
                )
            report_id = str(uuid.uuid4())
            reason = (
                body["customReason"].strip()
                if body["reasonPreset"] == "custom"
                else REASON_PRESETS[body["reasonPreset"]]
            )
            additional_context = json.dumps(
                {
                    "source": "health-pulse-web",
                    "reportId": report_id,
                    "reason": reason,
                },
                separators=(",", ":"),
                ensure_ascii=False,
            )
            if len(additional_context) > 4096:
                return validation_error(
                    "invalid_reason", "The report context is too long."
                )
            report = {
                "signalName": CANONICAL_SIGNAL_NAME,
                "healthState": body["healthState"],
                "value": body["value"],
                "expiresInMinutes": body["expiresInMinutes"],
                "additionalContext": additional_context,
            }
            span.set_attribute("cloudhealth.state", body["healthState"])
            span.set_attribute(
                "cloudhealth.expiry_minutes", body["expiresInMinutes"]
            )
            span.set_attribute("demo.report_id", report_id)
            health_client.entities.ingest_health_report(
                selected_group, selected_model, entity_name, report
            )
            submitted_at = datetime.now(timezone.utc)
            expires_at = submitted_at + timedelta(
                minutes=body["expiresInMinutes"]
            )
            return JSONResponse(
                {
                    "status": "accepted",
                    "reportId": report_id,
                    "entityName": entity_name,
                    "signalName": CANONICAL_SIGNAL_NAME,
                    "requestedState": body["healthState"],
                    "submittedAt": submitted_at.isoformat().replace("+00:00", "Z"),
                    "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
                },
                status_code=202,
            )
        except HttpResponseError as error:
            return sdk_error_response(error, "entity.report")


@app.api_route("/agent", methods=_AGENT_METHODS)
async def agent_root(request: Request):
    return await _proxy_agent(request, "")


@app.api_route("/agent/{agent_path:path}", methods=_AGENT_METHODS)
async def agent_sub(request: Request, agent_path: str):
    return await _proxy_agent(request, agent_path)


app.mount(
    "/assets",
    StaticFiles(directory=str(UI_DIST_DIR / "assets"), check_dir=False),
    name="assets",
)


@app.get("/{full_path:path}")
async def spa_deep_link(full_path: str):
    return _serve_shell()
