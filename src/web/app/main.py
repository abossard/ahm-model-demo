import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated

from azure.core.exceptions import AzureError, ClientAuthenticationError, HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import ContainerClient
from azure.monitor.opentelemetry import configure_azure_monitor
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.trace import SpanKind
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders

import apply
import history_store
import inventory
import live_data
import model_diff
import reports
from auth import (
    LOCAL_CALLER,
    AuthUnavailable,
    Authenticator,
    Caller,
    TenantRefused,
    TokenRules,
    Unauthenticated,
    signing_keys,
)
from config import (
    CANONICAL_SIGNAL_NAME,
    FAKE_AGENT_ENDPOINT,
    GITHUB_REPOSITORY,
    INSTRUCTION_MAX_CHARS,
    LIVE_RETRY_MS,
    MAX_BODY_BYTES,
    MEMORY_STORE_URL,
    NONCE_MAX_CHARS,
    REASON_PRESETS,
    SECURITY_POLICY,
    SESSION_TITLE_MAX_CHARS,
    SSE_KEEP_ALIVE_SECONDS,
    TASK_TYPES,
    UI_DIST_DIR,
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
from errors import error_response, sdk_error_response, store_error_response, validation_error
from fake_agent import FakeAgent
from fixture_models import FixtureHealthModels
from foundry_agent import FoundryAgent
from healthmodels import HealthModels
from obo import ConsentRequired, Developer, InteractionRequired, OnBehalfOf, application_factory
from sessions_store import (
    UNFINISHED,
    BlobSessionsStore,
    MemorySessionsStore,
    SessionLimit,
    SessionNotFound,
    StoreUnavailable,
    TaskLimit,
    session_summary,
    utc_now,
)
from model_hub import HubSettings, ModelHub, Refusal
from timeline import TimelineReader, TimelineRequestError, build_structure
from task_runner import AgentsBusy, TaskRunner, TaskRunning, TooManySubscribers, UserBusy


RUNTIME_SCOPE = require_runtime_config(os.environ)

AUTH_MODE = RUNTIME_SCOPE["auth_mode"]
TENANT_ID = RUNTIME_SCOPE["tenant_id"]
ALLOWED_TENANTS = RUNTIME_SCOPE["allowed_tenants"]
CLIENT_ID = RUNTIME_SCOPE["client_id"]
API_SCOPE = RUNTIME_SCOPE["api_scope"]
MCP_SCOPE = RUNTIME_SCOPE["mcp_scope"]
AGENT_PRINCIPAL_ID = RUNTIME_SCOPE["agent_principal_id"]
MANAGED_IDENTITY_CLIENT_ID = RUNTIME_SCOPE["managed_identity_client_id"]
SUBSCRIPTION_ID = RUNTIME_SCOPE["subscription_id"]
RESOURCE_GROUP = RUNTIME_SCOPE["resource_group"]
MODEL_NAME = RUNTIME_SCOPE["model_name"]
DEFAULT_MODEL = (SUBSCRIPTION_ID, RESOURCE_GROUP, MODEL_NAME)
DESIGN_MODEL = (SUBSCRIPTION_ID, RESOURCE_GROUP, RUNTIME_SCOPE["design_model_name"])
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

credential = DefaultAzureCredential(managed_identity_client_id=MANAGED_IDENTITY_CLIENT_ID)
configure_azure_monitor(
    connection_string=os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
    credential=credential,
    enable_live_metrics=False,
)

logger = logging.getLogger("ahm-demo")
logger.setLevel(logging.INFO)
tracer = trace.get_tracer("ahm-demo")

if AUTH_MODE == "local":
    credentials = Developer(DefaultAzureCredential(exclude_managed_identity_credential=True))
    authenticator = None
else:
    credentials = OnBehalfOf(application_factory(CLIENT_ID, MANAGED_IDENTITY_CLIENT_ID))
    authenticator = Authenticator(
        TokenRules(TENANT_ID, CLIENT_ID, API_SCOPE.rsplit("/", 1)[-1], ALLOWED_TENANTS), signing_keys()
    )
if RUNTIME_SCOPE["sessions_container_url"] == MEMORY_STORE_URL:
    store = MemorySessionsStore()
else:
    store = BlobSessionsStore(RUNTIME_SCOPE["sessions_container_url"], credential)
if RUNTIME_SCOPE["foundry_project_endpoint"] == FAKE_AGENT_ENDPOINT:
    agent = FakeAgent()
    health = FixtureHealthModels(
        DEFAULT_MODEL,
        DESIGN_MODEL,
        live_seconds=int(os.environ["FIXTURE_LIVE_SECONDS"]) if os.environ.get("FIXTURE_LIVE_SECONDS", "").isdigit() else None,
    )
else:
    agent = FoundryAgent(
        credential,
        RUNTIME_SCOPE["foundry_project_endpoint"],
        RUNTIME_SCOPE["foundry_agent_name"],
    )
    health = HealthModels(credentials)
runner = TaskRunner(store, agent, health)


def read_state(user, selection):
    """One observation of a model, as a viewer: its inventory and its structure for the timeline."""
    subscription_id, resource_group, model_name = selection
    raw = inventory.read_raw(user.client(subscription_id), resource_group, model_name)
    return inventory.inventory_from(*raw, model_name), build_structure(raw[1], raw[2], model_name)


def warm_structure(selection):
    hub = live_hub.warm(selection)
    return hub.structure if hub else None


history = history_store.LayeredHistory(
    history_store.MemoryHistory(),
    None
    if RUNTIME_SCOPE["sessions_container_url"] == MEMORY_STORE_URL
    else history_store.BlobHistory(ContainerClient.from_container_url(RUNTIME_SCOPE["sessions_container_url"], credential=credential)),
)
timeline = TimelineReader(history=history, structure=warm_structure)
live_hub = ModelHub(
    read_state,
    timeline.read_tail,
    HubSettings(**({"poll_seconds": float(os.environ["HUB_POLL_SECONDS"])} if os.environ.get("HUB_POLL_SECONDS", "").replace(".", "", 1).isdigit() else {})),
)


def _serve_shell():
    return HTMLResponse((UI_DIST_DIR / "index.html").read_text(encoding="utf-8"))


async def recover_tasks():
    try:
        await runner.recover()
    except Exception as error:
        logger.error("task recovery failed error_type=%s", type(error).__name__)


@asynccontextmanager
async def lifespan(application):
    application.state.recovery = asyncio.create_task(recover_tasks())
    yield
    application.state.recovery.cancel()
    await asyncio.gather(application.state.recovery, return_exceptions=True)
    await runner.shutdown()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
FastAPIInstrumentor.instrument_app(app, exclude_spans=["receive", "send"])


class SecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message["headers"])
                headers["content-security-policy"] = SECURITY_POLICY
                headers["cache-control"] = "no-store"
                headers["x-content-type-options"] = "nosniff"
                headers["referrer-policy"] = "no-referrer"
                headers["strict-transport-security"] = "max-age=31536000"
            await send(message)

        await self.app(scope, receive, send_wrapper)


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length", "0")
        if not (declared.isascii() and declared.isdigit() and len(declared) <= 9) or int(declared) > MAX_BODY_BYTES:
            await self.reject(scope, receive, send)
            return
        body, more = bytearray(), True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body += message.get("body", b"")
            if len(body) > MAX_BODY_BYTES:
                await self.reject(scope, receive, send)
                return
            more = message.get("more_body", False)
        delivered = False

        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)

    async def reject(self, scope, receive, send):
        response = error_response(
            413,
            "payload_too_large",
            f"The request body must be at most {MAX_BODY_BYTES // 1024} KB.",
            False,
        )
        await response(scope, receive, send)


