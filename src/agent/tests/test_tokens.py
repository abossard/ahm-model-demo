import json
import logging
import shlex
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from tokens import BACKOFF_SECONDS, AzureUnavailable, BearerCommand, Broker, secure_url, token_source

NONCE = "n" * 43
AGENT_TOKEN = "agent-identity-token-value"
USER_TOKEN = "user-token-for-the-mcp-server"
AUDIENCE = "api://00000000-0000-0000-0000-00000000aaaa"
NOW = 1_000_000.0


def granted(token=USER_TOKEN, lasts=3600):
    return 200, {"accessToken": token, "expiresOn": NOW + lasts}


def refused(status, code, retryable=False):
    return status, {"error": {"code": code, "message": "a message from the web app", "retryable": retryable, "operationId": "op-1"}}


class FakeBroker:
    """The web app's token broker. Answers come from a script; the last one repeats. Every request is recorded."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                owner.requests.append({"path": self.path, "authorization": self.headers.get("Authorization"), "body": json.loads(body)})
                answer = owner.answers.pop(0) if len(owner.answers) > 1 else owner.answers[0]
                if answer[0] in (301, 302, 307):
                    self.send_response(answer[0])
                    self.send_header("Location", answer[1])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                payload = answer[1] if isinstance(answer[1], bytes) else json.dumps(answer[1]).encode()
                self.send_response(answer[0])
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Credential:
    def __init__(self, error=None):
        self.error = error
        self.scopes = []

    def get_token(self, *scopes):
        self.scopes.append(scopes)
        if self.error:
            raise self.error
        return AccessToken(AGENT_TOKEN, 4_000_000_000)


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


class Records(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class BrokerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()
        self.sleeps = []
        self.credential = Credential()
        self.records = Records()
        logging.getLogger("health-model-agent").addHandler(self.records)
        self.addCleanup(logging.getLogger("health-model-agent").removeHandler, self.records)

    def broker_for(self, *answers):
        fake = FakeBroker(*answers)
        self.addCleanup(fake.close)

        async def sleep(seconds):
            self.sleeps.append(seconds)

        return fake, Broker(fake.url, AUDIENCE, self.credential, clock=self.clock, sleep=sleep)

    async def test_asks_the_broker_with_the_agent_identity_token_and_the_nonce(self):
        fake, broker = self.broker_for(granted())

        token = await broker.token_for(NONCE)

        self.assertEqual(token, USER_TOKEN)
        self.assertEqual(self.credential.scopes, [(f"{AUDIENCE}/.default",)])
        self.assertEqual(fake.requests, [{"path": "/api/agent/token", "authorization": f"Bearer {AGENT_TOKEN}", "body": {"nonce": NONCE}}])

    async def test_the_scope_is_the_audience_with_default_whatever_its_trailing_slash(self):
        for audience in (AUDIENCE, f"{AUDIENCE}/"):
            with self.subTest(audience):
                credential = Credential()
                broker = Broker("http://127.0.0.1:9", audience, credential, clock=self.clock, sleep=self._sleep)
                with self.assertRaises(AzureUnavailable):
                    await broker.token_for(NONCE)
                self.assertEqual(credential.scopes, [(f"{AUDIENCE}/.default",)])

    async def test_the_token_is_kept_per_nonce_until_five_minutes_before_it_ends(self):
        other = "o" * 43
        fake, broker = self.broker_for(granted("first"), granted("second"), granted("third"))
        steps = [
            ("first ask", 0, NONCE, "first", 1),
            ("held", 600, NONCE, "first", 1),
            ("just before the margin", 3299, NONCE, "first", 1),
            ("another task has its own", 3299, other, "second", 2),
            ("margin reached", 3300, NONCE, "third", 3),
        ]
        for label, at, nonce, expected, calls in steps:
            with self.subTest(label):
                self.clock.now = NOW + at

                self.assertEqual(await broker.token_for(nonce), expected)
                self.assertEqual(len(fake.requests), calls)

    async def test_cached_serves_the_token_until_it_expires_and_never_asks(self):
        fake, broker = self.broker_for(granted(lasts=600))
        self.assertIsNone(broker.cached(NONCE))
        await broker.token_for(NONCE)

        for label, at, expected in [("held", 599, USER_TOKEN), ("expired", 600, None)]:
            with self.subTest(label):
                self.clock.now = NOW + at

                self.assertEqual(broker.cached(NONCE), expected)
        self.assertIsNone(broker.cached("someone-else"))
        self.assertIsNone(broker.cached(None))
        self.assertEqual(len(fake.requests), 1)

    async def test_a_token_that_is_short_lived_is_not_asked_for_again_at_every_call(self):
        fake, broker = self.broker_for(granted("short", lasts=200), granted("next", lasts=3600))
        await broker.token_for(NONCE)

        for label, at, expected, calls in [("held for a while", 20, "short", 1), ("asked again", 31, "next", 2)]:
            with self.subTest(label):
                self.clock.now = NOW + at

                self.assertEqual(await broker.token_for(NONCE), expected)
                self.assertEqual(len(fake.requests), calls)

    async def test_a_failed_refresh_keeps_serving_the_held_token_until_it_expires(self):
        fake, broker = self.broker_for(granted(lasts=600), refused(503, "token_unavailable", True))
        await broker.token_for(NONCE)

        self.clock.now = NOW + 400
        self.assertEqual(await broker.token_for(NONCE), USER_TOKEN)
        self.clock.now = NOW + 600
        with self.assertRaises(AzureUnavailable):
            await broker.token_for(NONCE)

    async def test_each_broker_answer_leads_to_its_reason_and_its_retries(self):
        retried = len(BACKOFF_SECONDS) + 1
        cases = [
            ("task ended", refused(404, "unknown_task"), "does not know this Task any more", 1),
            ("agent identity refused", refused(403, "forbidden"), "does not accept the agent's identity", 1),
            ("agent token refused", refused(401, "unauthenticated"), "did not accept the agent identity's token", 1),
            ("bad nonce", refused(400, "invalid_nonce"), "refused the Task's nonce", 1),
            ("sign in again", refused(401, "interaction_required"), "must sign in again", 1),
            ("consent", refused(403, "consent_required"), "administrator must grant consent", 1),
            ("exchange refused", refused(502, "token_exchange_failed"), "refused to give this Task a token", 1),
            ("rate limited", refused(429, "rate_limited", True), "limiting token requests", retried),
            ("exchange unavailable", refused(503, "token_unavailable", True), "unavailable right now", retried),
            ("identity not configured", refused(503, "agent_identity_not_configured", True), "deploy script has to run again", retried),
            ("server error without an error body", (500, b"<html>oops</html>"), "answered HTTP 500", retried),
            ("server error that says do not retry", refused(500, "token_unavailable", False), "unavailable right now", 1),
            ("refusal that is not the broker's", (403, b"egress denied"), "answered HTTP 403", 1),
            ("answer without a token", (200, {"expiresOn": NOW + 600}), "malformed", 1),
            ("answer that is already expired", (200, {"accessToken": "t", "expiresOn": NOW - 1}), "malformed", 1),
        ]
        for label, answer, reason, calls in cases:
            with self.subTest(label):
                self.sleeps.clear()
                fake, broker = self.broker_for(answer)

                with self.assertRaises(AzureUnavailable) as failure:
                    await broker.token_for(NONCE)

                self.assertIn(reason, str(failure.exception))
                self.assertEqual(len(fake.requests), calls)
                self.assertEqual(self.sleeps, list(BACKOFF_SECONDS[: calls - 1]))

    async def test_a_transient_failure_that_clears_returns_the_token(self):
        fake, broker = self.broker_for(refused(429, "rate_limited", True), refused(503, "token_unavailable", True), granted())

        self.assertEqual(await broker.token_for(NONCE), USER_TOKEN)
        self.assertEqual(len(fake.requests), 3)
        self.assertEqual(self.sleeps, [1.0, 2.0])

    async def test_a_web_app_that_cannot_be_reached_is_retried_then_reported(self):
        broker = Broker("http://127.0.0.1:9", AUDIENCE, self.credential, clock=self.clock, sleep=self._sleep)

        with self.assertRaises(AzureUnavailable) as failure:
            await broker.token_for(NONCE)

        self.assertIn("could not be reached", str(failure.exception))
        self.assertEqual(self.sleeps, list(BACKOFF_SECONDS))

    async def _sleep(self, seconds):
        self.sleeps.append(seconds)

    async def test_a_redirect_is_not_followed_so_the_identity_token_stays_with_the_web_app(self):
        elsewhere = FakeBroker(granted())
        self.addCleanup(elsewhere.close)
        fake, broker = self.broker_for((302, f"{elsewhere.url}/steal"))

        with self.assertRaises(AzureUnavailable) as failure:
            await broker.token_for(NONCE)

        self.assertIn("answered HTTP 302", str(failure.exception))
        self.assertEqual(elsewhere.requests, [])

    async def test_a_task_without_a_nonce_never_reaches_the_broker(self):
        for nonce in (None, ""):
            with self.subTest(repr(nonce)):
                fake, broker = self.broker_for(granted())

                with self.assertRaises(AzureUnavailable) as failure:
                    await broker.token_for(nonce)

                self.assertEqual(failure.exception.code, "no_nonce")
                self.assertEqual(fake.requests, [])

    async def test_an_agent_identity_that_cannot_get_a_token_is_named_by_type_only(self):
        self.credential.error = ClientAuthenticationError("details with endpoint http://169.254.0.1 and a secret")
        fake, broker = self.broker_for(granted())

        with self.assertRaises(AzureUnavailable) as failure:
            await broker.token_for(NONCE)

        self.assertIn("ClientAuthenticationError", str(failure.exception))
        self.assertNotIn("secret", str(failure.exception))
        self.assertEqual(fake.requests, [])

    async def test_no_token_and_no_nonce_reaches_a_log_line_or_an_exception(self):
        cases = [
            ("success", [granted()]),
            ("refused", [refused(403, "consent_required")]),
            ("transient", [refused(503, "token_unavailable", True)]),
            ("not json", [(500, f"{USER_TOKEN} {NONCE} {AGENT_TOKEN}".encode())]),
        ]
        for label, answers in cases:
            with self.subTest(label):
                self.records.lines.clear()
                fake, broker = self.broker_for(*answers)
                shown = []

                try:
                    await broker.token_for(NONCE)
                except AzureUnavailable as failure:
                    shown += [str(failure), repr(failure), failure.reason, failure.code]

                for line in [*self.records.lines, *shown]:
                    for secret in (NONCE, AGENT_TOKEN, USER_TOKEN):
                        self.assertNotIn(secret, line)

    async def test_expired_entries_leave_the_cache_when_another_task_asks(self):
        other = "o" * 43
        fake, broker = self.broker_for(granted("first", lasts=600), granted("second"))
        await broker.token_for(NONCE)
        self.clock.now = NOW + 700

        await broker.token_for(other)

        self.assertEqual(list(broker._held), [other])


class SecureUrlTests(unittest.TestCase):
    def test_a_bearer_token_goes_over_https_or_to_this_machine_only(self):
        cases = [
            ("https", "https://app.example.net", True),
            ("https with path", "https://app.example.net/", True),
            ("localhost", "http://localhost:8000", True),
            ("loopback", "http://127.0.0.1:8000", True),
            ("loopback v6", "http://[::1]:8000", True),
            ("plain http elsewhere", "http://app.example.net", False),
            ("another scheme", "ftp://app.example.net", False),
            ("no host", "https://", False),
            ("empty", "", False),
            ("not a url", "app.example.net", False),
        ]
        for label, url, allowed in cases:
            with self.subTest(label):
                if allowed:
                    self.assertEqual(secure_url(url, "WEB_APP_URL"), url)
                else:
                    with self.assertRaises(ValueError) as failure:
                        secure_url(url, "WEB_APP_URL")
                    self.assertIn("WEB_APP_URL", str(failure.exception))

    def test_the_broker_refuses_an_insecure_address(self):
        with self.assertRaises(ValueError):
            Broker("http://app.example.net", AUDIENCE, Credential())


class BearerCommandTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()

    async def test_the_command_output_is_the_token_and_it_is_held_for_ten_minutes(self):
        command = BearerCommand(f"{sys.executable} -c \"import time; print('dev-token-' + str(time.monotonic_ns()))\"", clock=self.clock)
        first = await command.token_for(None)

        for label, at, same in [("held", 599, True), ("run again", 600, False)]:
            with self.subTest(label):
                self.clock.now = NOW + at

                self.assertEqual(await command.token_for("any nonce") == first, same)
        self.assertTrue(first.startswith("dev-token-"))
        self.assertEqual(command.cached(None), await command.token_for(None))

    async def test_a_command_that_fails_or_prints_nothing_is_reported_without_its_output(self):
        cases = [
            ("exit code", [sys.executable, "-c", "import sys; print('secret-output'); sys.exit(3)"], "exited with 3"),
            ("no output", [sys.executable, "-c", "pass"], "printed no token"),
            ("missing program", ["/no/such/program"], "could not run"),
        ]
        for label, argv, reason in cases:
            with self.subTest(label):
                command = BearerCommand(shlex.join(argv), clock=self.clock)

                with self.assertRaises(AzureUnavailable) as failure:
                    await command.token_for(None)

                self.assertIn(reason, str(failure.exception))
                self.assertNotIn("secret-output", str(failure.exception))
                self.assertIsNone(command.cached(None))

    def test_an_empty_command_is_refused(self):
        with self.assertRaises(ValueError):
            BearerCommand("   ")


class TokenSourceTests(unittest.TestCase):
    SETTINGS = {"WEB_APP_URL": "https://web.example.net", "WEB_API_AUDIENCE": AUDIENCE}

    def test_the_hosted_agent_uses_the_broker(self):
        source = token_source({**self.SETTINGS, "FOUNDRY_AGENT_NAME": "health-model-agent"}, Credential())

        self.assertIsInstance(source, Broker)

    def test_the_override_replaces_the_broker_on_a_developer_machine(self):
        for label, env in [("with the broker settings", {**self.SETTINGS}), ("without them", {})]:
            with self.subTest(label):
                source = token_source({**env, "MCP_BEARER_COMMAND": "az account get-access-token"}, Credential())

                self.assertIsInstance(source, BearerCommand)

    def test_a_hosted_agent_refuses_the_override(self):
        with self.assertRaises(RuntimeError) as failure:
            token_source({**self.SETTINGS, "MCP_BEARER_COMMAND": "echo token", "FOUNDRY_AGENT_NAME": "health-model-agent"}, Credential())

        self.assertIn("MCP_BEARER_COMMAND", str(failure.exception))
        self.assertIn("FOUNDRY_AGENT_NAME", str(failure.exception))

    def test_a_missing_setting_is_named(self):
        for missing in self.SETTINGS:
            with self.subTest(missing):
                env = {name: value for name, value in self.SETTINGS.items() if name != missing}

                with self.assertRaises(RuntimeError) as failure:
                    token_source(env, Credential())

                self.assertIn(missing, str(failure.exception))


if __name__ == "__main__":
    unittest.main()
