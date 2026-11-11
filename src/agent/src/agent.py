import copy
import json
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from agent_framework import (
    Agent,
    AgentContext,
    AgentMiddleware,
    AgentResponseUpdate,
    ChatContext,
    ChatMiddleware,
    Content,
    FunctionInvocationContext,
    FunctionMiddleware,
    Message,
    MiddlewareTermination,
    SkillsProvider,
    SupportsChatGetResponse,
)

from azure_mcp import AZURE_MCP_TOOLS
from instructions import INSTRUCTIONS
from tokens import AzureUnavailable, TokenSource
from tools import CURRENT_RUN, INSPECT_TOOL, QUERY_TOOLS, SUBMIT_TOOL, TaskTools, find_envelope, target_name

AGENT_NAME = "health-model-agent"
FUNCTION_INVOCATION_CONFIGURATION = {"include_detailed_errors": True}
KEPT_RESULTS = 3
NONCE_VALUE = re.compile(r'("nonce"\s*:\s*")[^"]*(")')
SKILL_RESOURCE_EXTENSIONS = (".md", ".json", ".yaml", ".yml", ".csv", ".xml", ".txt", ".bicep")


def skills_provider(skills_dir: Path) -> SkillsProvider:
    return SkillsProvider.from_paths(
        skills_dir,
        resource_extensions=SKILL_RESOURCE_EXTENSIONS,
        disable_load_skill_approval=True,
        disable_read_skill_resource_approval=True,
        disable_run_skill_script_approval=True,
    )


def without_repeated_arguments(update: AgentResponseUpdate, streamed: set[str]) -> AgentResponseUpdate:
    """The model client ends a streamed call with its whole arguments, which the host server would add a second time."""
    kept = []
    for content in update.contents:
        if content.type == "function_call":
            if content.merge_mode == "replace" and content.call_id in streamed:
                continue
            if content.arguments:
                streamed.add(content.call_id)
        kept.append(content)
    if len(kept) == len(update.contents):
        return update
    changed = copy.copy(update)
    changed.contents = kept
    return changed


class ArgumentsOnce(AgentMiddleware):
    async def process(self, context: AgentContext, call_next: Callable[[], Awaitable[None]]) -> None:
        if context.stream:
            streamed: set[str] = set()
            context.stream_update_transforms.append(lambda update: without_repeated_arguments(update, streamed))
        await call_next()


def remembered(content: Content, submitted: set[str]) -> bool:
    if content.type in ("function_call", "function_result"):
        return content.call_id in submitted
    return content.type != "text_reasoning"


def forget_reads(messages: Sequence[Message]) -> list[Message]:
    """Earlier Tasks of the conversation stay as their messages. Of their submitted results only the last few about
    the model of this Task stay: another model's result would be copied into this one. Their reads, tool outputs and
    reasoning go, so a Task works from its own readings and a long conversation does not outgrow the model."""
    start = max((index for index, message in enumerate(messages) if message.role == "user"), default=0)
    current = target_name(find_envelope([messages[start].text or ""])) if messages else ""
    owner, submitted = "", []
    for message in messages[:start]:
        if message.role == "user":
            owner = target_name(find_envelope([message.text or ""]))
        submitted += [
            content.call_id
            for content in message.contents or []
            if content.type == "function_call" and content.name == SUBMIT_TOOL and (not current or owner == current)
        ]
    kept = set(submitted[-KEPT_RESULTS:])
    forgotten: list[Message] = []
    for index, message in enumerate(messages):
        contents = [content for content in message.contents or [] if index >= start or remembered(content, kept)]
        if len(contents) == len(message.contents or []):
            forgotten.append(message)
        elif contents:
            changed = copy.copy(message)
            changed.contents = contents
            forgotten.append(changed)
    return forgotten


def carries_nonce(content: Content) -> bool:
    return content.type == "text" and '"nonce"' in (content.text or "")


