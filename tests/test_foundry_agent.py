import json
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import foundry_agent  # noqa: E402

ENDPOINT = "https://acct.services.ai.azure.com/api/projects/proj/"
BASE = "https://acct.services.ai.azure.com/api/projects/proj/agents/health-model-agent/endpoint/protocols/openai"


LOGGED = {"agent_forbidden", "agent_rejected", "agent_unavailable"}
REAL_ID = "conv_live_old" + "A" * 40
REAL_MESSAGE = f"Conversation '{REAL_ID}' not found. [Request ID: 0c3a47749ff4db15d4697e998d2422ce]"
REAL_404 = {"error": {"code": "not_found", "message": REAL_MESSAGE, "type": "error", "details": [], "additionalInfo": {"request_id": "0c3a47749ff4db15d4697e998d2422ce"}}}


def sse(*events):
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()


class Harness:
    def __init__(self, handler):
        self.requests = []
        self.scopes = []
        self.credential = SimpleNamespace(get_token=self.token)
        self.agent = foundry_agent.FoundryAgent(
            self.credential,
            ENDPOINT,
            "health-model-agent",
            transport=httpx.MockTransport(self.wrap(handler)),
        )

    def token(self, scope):
        self.scopes.append(scope)
        return SimpleNamespace(token="the-token")

    def wrap(self, handler):
        def inner(request):
            self.requests.append(request)
            return handler(request)

        return inner

    async def collect(self, text="hello"):
        return [event async for event in self.agent.stream_response("conv_1", text)]


