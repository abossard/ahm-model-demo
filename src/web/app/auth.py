import hashlib
import time
from dataclasses import dataclass, field

import jwt
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError

from config import GUID, LOCAL_NAME, LOCAL_OID, MAX_TOKEN_CHARS, TOKEN_LEEWAY_SECONDS


@dataclass(frozen=True)
class Caller:
    oid: str
    name: str
    assertion: str = field(repr=False)

    @property
    def fingerprint(self):
        return hashlib.sha256(self.assertion.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class TokenRules:
    tenant_id: str
    client_id: str
    scope: str

    @property
    def issuer(self):
        return f"https://login.microsoftonline.com/{self.tenant_id}/v2.0"

    @property
    def audiences(self):
        return {self.client_id.casefold(), f"api://{self.client_id}".casefold()}


class Unauthenticated(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class AuthUnavailable(Exception):
    pass


LOCAL_CALLER = Caller(oid=LOCAL_OID, name=LOCAL_NAME, assertion="")


def bearer_token(header):
    parts = (header or "").split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1] or len(parts[1]) > MAX_TOKEN_CHARS:
        raise Unauthenticated("malformed")
    return parts[1]


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def check_claims(claims, rules, now, delegated):
    if claims.get("iss") != rules.issuer:
        raise Unauthenticated("issuer")
    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if not rules.audiences & {a.casefold() for a in audiences if isinstance(a, str)}:
        raise Unauthenticated("audience")
    tenant = claims.get("tid")
    if not isinstance(tenant, str) or tenant.casefold() != rules.tenant_id.casefold():
        raise Unauthenticated("tenant")
    expires = claims.get("exp")
    if not is_number(expires):
        raise Unauthenticated("claims")
    if now > expires + TOKEN_LEEWAY_SECONDS:
        raise Unauthenticated("expired")
    not_before = claims.get("nbf")
    if not_before is not None and (not is_number(not_before) or now + TOKEN_LEEWAY_SECONDS < not_before):
        raise Unauthenticated("not_yet_valid")
    oid = claims.get("oid")
    if not isinstance(oid, str) or not GUID.fullmatch(oid):
        raise Unauthenticated("claims")
    scopes = claims.get("scp")
    if delegated:
        if claims.get("idtyp") == "app" or (scopes is None and "roles" in claims):
            raise Unauthenticated("app_only")
        if not isinstance(scopes, str) or rules.scope not in scopes.split():
            raise Unauthenticated("scope")
    elif scopes is not None or claims.get("idtyp", "app") != "app":
        raise Unauthenticated("not_app_only")
    name = claims.get("name") or claims.get("preferred_username")
    return oid.casefold(), name if isinstance(name, str) else ""


def read_claims(token, key):
    try:
        return jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            options={
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
                "verify_aud": False,
                "verify_iss": False,
            },
        )
    except PyJWTError as error:
        raise Unauthenticated("signature") from error


class Authenticator:
    def __init__(self, rules, keys, clock=time.time):
        self._rules = rules
        self._keys = keys
        self._clock = clock

    def verify(self, header, delegated):
        token = bearer_token(header)
        try:
            key = self._keys.get_signing_key_from_jwt(token).key
        except PyJWKClientConnectionError as error:
            raise AuthUnavailable() from error
        except (PyJWKClientError, PyJWTError) as error:
            raise Unauthenticated("key") from error
        claims = read_claims(token, key)
        oid, name = check_claims(claims, self._rules, self._clock(), delegated)
        return Caller(oid=oid, name=name, assertion=token)

    def user(self, header):
        return self.verify(header, delegated=True)

    def agent(self, header):
        return self.verify(header, delegated=False)


def signing_keys(tenant_id):
    return jwt.PyJWKClient(
        f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys",
        cache_keys=True,
        max_cached_keys=16,
        cache_jwk_set=True,
        lifespan=3600,
        timeout=10,
        cooldown_duration=30,
    )
