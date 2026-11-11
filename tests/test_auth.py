import dataclasses
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.error import URLError

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import auth  # noqa: E402
import config  # noqa: E402

TENANT = "3a3a3a3a-3a3a-3a3a-3a3a-3a3a3a3a3a3a"
OTHER_TENANT = "55555555-5555-5555-5555-555555555555"
CLIENT = "44444444-4444-4444-4444-444444444444"
OID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
NOW = 1_800_000_000
RULES = auth.TokenRules(TENANT, CLIENT, "access_as_user")
PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def issuer_of(tenant):
    return f"https://login.microsoftonline.com/{tenant}/v2.0"


def claims(**changes):
    base = {
        "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0",
        "aud": CLIENT,
        "tid": TENANT,
        "oid": OID,
        "sub": "pairwise-subject",
        "name": "Ada Lovelace",
        "scp": "access_as_user",
        "exp": NOW + 3600,
        "nbf": NOW - 60,
        "iat": NOW - 60,
        "ver": "2.0",
    }
    base.update(changes)
    return {name: value for name, value in base.items() if value is not None}


def mint(payload=None, key=PRIVATE, kid="k1", algorithm="RS256"):
    return jwt.encode(payload if payload is not None else claims(), key, algorithm=algorithm, headers={"kid": kid})


class FakeKeys:
    def __init__(self, known=("k1",), error=None):
        self.known = known
        self.error = error
        self.asked = []

    def get_signing_key_from_jwt(self, token):
        self.asked.append(token)
        if self.error:
            raise self.error
        kid = jwt.get_unverified_header(token).get("kid")
        if kid not in self.known:
            raise PyJWKClientError(f"no key {kid}")
        return SimpleNamespace(key=PRIVATE.public_key())


class Opener:
    def __init__(self, kids=("k1",), error=None):
        self.kids = kids
        self.error = error
        self.fetches = 0

    def open(self, request, timeout=None):
        self.fetches += 1
        if self.error:
            raise self.error
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(PRIVATE.public_key(), as_dict=True)
        keys = [{**jwk, "kid": kid, "use": "sig", "alg": "RS256"} for kid in self.kids]
        return io.BytesIO(json.dumps({"keys": keys}).encode())


def key_endpoint(opener):
    return mock.patch("jwt.jwks_client.urllib.request.build_opener", return_value=opener)


def authenticator(keys=None):
    return auth.Authenticator(RULES, keys or FakeKeys(), clock=lambda: NOW)


