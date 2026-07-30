import logging
import uuid

from fastapi.responses import JSONResponse
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode


logger = logging.getLogger("ahm-demo")


def operation_id():
    span_context = trace.get_current_span().get_span_context()
    if span_context.is_valid:
        return f"{span_context.trace_id:032x}"
    return uuid.uuid4().hex


def set_span_attribute(span, key, value):
    if value is not None:
        span.set_attribute(key, value)


def error_response(status, code, message, retryable, operation_id_value=None):
    return JSONResponse(
        {
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
                "operationId": operation_id_value or operation_id(),
            }
        },
        status_code=status,
    )


def validation_error(code, message, status=400):
    current = operation_id()
    logger.info(
        "healthmodel validation rejected code=%s operation_id=%s",
        code,
        current,
    )
    return error_response(
        status, code, message, False, operation_id_value=current
    )


def invalid_format_response():
    current = operation_id()
    logger.info(
        "compatibility format rejected operation_id=%s",
        current,
    )
    response = error_response(
        400,
        "invalid_format",
        "Format must be exactly json or html.",
        False,
        operation_id_value=current,
    )
    response.headers["X-Operation-ID"] = current
    return response


def sdk_error_response(error, operation):
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    current = operation_id()
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
        current,
    )
    span = trace.get_current_span()
    span.set_status(Status(StatusCode.ERROR, "CloudHealth request failed"))
    span.add_event(
        "cloudhealth.failed",
        {
            "cloudhealth.operation": operation,
            "cloudhealth.status_code": status if status is not None else 0,
            "demo.operation_id": current,
        },
    )
    return error_response(*result, operation_id_value=current)


def agent_error(status, code, retryable):
    current = operation_id()
    logger.warning(
        "agent proxy failed code=%s operation_id=%s",
        code,
        current,
    )
    response = error_response(
        status,
        code,
        "Health copilot is temporarily unavailable.",
        retryable,
        operation_id_value=current,
    )
    response.headers["X-Operation-ID"] = current
    return response
