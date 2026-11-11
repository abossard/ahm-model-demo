import asyncio
import json
import logging
import re
from collections import namedtuple

import httpx

from activity import redact, safe_message
from config import AGENT_API_VERSION, AGENT_TOKEN_SCOPE, AGENT_WAIT_SECONDS


logger = logging.getLogger("ahm-demo")

StreamEvent = namedtuple("StreamEvent", ["name", "data"])

MISSING_CONVERSATION = re.compile(
    r"conversation\b[^.\n]{0,200}?(not.?found|does not exist|no longer exists|expired|deleted)"
    r"|(not.?found|does not exist)[^.\n]{0,200}?conversation",
    re.IGNORECASE,
)


class ConversationNotFound(Exception):
    pass


class AgentError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def decode_event(name, data_lines):
    text = "\n".join(data_lines).strip()
    if not text or text == "[DONE]":
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    return StreamEvent(name or data.get("type") or "", data)


async def events(lines):
    name, data_lines = None, []
    async for line in lines:
        if line == "":
            event = decode_event(name, data_lines) if data_lines else None
            name, data_lines = None, []
            if event:
                yield event
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].removeprefix(" "))
    event = decode_event(name, data_lines) if data_lines else None
    if event:
        yield event


def error_of(event):
    data = event.data
    error = (data.get("response") or {}).get("error") if event.name == "response.failed" else data
    return error if isinstance(error, dict) else {}


def says_conversation_missing(error):
    return error.get("code") == "conversation_not_found" or bool(
        MISSING_CONVERSATION.search(str(error.get("message") or ""))
    )


def json_body(response):
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def error_body(response):
    body = json_body(response)
    error = body.get("error")
    return error if isinstance(error, dict) else body


def raise_for_status(response, missing_is_conversation):
    status = response.status_code
    if status < 400:
        return
    error = error_body(response)
    if missing_is_conversation and (status == 404 or says_conversation_missing(error)):
        raise ConversationNotFound(f"HTTP {status}")
    message = str(error.get("message") or f"HTTP {status}")
    logger.warning("agent call failed status=%s message=%s", status, redact(message))
    if status in (401, 403):
        raise AgentError("agent_forbidden", "The web app is not allowed to call the agent.")
    if status >= 500:
        raise AgentError("agent_unavailable", safe_message(f"The agent is unavailable ({message})."))
    raise AgentError("agent_rejected", safe_message(f"The agent rejected the request ({message})."))


class FoundryAgent:
    def __init__(self, credential, project_endpoint, agent_name, transport=None):
        self._credential = credential
        self._base = (
            f"{project_endpoint.rstrip('/')}/agents/{agent_name}/endpoint/protocols/openai"
        )
        self._transport = transport

    async def _headers(self):
        token = await asyncio.to_thread(self._credential.get_token, AGENT_TOKEN_SCOPE)
        return {"Authorization": f"Bearer {token.token}", "Content-Type": "application/json"}

    def _client(self):
        return httpx.AsyncClient(
            timeout=httpx.Timeout(connect=AGENT_WAIT_SECONDS, read=AGENT_WAIT_SECONDS, write=30, pool=15),
            transport=self._transport,
        )

    async def create_conversation(self):
        params = {"api-version": AGENT_API_VERSION}
        try:
            async with self._client() as client:
                response = await client.post(
                    f"{self._base}/conversations",
                    params=params,
                    json={},
                    headers=await self._headers(),
                )
        except httpx.HTTPError as error:
            raise AgentError(
                "agent_unreachable", f"The agent could not be reached ({type(error).__name__})."
            ) from error
        raise_for_status(response, missing_is_conversation=False)
        conversation_id = json_body(response).get("id")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise AgentError("agent_error", "The agent did not return a conversation id.")
        return conversation_id

    async def stream_response(self, conversation_id, text):
        body = {"conversation": conversation_id, "input": text, "stream": True}
        headers = {**await self._headers(), "Accept": "text/event-stream"}
        params = {"api-version": AGENT_API_VERSION}
        for attempt in (1, 2):
            received = False
            try:
                async with self._client() as client:
                    async with client.stream(
                        "POST", f"{self._base}/responses", params=params, json=body, headers=headers
                    ) as response:
                        if response.status_code >= 400:
                            await response.aread()
                        raise_for_status(response, missing_is_conversation=True)
                        async for event in events(response.aiter_lines()):
                            received = True
                            if event.name in ("error", "response.failed") and says_conversation_missing(
                                error_of(event)
                            ):
                                raise ConversationNotFound(event.name)
                            yield event
                return
            except httpx.TransportError as error:
                if received or attempt == 2:
                    raise AgentError(
                        "agent_unreachable", f"The agent connection failed ({type(error).__name__})."
                    ) from error
                logger.warning(
                    "agent request failed before any event, trying once more error_type=%s",
                    type(error).__name__,
                )
            except httpx.HTTPError as error:
                raise AgentError(
                    "agent_unreachable", f"The agent connection failed ({type(error).__name__})."
                ) from error