class ClaimRuleTests(unittest.TestCase):
    def test_every_rule_refuses_a_user_token_with_its_reason(self):
        cases = [
            ("a v1 issuer", {"iss": f"https://sts.windows.net/{TENANT}/"}, "issuer"),
            ("another tenant's issuer", {"iss": "https://login.microsoftonline.com/55555555-5555-5555-5555-555555555555/v2.0"}, "issuer"),
            ("the issuer without a version", {"iss": f"https://login.microsoftonline.com/{TENANT}/"}, "issuer"),
            ("no issuer", {"iss": None}, "issuer"),
            ("another audience", {"aud": "66666666-6666-6666-6666-666666666666"}, "audience"),
            ("another api audience", {"aud": "api://66666666-6666-6666-6666-666666666666"}, "audience"),
            ("the graph audience", {"aud": "00000003-0000-0000-c000-000000000000"}, "audience"),
            ("no audience", {"aud": None}, "audience"),
            ("a list without our audience", {"aud": ["a", "b"]}, "audience"),
            ("an audience that is no text", {"aud": 5}, "audience"),
            ("a tenant that is not the one of the issuer", {"tid": OTHER_TENANT}, "issuer"),
            ("no tenant", {"tid": None}, "tenant"),
            ("a tenant that is no guid", {"tid": "contoso"}, "tenant"),
            ("a tenant that is a number", {"tid": 7}, "tenant"),
            ("no expiry", {"exp": None}, "claims"),
            ("an expiry that is text", {"exp": "9999999999"}, "claims"),
            ("an expiry that is a flag", {"exp": True}, "claims"),
            ("an expired token", {"exp": NOW - 61}, "expired"),
            ("a token from the future", {"nbf": NOW + 61}, "not_yet_valid"),
            ("a not before that is text", {"nbf": "soon"}, "not_yet_valid"),
            ("no oid", {"oid": None}, "claims"),
            ("an oid that is no guid", {"oid": "ada"}, "claims"),
            ("an oid with a trailing newline", {"oid": OID + "\n"}, "claims"),
            ("an oid that is a number", {"oid": 7}, "claims"),
            ("no scope and no roles", {"scp": None}, "scope"),
            ("another scope", {"scp": "user_impersonation"}, "scope"),
            ("a scope that only contains ours", {"scp": "access_as_user_admin"}, "scope"),
            ("scopes as a list", {"scp": ["access_as_user"]}, "scope"),
            ("an app-only token with roles", {"scp": None, "roles": ["Task.Run"]}, "app_only"),
            ("an app-only token marked as app", {"scp": None, "idtyp": "app"}, "app_only"),
            ("a delegated claim on an app token", {"idtyp": "app"}, "app_only"),
        ]
        for label, changes, reason in cases:
            with self.subTest(label=label):
                with self.assertRaises(auth.Unauthenticated) as caught:
                    auth.check_claims(claims(**changes), RULES, NOW, delegated=True)

                self.assertEqual(caught.exception.reason, reason)

    def test_valid_user_tokens_are_accepted_in_every_allowed_shape(self):
        cases = [
            ("the client id as audience", {}),
            ("the api uri as audience", {"aud": f"api://{CLIENT}"}),
            ("the api uri in capitals", {"aud": f"API://{CLIENT.upper()}"}),
            ("a list of audiences", {"aud": ["other", CLIENT]}),
            ("more scopes", {"scp": "openid access_as_user profile"}),
            ("an expiry just inside the leeway", {"exp": NOW - 59}),
            ("an expiry exactly at the leeway", {"exp": NOW - 60}),
            ("a not before just inside the leeway", {"nbf": NOW + 59}),
            ("a not before exactly at the leeway", {"nbf": NOW + 60}),
            ("no not before", {"nbf": None}),
            ("a float expiry", {"exp": float(NOW + 10)}),
            ("a tenant in capitals", {"tid": TENANT.upper()}),
            ("an idtyp of user", {"idtyp": "user"}),
            ("the oid in capitals", {"oid": OID.upper()}),
        ]
        for label, changes in cases:
            with self.subTest(label=label):
                identity = auth.check_claims(claims(**changes), RULES, NOW, delegated=True)

                self.assertEqual(identity, (TENANT, OID, "Ada Lovelace"))

    def test_a_user_of_any_directory_is_accepted_and_named_by_the_directory_of_the_token(self):
        for label, tenant in [("a work directory", OTHER_TENANT), ("a directory in capitals", OTHER_TENANT.upper())]:
            with self.subTest(label=label):
                token = claims(tid=tenant, iss=issuer_of(OTHER_TENANT))

                self.assertEqual(auth.check_claims(token, RULES, NOW, delegated=True), (OTHER_TENANT, OID, "Ada Lovelace"))

    def test_a_directory_is_refused_for_its_own_reason_after_the_token_proved_valid(self):
        listed = auth.TokenRules(TENANT, CLIENT, "access_as_user", frozenset({OTHER_TENANT}))
        third = "66666666-6666-6666-6666-666666666666"
        cases = [
            ("a personal account", RULES, config.CONSUMERS_TENANT_ID, "personal_account"),
            ("a personal account when directories are listed", listed, config.CONSUMERS_TENANT_ID, "personal_account"),
            ("a directory that is not listed", listed, third, "tenant_not_allowed"),
            ("a listed directory", listed, OTHER_TENANT, None),
            ("the home directory, which is never left out", listed, TENANT, None),
            ("any directory when none is listed", RULES, third, None),
        ]
        for label, rules, tenant, reason in cases:
            with self.subTest(label=label):
                token = claims(tid=tenant, iss=issuer_of(tenant))
                if reason is None:
                    self.assertEqual(auth.check_claims(token, rules, NOW, delegated=True)[0], tenant)
                    continue
                with self.assertRaises(auth.TenantRefused) as caught:
                    auth.check_claims(token, rules, NOW, delegated=True)

                self.assertEqual(caught.exception.reason, reason)

    def test_a_personal_account_token_that_is_expired_or_for_another_audience_is_only_unauthenticated(self):
        for label, changes in [("expired", {"exp": NOW - 3600}), ("another audience", {"aud": "x"}), ("no scope", {"scp": None})]:
            with self.subTest(label=label):
                token = claims(tid=config.CONSUMERS_TENANT_ID, iss=issuer_of(config.CONSUMERS_TENANT_ID), **changes)

                with self.assertRaises(auth.Unauthenticated):
                    auth.check_claims(token, RULES, NOW, delegated=True)

    def test_the_name_is_optional_and_never_breaks_the_check(self):
        cases = [
            ("the name", {}, "Ada Lovelace"),
            ("the user name when there is no name", {"name": None, "preferred_username": "ada@example.test"}, "ada@example.test"),
            ("nothing", {"name": None}, ""),
            ("a name that is no text", {"name": 5}, ""),
        ]
        for label, changes, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(auth.check_claims(claims(**changes), RULES, NOW, delegated=True)[2], expected)

    def test_agent_tokens_must_be_app_only_and_pass_the_common_rules(self):
        app = {"scp": None, "roles": ["Task.Run"], "idtyp": "app", "name": None}
        cases = [
            ("an app token", app, None),
            ("an app token without optional claims", {"scp": None, "name": None}, None),
            ("a delegated user token", {}, "not_app_only"),
            ("a user token by type", {"scp": None, "idtyp": "user"}, "not_app_only"),
            ("another audience", {**app, "aud": "someone-else"}, "audience"),
            ("another tenant", {**app, "tid": OTHER_TENANT, "iss": issuer_of(OTHER_TENANT)}, "tenant"),
            ("a personal account", {**app, "tid": config.CONSUMERS_TENANT_ID, "iss": issuer_of(config.CONSUMERS_TENANT_ID)}, "tenant"),
            ("a tenant that is not the one of the issuer", {**app, "tid": OTHER_TENANT}, "issuer"),
            ("another issuer", {**app, "iss": "https://sts.windows.net/x/"}, "issuer"),
            ("an expired token", {**app, "exp": NOW - 120}, "expired"),
            ("no oid", {**app, "oid": None}, "claims"),
        ]
        for label, changes, reason in cases:
            with self.subTest(label=label):
                if reason is None:
                    self.assertEqual(auth.check_claims(claims(**changes), RULES, NOW, delegated=False)[1], OID)
                    continue
                with self.assertRaises(auth.Unauthenticated) as caught:
                    auth.check_claims(claims(**changes), RULES, NOW, delegated=False)

                self.assertEqual(caught.exception.reason, reason)


