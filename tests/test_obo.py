import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError, ServiceRequestError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import config  # noqa: E402
import obo  # noqa: E402
from auth import Caller  # noqa: E402

OID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SCOPE = "api://mcp-client/Mcp.Tools.ReadWrite"
OTHER_SCOPE = "https://graph.microsoft.com/.default"
CLAIMS = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}'
SECRETS = ("assertion-one", "assertion-two", "issued-token", "tampered-token", CLAIMS)


class Clock:
    def __init__(self, now=1_000_000):
        self.now = now

    def __call__(self):
        return self.now


class Application:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def acquire_token_on_behalf_of(self, assertion, scopes, claims_challenge=None):
        self.calls.append((assertion, scopes, claims_challenge))
        result = self.results.pop(0) if self.results else {"access_token": f"token-{len(self.calls)}", "expires_in": 3600}
        if isinstance(result, Exception):
            raise result
        return result


def granted(token="issued-token", expires_in=3600):
    return {"access_token": token, "expires_in": expires_in}


def exchanger(*results, clock=None):
    application = Application(*results)
    return obo.OnBehalfOf(lambda: application, clock or Clock()), application


class FailureTests(unittest.TestCase):
    def test_refusals_map_to_the_failure_the_caller_can_act_on(self):
        cases = [
            ("consent by error", {"error": "consent_required"}, obo.ConsentRequired, None),
            ("consent by suberror", {"error": "invalid_grant", "suberror": "consent_required"}, obo.ConsentRequired, None),
            ("consent by code", {"error": "invalid_grant", "error_codes": [65001]}, obo.ConsentRequired, None),
            (
                "consent by description",
                {"error": "invalid_grant", "error_description": "AADSTS65001: The user or administrator has not consented"},
                obo.ConsentRequired,
                None,
            ),
            ("consent wins over claims", {"error": "invalid_grant", "error_codes": [65001], "claims": CLAIMS}, obo.ConsentRequired, None),
            ("interaction by error", {"error": "interaction_required"}, obo.InteractionRequired, None),
            ("interaction by claims", {"error": "invalid_grant", "claims": CLAIMS}, obo.InteractionRequired, CLAIMS),
            ("interaction with claims by error", {"error": "interaction_required", "claims": CLAIMS}, obo.InteractionRequired, CLAIMS),
            ("an empty claims challenge", {"error": "interaction_required", "claims": ""}, obo.InteractionRequired, None),
            ("interaction by basic_action", {"error": "invalid_grant", "suberror": "basic_action"}, obo.InteractionRequired, None),
            ("interaction by additional_action", {"error": "invalid_grant", "suberror": "additional_action"}, obo.InteractionRequired, None),
            ("interaction by message_only", {"error": "invalid_grant", "suberror": "message_only"}, obo.InteractionRequired, None),
            ("interaction by expired password", {"error": "invalid_grant", "suberror": "user_password_expired"}, obo.InteractionRequired, None),
            ("interaction by multi factor code", {"error": "invalid_grant", "error_codes": [50076]}, obo.InteractionRequired, None),
            ("interaction by registration code", {"error": "invalid_grant", "error_codes": [50079]}, obo.InteractionRequired, None),
            ("interaction by conditional access code", {"error": "invalid_grant", "error_codes": [50158]}, obo.InteractionRequired, None),
            ("interaction by device code", {"error": "invalid_grant", "error_codes": [500133]}, obo.InteractionRequired, None),
        ]
        for label, result, kind, claims in cases:
            with self.subTest(label=label):
                failure = obo.failure_for(result)

                self.assertIsInstance(failure, kind)
                if kind is obo.InteractionRequired:
                    self.assertEqual(failure.claims, claims)

    def test_every_other_refusal_is_an_authentication_error_without_the_server_text(self):
        cases = [
            ("a bad client", {"error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret"}, "invalid_client"),
            ("an invalid assertion", {"error": "invalid_grant", "error_codes": [50013]}, "invalid_grant"),
            ("an unknown error", {"error": "something_new"}, "something_new"),
            ("nothing", {}, "unknown"),
        ]
        for label, result, named in cases:
            with self.subTest(label=label):
                failure = obo.failure_for(result)

                self.assertIsInstance(failure, ClientAuthenticationError)
                self.assertEqual(failure.status_code, 401)
                self.assertIn(named, str(failure))
                self.assertNotIn("AADSTS", str(failure))