def hidden_nonce(content: Content) -> Content:
    if not carries_nonce(content):
        return content
    changed = copy.copy(content)
    changed.text = NONCE_VALUE.sub(r"\1[hidden]\2", content.text)
    return changed


def without_nonce(message: Message) -> Message:
    if not any(carries_nonce(content) for content in message.contents or []):
        return message
    changed = copy.copy(message)
    changed.contents = [hidden_nonce(content) for content in message.contents]
    return changed


class EarlierTasksAsResults(ChatMiddleware):
    """What the model sees of the conversation: earlier Tasks as results, and no Task's nonce, which is the web app's
    secret for the token broker."""

    async def process(self, context: ChatContext, call_next: Callable[[], Awaitable[None]]) -> None:
        context.messages = [without_nonce(message) for message in forget_reads(context.messages)]
        await call_next()


def result_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    return "".join(getattr(content, "text", None) or "" for content in result or [])


def requested_entity(arguments: Any) -> str | None:
    entity = arguments.get("entity") if isinstance(arguments, Mapping) else getattr(arguments, "entity", None)
    return entity if isinstance(entity, str) and entity else None


class RecordCalls(FunctionMiddleware):
    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        name = context.function.name
        if record is None or name not in (*QUERY_TOOLS, INSPECT_TOOL):
            await call_next()
            return
        try:
            await call_next()
        except Exception:
            if name != INSPECT_TOOL:
                record.queries.append(False)
            raise
        if name == INSPECT_TOOL:
            record.read_entities(result_text(context.result), requested_entity(context.arguments))
        else:
            record.queries.append(True)


class FreshToken(FunctionMiddleware):
    """An Azure call sends the token held in memory for the Task. This fetches a new one first when the held one is
    close to its end, and records why when the Task has none, so the result can say so."""

    def __init__(self, tokens: TokenSource) -> None:
        self._tokens = tokens

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        if record is not None and not record.blocked and context.function.name in AZURE_MCP_TOOLS:
            try:
                await self._tokens.token_for(record.nonce)
            except AzureUnavailable as error:
                record.blocked = str(error)
                raise
        await call_next()


class RequireToolCall(ChatMiddleware):
    """Only a tool call delivers a result, and the run ends when one is accepted. A model that answers in words has
    delivered nothing: one hosted run ended with an empty message after a rejection. The framework asks for `required`
    on the first call only, so this asks on every call except its last one, which has tools off."""

    async def process(self, context: ChatContext, call_next: Callable[[], Awaitable[None]]) -> None:
        if context.options is not None and context.options.get("tool_choice") in (None, "auto"):
            context.options["tool_choice"] = "required"
        await call_next()


class EndAtAcceptedResult(FunctionMiddleware):
    """The run ends with the accepted result: the UI shows it, and another model call would only send the whole
    conversation again for a closing sentence."""

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        await call_next()
        if context.function.name == SUBMIT_TOOL and accepted(result_text(context.result)):
            raise MiddlewareTermination()


def accepted(text: str) -> bool:
    try:
        return json.loads(text).get("status") == "accepted"
    except (ValueError, AttributeError):
        return False


def build_agent(
    client: SupportsChatGetResponse[Any],
    *,
    skills_dir: Path,
    workspace: Path,
    tools: Sequence[Any] = (),
    tokens: TokenSource | None = None,
) -> Agent:
    """`tokens` gives each Task its token for the Azure MCP server; without it the agent has no Azure access."""
    refresh = [FreshToken(tokens)] if tokens is not None else []
    return Agent(
        client=client,
        name=AGENT_NAME,
        instructions=INSTRUCTIONS,
        tools=list(tools),
        context_providers=[skills_provider(skills_dir), TaskTools(workspace, tokens)],
        middleware=[ArgumentsOnce(), RecordCalls(), *refresh, EndAtAcceptedResult(), EarlierTasksAsResults(), RequireToolCall()],
        default_options={"store": False},
    )
