import copy
import json
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agent_framework import (
    Agent,
    AgentContext,
    AgentMiddleware,
    AgentResponseUpdate,
    ChatContext,
    ChatMiddleware,
    ChatResponse,
    ChatResponseUpdate,
    Content,
    FunctionInvocationContext,
    FunctionMiddleware,
    Message,
    MiddlewareTermination,
    ResponseStream,
    SupportsChatGetResponse,
)

from azure_mcp import ACTIVITY_LOG_TOOL, AZURE_MCP_TOOLS
from history import HistoryRefused, activity_arguments, bounded_arguments, log_arguments, metric_arguments, widened
from instructions import COMMON
from scope import scope_refusal, used_groups
from skillset import skills_provider
from tokens import AzureUnavailable, TokenSource
from tools import (
    CURRENT_RUN,
    INSPECT_TOOL,
    LIST_TOOL,
    LOG_QUERY_TOOL,
    MAX_IDLE,
    METRICS_TOOL,
    QUERY_TOOLS,
    SHELL_TOOL,
    SUBMIT_TOOL,
    TYPE_TOOLS,
    RunRecord,
    TaskTools,
    find_envelope,
    forced_result,
    target_name,
)

logger = logging.getLogger("health-model-agent")

AGENT_NAME = "health-model-agent"
MAX_ITERATIONS = 40
# The framework stops a run after this many rounds of tool errors in a row and lets the model answer in words, which leaves the
# Task without a result. The model calls each type may use (MODEL_CALLS) end a run first, with a result.
FUNCTION_INVOCATION_CONFIGURATION = {
    "include_detailed_errors": True,
    "max_iterations": MAX_ITERATIONS,
    "max_consecutive_errors_per_request": MAX_ITERATIONS,
}
MODEL_CALLS = {"explain": 12, "review": 20, "design": 30}
# The web app gives a Task 10 minutes (`TASK_TIMEOUT_SECONDS`) and then fails it without a result. The agent stops calling the model
# well before: at 75% of its seconds the model must submit, after them the agent submits for it.
MODEL_SECONDS = {"explain": 240, "review": 360, "design": 420}
LAST_CALL_SHARE = 0.75
KEPT_RESULTS = 1
LOAD_SKILL_TOOL = "load_skill"
NONCE_VALUE = re.compile(r'("nonce"\s*:\s*")[^"]*(")')
REASONING_MODEL = re.compile(r"^(gpt-?5|o\d)", re.IGNORECASE)
EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh")
DEFAULT_EFFORT = {"explain": "low", "review": "medium", "design": "medium"}


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
    """Earlier Tasks of the conversation stay as their messages. Of their submitted results only the last one about
    the model of this Task stays: another model's result would be copied into this one. Their reads, tool outputs and
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


def arguments_of(arguments: Any) -> dict[str, Any]:
    """The arguments of a call by name without separators and in lower case: `metric-names` is `metricnames`."""
    if isinstance(arguments, Mapping):
        items = arguments.items()
    elif hasattr(arguments, "model_dump"):
        items = arguments.model_dump().items()
    else:
        items = ()
    return {re.sub(r"[-_]", "", str(key)).lower(): value for key, value in items}


def as_mapping(arguments: Any) -> dict[str, Any]:
    """The arguments of a call with their own names."""
    if isinstance(arguments, Mapping):
        return dict(arguments)
    return arguments.model_dump() if hasattr(arguments, "model_dump") else {}


RECORDED_TOOLS = (*QUERY_TOOLS, INSPECT_TOOL, LIST_TOOL, SHELL_TOOL)


class AzureScope(FunctionMiddleware):
    """An Azure call stays inside the subscription, resource groups and health model of its Task. The refusal is the answer
    of the tool and no error, which the framework counts towards stopping a run."""

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        if record is not None and record.scope is not None and context.function.name in AZURE_MCP_TOOLS:
            subscription = record.scope[0]
            refusal = scope_refusal(
                arguments_of(context.arguments),
                subscription=subscription,
                groups=record.groups | used_groups(record.entities, subscription),
                model=record.root,
            )
            if refusal:
                logger.info("azure call refused task=%s tool=%s: %s", record.folder.name if record.folder else "", context.function.name, refusal)
                context.result = f"Error: refused. {refusal}"
                return
        await call_next()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class InspectWindow(FunctionMiddleware):
    """History is read for a bounded window only: the model has no clock, and the server's own default is open-ended. See
    `history.py` for the rule. A read of history that the rule does not allow is answered with a refusal. For a Task about a
    past moment (`asOf`) every read is of the model as it was then, and the window ends there."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        self._clock = clock

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        if record is not None and context.function.name == INSPECT_TOOL:
            try:
                arguments, window = bounded_arguments(
                    as_mapping(context.arguments),
                    task_type=record.task_type,
                    asked=record.asked,
                    instruction=record.instruction,
                    now=self._clock(),
                    as_of=record.as_of,
                )
            except HistoryRefused as refusal:
                context.result = f"Error: refused. {refusal}"
                return
            if window is not None or record.as_of is not None:
                context.arguments = arguments
            if window is not None:
                record.history_window = widened(record.history_window, window)
        await call_next()