class ExchangeTests(unittest.TestCase):
    def test_an_assertion_is_exchanged_for_the_scope_and_the_token_expires_as_issued(self):
        clock = Clock(5000)
        on_behalf_of, application = exchanger(granted("issued-token", 1800), clock=clock)

        token = on_behalf_of.exchange("assertion-one", [SCOPE])

        self.assertEqual(token, AccessToken("issued-token", 5000 + 1800))
        self.assertEqual(application.calls, [("assertion-one", [SCOPE], None)])

    def test_a_token_is_reused_until_it_is_close_to_expiry(self):
        margin = config.OBO_EXPIRY_MARGIN_SECONDS
        cases = [
            ("right away", 0, 1),
            ("half way", 1800, 1),
            ("one second before the margin", 3600 - margin - 1, 1),
            ("at the margin", 3600 - margin, 2),
            ("inside the margin", 3600 - margin + 1, 2),
            ("after expiry", 3601, 2),
        ]
        for label, elapsed, exchanges in cases:
            with self.subTest(label=label):
                clock = Clock()
                on_behalf_of, application = exchanger(clock=clock)
                on_behalf_of.exchange("assertion-one", [SCOPE])
                clock.now += elapsed

                again = on_behalf_of.exchange("assertion-one", [SCOPE])

                self.assertEqual(len(application.calls), exchanges)
                self.assertEqual(again.token, f"token-{exchanges}")

    def test_tokens_are_kept_per_assertion_and_per_scope(self):
        cases = [
            ("the same assertion and scope", ("assertion-one", [SCOPE]), 1),
            ("another assertion", ("assertion-two", [SCOPE]), 2),
            ("another scope", ("assertion-one", [OTHER_SCOPE]), 2),
            ("more scopes", ("assertion-one", [SCOPE, OTHER_SCOPE]), 2),
        ]
        for label, (assertion, scopes), exchanges in cases:
            with self.subTest(label=label):
                on_behalf_of, application = exchanger()
                on_behalf_of.exchange("assertion-one", [SCOPE])

                on_behalf_of.exchange(assertion, scopes)

                self.assertEqual(len(application.calls), exchanges)

    def test_scopes_may_come_as_any_sequence(self):
        on_behalf_of, application = exchanger()

        on_behalf_of.exchange("assertion-one", (SCOPE,))
        on_behalf_of.exchange("assertion-one", [SCOPE])

        self.assertEqual(len(application.calls), 1)
        self.assertEqual(application.calls[0][1], [SCOPE])

    def test_a_claims_challenge_bypasses_the_cache_and_is_not_stored(self):
        on_behalf_of, application = exchanger(granted("first"), granted("challenged"), granted("unused"))
        first = on_behalf_of.exchange("assertion-one", [SCOPE])

        challenged = on_behalf_of.exchange("assertion-one", [SCOPE], CLAIMS)
        after = on_behalf_of.exchange("assertion-one", [SCOPE])

        self.assertEqual((first.token, challenged.token, after.token), ("first", "challenged", "first"))
        self.assertEqual([call[2] for call in application.calls], [None, CLAIMS])

    def test_the_cache_keeps_the_most_recently_used_tokens_within_its_bound(self):
        with mock.patch.object(obo, "OBO_TOKEN_CACHE_SIZE", 2):
            on_behalf_of, application = exchanger()
            on_behalf_of.exchange("a", [SCOPE])
            on_behalf_of.exchange("b", [SCOPE])
            on_behalf_of.exchange("a", [SCOPE])
            on_behalf_of.exchange("c", [SCOPE])

            on_behalf_of.exchange("a", [SCOPE])
            kept = len(application.calls)
            on_behalf_of.exchange("b", [SCOPE])

        self.assertEqual(kept, 3)
        self.assertEqual(len(application.calls), 4)
        self.assertLessEqual(len(on_behalf_of._tokens), 2)

    def test_an_expired_entry_is_dropped_when_it_is_found(self):
        clock = Clock()
        on_behalf_of, _ = exchanger(clock=clock)
        on_behalf_of.exchange("assertion-one", [SCOPE])
        clock.now += 3600

        on_behalf_of.exchange("assertion-two", [SCOPE])
        on_behalf_of.exchange("assertion-one", [SCOPE])

        self.assertEqual(len(on_behalf_of._tokens), 2)

    def test_a_token_without_a_lifetime_is_not_reused(self):
        on_behalf_of, application = exchanger({"access_token": "short"}, granted("fresh"))

        first = on_behalf_of.exchange("assertion-one", [SCOPE])
        second = on_behalf_of.exchange("assertion-one", [SCOPE])

        self.assertEqual((first.token, second.token, len(application.calls)), ("short", "fresh", 2))

    def test_refusals_raise_their_typed_failure_and_nothing_is_cached(self):
        cases = [
            ("interaction", {"error": "interaction_required", "claims": CLAIMS}, obo.InteractionRequired),
            ("consent", {"error": "invalid_grant", "error_codes": [65001]}, obo.ConsentRequired),
            ("another refusal", {"error": "invalid_client"}, ClientAuthenticationError),
        ]
        for label, refusal, kind in cases:
            with self.subTest(label=label):
                on_behalf_of, application = exchanger(refusal, granted())

                with self.assertLogs("ahm-demo", level="WARNING"):
                    with self.assertRaises(kind):
                        on_behalf_of.exchange("assertion-one", [SCOPE])
                token = on_behalf_of.exchange("assertion-one", [SCOPE])

                self.assertEqual(token.token, "issued-token")
                self.assertEqual(len(application.calls), 2)

    def test_an_exception_from_the_library_becomes_a_service_error_without_its_text(self):
        for label, error in [
            ("a runtime error", RuntimeError("tampered-token leaked")),
            ("a value error", ValueError("assertion-one")),
            ("a timeout", TimeoutError("slow")),
        ]:
            with self.subTest(label=label):
                on_behalf_of, _ = exchanger(error)

                with self.assertLogs("ahm-demo", level="WARNING"):
                    with self.assertRaises(ServiceRequestError) as caught:
                        on_behalf_of.exchange("assertion-one", [SCOPE])

                self.assertIs(type(caught.exception.__cause__), type(error))
                self.assertNotIn("leaked", str(caught.exception))
                self.assertNotIn("assertion-one", str(caught.exception))

    def test_nothing_secret_reaches_the_log(self):
        cases = [
            ("a refusal", {"error": "interaction_required", "claims": CLAIMS, "error_description": "tampered-token"}),
            ("an exception", RuntimeError("tampered-token assertion-one")),
        ]
        for label, outcome in cases:
            with self.subTest(label=label):
                on_behalf_of, _ = exchanger(outcome)

                with self.assertLogs("ahm-demo", level="WARNING") as logged:
                    with self.assertRaises(Exception):
                        on_behalf_of.exchange("assertion-one", [SCOPE])

                text = "\n".join(logged.output)
                for secret in SECRETS + ("tampered-token",):
                    self.assertNotIn(secret, text)

    def test_a_successful_exchange_logs_nothing(self):
        on_behalf_of, _ = exchanger()

        with self.assertNoLogs("ahm-demo", level="DEBUG"):
            on_behalf_of.exchange("assertion-one", [SCOPE])


