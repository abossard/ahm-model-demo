"""The signed-in user's token for the Azure MCP server, one per running Task.

The agent holds no Azure role. The web app's token broker exchanges a Task's nonce for a token of the user who started
the Task; the agent asks for it with its own identity's token and keeps the answer in memory only."""

import asyncio
import http.client
import json
import logging
import re
import shlex
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from azure.identity import DefaultAzureCredential

logger = logging.getLogger("health-model-agent")

BROKER_PATH = "/api/agent/token"
REFRESH_MARGIN_SECONDS = 300
MIN_HOLD_SECONDS = 30
BACKOFF_SECONDS = (1.0, 2.0, 4.0)
REQUEST_TIMEOUT_SECONDS = 20
MAX_ANSWER_BYTES = 64 * 1024
DEV_TOKEN_SECONDS = 600
DEV_COMMAND_TIMEOUT_SECONDS = 60
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

# What the user and the model are told for each broker error code. None carries a token, a nonce or an address.
MESSAGES = {
    "interaction_required": "The signed-in user must sign in again before Azure can be read.",
    "consent_required": "An administrator must grant consent to the app registrations before Azure can be read.",
    "unknown_task": "The web app does not know this Task any more: it ended or was cancelled.",
    "forbidden": "The web app does not accept the agent's identity for token requests.",
    "unauthenticated": "The web app did not accept the agent identity's token.",
    "invalid_nonce": "The web app refused the Task's nonce.",
    "agent_identity_not_configured": "The web app does not know the agent's identity yet: the agent deploy script has to run again.",
    "rate_limited": "The web app is limiting token requests for this Task.",
    "token_exchange_failed": "Azure refused to give this Task a token for the signed-in user.",
    "token_unavailable": "Azure's token exchange is unavailable right now.",
}


class AzureUnavailable(KeyError):
    """Azure cannot be read for this Task. `str()` is the reason, safe to show. It is a KeyError because the MCP tool
    defers a run's header lookup when the provider raises one, and raises it again when a call needs the header."""

    def __init__(self, reason: str, code: str = "unavailable") -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code

    def __str__(self) -> str:
        return self.reason


class TokenSource(Protocol):
    async def token_for(self, nonce: str | None) -> str:
        """The token for the Task with this nonce, refreshed when it is close to its end. Raises AzureUnavailable."""
        ...

    def cached(self, nonce: str | None) -> str | None:
        """The token held in memory for this nonce, if it has not expired."""
        ...


@dataclass(frozen=True)
class Held:
    token: str
    refresh_at: float
    expires_at: float


@dataclass(frozen=True)
class Failure:
    code: str
    reason: str
    transient: bool


def secure_url(url: str, name: str) -> str:
    """A bearer token travels to this address: https, or http to this machine."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "https" and parsed.hostname or parsed.scheme == "http" and parsed.hostname in LOCAL_HOSTS:
        return url
    raise ValueError(f"{name} must be an https URL (http only for localhost)")


def failure_for(status: int, answer: object) -> Failure:
    """The broker's error answer `{"error": {"code", "message", "retryable"}}` as a failure. A server error or
    rate limit is transient unless the broker says it is not retryable."""
    error = answer.get("error") if isinstance(answer, dict) else None
    error = error if isinstance(error, dict) else {}
    code = error.get("code") if isinstance(error.get("code"), str) and re.fullmatch(r"[a-z_]{1,40}", error["code"]) else ""
    transient = (status == 429 or status >= 500) and error.get("retryable") is not False
    return Failure(code or f"http_{status}", MESSAGES.get(code) or f"The web app answered HTTP {status} to the token request.", transient)


def held_from(answer: object, now: float) -> Held | None:
    token = answer.get("accessToken") if isinstance(answer, dict) else None
    expires_on = answer.get("expiresOn") if isinstance(answer, dict) else None
    if not isinstance(token, str) or not token or isinstance(expires_on, bool) or not isinstance(expires_on, (int, float)):
        return None
    if expires_on <= now:
        return None
    # A token that is already close to its end is asked for again at most every MIN_HOLD_SECONDS.
    return Held(token, min(expires_on, max(expires_on - REFRESH_MARGIN_SECONDS, now + MIN_HOLD_SECONDS)), expires_on)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """The agent identity's token goes to the configured web app only, never to wherever it redirects."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def exchange(url: str, agent_token: str, nonce: str) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        data=json.dumps({"nonce": nonce}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {agent_token}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return response.status, response.read(MAX_ANSWER_BYTES)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read(MAX_ANSWER_BYTES)