app.add_middleware(BodyLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)


def authenticated(request: Request) -> Caller:
    if AUTH_MODE == "local":
        return LOCAL_CALLER
    return authenticator.user(request.headers.get("authorization"))


Authed = Annotated[Caller, Depends(authenticated)]
api = APIRouter(prefix="/api", dependencies=[Depends(authenticated)])


@app.exception_handler(StoreUnavailable)
async def store_unavailable(_request, error):
    return store_error_response(error.operation)


@app.exception_handler(AzureError)
async def azure_unreachable(_request, error):
    """Whatever Azure or the sign-in exchange raised that a route did not map itself: the usual envelope, not a plain 500."""
    return sdk_error_response(error, "request")


@app.exception_handler(Unauthenticated)
async def unauthenticated(_request, error):
    logger.info("request refused reason=%s", error.reason)
    response = error_response(401, "unauthenticated", "Sign in to continue.", False)
    response.headers["WWW-Authenticate"] = "Bearer"
    return response


TENANT_REFUSALS = {
    "personal_account": (
        "A personal Microsoft account reaches Azure through a directory, not on its own. "
        "Sign in with the directory your account belongs to."
    ),
    "tenant_not_allowed": "The directory you signed in to is not allowed to use this app.",
}


@app.exception_handler(TenantRefused)
async def tenant_refused(_request, error):
    logger.info("request refused reason=%s", error.reason)
    return error_response(403, error.reason, TENANT_REFUSALS[error.reason], False)


