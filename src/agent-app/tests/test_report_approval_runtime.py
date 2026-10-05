import json
import sys
import unittest
from pathlib import Path

import httpx
from agent_framework import (
    BaseChatClient,
    ChatResponse,
    ChatResponseUpdate,
    Content,
    FunctionInvocationLayer,
    Message,
    ResponseStream,
)
from agent_framework_ag_ui import add_agent_framework_fastapi_endpoint
from fastapi import FastAPI
from fastapi.testclient import TestClient


AGENT_SRC = Path(__file__).parents[1] / "src"
sys.path.insert(0, str(AGENT_SRC))

from agent import create_agent
from health_api import HealthApiClient


REPORT_ARGS = {
    "entity_name": "api",
    "signal_name": "web-ui-health-report",
    "health_state": "Degraded",
    "value": 0.5,
    "reason_preset": "maintenance",
    "reason": "Maintenance window",
    "expires_in_minutes": 30,
}


class ScriptedClient(FunctionInvocationLayer, BaseChatClient):
    def __init__(self):
        super().__init__()
        self.model_calls = 0

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        self.model_calls += 1
        has_function_result = any(
            content.type == "function_result"
            for message in messages
            for content in (message.contents or [])
        )
        contents = (
            [Content.from_text("Report outcome recorded.")]
            if has_function_result
            else [
                Content.from_function_call(
                    "call-report-1",
                    "send_health_report",
                    arguments=json.dumps(REPORT_ARGS),
                )
            ]
        )
        if not stream:
            async def _response():
                return ChatResponse(messages=[Message(role="assistant", contents=contents)])

            return _response()

        async def _stream():
            yield ChatResponseUpdate(role="assistant", contents=contents)

        return ResponseStream(_stream(), finalizer=lambda updates: ChatResponse.from_updates(updates))


def parse_sse_events(raw: str):
    return [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: ")]


class ReportApprovalRuntimeTests(unittest.TestCase):
    def build_runtime(self):
        posts: list[tuple[str, str, dict[str, object]]] = []

        def transport(request: httpx.Request):
            payload = json.loads(request.content.decode("utf-8"))
            posts.append((request.method, str(request.url), payload))
            return httpx.Response(
                202,
                json={
                    "status": "accepted",
                    "reportId": "rep-1",
                    "entityName": "api",
                    "signalName": "web-ui-health-report",
                    "requestedState": "Degraded",
                    "submittedAt": "2026-10-01T00:00:00Z",
                    "expiresAt": "2026-10-01T00:30:00Z",
                },
            )

        health = HealthApiClient(
            "https://health.example",
            client=httpx.Client(transport=httpx.MockTransport(transport)),
        )
        send_calls: list[tuple[str, dict[str, object]]] = []
        original_send = health.send_health_report

        def spy_send(entity_name, report):
            send_calls.append((entity_name, report.payload()))
            return original_send(entity_name, report)

        health.send_health_report = spy_send
        scripted = ScriptedClient()
        app = FastAPI()
        add_agent_framework_fastapi_endpoint(
            app=app,
            agent=create_agent(scripted, health),
            path="/",
        )
        return TestClient(app), send_calls, posts

    def test_cancel_approval_skips_ingest_and_approve_writes_once(self):
        for accepted, expected_calls in ((False, 0), (True, 1)):
            with self.subTest(accepted=accepted):
                client, send_calls, posts = self.build_runtime()
                base = {
                    "tools": [],
                    "context": [],
                    "state": {},
                    "forwardedProps": {},
                    "messages": [
                        {
                            "id": "user-1",
                            "role": "user",
                            "content": "Stage a health report",
                        }
                    ],
                }

                first = client.post(
                    "/",
                    json={**base, "threadId": "thread-1", "runId": "run-1"},
                    headers={"Accept": "text/event-stream"},
                )
                first_events = parse_sse_events(first.text)
                finished = [event for event in first_events if event.get("type") == "RUN_FINISHED"]
                self.assertTrue(finished)
                outcome = finished[-1].get("outcome") or {}
                interrupts = outcome.get("interrupts") or outcome.get("interrupt")
                self.assertTrue(interrupts)
                interrupt = interrupts[0] if isinstance(interrupts, list) else interrupts
                self.assertEqual(interrupt.get("toolCallId"), "call-report-1")
                self.assertEqual(len(send_calls), 0)
                self.assertEqual(len(posts), 0)

                second = client.post(
                    "/",
                    json={
                        **base,
                        "threadId": "thread-1",
                        "runId": "run-2",
                        "resume": [
                            {
                                "interruptId": interrupt.get("id"),
                                "status": "resolved",
                                "payload": {"accepted": accepted},
                            }
                        ],
                    },
                    headers={"Accept": "text/event-stream"},
                )
                self.assertEqual(second.status_code, 200)
                self.assertEqual(len(send_calls), expected_calls)
                self.assertEqual(len(posts), expected_calls)
                if accepted:
                    self.assertEqual(
                        send_calls[0],
                        (
                            "api",
                            {
                                "signalName": "web-ui-health-report",
                                "healthState": "Degraded",
                                "value": 0.5,
                                "expiresInMinutes": 30,
                                "reasonPreset": "maintenance",
                            },
                        ),
                    )
                    method, url, payload = posts[0]
                    self.assertEqual(method, "POST")
                    self.assertEqual(
                        url,
                        "https://health.example/api/entities/api/health-reports",
                    )
                    self.assertEqual(payload, send_calls[0][1])


if __name__ == "__main__":
    unittest.main()
