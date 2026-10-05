import logging
import unittest
from unittest import mock

from fastapi.testclient import TestClient
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
import psycopg

from src.survey.app.config import Config
from src.survey.app.main import create_app
from src.survey.app.storage import Storage
from src.survey.app.telemetry import PrivateLogFilter, ROLE, Telemetry


class TelemetryPrivacyTests(unittest.TestCase):
    def test_http_error_paths_export_allowlist_without_input(self):
        from azure.monitor.opentelemetry.exporter.export.trace._exporter import _convert_span_to_envelope
        exporter = InMemorySpanExporter()
        provider = TracerProvider(resource=Resource({"service.name": ROLE}))
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        connect = mock.Mock(side_effect=psycopg.OperationalError("secret SQL parameter: private-answer"))
        client = TestClient(create_app(Storage(connect), Telemetry(provider)))
        for method, path, options, expected in (
            ("put", "/api/surveys/ABCDEF/ballot?key=private-query", {"json": {
                "version": 0, "survey_version": 1, "answers": {"bad": "private-answer"}}}, 422),
            ("get", "/api/surveys/ABCDEF/editor?key=private-query",
             {"headers": {"Authorization": "Bearer private-header"}}, 403),
            ("get", "/api/surveys/ABCDEF?key=private-query", {}, 503),
        ):
            with self.subTest(status=expected):
                self.assertEqual(getattr(client, method)(path, **options).status_code, expected)
        spans = exporter.get_finished_spans()
        self.assertEqual(len(spans), 3)
        for span, expected in zip(spans, (422, 403, 503)):
            with self.subTest(status=expected):
                self.assertEqual(set(span.attributes), {
                    "survey.operation", "http.request.method", "http.response.status_code"})
                envelope = _convert_span_to_envelope(span)
                self.assertEqual(envelope.data.base_data.response_code, str(expected))
                self.assertFalse(envelope.data.base_data.success)
                self.assertEqual(envelope.tags["ai.cloud.role"], ROLE)
                self.assertNotIn("private-", str(envelope))
                self.assertFalse(span.events)
        provider.shutdown()

    def test_unexpected_runtime_log_is_sanitized(self):
        record = logging.LogRecord("uvicorn.error", logging.ERROR, "", 0,
                                   "secret header %s", ("private-key",), (ValueError, ValueError("answer"), None))
        self.assertTrue(PrivateLogFilter().filter(record))
        self.assertEqual(record.getMessage(), "survey runtime event")
        self.assertIsNone(record.exc_info)

    def test_config_fails_with_names_not_values(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Missing survey configuration: POSTGRES_HOST"):
                Config.load()
