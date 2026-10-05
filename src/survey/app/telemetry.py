import logging

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode


ROLE = "ahm-survey"
OPERATIONS = frozenset(("author_save", "author_read", "join_read", "ballot_read",
                        "ballot_save", "results_read", "readiness", "static", "invalid_route"))


class PrivateLogFilter(logging.Filter):
    def filter(self, record):
        record.msg = "survey runtime event"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def configure(config):
    # Do not enable HTTP, SQL, credential, or exception auto-instrumentation.
    from azure.monitor.opentelemetry.exporter import AzureMonitorTraceExporter
    from azure.identity import DefaultAzureCredential

    credential = DefaultAzureCredential(managed_identity_client_id=config.client_id)
    provider = TracerProvider(resource=Resource({"service.name": ROLE}))
    provider.add_span_processor(BatchSpanProcessor(AzureMonitorTraceExporter(
        connection_string=config.insights, credential=credential, disable_offline_storage=True,
        tracer_provider=provider,
    )))
    for name in ("uvicorn.error", "uvicorn.access", "azure", "opentelemetry"):
        logging.getLogger(name).addFilter(PrivateLogFilter())
    # Child SDK loggers propagate directly to handlers, bypassing ancestor filters.
    for handler in logging.getLogger().handlers:
        handler.addFilter(PrivateLogFilter())
    return provider, credential


class Telemetry:
    def __init__(self, provider=None):
        self.tracer = provider.get_tracer("survey") if provider else None

    def record(self, operation, status, started, ended):
        method = "PUT" if operation in ("author_save_update", "ballot_save") else "POST" if operation == "author_save" else "GET"
        if operation == "author_save_update":
            operation = "author_save"
        if operation not in OPERATIONS:
            operation = "invalid_route"
        if self.tracer:
            span = self.tracer.start_span(
                operation, kind=SpanKind.SERVER, start_time=started,
                attributes={"survey.operation": operation,
                            "http.request.method": method,
                            "http.response.status_code": status},
            )
            span.set_status(Status(StatusCode.OK if status < 400 else StatusCode.ERROR))
            span.end(end_time=ended)
