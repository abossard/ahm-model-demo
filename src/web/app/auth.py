import hashlib
import time
from dataclasses import dataclass, field

import jwt
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError

from config import (
    AUTHORITY_HOST,
    CONSUMERS_TENANT_ID,
    GUID,
    LOCAL_NAME,
    LOCAL_OID,
    MAX_TOKEN_CHARS,
    TOKEN_LEEWAY_SECONDS,
)


@dataclass(frozen=True)
class Caller:
    """A signed-in user: the object id is unique in one directory, so every key of the user also names the directory."""

    oid: str
    name: str
    assertion: str = field(repr=False)
    expires_at: float | None = None
    tenant_id: str = ""
    in_home_tenant: bool = True

    @property
    def fingerprint(self):
        return hashlib.sha256(self.assertion.encode("utf-8")).hexdigest()[:16]

    @property
    def owner(self):
        """The user's key in every store, cache and limit. In the directory the app belongs to it stays the object id,
        which is where the Sessions of earlier versions live; in any other directory it is the tenant id and the object id."""
        return self.oid if self.in_home_tenant else f"{self.tenant_id}/{self.oid}"


@dataclass(frozen=True)
class TokenRules:
    """Who may call: users of any directory (or of the listed ones) and, for the agent, the app's own directory."""

    home_tenant_id: str
    client_id: str
    scope: str
    allowed_tenants: frozenset = frozenset()

    def issuer(self, tenant_id):
        return f"{AUTHORITY_HOST}/{tenant_id}/v2.0"

    @property
    def audiences(self):
        return {self.client_id.casefold(), f"api://{self.client_id}".casefold()}

    def refusal(self, tenant_id):
        """Why a user of this directory may not use the app, or None."""
        if tenant_id == CONSUMERS_TENANT_ID:
            return "personal_account"
        if self.allowed_tenants and tenant_id not in self.allowed_tenants | {self.home_tenant_id.casefold()}:
            return "tenant_not_allowed"
        return None


class Unauthenticated(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class TenantRefused(Exception):
    """A valid token of a directory the app does not serve: `personal_account` or `tenant_not_allowed`."""

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
    """The tenant id, the object id and the name of the caller, or why the token is refused."""
    tenant = claims.get("tid")
    if not isinstance(tenant, str) or not GUID.fullmatch(tenant):
        raise Unauthenticated("tenant")
    tenant = tenant.casefold()
    if claims.get("iss") != rules.issuer(tenant):
        raise Unauthenticated("issuer")
    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if not rules.audiences & {a.casefold() for a in audiences if isinstance(a, str)}:
        raise Unauthenticated("audience")
    if not delegated and tenant != rules.home_tenant_id.casefold():
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
    refusal = rules.refusal(tenant) if delegated else None
    if refusal:
        raise TenantRefused(refusal)
    name = claims.get("name") or claims.get("preferred_username")
    return tenant, oid.casefold(), name if isinstance(name, str) else ""


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
        tenant_id, oid, name = check_claims(claims, self._rules, self._clock(), delegated)
        return Caller(
            oid=oid,
            name=name,
            assertion=token,
            expires_at=float(claims["exp"]),
            tenant_id=tenant_id,
            in_home_tenant=tenant_id == self._rules.home_tenant_id.casefold(),
        )

    def user(self, header):
        return self.verify(header, delegated=True)

    def agent(self, header):
        return self.verify(header, delegated=False)


def signing_keys():
    """One key set for every directory: a multitenant app reads the keys from the common endpoint, which also carries
    the keys of personal accounts, so a personal account's token is refused with its own reason and not as a stranger."""
    return jwt.PyJWKClient(
        f"{AUTHORITY_HOST}/common/discovery/v2.0/keys",
        cache_keys=True,
        max_cached_keys=16,
        cache_jwk_set=True,
        lifespan=3600,
        timeout=10,
        cooldown_duration=30,
    )