def stream_of(content, status=200):
    return lambda request: httpx.Response(status, headers={"content-type": "text/event-stream"}, content=content)


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_conversation_is_created_with_the_agent_scope_and_returns_its_id(self):
        harness = Harness(lambda request: httpx.Response(200, json={"id": "conv_abc", "object": "conversation"}))

        conversation_id = await harness.agent.create_conversation()

        (request,) = harness.requests
        self.assertEqual(conversation_id, "conv_abc")
        self.assertEqual(request.method, "POST")
        self.assertEqual(f"{request.url.scheme}://{request.url.host}{request.url.path}", f"{BASE}/conversations")
        self.assertEqual(request.url.params["api-version"], "v1")
        self.assertEqual(request.headers["authorization"], "Bearer the-token")
        self.assertEqual(harness.scopes, ["https://ai.azure.com/.default"])
        self.assertEqual(json.loads(request.content), {})

    async def test_failures_creating_a_conversation_are_classified(self):
        def refusing(status, body):
            return lambda request: httpx.Response(status, json=body)

        def unreachable(request):
            raise httpx.ConnectError("down: SECRET")

        cases = [
            ("unauthorized", refusing(401, {"error": {"message": "no token"}}), "agent_forbidden"),
            ("forbidden", refusing(403, {}), "agent_forbidden"),
            ("agent missing", refusing(404, {"error": {"message": "agent not found"}}), "agent_rejected"),
            ("bad request", refusing(400, {"error": {"code": "invalid", "message": "bad input"}}), "agent_rejected"),
            ("server error", refusing(500, {"error": {"message": "boom"}}), "agent_unavailable"),
            ("no id", refusing(200, {"object": "conversation"}), "agent_error"),
            ("not json", lambda request: httpx.Response(200, content=b"<html>"), "agent_error"),
            ("unreachable", unreachable, "agent_unreachable"),
        ]
        for label, handler, code in cases:
            with self.subTest(label=label):
                harness = Harness(handler)
                logs = self.assertLogs("ahm-demo", level="WARNING") if code in LOGGED else nullcontext()

                with logs, self.assertRaises(foundry_agent.AgentError) as caught:
                    await harness.agent.create_conversation()

                self.assertEqual(caught.exception.code, code)
                self.assertNotIn("SECRET", caught.exception.message)


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_response_is_requested_in_the_conversation_with_streaming(self):
        harness = Harness(stream_of(sse(("response.created", {"type": "response.created"}))))

        events = await harness.collect("do the task")

        (request,) = harness.requests
        self.assertEqual(f"{request.url.scheme}://{request.url.host}{request.url.path}", f"{BASE}/responses")
        self.assertEqual(request.url.params["api-version"], "v1")
        self.assertEqual(json.loads(request.content), {"conversation": "conv_1", "input": "do the task", "stream": True})
        self.assertEqual(request.headers["accept"], "text/event-stream")
        self.assertEqual(request.headers["authorization"], "Bearer the-token")
        self.assertEqual(events, [foundry_agent.StreamEvent("response.created", {"type": "response.created"})])

    async def test_sse_parsing_is_tolerant(self):
        cases = [
            ("two events", b"event: a\ndata: {\"n\": 1}\n\nevent: b\ndata: {\"n\": 2}\n\n", [("a", {"n": 1}), ("b", {"n": 2})]),
            ("comments and keep-alives", b": keep-alive\n\nevent: a\n: inline\ndata: {\"n\": 1}\n\n: more\n\n", [("a", {"n": 1})]),
            ("done sentinel", b"event: a\ndata: {\"n\": 1}\n\ndata: [DONE]\n\n", [("a", {"n": 1})]),
            ("malformed json is skipped", b"event: a\ndata: {oops\n\nevent: b\ndata: {\"n\": 2}\n\n", [("b", {"n": 2})]),
            ("non-object json is skipped", b"event: a\ndata: [1, 2]\n\nevent: b\ndata: 3\n\nevent: c\ndata: {\"n\": 3}\n\n", [("c", {"n": 3})]),
            ("multi-line data", b"event: a\ndata: {\"n\":\ndata: 1}\n\n", [("a", {"n": 1})]),
            ("name falls back to the type", b"data: {\"type\": \"response.created\"}\n\n", [("response.created", {"type": "response.created"})]),
            ("windows line endings", b"event: a\r\ndata: {\"n\": 1}\r\n\r\nevent: b\r\ndata: {\"n\": 2}\r\n\r\n", [("a", {"n": 1}), ("b", {"n": 2})]),
            ("last event without a blank line", b"event: a\ndata: {\"n\": 1}", [("a", {"n": 1})]),
            ("data without a space", b"event:a\ndata:{\"n\": 1}\n\n", [("a", {"n": 1})]),
            ("blank events", b"\n\n\n", []),
            ("unknown events are passed on", b"event: response.brand.new\ndata: {\"x\": 1}\n\n", [("response.brand.new", {"x": 1})]),
        ]
        for label, content, expected in cases:
            with self.subTest(label=label):
                harness = Harness(stream_of(content))

                events = await harness.collect()

                self.assertEqual([(e.name, e.data) for e in events], expected)

    async def test_a_missing_conversation_is_recognised_wherever_the_service_says_so(self):
        failed = lambda message, code="invalid_request": ("response.failed", {"response": {"error": {"code": code, "message": message}}})
        cases = [
            ("http 404", httpx.Response(404, json={"error": {"message": "not found"}})),
            ("http 404 without a body", httpx.Response(404, content=b"")),
            ("http 400 with a conversation message", httpx.Response(400, json={"error": {"message": "Conversation conv_1 was not found."}})),
            ("http 400 with a code", httpx.Response(400, json={"error": {"code": "conversation_not_found", "message": "x"}})),
            ("error event with a code", httpx.Response(200, content=sse(("error", {"code": "conversation_not_found", "message": "gone"})))),
            ("error event with a message", httpx.Response(200, content=sse(("error", {"code": "x", "message": "The conversation does not exist."})))),
            ("failed response", httpx.Response(200, content=sse(failed("Conversation no longer exists")))),
            ("expired", httpx.Response(200, content=sse(failed("conversation expired")))),
            ("the 404 a deleted conversation really gets", httpx.Response(404, json=REAL_404)),
            ("the real message in a failed response", httpx.Response(200, content=sse(failed(REAL_MESSAGE, code="not_found")))),
            ("the real message in an error event", httpx.Response(200, content=sse(("error", {"code": "not_found", "message": REAL_MESSAGE})))),
        ]
        for label, response in cases:
            with self.subTest(label=label):
                harness = Harness(lambda request, response=response: response)

                with self.assertRaises(foundry_agent.ConversationNotFound):
                    await harness.collect()

    async def test_only_messages_about_the_conversation_count_as_a_missing_conversation(self):
        cases = [
            ("the real message", {"code": "not_found", "message": REAL_MESSAGE}, True),
            ("the real message without a code", {"message": REAL_MESSAGE}, True),
            ("a very long id", {"message": f"Conversation 'conv_{'x' * 150}' not found."}, True),
            ("the code alone", {"code": "conversation_not_found"}, True),
            ("the words the other way round", {"message": "Not found: no such conversation."}, True),
            ("another resource that was not found", {"code": "not_found", "message": "Agent 'health-model-agent' not found. [Request ID: 1]"}, False),
            ("a model that was not found", {"code": "not_found", "message": "The model deployment was not found."}, False),
            ("an internal error", {"code": "server_error", "message": "An internal server error occurred."}, False),
            ("two sentences", {"message": "Conversation started. The agent was not found."}, False),
            ("no message", {}, False),
            ("a message that is no text", {"message": None}, False),
        ]
        for label, error, expected in cases:
            with self.subTest(label=label):
                self.assertIs(foundry_agent.says_conversation_missing(error), expected)

    async def test_a_deleted_conversation_is_told_apart_from_a_missing_agent_when_creating_one(self):
        harness = Harness(lambda request: httpx.Response(404, json={"error": {"code": "not_found", "message": "Agent 'a' not found."}}))

        with self.assertLogs("ahm-demo", level="WARNING"):
            with self.assertRaises(foundry_agent.AgentError) as caught:
                await harness.agent.create_conversation()

        self.assertEqual(caught.exception.code, "agent_rejected")

    async def test_the_missing_conversation_error_is_not_passed_to_the_caller_as_an_event(self):
        content = sse(
            ("response.created", {"type": "response.created"}),
            ("error", {"code": "conversation_not_found", "message": "gone"}),
            ("response.completed", {"type": "response.completed"}),
        )
        harness = Harness(stream_of(content))
        seen = []

        with self.assertRaises(foundry_agent.ConversationNotFound):
            async for event in harness.agent.stream_response("conv_1", "x"):
                seen.append(event.name)

        self.assertEqual(seen, ["response.created"])

    async def test_other_errors_are_events_not_exceptions(self):
        content = sse(
            ("error", {"code": "server_error", "message": "The tool failed to start."}),
            ("response.failed", {"response": {"error": {"code": "tool_start_failed", "message": "MCP child exited."}}}),
        )

        events = await Harness(stream_of(content)).collect()

        self.assertEqual([e.name for e in events], ["error", "response.failed"])

    async def test_http_and_connection_failures_are_classified(self):
        def unreachable(request):
            raise httpx.ConnectError("down: SECRET")

        class Cut(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"event: a\ndata: {\"n\": 1}\n\n"
                raise httpx.ReadError("cut: SECRET")

        cases = [
            ("unauthorized", lambda r: httpx.Response(401, json={}), "agent_forbidden"),
            ("forbidden", lambda r: httpx.Response(403, json={}), "agent_forbidden"),
            ("rejected", lambda r: httpx.Response(422, json={"error": {"message": "bad input"}}), "agent_rejected"),
            ("unavailable", lambda r: httpx.Response(503, json={"error": {"message": "busy"}}), "agent_unavailable"),
            ("unreachable", unreachable, "agent_unreachable"),
            ("cut mid-stream", lambda r: httpx.Response(200, stream=Cut()), "agent_unreachable"),
        ]
        for label, handler, code in cases:
            with self.subTest(label=label):
                harness = Harness(handler)
                logs = self.assertLogs("ahm-demo", level="WARNING") if code in LOGGED or label == "unreachable" else nullcontext()

                with logs, self.assertRaises(foundry_agent.AgentError) as caught:
                    await harness.collect()

                self.assertEqual(caught.exception.code, code)
                self.assertNotIn("SECRET", caught.exception.message)

    async def test_waiting_for_an_answer_is_bounded_to_two_minutes(self):
        agent = Harness(lambda request: httpx.Response(200)).agent

        timeout = agent._client().timeout

        self.assertEqual(foundry_agent.AGENT_WAIT_SECONDS, 120)
        self.assertEqual((timeout.connect, timeout.read, timeout.write, timeout.pool), (120, 120, 30, 15))

    async def test_a_request_that_gets_no_event_is_sent_once_more_and_never_after_events_arrived(self):
        ok = lambda: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse(("response.created", {"type": "response.created"}), ("response.completed", {"type": "response.completed"})))

        class Cut(httpx.AsyncByteStream):
            def __init__(self, error):
                self.error = error

            async def __aiter__(self):
                yield sse(("response.created", {"type": "response.created"}))
                raise self.error

        class Silent(httpx.AsyncByteStream):
            def __init__(self, error):
                self.error = error

            async def __aiter__(self):
                raise self.error
                yield b""

        cases = [
            ("a timeout, then an answer", [httpx.ReadTimeout("slow"), ok], ["response.created", "response.completed"], None, 2),
            ("a connect timeout, then an answer", [httpx.ConnectTimeout("slow"), ok], ["response.created", "response.completed"], None, 2),
            ("a refused connection, then an answer", [httpx.ConnectError("refused"), ok], ["response.created", "response.completed"], None, 2),
            ("a reset, then an answer", [httpx.ReadError("reset"), ok], ["response.created", "response.completed"], None, 2),
            ("a broken protocol, then an answer", [httpx.RemoteProtocolError("closed"), ok], ["response.created", "response.completed"], None, 2),
            ("headers and then a reset before any event", [lambda: httpx.Response(200, stream=Silent(httpx.ReadError("reset"))), ok], ["response.created", "response.completed"], None, 2),
            ("two timeouts", [httpx.ReadTimeout("one"), httpx.ReadTimeout("two")], [], "agent_unreachable", 2),
            ("a reset after an event", [lambda: httpx.Response(200, stream=Cut(httpx.ReadError("reset"))), ok], ["response.created"], "agent_unreachable", 1),
            ("a timeout after an event", [lambda: httpx.Response(200, stream=Cut(httpx.ReadTimeout("silent"))), ok], ["response.created"], "agent_unreachable", 1),
            ("a decoding error is not retried", [httpx.DecodingError("bad encoding"), ok], [], "agent_unreachable", 1),
            ("a server error is not retried", [lambda: httpx.Response(500, json={"error": {"message": "boom"}}), ok], [], "agent_unavailable", 1),
            ("a refusal is not retried", [lambda: httpx.Response(403, json={}), ok], [], "agent_forbidden", 1),
            ("a missing conversation is not retried here", [lambda: httpx.Response(404, json=REAL_404), ok], [], "conversation", 1),
        ]
        for label, answers, names, error_code, requests_sent in cases:
            with self.subTest(label=label):
                queue = list(answers)

                def handler(request):
                    answer = queue.pop(0)
                    if isinstance(answer, BaseException):
                        raise answer
                    return answer() if callable(answer) else answer

                harness = Harness(handler)
                seen = []

                logs = self.assertLogs("ahm-demo", level="WARNING") if requests_sent == 2 or error_code in LOGGED else nullcontext()
                with logs:
                    try:
                        async for event in harness.agent.stream_response("conv_1", "x"):
                            seen.append(event.name)
                        raised = None
                    except foundry_agent.AgentError as error:
                        raised = error.code
                    except foundry_agent.ConversationNotFound:
                        raised = "conversation"

                self.assertEqual(seen, names)
                self.assertEqual(raised, error_code)
                self.assertEqual(len(harness.requests), requests_sent)

    async def test_the_error_text_from_the_service_is_bounded_redacted_and_kept_whole_in_the_log(self):
        token = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.c2lnbmF0dXJl"
        rejected, unavailable = "The agent rejected the request (", "The agent is unavailable ("
        clipped = lambda prefix, text: (prefix + text + ").")[:297] + "..."
        cases = [
            ("a short message", 400, "bad input", f"{rejected}bad input)."),
            ("a long message", 400, "x" * 5000, clipped(rejected, "x" * 5000)),
            ("a long message from a failing service", 502, "y" * 5000, clipped(unavailable, "y" * 5000)),
            ("a token in the message", 500, f"denied for {token}", f"{unavailable}denied for [redacted token])."),
            ("a token at the end of a long message", 400, "z" * 270 + f" {token}", clipped(rejected, "z" * 270 + " [redacted token]")),
        ]
        for label, status, upstream, shown in cases:
            with self.subTest(label=label):
                harness = Harness(lambda r: httpx.Response(status, json={"error": {"message": upstream}}))

                with self.assertLogs("ahm-demo", level="WARNING") as logged:
                    with self.assertRaises(foundry_agent.AgentError) as caught:
                        await harness.collect()

                self.assertEqual(caught.exception.message, shown)
                self.assertLessEqual(len(caught.exception.message), 300)
                self.assertNotIn("eyJ", caught.exception.message)
                self.assertIn(upstream.replace(token, "[redacted token]"), "\n".join(logged.output))
                self.assertNotIn("eyJ", "\n".join(logged.output))

    async def test_forbidden_answers_say_nothing_from_the_service(self):
        harness = Harness(lambda r: httpx.Response(403, json={"error": {"message": "SECRET detail"}}))

        with self.assertLogs("ahm-demo", level="WARNING"):
            with self.assertRaises(foundry_agent.AgentError) as caught:
                await harness.collect()

        self.assertEqual(caught.exception.message, "The web app is not allowed to call the agent.")


if __name__ == "__main__":
    unittest.main()