class BearerTests(unittest.TestCase):
    def test_only_a_well_formed_bearer_header_yields_a_token(self):
        cases = [
            ("a bearer token", "Bearer abc.def.ghi", "abc.def.ghi"),
            ("the scheme in capitals", "BEARER abc", "abc"),
            ("no header", None, None),
            ("an empty header", "", None),
            ("only the scheme", "Bearer", None),
            ("an empty token", "Bearer ", None),
            ("two spaces", "Bearer  abc", None),
            ("another scheme", "Basic abc", None),
            ("a token with a space", "Bearer abc def", None),
            ("the token alone", "abc", None),
            ("a token at the limit", "Bearer " + "x" * config.MAX_TOKEN_CHARS, "x" * config.MAX_TOKEN_CHARS),
            ("a token over the limit", "Bearer " + "x" * (config.MAX_TOKEN_CHARS + 1), None),
        ]
        for label, header, expected in cases:
            with self.subTest(label=label):
                if expected is None:
                    with self.assertRaises(auth.Unauthenticated) as caught:
                        auth.bearer_token(header)
                    self.assertEqual(caught.exception.reason, "malformed")
                else:
                    self.assertEqual(auth.bearer_token(header), expected)


class SignatureTests(unittest.TestCase):
    def test_a_token_signed_by_the_tenant_key_gives_a_caller(self):
        token = mint()

        caller = authenticator().user(f"Bearer {token}")

        self.assertEqual((caller.oid, caller.name, caller.assertion), (OID, "Ada Lovelace", token))

    def test_tokens_that_are_not_signed_by_a_known_key_are_refused(self):
        valid = mint()
        header, payload, signature = valid.split(".")
        tampered = claims(oid="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        cases = [
            ("a forged signature with the same key id", mint(key=OTHER_PRIVATE), "signature"),
            ("a tampered payload", ".".join([header, mint(tampered).split(".")[1], signature]), "signature"),
            ("a cut signature", ".".join([header, payload, signature[:-6]]), "signature"),
            ("a symmetric signature made with the public key", mint(key="secret-" * 8, algorithm="HS256"), "signature"),
            ("no signature algorithm", jwt.encode(claims(), None, algorithm="none", headers={"kid": "k1"}), "signature"),
            ("a key id nobody knows", mint(kid="unknown"), "key"),
            ("no key id", jwt.encode(claims(), PRIVATE, algorithm="RS256"), "key"),
            ("text that is no token", "not-a-token", "key"),
            ("two parts", "aaa.bbb", "key"),
            ("garbage parts", "a.b.c", "key"),
        ]
        for label, token, reason in cases:
            with self.subTest(label=label):
                with self.assertRaises(auth.Unauthenticated) as caught:
                    authenticator().user(f"Bearer {token}")

                self.assertEqual(caught.exception.reason, reason)

    def test_a_valid_signature_does_not_excuse_bad_claims(self):
        for label, changes, reason in [
            ("expired", {"exp": NOW - 3600}, "expired"),
            ("another audience", {"aud": "x"}, "audience"),
            ("another tenant's issuer", {"tid": OTHER_TENANT}, "issuer"),
            ("no scope", {"scp": None}, "scope"),
            ("app only", {"scp": None, "roles": ["r"]}, "app_only"),
        ]:
            with self.subTest(label=label):
                with self.assertRaises(auth.Unauthenticated) as caught:
                    authenticator().user(f"Bearer {mint(claims(**changes))}")

                self.assertEqual(caught.exception.reason, reason)

    def test_the_agent_check_reads_the_same_header_and_wants_an_app_token(self):
        app = mint(claims(scp=None, idtyp="app"))

        caller = authenticator().agent(f"Bearer {app}")

        self.assertEqual(caller.oid, OID)
        with self.assertRaises(auth.Unauthenticated):
            authenticator().agent(f"Bearer {mint()}")
        with self.assertRaises(auth.Unauthenticated):
            authenticator().user(f"Bearer {app}")

    def test_an_unreachable_key_endpoint_is_not_a_bad_token(self):
        keys = FakeKeys(error=PyJWKClientConnectionError("down"))

        with self.assertRaises(auth.AuthUnavailable):
            authenticator(keys).user(f"Bearer {mint()}")

    def test_a_missing_header_never_reaches_the_keys(self):
        keys = FakeKeys()

        for header in (None, "", "Basic abc", "Bearer"):
            with self.subTest(header=header):
                with self.assertRaises(auth.Unauthenticated):
                    authenticator(keys).user(header)

        self.assertEqual(keys.asked, [])