class ApplicationTests(unittest.TestCase):
    def test_the_application_is_built_on_first_use_and_only_once(self):
        built = []

        def factory():
            built.append(1)
            return Application()

        on_behalf_of = obo.OnBehalfOf(factory, Clock())
        self.assertEqual(built, [])

        for assertion in ("assertion-one", "assertion-two", "assertion-one"):
            on_behalf_of.exchange(assertion, [SCOPE])

        self.assertEqual(len(built), 1)

    def test_a_failed_start_is_a_service_error_that_a_later_call_retries(self):
        attempts = []

        def factory():
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError("authority unreachable assertion-one")
            return Application()

        on_behalf_of = obo.OnBehalfOf(factory, Clock())

        with self.assertLogs("ahm-demo", level="WARNING") as logged:
            with self.assertRaises(ServiceRequestError) as caught:
                on_behalf_of.exchange("assertion-one", [SCOPE])
        token = on_behalf_of.exchange("assertion-one", [SCOPE])

        self.assertNotIn("assertion-one", str(caught.exception))
        self.assertNotIn("assertion-one", "\n".join(logged.output))
        self.assertEqual((len(attempts), token.token), (2, "token-1"))

    def test_concurrent_first_calls_build_one_application(self):
        built = []
        gate = threading.Event()

        def factory():
            built.append(1)
            gate.wait(1)
            return Application()

        on_behalf_of = obo.OnBehalfOf(factory, Clock())
        workers = [threading.Thread(target=on_behalf_of.exchange, args=(f"assertion-{n}", [SCOPE])) for n in range(4)]
        for worker in workers:
            worker.start()
        gate.set()
        for worker in workers:
            worker.join(5)

        self.assertEqual(len(built), 1)