@app.exception_handler(AuthUnavailable)
async def auth_unavailable(_request, _error):
    return error_response(
        503, "auth_unavailable", "Sign-in checks are temporarily unavailable. Try again.", True
    )


@app.exception_handler(InteractionRequired)
async def interaction_required(_request, error):
    response = error_response(
        401,
        "interaction_required",
        "Azure needs more from your sign-in, for example multi-factor authentication. Sign in again.",
        False,
        **({"claims": error.claims} if error.claims else {}),
    )
    challenge = 'Bearer error="insufficient_claims"'
    if error.claims:
        challenge += f', claims="{base64.b64encode(error.claims.encode("utf-8")).decode("ascii")}"'
    response.headers["WWW-Authenticate"] = challenge
    return response


@app.exception_handler(ConsentRequired)
async def consent_required(_request, _error):
    return error_response(
        403,
        "consent_required",
        "The app has not been approved to reach Azure for you. An administrator of your directory has to "
        "approve it for the organization, then sign in again.",
        False,
    )


@app.get("/")
async def index():
    return _serve_shell()


@app.get("/api/config")
async def public_config():
    local = AUTH_MODE == "local"
    return JSONResponse(
        {
            "authMode": AUTH_MODE,
            "clientId": None if local else CLIENT_ID,
            "apiScope": None if local else API_SCOPE,
            # The directory the app is registered in: its members and guests sign in to it with one click.
            "homeDirectory": None if local else TENANT_ID,
        }
    )


@api.get("/health-models")
def health_models(caller: Authed):
    user = health.as_user(caller)
    default = default_for(caller)
    with tracer.start_as_current_span("healthmodel.catalog", kind=SpanKind.CLIENT) as span:
        span.set_attribute("cloudhealth.operation", "catalog.read")
        models = inventory.list_models(user, default)
        span.set_attribute("cloudhealth.model_count", len(models))
        return JSONResponse({"models": models, "default": inventory.default_model(models, default)})


def default_for(caller):
    """The deployment's own model is the default of a user of its directory only: anyone else has their own models."""
    return DEFAULT_MODEL if caller.in_home_tenant else None


def _resolve_selection(params, user, caller):
    try:
        selection, rejected = inventory.resolve_selection(
            params, user.has_model, default_for(caller)
        )
    except HttpResponseError as error:
        return None, sdk_error_response(error, "model.select")
    if rejected:
        return None, validation_error(
            rejected, "The requested Health Model is not available to this app."
        )
    return selection, None


def _selected_model(request, user, caller):
    return _resolve_selection(request.query_params, user, caller)


def _live_frame(event):
    data = json.dumps(event["data"], separators=(",", ":"), ensure_ascii=False)
    return f"id: {event['id']}\nevent: {event['event']}\ndata: {data}\n\n"


