import html
import json
import logging
import os
import uuid
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import psycopg
from azure.core.exceptions import HttpResponseError
from azure.identity import ManagedIdentityCredential
from azure.mgmt.cloudhealth import CloudHealthMgmtClient
from azure.monitor.opentelemetry import configure_azure_monitor
from azure.storage.queue import QueueClient
from flask import Flask, Response, jsonify, render_template, request
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode


EXPECTED_SUBSCRIPTION_ID = "b2af20ad-98fa-4aa7-94c3-059663641d9f"
EXPECTED_SUBSCRIPTION_NAME = "ME-MngEnvMCAP462928-anbossar-1"
EXPECTED_RESOURCE_GROUP = "rg-ahm-movie-demo"
EXPECTED_MODEL_NAME = "hm-ahm-movie-demo"
EXPECTED_MODEL_LOCATION = "northeurope"
CLOUDHEALTH_API_VERSION = "2026-05-01-preview"
CANONICAL_SIGNAL_NAME = "web-ui-health-report"
RESERVED_SIGNAL_NAME = "database-connectivity-probe"
HEALTH_STATES = ("Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted")
REPORT_VALUES = (None, 0, 0.5, 1)
REPORT_EXPIRIES = (1, 5, 15, 30, 60, 120)
REASON_PRESETS = {
    "demo-test": "Demo test",
    "investigating": "Investigating",
    "maintenance": "Maintenance window",
    "recovery": "Recovery confirmed",
    "custom": None,
}
REPORT_KEYS = {
    "signalName",
    "healthState",
    "value",
    "expiresInMinutes",
    "reasonPreset",
    "customReason",
}
SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
    "frame-ancestors 'none'"
)


def validate_runtime_scope(environment):
    expected = {
        "AZURE_SUBSCRIPTION_ID": EXPECTED_SUBSCRIPTION_ID,
        "AZURE_SUBSCRIPTION_NAME": EXPECTED_SUBSCRIPTION_NAME,
        "AZURE_RESOURCE_GROUP": EXPECTED_RESOURCE_GROUP,
        "HEALTH_MODEL_NAME": EXPECTED_MODEL_NAME,
        "HEALTH_MODEL_LOCATION": EXPECTED_MODEL_LOCATION,
    }
    mismatches = [
        key
        for key, value in expected.items()
        if environment.get(key, "").strip().lower() != value.lower()
    ]
    if mismatches:
        raise RuntimeError(
            "Health Model runtime scope mismatch: " + ",".join(sorted(mismatches))
        )


validate_runtime_scope(os.environ)

CLIENT_ID = os.environ["AZURE_CLIENT_ID"]
QUEUE_URL = os.environ["QUEUE_URL"]
POSTGRES_HOST = os.environ["POSTGRES_HOST"]
POSTGRES_DATABASE = os.environ.get("POSTGRES_DATABASE", "demo")
POSTGRES_USER = os.environ["POSTGRES_USER"]
SUBSCRIPTION_ID = os.environ["AZURE_SUBSCRIPTION_ID"]
RESOURCE_GROUP = os.environ["AZURE_RESOURCE_GROUP"]
MODEL_NAME = os.environ["HEALTH_MODEL_NAME"]

credential = ManagedIdentityCredential(client_id=CLIENT_ID)
configure_azure_monitor(
    connection_string=os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
    credential=credential,
    enable_live_metrics=False,
)

app = Flask(__name__)
logger = logging.getLogger("ahm-demo")
logger.setLevel(logging.INFO)
tracer = trace.get_tracer("ahm-demo")
queue_client = QueueClient.from_queue_url(QUEUE_URL, credential=credential)
health_client = CloudHealthMgmtClient(
    credential,
    SUBSCRIPTION_ID,
    api_version=CLOUDHEALTH_API_VERSION,
)


def _field(value, *names, default=None):
    if value is None:
        return default
    for name in names:
        if isinstance(value, Mapping) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return default


def _scalar(value):
    return getattr(value, "value", value)


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _history_items(response):
    for name in ("history", "value", "items"):
        value = _field(response, name)
        if value is not None and not callable(value):
            return list(value)
    if response is None:
        return []
    if isinstance(response, (list, tuple)):
        return list(response)
    return list(response)


def _configured_copilot_url(environment):
    value = environment.get("COPILOT_URL", "").strip()
    if not value:
        return None
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        return None
    return value