EVIDENCE_AT = {METRICS_TOOL: metric_arguments, LOG_QUERY_TOOL: log_arguments, ACTIVITY_LOG_TOOL: activity_arguments}


class EvidenceWindow(FunctionMiddleware):
    """A Task about a past moment (`asOf`) reads its evidence for that moment too: metrics for the window that ends there, a
    log query as it would have run then, the activity log far enough back. See `history.py`. A log query that would read up
    to now is answered with a refusal that says what to add."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        self._clock = clock

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        at_moment = EVIDENCE_AT.get(context.function.name)
        if record is not None and record.as_of is not None and at_moment is not None:
            try:
                context.arguments = at_moment(as_mapping(context.arguments), as_of=record.as_of, instruction=record.instruction, now=self._clock())
            except HistoryRefused as refusal:
                context.result = f"Error: refused. {refusal}"
                return
        await call_next()


class RecordCalls(FunctionMiddleware):
    """What the run read, listed and ran is what its result may rest on: the record is kept here, call by call."""

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        name = context.function.name
        if record is None or name not in RECORDED_TOOLS:
            await call_next()
            return
        arguments = arguments_of(context.arguments)
        try:
            await call_next()
        except Exception:
            record.call_failed(name, arguments)
            raise
        record.call_returned(name, arguments, result_text(context.result))


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


class EndAtAcceptedResult(FunctionMiddleware):
    """The run ends with the accepted result: the UI shows it, and another model call would only send the whole
    conversation again for a closing sentence."""

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        await call_next()
        if context.function.name == SUBMIT_TOOL and accepted(result_text(context.result)):
            raise MiddlewareTermination()


def answered(text: str, status: str) -> bool:
    try:
        return json.loads(text).get("status") == status
    except (ValueError, AttributeError):
        return False


def accepted(text: str) -> bool:
    return answered(text, "accepted")


@dataclass(frozen=True)
class TaskSettings:
    """The model deployment and the reasoning effort of a Task type; None leaves what the client has."""

    model: str | None = None
    effort: str | None = None


def task_settings(environ: Mapping[str, str], model: str) -> dict[str, TaskSettings]:
    """Each type works with the deployment of the agent, at its reasoning effort: low to explain, medium to review and
    design. The environment can name another deployment (`EXPLAIN_MODEL`) or effort (`EXPLAIN_REASONING_EFFORT`, empty for the
    deployment's own default). Efforts are set only for reasoning models: the others reject the option."""
    settings = {}
    for task_type, effort in DEFAULT_EFFORT.items():
        prefix = task_type.upper()
        chosen = environ.get(f"{prefix}_MODEL", "").strip() or None
        given = environ.get(f"{prefix}_REASONING_EFFORT")
        wanted = given.strip().lower() if given is not None else (effort if REASONING_MODEL.match(chosen or model) else "")
        if wanted and wanted not in EFFORTS:
            raise RuntimeError(f"{prefix}_REASONING_EFFORT is '{wanted}', not one of {', '.join(EFFORTS)}")
        settings[task_type] = TaskSettings(chosen, wanted or None)
    return settings


def visible_tools(task_type: str) -> frozenset[str]:
    """What the model is offered for a Task type: the tools of its type, the Azure tools (the activity log not for a design) and
    `load_skill`. The skill provider also builds `read_skill_resource` and `run_skill_script`: no type needs them."""
    azure = set(AZURE_MCP_TOOLS) - ({ACTIVITY_LOG_TOOL} if task_type == "design" else set())
    return frozenset({*TYPE_TOOLS[task_type], *azure, LOAD_SKILL_TOOL})


def submit_call(result: Mapping[str, Any]) -> Content:
    return Content.from_function_call(f"forced-{uuid.uuid4().hex[:16]}", SUBMIT_TOOL, arguments=json.dumps({"result": result}, ensure_ascii=False))


def submit_response(result: Mapping[str, Any], *, stream: bool) -> ChatResponse | ResponseStream:
    """The model's answer to a call that the agent takes over: a `submit_result` call that carries `result`. It goes through the
    same tool as the model's own, and a streamed run shows it to the client like any other call, where the web app reads it."""
    call = submit_call(result)
    if not stream:
        return ChatResponse(messages=[Message(role="assistant", contents=[call])])

    async def updates():
        yield ChatResponseUpdate(role="assistant", contents=[call])

    return ResponseStream(updates(), finalizer=lambda collected: ChatResponse.from_updates(collected))


class RunPolicy(ChatMiddleware):
    """What each model call of a Task may be, so that a Task always ends with a result:
    - the model must call a tool (`tool_choice` required), and offers only the tools of its Task type;
    - the last call it may make (`MODEL_CALLS` of its type), or any call after `LAST_CALL_SHARE` of its seconds, must be
      `submit_result`;
    - when `submit_result` has been rejected too often (see `tools.submit`), or the model uses `MAX_IDLE` calls after a
      rejection without submitting, or it is out of calls or seconds, the call is not made: the agent submits the reduced
      result itself (`tools.forced_result`: what passes every check, the rest as findings), as a `submit_result` call in the
      stream;
    - the Task type's reasoning effort and deployment, when set."""

    def __init__(
        self,
        settings: Mapping[str, TaskSettings] | None = None,
        calls: Mapping[str, int] = MODEL_CALLS,
        seconds: Mapping[str, float] = MODEL_SECONDS,
        timer: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = dict(settings or {})
        self._calls = dict(calls)
        self._seconds = dict(seconds)
        self._timer = timer

    async def process(self, context: ChatContext, call_next: Callable[[], Awaitable[None]]) -> None:
        record = CURRENT_RUN.get()
        if record is None or record.task_type not in self._calls:
            await call_next()
            return
        record.model_calls += 1
        record.idle += 1 if record.rejected else 0
        now = self._timer()
        record.started = now if record.started is None else record.started
        elapsed = now - record.started
        if not record.reduced_sent and (why := self.reason_to_submit(record, elapsed)):
            if record.reduced is None:
                record.reduced = forced_result(record, record.folder or Path(), why)
            record.reduced_sent = True
            logger.info(
                "agent submits a reduced result task=%s reason=%s model_calls=%d rejections=%d",
                record.folder.name if record.folder else "",
                why,
                record.model_calls,
                record.rejections,
            )
            context.result = submit_response(record.reduced, stream=context.stream)
            return
        self.shape(context.options, record, elapsed)
        await call_next()

    def reason_to_submit(self, record: RunRecord, elapsed: float) -> str:
        """Why the agent submits for the model instead of calling it, or an empty text."""
        if record.reduced is not None:
            return "the proposal kept being rejected"
        if record.model_calls > self._calls[record.task_type]:
            return f"the Task used all {self._calls[record.task_type]} model calls"
        if elapsed > (budget := self._seconds.get(record.task_type, float("inf"))):
            return f"the Task used its {int(budget // 60)} minutes"
        if record.rejected and record.idle > MAX_IDLE:
            return f"the last rejection was not corrected in {MAX_IDLE} model calls"
        return ""

    def last_call(self, record: RunRecord, elapsed: float) -> bool:
        """Is this the last call the Task type may make: no call left, or its seconds almost used up?"""
        budget = self._seconds.get(record.task_type, float("inf"))
        return record.model_calls >= self._calls[record.task_type] or elapsed >= LAST_CALL_SHARE * budget

    def shape(self, options: Any, record: RunRecord, elapsed: float) -> None:
        if options is None:
            return
        visible = visible_tools(record.task_type)
        if options.get("tools"):
            options["tools"] = [tool for tool in options["tools"] if getattr(tool, "name", None) in visible]
        if self.last_call(record, elapsed):
            options["tool_choice"] = {"mode": "required", "required_function_name": SUBMIT_TOOL}
        elif options.get("tool_choice") in (None, "auto"):
            options["tool_choice"] = "required"
        settings = self._settings.get(record.task_type)
        if settings and settings.model:
            options["model"] = settings.model
        if settings and settings.effort:
            options["reasoning"] = {**dict(options.get("reasoning") or {}), "effort": settings.effort}


def build_agent(
    client: SupportsChatGetResponse[Any],
    *,
    skills_dir: Path,
    workspace: Path,
    tools: Sequence[Any] = (),
    tokens: TokenSource | None = None,
    settings: Mapping[str, TaskSettings] | None = None,
    calls: Mapping[str, int] = MODEL_CALLS,
    seconds: Mapping[str, float] = MODEL_SECONDS,
    timer: Callable[[], float] = time.monotonic,
    clock: Callable[[], datetime] = utc_now,
) -> Agent:
    """`tokens` gives each Task its token for the Azure MCP server; without it the agent has no Azure access."""
    refresh = [FreshToken(tokens)] if tokens is not None else []
    return Agent(
        client=client,
        name=AGENT_NAME,
        instructions=COMMON,
        tools=list(tools),
        context_providers=[TaskTools(workspace, tokens), skills_provider(skills_dir)],
        middleware=[
            ArgumentsOnce(),
            AzureScope(),
            InspectWindow(clock),
            EvidenceWindow(clock),
            RecordCalls(),
            *refresh,
            EndAtAcceptedResult(),
            EarlierTasksAsResults(),
            RunPolicy(settings, calls, seconds, timer),
        ],
        default_options={"store": False},
    )