class CredentialTests(unittest.TestCase):
    def test_a_caller_credential_exchanges_the_callers_assertion(self):
        on_behalf_of, application = exchanger()
        caller = Caller(OID, "Ada", "assertion-one")

        credential = on_behalf_of.credential(caller)
        token = credential.get_token(SCOPE, OTHER_SCOPE)
        credential.get_token(SCOPE, claims=CLAIMS, tenant_id="ignored")

        self.assertEqual(token.token, "token-1")
        self.assertEqual(
            application.calls,
            [("assertion-one", [SCOPE, OTHER_SCOPE], None), ("assertion-one", [SCOPE], CLAIMS)],
        )

    def test_the_arm_scope_the_sdk_asks_for_is_exchanged_as_the_exact_delegated_scope(self):
        default, exact = config.ARM_DEFAULT_SCOPE, config.ARM_DELEGATED_SCOPE
        cases = [
            ("the arm default", (default,), [exact]),
            ("the exact delegated scope", (exact,), [exact]),
            ("the mcp scope", (SCOPE,), [SCOPE]),
            ("another default scope", ("https://graph.microsoft.com/.default",), ["https://graph.microsoft.com/.default"]),
            ("the arm default beside another scope", (default, SCOPE), [exact, SCOPE]),
        ]
        for label, asked, exchanged in cases:
            with self.subTest(label=label):
                on_behalf_of, application = exchanger()

                on_behalf_of.credential(Caller(OID, "Ada", "assertion-one")).get_token(*asked)

                self.assertEqual(application.calls, [("assertion-one", exchanged, None)])

    def test_the_default_and_the_exact_arm_scope_share_one_exchange(self):
        on_behalf_of, application = exchanger()
        credential = on_behalf_of.credential(Caller(OID, "Ada", "assertion-one"))

        credential.get_token(config.ARM_DEFAULT_SCOPE)
        credential.get_token(config.ARM_DELEGATED_SCOPE)

        self.assertEqual(len(application.calls), 1)

    def test_credentials_of_different_callers_never_share_tokens(self):
        on_behalf_of, application = exchanger()

        one = on_behalf_of.credential(Caller(OID, "Ada", "assertion-one")).get_token(SCOPE)
        two = on_behalf_of.credential(Caller("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Bob", "assertion-two")).get_token(SCOPE)

        self.assertNotEqual(one.token, two.token)
        self.assertEqual([call[0] for call in application.calls], ["assertion-one", "assertion-two"])

    def test_the_developer_credential_serves_every_caller(self):
        shared = object()
        developer = obo.Developer(shared)

        for caller in (Caller("local", "Local", ""), Caller(OID, "Ada", "assertion-one")):
            with self.subTest(caller=caller.oid):
                self.assertIs(developer.credential(caller), shared)


class FactoryTests(unittest.TestCase):
    def test_the_application_is_a_confidential_client_proved_by_the_managed_identity(self):
        identity = mock.Mock()
        identity.get_token.return_value = SimpleNamespace(token="federated-assertion")
        with mock.patch("msal.ConfidentialClientApplication") as application, mock.patch(
            "azure.identity.ManagedIdentityCredential", return_value=identity
        ) as managed:
            built = obo.application_factory("tenant-id", "client-id", "identity-client-id")()

        self.assertIs(built, application.return_value)
        managed.assert_called_once_with(client_id="identity-client-id")
        args, kwargs = application.call_args
        self.assertEqual(args, ("client-id",))
        self.assertEqual(kwargs["authority"], "https://login.microsoftonline.com/tenant-id")
        self.assertEqual(set(kwargs["client_credential"]), {"client_assertion"})
        self.assertEqual(kwargs["client_credential"]["client_assertion"](), "federated-assertion")
        identity.get_token.assert_called_once_with(config.TOKEN_EXCHANGE_SCOPE)

    def test_nothing_is_imported_or_created_until_the_factory_runs(self):
        with mock.patch("msal.ConfidentialClientApplication") as application, mock.patch(
            "azure.identity.ManagedIdentityCredential"
        ) as managed:
            obo.application_factory("tenant-id", "client-id", "identity-client-id")

        application.assert_not_called()
        managed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
