import hashlib
import logging
import threading
import time
from collections import OrderedDict

from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError, ServiceRequestError

from config import (
    ARM_DEFAULT_SCOPE,
    ARM_DELEGATED_SCOPE,
    OBO_EXPIRY_MARGIN_SECONDS,
    OBO_TOKEN_CACHE_SIZE,
    TOKEN_EXCHANGE_SCOPE,
)


logger = logging.getLogger("ahm-demo")

CONSENT_ERROR_CODES = (65001,)
INTERACTION_ERROR_CODES = (50076, 50079, 50158, 500133)
INTERACTION_SUBERRORS = ("basic_action", "additional_action", "message_only", "user_password_expired")


class InteractionRequired(Exception):
    def __init__(self, claims=None):
        super().__init__("interaction required")
        self.claims = claims


class ConsentRequired(Exception):
    pass


def failure_for(result):
    error = str(result.get("error") or "")
    suberror = str(result.get("suberror") or "")
    codes = result.get("error_codes") or []
    description = str(result.get("error_description") or "")
    if (
        error == "consent_required"
        or suberror == "consent_required"
        or any(code in codes for code in CONSENT_ERROR_CODES)
        or "AADSTS65001" in description
    ):
        return ConsentRequired()
    if (
        result.get("claims")
        or error == "interaction_required"
        or suberror in INTERACTION_SUBERRORS
        or any(code in codes for code in INTERACTION_ERROR_CODES)
    ):
        return InteractionRequired(result.get("claims") or None)
    failure = ClientAuthenticationError(message=f"The on-behalf-of exchange failed ({error or 'unknown'}).")
    failure.status_code = 401
    return failure


def delegated(scopes):
    return tuple(ARM_DELEGATED_SCOPE if scope == ARM_DEFAULT_SCOPE else scope for scope in scopes)


class UserCredential:
    def __init__(self, exchange, assertion):
        self._exchange = exchange
        self._assertion = assertion

    def get_token(self, *scopes, claims=None, **_):
        return self._exchange(self._assertion, delegated(scopes), claims)


class OnBehalfOf:
    def __init__(self, factory, clock=time.time):
        self._factory = factory
        self._clock = clock
        self._application = None
        self._building = threading.Lock()
        self._tokens = OrderedDict()
        self._guard = threading.Lock()

    def credential(self, caller):
        return UserCredential(self.exchange, caller.assertion)

    def _build(self):
        with self._building:
            if self._application is None:
                try:
                    self._application = self._factory()
                except Exception as error:
                    logger.warning("on-behalf-of application could not start error_type=%s", type(error).__name__)
                    raise ServiceRequestError("The on-behalf-of exchange is not available.") from error
            return self._application

    def _cached(self, key, now):
        with self._guard:
            token = self._tokens.get(key)
            if token is None:
                return None
            if token.expires_on - now <= OBO_EXPIRY_MARGIN_SECONDS:
                del self._tokens[key]
                return None
            self._tokens.move_to_end(key)
            return token

    def _store(self, key, token):
        with self._guard:
            self._tokens[key] = token
            self._tokens.move_to_end(key)
            while len(self._tokens) > OBO_TOKEN_CACHE_SIZE:
                self._tokens.popitem(last=False)

    def exchange(self, assertion, scopes, claims=None):
        scopes = tuple(scopes)
        key = (hashlib.sha256(assertion.encode("utf-8")).hexdigest(), scopes)
        now = self._clock()
        if claims is None:
            hit = self._cached(key, now)
            if hit is not None:
                return hit
        application = self._build()
        try:
            result = application.acquire_token_on_behalf_of(assertion, list(scopes), claims_challenge=claims)
        except Exception as error:
            logger.warning("on-behalf-of exchange could not run error_type=%s", type(error).__name__)
            raise ServiceRequestError("The on-behalf-of exchange could not be completed.") from error
        if "access_token" not in result:
            logger.warning(
                "on-behalf-of exchange refused error=%s suberror=%s codes=%s",
                result.get("error"),
                result.get("suberror"),
                result.get("error_codes"),
            )
            raise failure_for(result)
        token = AccessToken(result["access_token"], int(now) + int(result.get("expires_in") or 0))
        if claims is None:
            self._store(key, token)
        return token


class Developer:
    def __init__(self, credential):
        self._credential = credential

    def credential(self, caller):
        return self._credential


def application_factory(tenant_id, client_id, managed_identity_client_id):
    def build():
        import msal
        from azure.identity import ManagedIdentityCredential

        identity = ManagedIdentityCredential(client_id=managed_identity_client_id)
        return msal.ConfidentialClientApplication(
            client_id,
            client_credential={"client_assertion": lambda: identity.get_token(TOKEN_EXCHANGE_SCOPE).token},
            authority=f"https://login.microsoftonline.com/{tenant_id}",
        )

    return build