class KeyClientTests(unittest.TestCase):
    def test_the_key_client_reads_the_common_key_set_with_bounds(self):
        client = auth.signing_keys()

        self.assertEqual(client.uri, "https://login.microsoftonline.com/common/discovery/v2.0/keys")
        self.assertEqual((client.timeout, client.cooldown_duration), (10, 30))
        self.assertIsNotNone(client.jwk_set_cache)
        self.assertTrue(hasattr(client.get_signing_key, "cache_info"))
        self.assertEqual(client.get_signing_key.cache_info().maxsize, 16)

    def test_keys_come_from_the_key_set_once_and_unknown_ones_do_not_refetch_it_within_the_cooldown(self):
        opener = Opener()
        with key_endpoint(opener):
            verifier = authenticator(auth.signing_keys())

            for _ in range(3):
                verifier.user(f"Bearer {mint()}")
            for _ in range(3):
                with self.assertRaises(auth.Unauthenticated) as caught:
                    verifier.user(f"Bearer {mint(kid='forged')}")

        self.assertEqual(caught.exception.reason, "key")
        self.assertEqual(opener.fetches, 1)

    def test_a_key_set_without_the_key_refuses_the_token(self):
        with key_endpoint(Opener(["k2"])):
            verifier = authenticator(auth.signing_keys())

            with self.assertRaises(auth.Unauthenticated) as caught:
                verifier.user(f"Bearer {mint(kid='k1')}")

        self.assertEqual(caught.exception.reason, "key")

    def test_a_down_key_endpoint_is_unavailable_and_recovers(self):
        down = Opener(error=URLError("down"))
        with key_endpoint(down):
            verifier = authenticator(auth.signing_keys())
            with self.assertRaises(auth.AuthUnavailable):
                verifier.user(f"Bearer {mint()}")
            with self.assertRaises(auth.AuthUnavailable):
                verifier.user(f"Bearer {mint()}")

        self.assertEqual(down.fetches, 2)
        with key_endpoint(Opener()):
            self.assertEqual(verifier.user(f"Bearer {mint()}").oid, OID)