def _operation_id():
    span_context = trace.get_current_span().get_span_context()
    if span_context.is_valid:
        return f"{span_context.trace_id:032x}"
    return uuid.uuid4().hex


def _set_span_attribute(span, key, value):
    if value is not None:
        span.set_attribute(key, value)


def _error_response(status, code, message, retryable, operation_id=None):
    response = jsonify(
        {
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
                "operationId": operation_id or _operation_id(),
            }
        }
    )
    response.status_code = status
    return response


def _validation_error(code, message, status=400):
    operation_id = _operation_id()
    logger.info(
        "healthmodel validation rejected code=%s operation_id=%s",
        code,
        operation_id,
    )
    return _error_response(
        status, code, message, False, operation_id=operation_id
    )


def _sdk_error_response(error, operation):
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    operation_id = _operation_id()
    mapping = {
        401: (
            503,
            "health_model_access_unavailable",
            "Health Model access is unavailable.",
            False,
        ),
        403: (
            503,
            "health_model_access_unavailable",
            "Health Model access is unavailable.",
            False,
        ),
        404: (404, "not_found", "The requested Health Model resource was not found.", False),
        409: (409, "health_model_conflict", "Azure could not apply the operation yet.", True),
        429: (503, "health_model_busy", "Azure is temporarily busy. Try again.", True),
    }
    result = mapping.get(
        status,
        (
            503,
            "health_model_unavailable",
            "Health Model data is temporarily unavailable.",
            True,
        ),
    )
    logger.warning(
        "cloudhealth operation failed operation=%s status=%s operation_id=%s",
        operation,
        status if status is not None else "unknown",
        operation_id,
    )
    span = trace.get_current_span()
    span.set_status(Status(StatusCode.ERROR, "CloudHealth request failed"))
    span.add_event(
        "cloudhealth.failed",
        {
            "cloudhealth.operation": operation,
            "cloudhealth.status_code": status if status is not None else 0,
            "demo.operation_id": operation_id,
        },
    )
    return _error_response(*result, operation_id=operation_id)


@app.after_request
def apply_response_headers(response):
    response.headers["Content-Security-Policy"] = SECURITY_POLICY
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


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