def _closed_frame(closed):
    data = {"reason": closed.reason, **({"error": closed.error} if closed.error else {})}
    return f"event: {closed.kind}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def _live_stream(subscription):
    try:
        yield f"retry: {LIVE_RETRY_MS}\n\n"
        for event in subscription.initial:
            yield _live_frame(event)
        while True:
            item = await subscription.next(SSE_KEEP_ALIVE_SECONDS)
            if item is None:
                yield ": keep-alive\n\n"
            elif isinstance(item, dict):
                yield _live_frame(item)
            else:
                yield _closed_frame(item)
                return
    finally:
        subscription.close()


@api.get("/health-model/stream")
async def health_model_stream(request: Request, caller: Authed):
    if set(request.query_params) - set(inventory.SELECTOR_KEYS):
        return validation_error("unsupported_query", "The live stream takes only the model selector.")
    last_id = request.headers.get("last-event-id")
    if last_id is not None and live_data.parse_event_id(last_id) is None:
        return validation_error("invalid_last_event_id", "Last-Event-ID is not an id of this stream.")
    user = health.as_user(caller)
    selection, rejected = await run_in_threadpool(_selected_model, request, user, caller)
    if rejected:
        return rejected
    try:
        subscription = await live_hub.subscribe(caller, user, selection, last_id, caller.expires_at)
    except Refusal as refusal:
        return error_response(refusal.status, refusal.code, refusal.message, refusal.retryable)
    except AzureError as error:
        return sdk_error_response(error, "live.subscribe")
    return StreamingResponse(
        _live_stream(subscription),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _refresh_live(selection, user):
    """A write changed the model: a warm hub reads it again now, so the next read and the stream show the change."""
    try:
        await live_hub.refresh(selection, user)
    except Exception:
        logger.warning("live refresh failed after a write")


@api.get("/health-model")
async def health_model(request: Request, caller: Authed):
    user = health.as_user(caller)
    selection, rejected = await run_in_threadpool(_selected_model, request, user, caller)
    if rejected:
        return rejected
    if request.query_params.get("refresh") == "1":
        await _refresh_live(selection, user)
    return await run_in_threadpool(_read_health_model, selection, user)


def _read_health_model(selection, user):
    subscription_id, resource_group, model_name = selection
    warm = live_hub.warm(selection)
    if warm is not None:
        return JSONResponse(warm.inventory)
    with tracer.start_as_current_span("healthmodel.read", kind=SpanKind.CLIENT) as span:
        span.set_attribute("cloudhealth.operation", "inventory.read")
        span.set_attribute("cloudhealth.model", model_name)
        try:
            return JSONResponse(
                inventory.read_inventory(
                    user.client(subscription_id), resource_group, model_name
                )
            )
        except HttpResponseError as error:
            return sdk_error_response(error, "inventory.read")


@api.get("/timeline")
def timeline_history(request: Request, caller: Authed):
    user = health.as_user(caller)
    selection, rejected = _selected_model(request, user, caller)
    if rejected:
        return rejected
    with tracer.start_as_current_span("healthmodel.timeline", kind=SpanKind.CLIENT) as span:
        span.set_attribute("cloudhealth.operation", "timeline.read")
        span.set_attribute("cloudhealth.model", selection[2])
        try:
            body = timeline.read(
                caller, user, selection, request.query_params, request.query_params.getlist("entity")
            )
        except TimelineRequestError as error:
            return validation_error(error.code, error.message)
        except AzureError as error:
            return sdk_error_response(error, "timeline.read")
        span.set_attribute("cloudhealth.partial", body["partial"])
        return JSONResponse(body)


@api.get("/entities/{entity_name:path}")
def entity_detail(entity_name: str, request: Request, caller: Authed):
    if set(request.query_params) - set(inventory.SELECTOR_KEYS):
        return validation_error(
            "unsupported_query", "History selection is server controlled."
        )
    user = health.as_user(caller)
    selection, rejected = _selected_model(request, user, caller)
    if rejected:
        return rejected
    subscription_id, selected_group, selected_model = selection
    client = user.client(subscription_id)
    with tracer.start_as_current_span(
        "healthmodel.history", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("cloudhealth.operation", "entity.history")
        span.set_attribute("cloudhealth.entity", entity_name)
        span.set_attribute("cloudhealth.model", selected_model)
        try:
            current = inventory.find_current_entity(
                client,
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
            exact = client.entities.get(selected_group, selected_model, entity_name)
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
            history = client.entities.get_history(
                selected_group, selected_model, entity_name, history_body
            )
            try:
                signal_history = client.entities.get_signal_history(
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


@api.post("/entities/{entity_name:path}/health-reports")
async def ingest_health_report(entity_name: str, request: Request, caller: Authed):
    mimetype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if mimetype != "application/json":
        return validation_error(
            "json_required", "Health reports require a JSON request.", 415
        )
    try:
        body = await request.json()
    except Exception:
        body = None
    response = await run_in_threadpool(_ingest_health_report, entity_name, request, body, caller)
    if response.status_code == 202:
        user = health.as_user(caller)
        selection, _ = await run_in_threadpool(_selected_model, request, user, caller)
        if selection:
            await _refresh_live(selection, user)
    return response


def _ingest_health_report(entity_name, request, body, caller):
    invalid = reports.validate_report_body(body)
    if invalid:
        return validation_error(*invalid)
    user = health.as_user(caller)
    selection, rejected = _selected_model(request, user, caller)
    if rejected:
        return rejected
    subscription_id, selected_group, selected_model = selection
    client = user.client(subscription_id)
    with tracer.start_as_current_span(
        "healthmodel.report", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("cloudhealth.operation", "entity.report")
        span.set_attribute("cloudhealth.entity", entity_name)
        span.set_attribute("cloudhealth.model", selected_model)
        try:
            current = inventory.find_current_entity(
                client, selected_group, selected_model, entity_name
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
            client.entities.ingest_health_report(
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


def _not_found(code, message):
    return error_response(404, code, message, False)


def storable(text):
    """False for a text with a lone surrogate: JSON parses it, but neither the store nor a response can encode it."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


async def _json_body(request):
    raw = await request.body()
    if not raw.strip():
        return {}, None
    mimetype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if mimetype != "application/json":
        return None, validation_error("json_required", "Requests must be JSON.", 415)
    try:
        body = json.loads(raw)
    except ValueError:
        return None, validation_error("invalid_json", "The request body must be JSON.")
    if not isinstance(body, dict):
        return None, validation_error("invalid_json", "The request body must be a JSON object.")
    return body, None


async def _session(owner, sid):
    return await store.get_session(owner, sid) if SESSION_ID.fullmatch(sid) else None


async def _task(owner, sid, tid):
    if not SESSION_ID.fullmatch(sid) or not (tid.isascii() and tid.isdigit() and len(tid) <= 9):
        return None
    task = await store.get_task(owner, sid, int(tid))
    return await runner.settled(owner, sid, task) if task else None


def _resolve_target(target, needs_entity, user, caller):
    params = {}
    if isinstance(target, dict):
        params = {
            "model": target.get("name"),
            "resourceGroup": target.get("resourceGroup"),
            "subscription": target.get("subscriptionId"),
        }
    texts = (params.get("model"), params.get("resourceGroup"), params.get("subscription") or "")
    if not all(isinstance(value, str) for value in texts) or not (texts[0] and texts[1]):
        return None, validation_error(
            "unknown_model", "The requested Health Model is not available to this app."
        )
    selection, rejected = _resolve_selection(params, user, caller)
    if rejected:
        return None, rejected
    subscription_id, resource_group, model_name = selection
    resolved = {
        "subscriptionId": subscription_id,
        "resourceGroup": resource_group,
        "name": model_name,
    }
    if not needs_entity:
        return resolved, None
    entity = target.get("entity")
    if not isinstance(entity, str) or not entity.strip():
        return None, validation_error("entity_required", "An explain task needs target.entity.")
    try:
        current = inventory.find_current_entity(
            user.client(subscription_id), resource_group, model_name, entity
        )
    except HttpResponseError as error:
        return None, sdk_error_response(error, "entity.check")
    if current is None:
        return None, validation_error("unknown_entity", "The entity is not in the target model.")
    return {**resolved, "entity": entity}, None


def _design_fields(body):
    workload = body.get("workload")
    if workload is None:
        workload = {}
    if not isinstance(workload, dict):
        return None, validation_error("invalid_workload", "workload must be an object.")
    group = workload.get("resourceGroup", RESOURCE_GROUP)
    if not isinstance(group, str) or group.casefold() != RESOURCE_GROUP.casefold():
        return None, validation_error(
            "invalid_workload", "workload.resourceGroup must be this deployment's resource group."
        )
    repository = workload.get("repositoryUrl")
    if repository not in (None, ""):
        if not isinstance(repository, str) or not GITHUB_REPOSITORY.fullmatch(repository):
            return None, validation_error(
                "invalid_repository_url",
                "Enter a public GitHub repository, such as https://github.com/owner/repository.",
            )
    return {
        "target": {
            "subscriptionId": DESIGN_MODEL[0],
            "resourceGroup": DESIGN_MODEL[1],
            "name": DESIGN_MODEL[2],
        },
        "workload": {"resourceGroup": RESOURCE_GROUP, **({"repositoryUrl": repository} if repository else {})},
    }, None


async def _task_fields(body, user, caller):
    task_type = body.get("type")
    if task_type not in TASK_TYPES:
        return None, validation_error("invalid_task_type", "type must be review, explain or design.")
    if task_type == "design" and not caller.in_home_tenant:
        return None, validation_error(
            "design_unavailable", "Designing a model is only available in the directory this app belongs to.", 403
        )
    instruction = body.get("instruction")
    if instruction is None:
        instruction = ""
    if not isinstance(instruction, str) or len(instruction) > INSTRUCTION_MAX_CHARS or not storable(instruction):
        return None, validation_error(
            "invalid_instruction",
            f"instruction must be text of at most {INSTRUCTION_MAX_CHARS} characters.",
        )
    fields = {"type": task_type, "instruction": instruction, "createdAt": utc_now()}
    if task_type == "design":
        design, rejected = _design_fields(body)
    else:
        design = None
        target, rejected = await run_in_threadpool(
            _resolve_target, body.get("target"), task_type == "explain", user, caller
        )
    if rejected:
        return None, rejected
    return {**fields, **(design if design else {"target": target})}, None


@api.get("/sessions")
async def list_sessions(caller: Authed):
    return JSONResponse({"sessions": await store.list_sessions(caller.owner)})


@api.post("/sessions")
async def create_session(request: Request, caller: Authed):
    body, rejected = await _json_body(request)
    if rejected:
        return rejected
    title = body.get("title")
    if title is None or title == "":
        title = f"Session {datetime.now(timezone.utc):%Y-%m-%d %H:%M}"
    elif not isinstance(title, str) or not title.strip() or len(title) > SESSION_TITLE_MAX_CHARS or not storable(title):
        return validation_error(
            "invalid_title", f"title must be text of at most {SESSION_TITLE_MAX_CHARS} characters."
        )
    try:
        session = await store.create_session(caller.owner, title.strip())
    except SessionLimit:
        return error_response(
            409, "session_limit", "The app has reached its limit of sessions.", False
        )
    return JSONResponse(session_summary(session, 0, None), status_code=201)


@api.get("/sessions/{sid}")
async def get_session(sid: str, caller: Authed):
    session = await _session(caller.owner, sid)
    if session is None:
        return _not_found("session_not_found", "The session was not found.")
    tasks = [
        await runner.settled(caller.owner, sid, task) for task in await store.list_tasks(caller.owner, sid)
    ]
    last = max((task.get("finishedAt") or task["createdAt"] for task in tasks), default=None)
    return JSONResponse(
        {
            "session": session_summary(session, len(tasks), last),
            "tasks": [{k: v for k, v in task.items() if k != "result"} for task in tasks],
        }
    )


@api.post("/sessions/{sid}/tasks")
async def create_task(sid: str, request: Request, caller: Authed):
    if await _session(caller.owner, sid) is None:
        return _not_found("session_not_found", "The session was not found.")
    body, rejected = await _json_body(request)
    if rejected:
        return rejected
    fields, rejected = await _task_fields(body, health.as_user(caller), caller)
    if rejected:
        return rejected
    try:
        task = await runner.start(caller, sid, fields)
    except UserBusy:
        return error_response(
            409, "task_running", "You already have a task running in another session. Wait for it to finish.", True
        )
    except TaskRunning:
        return error_response(
            409, "task_running", "A task is already running in this session.", True
        )
    except AgentsBusy:
        return error_response(
            503, "agents_busy", "All agents are busy with other tasks. Try again in a few minutes.", True
        )
    except TaskLimit:
        return error_response(
            409, "task_limit", "This session has reached its limit of tasks. Start a new session.", False
        )
    except SessionNotFound:
        return _not_found("session_not_found", "The session was not found.")
    return JSONResponse(task, status_code=202)


@api.get("/sessions/{sid}/tasks/{tid}")
async def get_task(sid: str, tid: str, caller: Authed):
    task = await _task(caller.owner, sid, tid)
    if task is None:
        return _not_found("task_not_found", "The task was not found.")
    return JSONResponse(task)


def _sse_frame(event):
    data = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    return f"id: {event['seq']}\nevent: activity\ndata: {data}\n\n"


def _done_frame(task):
    data = {"status": task["status"], **({"error": task["error"]} if task.get("error") else {})}
    return f"event: done\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def _final_task(owner, sid, seq):
    return await runner.settled(owner, sid, await store.get_task(owner, sid, seq))


async def _event_stream(owner, sid, seq, last, queue):
    try:
        for event in await store.read_events(owner, sid, seq, last):
            if event["seq"] > last:
                last = event["seq"]
                yield _sse_frame(event)
        while queue is not None:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=SSE_KEEP_ALIVE_SECONDS)
            except TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if event is None:
                break
            if event["seq"] > last:
                last = event["seq"]
                yield _sse_frame(event)
        task = await _final_task(owner, sid, seq)
        while task["status"] in UNFINISHED:
            yield ": keep-alive\n\n"
            await asyncio.sleep(SSE_KEEP_ALIVE_SECONDS)
            task = await _final_task(owner, sid, seq)
        yield _done_frame(task)
    finally:
        if queue is not None:
            runner.detach(owner, sid, queue)


@api.get("/sessions/{sid}/tasks/{tid}/events")
async def task_events(sid: str, tid: str, request: Request, caller: Authed):
    task = await _task(caller.owner, sid, tid)
    if task is None:
        return _not_found("task_not_found", "The task was not found.")
    raw = request.headers.get("last-event-id") or request.query_params.get("lastEventId") or ""
    if raw and not (raw.isascii() and raw.isdigit() and len(raw) <= 9):
        return validation_error(
            "invalid_last_event_id", "lastEventId must be a whole number of at most 9 digits."
        )
    try:
        queue = runner.attach(caller.owner, sid, task["seq"])
    except TooManySubscribers:
        return error_response(
            503, "too_many_subscribers", "Too many viewers are following this task. Try again shortly.", True
        )
    return StreamingResponse(
        _event_stream(caller.owner, sid, task["seq"], int(raw or 0), queue),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        background=BackgroundTask(runner.detach, caller.owner, sid, queue) if queue is not None else None,
    )


async def _finished_diff(owner, sid, tid):
    task = await _task(owner, sid, tid)
    result = (task or {}).get("result")
    if not task or task["status"] != "done" or not result or result.get("kind") != "diff":
        return None
    return task


@api.get("/sessions/{sid}/tasks/{tid}/diff")
async def task_diff(sid: str, tid: str, caller: Authed):
    task = await _finished_diff(caller.owner, sid, tid)
    base = await store.load_base(caller.owner, sid, task["seq"]) if task else None
    if base is None:
        return _not_found("diff_not_found", "The task has no diff.")
    target = task["target"]
    return JSONResponse(
        model_diff.diff_view(
            task["result"],
            base,
            target["name"],
            target,
            await store.read_applies(caller.owner, sid, task["seq"]),
            True,
        )
    )


@api.post("/sessions/{sid}/tasks/{tid}/apply")
async def task_apply(sid: str, tid: str, request: Request, caller: Authed):
    task = await _finished_diff(caller.owner, sid, tid)
    if task is None:
        return _not_found("diff_not_found", "The task has no diff.")
    body, rejected = await _json_body(request)
    if rejected:
        return rejected
    change_ids = body.get("changeIds")
    known = {change["id"] for change in task["result"]["changes"]}
    if (
        not isinstance(change_ids, list)
        or not change_ids
        or not all(isinstance(id_, str) and id_ in known for id_ in change_ids)
    ):
        return validation_error(
            "invalid_change_ids", "changeIds must list at least one change of this diff."
        )
    user = health.as_user(caller)
    try:
        outcome = await apply.apply_changes(store, user, caller.owner, sid, task, change_ids)
    except apply.BaseChanged:
        return error_response(
            409,
            "base_changed",
            "The model changed after this task captured it. Run the task again.",
            False,
        )
    except AzureError as error:
        return sdk_error_response(error, "apply.read")
    finally:
        # Whatever was written, whole or in part, shows at once.
        await _refresh_live(apply.reference(task["target"]), user)
    return JSONResponse({key: outcome[key] for key in ("outcome", "written", "failed", "expanded")})


@app.post("/api/agent/token")
async def agent_token(request: Request):
    if AUTH_MODE == "local":
        return _not_found("not_found", "There is no token broker in local mode.")
    identity = await run_in_threadpool(authenticator.agent, request.headers.get("authorization"))
    if not AGENT_PRINCIPAL_ID:
        return error_response(
            503, "agent_identity_not_configured", "The agent identity is not configured yet.", True
        )
    if identity.oid != AGENT_PRINCIPAL_ID.casefold():
        return error_response(403, "forbidden", "This identity may not request tokens.", False)
    body, rejected = await _json_body(request)
    if rejected:
        return rejected
    nonce = body.get("nonce")
    if not isinstance(nonce, str) or not nonce or len(nonce) > NONCE_MAX_CHARS or not nonce.isascii():
        return validation_error("invalid_nonce", "nonce must be the text from the task.")
    run = runner.run_for_nonce(nonce)
    if run is None or run.caller is None:
        return _not_found("unknown_task", "No task is running for that nonce.")
    if not run.allows_token(time.monotonic()):
        return error_response(
            429, "rate_limited", "Too many token requests for this task. Try again shortly.", True
        )
    user_credential = credentials.credential(run.caller)
    try:
        token = await asyncio.to_thread(user_credential.get_token, MCP_SCOPE)
    except ClientAuthenticationError:
        return error_response(502, "token_exchange_failed", "Azure refused the token exchange for this task.", False)
    except AzureError:
        return error_response(
            503, "token_unavailable", "The token exchange is temporarily unavailable. Try again.", True
        )
    return JSONResponse({"accessToken": token.token, "expiresOn": token.expires_on})


API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


@api.api_route("", methods=API_METHODS, include_in_schema=False)
@api.api_route("/{unknown:path}", methods=API_METHODS, include_in_schema=False)
async def unknown_api_path():
    return _not_found("not_found", "There is no such API route.")


app.include_router(api)

app.mount(
    "/assets",
    StaticFiles(directory=str(UI_DIST_DIR / "assets"), check_dir=False),
    name="assets",
)


@app.get("/{full_path:path}")
async def spa_deep_link(full_path: str):
    return _serve_shell()