class CallerTests(unittest.TestCase):
    def test_a_caller_cannot_change_and_never_prints_its_token(self):
        caller = auth.Caller("oid", "Name", "secret-assertion")

        with self.assertRaises(dataclasses.FrozenInstanceError):
            caller.oid = "other"
        self.assertNotIn("secret-assertion", repr(caller))
        self.assertNotIn("secret-assertion", str(caller))
        self.assertEqual(caller, auth.Caller("oid", "Name", "secret-assertion"))

    def test_the_fingerprint_tells_tokens_apart_without_revealing_them(self):
        one, two = auth.Caller("o", "n", "token-one"), auth.Caller("o", "n", "token-two")

        self.assertNotEqual(one.fingerprint, two.fingerprint)
        self.assertEqual(one.fingerprint, auth.Caller("x", "y", "token-one").fingerprint)
        self.assertRegex(one.fingerprint, r"^[0-9a-f]{16}$")
        self.assertNotIn("token-one", one.fingerprint)

    def test_a_user_is_keyed_by_the_directory_unless_it_is_the_one_the_app_belongs_to(self):
        cases = [
            ("the home directory keeps the object id alone", auth.Caller(OID, "n", "t", tenant_id=TENANT, in_home_tenant=True), OID),
            ("another directory adds its tenant id", auth.Caller(OID, "n", "t", tenant_id=OTHER_TENANT, in_home_tenant=False), f"{OTHER_TENANT}/{OID}"),
            ("a caller built without a directory is a home user", auth.Caller(OID, "n", "t"), OID),
        ]
        for label, caller, owner in cases:
            with self.subTest(label=label):
                self.assertEqual(caller.owner, owner)

    def test_the_same_object_id_in_two_directories_is_two_users(self):
        home = authenticator().user(f"Bearer {mint()}")
        other = authenticator().user(f"Bearer {mint(claims(tid=OTHER_TENANT, iss=issuer_of(OTHER_TENANT)))}")

        self.assertEqual((home.oid, other.oid), (OID, OID))
        self.assertEqual((home.tenant_id, other.tenant_id), (TENANT, OTHER_TENANT))
        self.assertEqual((home.in_home_tenant, other.in_home_tenant), (True, False))
        self.assertNotEqual(home.owner, other.owner)

    def test_the_local_caller_is_fixed(self):
        self.assertEqual((auth.LOCAL_CALLER.oid, auth.LOCAL_CALLER.assertion), ("local", ""))
        self.assertEqual(auth.LOCAL_CALLER.name, config.LOCAL_NAME)


if __name__ == "__main__":
    unittest.main()