def as_html(result):
    request_id = html.escape(result["request_id"])
    message_id = html.escape(result["just_enqueued"]["message_id"])
    queue_head = result["queue_head"]
    head_id = html.escape(queue_head["request_id"] if queue_head else "none")
    head_label = html.escape(
        queue_head["label"] if queue_head else "oldest visible / best-effort FIFO"
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azure Health Model Demo — request journey</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body><main class="legacy-result">
<h1>Movie request journey</h1>
<section><small>Correlated request</small><code>{request_id}</code></section>
<section><small>Just enqueued for this request</small><code>{message_id}</code></section>
<section><small>Queue head — {head_label}</small><code>{head_id}</code></section>
<section><small>PostgreSQL rows</small><strong>{result["row_count"]}</strong></section>
</main></body></html>"""


def run_request_journey(current_span, response_format, method, path):
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
        if response_format not in ("html", "json"):
            raise ValueError("format must be html or json")
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
        response = (
            jsonify(result)
            if response_format == "json"
            else Response(as_html(result), mimetype="text/html")
        )
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Operation-ID"] = _operation_id()
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
        operation_id = _operation_id()
        response = jsonify(
            {
                "request_id": request_id,
                "operation_id": operation_id,
                "status": "failed",
                "error": type(error).__name__,
            }
        )
        response.status_code = 503
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Operation-ID"] = operation_id
        return response


def _signal_group_values(groups):
    if groups is None:
        return []
    if isinstance(groups, Mapping):
        return list(groups.values())
    values = []
    for snake, camel in (
        ("azure_resource", "azureResource"),
        ("azure_log_analytics", "azureLogAnalytics"),
        ("azure_monitor_workspace", "azureMonitorWorkspace"),
        ("dependencies", "dependencies"),
        ("external", "external"),
    ):
        group = _field(groups, snake, camel)
        if group is not None:
            values.append(group)
    return values


def _context_fields(additional_context):
    if not additional_context:
        return {}
    try:
        value = json.loads(additional_context)
    except (TypeError, ValueError):
        return {}
    if not isinstance(value, dict) or value.get("source") != "health-pulse-web":
        return {}
    return {
        "source": "health-pulse-web",
        "reportId": value.get("reportId"),
        "reason": value.get("reason"),
    }


def _entity_signals(current_entity):
    properties = _field(current_entity, "properties")
    groups = _field(properties, "signal_groups", "signalGroups")
    result = []
    for group in _signal_group_values(groups):
        for current_signal in _field(group, "signals", default=[]) or []:
            status = _field(current_signal, "status")
            additional_context = _field(
                status, "additional_context", "additionalContext"
            )
            result.append(
                {
                    "name": _field(current_signal, "name"),
                    "displayName": _field(
                        current_signal, "display_name", "displayName"
                    ),
                    "kind": _scalar(
                        _field(current_signal, "signal_kind", "signalKind")
                    ),
                    "healthState": _scalar(
                        _field(status, "health_state", "healthState")
                    ),
                    "value": _field(status, "value"),
                    "reportedAt": _iso(
                        _field(status, "reported_at", "reportedAt")
                    ),
                    "writable": (
                        _field(current_signal, "name") == CANONICAL_SIGNAL_NAME
                    ),
                    **_context_fields(additional_context),
                }
            )
    return result


def _relationship_dto(current_relationship):
    properties = _field(current_relationship, "properties")
    return {
        "name": _field(current_relationship, "name"),
        "displayName": _field(properties, "display_name", "displayName"),
        "parentEntityName": _field(
            properties, "parent_entity_name", "parentEntityName"
        ),
        "childEntityName": _field(
            properties, "child_entity_name", "childEntityName"
        ),
    }


def _entity_order(entities, relationships):
    names = {_field(item, "name") for item in entities}
    children = {name: [] for name in names}
    incoming = {name: 0 for name in names}
    linked = set()
    for relation in relationships:
        parent = relation["parentEntityName"]
        child = relation["childEntityName"]
        if parent in names and child in names:
            children[parent].append(child)
            incoming[child] += 1
            linked.update((parent, child))
    roots = sorted(
        (name for name in names if incoming[name] == 0),
        key=lambda name: (name != MODEL_NAME, name.casefold()),
    )
    depth = {}
    frontier = [(name, 0) for name in roots]
    while frontier:
        name, current_depth = frontier.pop(0)
        if name in depth and depth[name] <= current_depth:
            continue
        depth[name] = current_depth
        frontier.extend((child, current_depth + 1) for child in children[name])
    display_names = {
        _field(item, "name"): (
            _field(
                _field(item, "properties"),
                "display_name",
                "displayName",
                default=_field(item, "name"),
            )
            or _field(item, "name")
        )
        for item in entities
    }
    return sorted(
        names,
        key=lambda name: (
            name != MODEL_NAME,
            name not in linked,
            depth.get(name, 10_000),
            display_names[name].casefold(),
            name.casefold(),
        ),
    )


def _entity_dto(current_entity, parent_names, child_names):
    properties = _field(current_entity, "properties")
    position = _field(properties, "canvas_position", "canvasPosition")
    signals = _entity_signals(current_entity)
    reported = [item["reportedAt"] for item in signals if item["reportedAt"]]
    state = _scalar(_field(properties, "health_state", "healthState")) or "Unknown"
    entity_name = _field(current_entity, "name")
    return {
        "name": entity_name,
        "displayName": _field(
            properties, "display_name", "displayName", default=entity_name
        )
        or entity_name,
        "healthState": state,
        "impact": _scalar(_field(properties, "impact")) or "Unknown",
        "canvasPosition": (
            {
                "x": _field(position, "x"),
                "y": _field(position, "y"),
            }
            if position is not None
            else None
        ),
        "discoveredBy": _field(properties, "discovered_by", "discoveredBy"),
        "parents": sorted(parent_names),
        "children": sorted(child_names),
        "unlinked": not parent_names and not child_names,
        "latestEvaluationAt": max(reported) if reported else None,
        "latestTransitionAt": None,
        "signals": signals,
        "report": {
            "eligible": state != "Deleted",
            "signalName": CANONICAL_SIGNAL_NAME if state != "Deleted" else None,
        },
    }


def _read_inventory():
    model = health_client.health_models.get(RESOURCE_GROUP, MODEL_NAME)
    entities = list(
        health_client.entities.list_by_health_model(RESOURCE_GROUP, MODEL_NAME)
    )
    relationships = [
        _relationship_dto(item)
        for item in health_client.relationships.list_by_health_model(
            RESOURCE_GROUP, MODEL_NAME
        )
    ]
    order = _entity_order(entities, relationships)
    entity_by_name = {_field(item, "name"): item for item in entities}
    parent_names = {name: [] for name in entity_by_name}
    child_names = {name: [] for name in entity_by_name}
    for relation in relationships:
        parent = relation["parentEntityName"]
        child = relation["childEntityName"]
        if parent in child_names and child in parent_names:
            child_names[parent].append(child)
            parent_names[child].append(parent)
    entity_dtos = [
        _entity_dto(entity_by_name[name], parent_names[name], child_names[name])
        for name in order
    ]
    order_index = {name: index for index, name in enumerate(order)}
    relationships.sort(
        key=lambda item: (
            order_index.get(item["parentEntityName"], 10_000),
            order_index.get(item["childEntityName"], 10_000),
            (item["name"] or "").casefold(),
        )
    )
    model_properties = _field(model, "properties")
    root_state = next(
        (
            item["healthState"]
            for item in entity_dtos
            if item["name"] == MODEL_NAME
        ),
        "Unknown",
    )
    model_state = _scalar(
        _field(model_properties, "health_state", "healthState", default=root_state)
    )
    return {
        "model": {
            "id": _field(model, "id"),
            "name": _field(model, "name", default=MODEL_NAME),
            "location": _field(model, "location"),
            "provisioningState": _scalar(
                _field(
                    model_properties,
                    "provisioning_state",
                    "provisioningState",
                )
            ),
            "healthState": model_state or root_state,
        },
        "observedAt": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "entities": entity_dtos,
        "relationships": relationships,
        "reportOptions": {
            "signalName": CANONICAL_SIGNAL_NAME,
            "healthStates": list(HEALTH_STATES),
            "values": list(REPORT_VALUES),
            "expiries": list(REPORT_EXPIRIES),
            "reasonPresets": [
                {"value": key, "label": label or "Custom reason"}
                for key, label in REASON_PRESETS.items()
            ],
        },
    }


def _find_current_entity(entity_name):
    entities = list(
        health_client.entities.list_by_health_model(RESOURCE_GROUP, MODEL_NAME)
    )
    return next(
        (item for item in entities if _field(item, "name") == entity_name),
        None,
    )


def _transition_dto(item):
    return {
        "previousState": _scalar(
            _field(item, "previous_state", "previousState")
        ),
        "healthState": _scalar(_field(item, "new_state", "newState")),
        "occurredAt": _iso(_field(item, "occurred_at", "occurredAt")),
    }


def _signal_history_dto(item):
    additional_context = _field(
        item, "additional_context", "additionalContext"
    )
    return {
        "healthState": _scalar(_field(item, "health_state", "healthState")),
        "value": _field(item, "value"),
        "occurredAt": _iso(_field(item, "occurred_at", "occurredAt")),
        **_context_fields(additional_context),
    }


def _validate_report_body(body):
    if not isinstance(body, dict):
        return "invalid_json", "The request body must be a JSON object."
    unknown = set(body) - REPORT_KEYS
    if unknown:
        return "unknown_field", "The request contains an unsupported field."
    required = {
        "signalName",
        "healthState",
        "value",
        "expiresInMinutes",
        "reasonPreset",
    }
    if not required.issubset(body):
        return "missing_field", "All visible report fields are required."
    if body["signalName"] != CANONICAL_SIGNAL_NAME:
        return "invalid_signal", "Only the displayed report signal is supported."
    if body["healthState"] not in HEALTH_STATES:
        return "invalid_state", "Select a supported health state."
    value = body["value"]
    if isinstance(value, bool) or value not in REPORT_VALUES:
        return "invalid_value", "Select a supported report value."
    expiry = body["expiresInMinutes"]
    if isinstance(expiry, bool) or expiry not in REPORT_EXPIRIES:
        return "invalid_expiry", "Select a supported expiry."
    preset = body["reasonPreset"]
    if preset not in REASON_PRESETS:
        return "invalid_reason", "Select a supported reason."
    custom_reason = body.get("customReason")
    if preset == "custom":
        if (
            not isinstance(custom_reason, str)
            or not custom_reason.strip()
            or len(custom_reason.strip()) > 280
            or "\x00" in custom_reason
        ):
            return "invalid_reason", "Enter a custom reason of 1 to 280 characters."
    elif custom_reason is not None:
        return "invalid_reason", "Custom reason is available only with Custom."
    return None


@app.get("/")
def index():
    response_format = request.args.get("format")
    if response_format is None:
        return render_template(
            "index.html",
            copilot_url=_configured_copilot_url(os.environ),
        )
    with tracer.start_as_current_span("GET /", kind=SpanKind.SERVER) as span:
        return run_request_journey(span, response_format, "GET", "/")


@app.post("/api/demo-request")
def demo_request():
    with tracer.start_as_current_span(
        "POST /api/demo-request", kind=SpanKind.SERVER
    ) as span:
        return run_request_journey(
            span, "json", "POST", "/api/demo-request"
        )


@app.get("/api/health-model")
def health_model():
    with tracer.start_as_current_span("healthmodel.read", kind=SpanKind.CLIENT) as span:
        span.set_attribute("cloudhealth.operation", "inventory.read")
        try:
            return jsonify(_read_inventory())
        except HttpResponseError as error:
            return _sdk_error_response(error, "inventory.read")


@app.get("/api/entities/<path:entity_name>")
def entity_detail(entity_name):
    if request.args:
        return _validation_error(
            "unsupported_query", "History selection is server controlled."
        )
    with tracer.start_as_current_span(
        "healthmodel.history", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("cloudhealth.operation", "entity.history")
        span.set_attribute("cloudhealth.entity", entity_name)
        try:
            current = _find_current_entity(entity_name)
            if current is None:
                return _error_response(
                    404,
                    "entity_not_found",
                    "The entity is no longer present.",
                    False,
                )
            exact = health_client.entities.get(
                RESOURCE_GROUP, MODEL_NAME, entity_name
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
                RESOURCE_GROUP, MODEL_NAME, entity_name, history_body
            )
            try:
                signal_history = health_client.entities.get_signal_history(
                    RESOURCE_GROUP, MODEL_NAME, entity_name, signal_body
                )
                signal_items = _history_items(signal_history)
            except HttpResponseError as error:
                status = getattr(error, "status_code", None) or getattr(
                    getattr(error, "response", None), "status_code", None
                )
                if status != 404:
                    raise
                signal_items = []
            entity_payload = _entity_dto(exact, [], [])
            current_signal = next(
                (
                    item
                    for item in entity_payload["signals"]
                    if item["name"] == CANONICAL_SIGNAL_NAME
                ),
                None,
            )
            return jsonify(
                {
                    "entity": entity_payload,
                    "observedAt": end_at.isoformat().replace("+00:00", "Z"),
                    "transitions": [
                        _transition_dto(item)
                        for item in _history_items(history)
                    ],
                    "canonicalSignal": {
                        "name": CANONICAL_SIGNAL_NAME,
                        "current": current_signal,
                        "history": [
                            _signal_history_dto(item)
                            for item in signal_items
                        ],
                    },
                }
            )
        except HttpResponseError as error:
            return _sdk_error_response(error, "entity.history")


@app.post("/api/entities/<path:entity_name>/health-reports")
def ingest_health_report(entity_name):
    if not request.is_json:
        return _validation_error(
            "json_required", "Health reports require a JSON request.", 415
        )
    body = request.get_json(silent=True)
    invalid = _validate_report_body(body)
    if invalid:
        return _validation_error(*invalid)
    with tracer.start_as_current_span(
        "healthmodel.report", kind=SpanKind.CLIENT
    ) as span:
        span.set_attribute("cloudhealth.operation", "entity.report")
        span.set_attribute("cloudhealth.entity", entity_name)
        try:
            current = _find_current_entity(entity_name)
            if current is None:
                return _error_response(
                    404,
                    "entity_not_found",
                    "The entity is no longer present.",
                    False,
                )
            current_state = _scalar(
                _field(
                    _field(current, "properties"),
                    "health_state",
                    "healthState",
                )
            )
            if current_state == "Deleted":
                return _error_response(
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
                return _validation_error(
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
                RESOURCE_GROUP, MODEL_NAME, entity_name, report
            )
            submitted_at = datetime.now(timezone.utc)
            expires_at = submitted_at + timedelta(
                minutes=body["expiresInMinutes"]
            )
            response = jsonify(
                {
                    "status": "accepted",
                    "reportId": report_id,
                    "entityName": entity_name,
                    "signalName": CANONICAL_SIGNAL_NAME,
                    "requestedState": body["healthState"],
                    "submittedAt": submitted_at.isoformat().replace("+00:00", "Z"),
                    "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
                }
            )
            response.status_code = 202
            return response
        except HttpResponseError as error:
            return _sdk_error_response(error, "entity.report")