class Broker:
    def __init__(
        self,
        web_app_url: str,
        audience: str,
        credential: Any,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        backoff: tuple[float, ...] = BACKOFF_SECONDS,
    ) -> None:
        self._url = secure_url(web_app_url, "WEB_APP_URL").rstrip("/") + BROKER_PATH
        self._scope = f"{audience.rstrip('/')}/.default"
        self._credential = credential
        self._clock = clock
        self._sleep = sleep
        self._backoff = backoff
        self._held: dict[str, Held] = {}
        self._lock = asyncio.Lock()

    def cached(self, nonce: str | None) -> str | None:
        held = self._held.get(nonce or "")
        return held.token if held and self._clock() < held.expires_at else None

    async def token_for(self, nonce: str | None) -> str:
        if not nonce:
            raise AzureUnavailable("The Task carries no nonce: the web app starts every Task with one.", "no_nonce")
        held = self._held.get(nonce)
        if held and self._clock() < held.refresh_at:
            return held.token
        async with self._lock:
            held = self._held.get(nonce)
            if held and self._clock() < held.refresh_at:
                return held.token
            try:
                fetched = await self._fetch(nonce)
            except AzureUnavailable:
                if held and self._clock() < held.expires_at:
                    return held.token
                raise
            now = self._clock()
            self._held = {key: value for key, value in self._held.items() if now < value.expires_at} | {nonce: fetched}
            return fetched.token

    async def _agent_token(self) -> str:
        try:
            return (await asyncio.to_thread(self._credential.get_token, self._scope)).token
        except Exception as error:
            logger.warning("the agent identity could not get a token for the web app error_type=%s", type(error).__name__)
            raise AzureUnavailable(
                f"The agent's identity could not get a token for the web app ({type(error).__name__}).", "agent_token"
            ) from None

    async def _fetch(self, nonce: str) -> Held:
        agent_token = await self._agent_token()
        failure = Failure("unreachable", "The web app could not be reached for a token.", True)
        for delay in (*self._backoff, None):
            outcome = await self._attempt(agent_token, nonce)
            if isinstance(outcome, Held):
                return outcome
            failure = outcome
            logger.warning("token request failed code=%s transient=%s", failure.code, failure.transient)
            if delay is None or not failure.transient:
                break
            await self._sleep(delay)
        raise AzureUnavailable(failure.reason, failure.code)

    async def _attempt(self, agent_token: str, nonce: str) -> Held | Failure:
        try:
            status, body = await asyncio.to_thread(exchange, self._url, agent_token, nonce)
        except (OSError, TimeoutError, ValueError, http.client.HTTPException):
            return Failure("unreachable", "The web app could not be reached for a token.", True)
        try:
            answer = json.loads(body)
        except ValueError:
            answer = None
        if status == 200:
            held = held_from(answer, self._clock())
            return held or Failure("bad_answer", "The web app's token answer was malformed.", False)
        return failure_for(status, answer)


class BearerCommand:
    """Development only: a command that prints a bearer token for the MCP server's scope, used instead of the broker."""

    def __init__(self, command: str, *, clock: Callable[[], float] = time.time) -> None:
        self._argv = shlex.split(command)
        if not self._argv:
            raise ValueError("MCP_BEARER_COMMAND is empty")
        self._clock = clock
        self._held: Held | None = None

    def cached(self, nonce: str | None) -> str | None:
        return self._held.token if self._held and self._clock() < self._held.expires_at else None

    async def token_for(self, nonce: str | None) -> str:
        if self._held and self._clock() < self._held.refresh_at:
            return self._held.token
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                *self._argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
            )
            output, _ = await asyncio.wait_for(process.communicate(), DEV_COMMAND_TIMEOUT_SECONDS)
        except (OSError, TimeoutError):
            if process is not None and process.returncode is None:
                process.kill()
            raise AzureUnavailable("MCP_BEARER_COMMAND could not run: run it in a terminal to see why.", "command") from None
        token = output.decode(errors="replace").strip()
        if process.returncode != 0 or not token:
            raise AzureUnavailable(
                f"MCP_BEARER_COMMAND exited with {process.returncode} or printed no token: run it in a terminal to see why.", "command"
            )
        now = self._clock()
        self._held = Held(token, now + DEV_TOKEN_SECONDS, now + DEV_TOKEN_SECONDS)
        return token


def token_source(env: Mapping[str, str], credential: Any = None) -> TokenSource:
    """The broker for the hosted agent; the development override when `MCP_BEARER_COMMAND` is set, which a hosted agent refuses."""
    command = env.get("MCP_BEARER_COMMAND", "").strip()
    if command:
        if env.get("FOUNDRY_AGENT_NAME"):
            raise RuntimeError("MCP_BEARER_COMMAND is a development override: a hosted agent (FOUNDRY_AGENT_NAME is set) must use the broker")
        return BearerCommand(command)
    settings = {name: env.get(name, "").strip() for name in ("WEB_APP_URL", "WEB_API_AUDIENCE")}
    for name, value in settings.items():
        if not value:
            raise RuntimeError(f"environment variable {name} is not set")
    return Broker(settings["WEB_APP_URL"], settings["WEB_API_AUDIENCE"], credential or DefaultAzureCredential())
