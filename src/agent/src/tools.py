import asyncio
import contextlib
import contextvars
import json
import logging
import os
import re
import shutil
import signal
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from agent_framework import AgentSession, ContextProvider, FunctionTool, SessionContext, SupportsAgentRun, tool
from pydantic import Field

from contracts import validate_task_result
from grounding import MetricRun, RepoScan, grounded_problems, letters, removed_names, scan_repository, scan_signature, squash, words_of
from clone import CLONE_TOOL, clone_tool
from history import window_problems
from instructions import instructions_for
from plain import plain_problems
from reduction import decision_lines, reduce_result, reduction_notice
from redaction import redact
from tokens import AzureUnavailable, TokenSource
from webchecks import removal_problems, web_problems

logger = logging.getLogger("health-model-agent")

SHELL_TIMEOUT_DEFAULT = 60
SHELL_TIMEOUT_CAP = 300
SHELL_OUTPUT_LIMIT = 20_000
SHELL_CPU_SECONDS = 240
SHELL_FILE_KIB = 2 * 1024 * 1024
SHELL_TASK_HEADROOM = 256
SHELL_ENV_KEYS = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "PYTHONNOUSERSITE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "GIT_SSL_CAINFO",
)
RUN_ID_KEY = "AGENT_RUN_ID"
DRAIN_SECONDS = 5
KILL_ROUNDS = 3


SUBMIT_TOOL = "submit_result"
METRICS_TOOL = "monitor_metrics_query"
LOG_QUERY_TOOL = "monitor_workspace_log_query"
QUERY_TOOLS = (METRICS_TOOL, LOG_QUERY_TOOL)
INSPECT_TOOL = "monitor_healthmodels_inspect"
LIST_TOOL = "group_resource_list"
SHELL_TOOL = "run_shell"
READ_ONLY_KEYS = frozenset(
    {
        "provisioningState",
        "healthState",
        "discoveredBy",
        "status",
        "external",
        "signalName",
        "aggregatedHealthState",
        "unresolvedMembers",
        "azureResourceKind",
        "canvasPosition",
    }
)


@dataclass
class RunRecord:
    """What this run read and ran: the properties of each entity monitor_healthmodels_inspect returned, and the
    metrics and log queries, one entry each: did it return? Changes and verification rows must rest on them.
    `nonce` is the Task's secret for the token broker; `blocked` is why Azure cannot be read, when it cannot;
    `read_failures` counts the reads of the model that failed. What grounds a result: the resources `group_resource_list`
    `listed` (id to name), the words of this workload (`vocabulary`: its resource names, instruction, resource group and
    repository address), the `repository` the Task names and whether a clone was tried, the log queries that ran
    (`log_runs`: query to status and columns) and the metrics queries that returned. `scope` is the Task target's
    subscription and resource group, `groups` the resource groups the Task names. The counters (`rejections`, `repeats`,
    `idle`, `model_calls`, `started`) decide when the agent submits a reduced result itself."""

    queries: list[bool] = field(default_factory=list)
    entities: dict[str, dict[str, Any]] = field(default_factory=dict)
    expected: frozenset[str] = frozenset()
    edges: dict[str, tuple[str, str]] = field(default_factory=dict)
    design: bool = False
    root: str = ""
    task_type: str = ""
    asked: str = ""
    rejected: list[str] = field(default_factory=list)
    nonce: str = ""
    blocked: str = ""
    read_failures: int = 0
    repository: str = ""
    clone_attempted: bool = False
    listed: dict[str, str] = field(default_factory=dict)
    vocabulary: set[str] = field(default_factory=set)
    log_runs: dict[str, tuple[str, frozenset[str]]] = field(default_factory=dict)
    metric_runs: list[MetricRun] = field(default_factory=list)
    scan: tuple[Any, RepoScan] | None = None
    folder: Path | None = None
    instruction: str = ""
    scope: tuple[str, str] | None = None
    groups: frozenset[str] = frozenset()
    rejections: int = 0
    repeats: int = 0
    last_result: dict[str, Any] | None = None
    idle: int = 0
    reduced: dict[str, Any] | None = None
    reduced_sent: bool = False
    model_calls: int = 0
    started: float | None = None
    history_window: tuple[datetime, datetime] | None = None

    def read_entities(self, text: str, requested: str | None = None) -> None:
        """An entity is named by itself, else by the last segment of its walk `path` (a `fields` filter can leave the
        name out), else by the entity the call asked for when that is all the call returned."""
        with contextlib.suppress(ValueError, KeyError, TypeError, AttributeError):
            items = json.loads(text)["results"]["entities"]
            for item in items:
                entity = item["entity"]
                name = entity.get("name") or str(item.get("path") or "").rsplit("/", 1)[-1] or (requested if len(items) == 1 else None)
                if name:
                    self.entities.setdefault(name.lower(), {}).update(entity.get("properties") or {})

    def note_resources(self, text: str) -> None:
        """The resources a group_resource_list call returned, and the words of their names."""
        with contextlib.suppress(ValueError, KeyError, TypeError, AttributeError):
            for item in json.loads(text)["results"]["resources"]:
                self.listed[str(item["id"]).lower()] = str(item["name"])
                self.vocabulary |= set(words_of(str(item["name"])))

    def note_log_query(self, arguments: Mapping[str, Any], text: str | None) -> None:
        """A log query of this run: it failed (`text` is None), returned no row, or returned one with these columns.
        A run that returned stays on record when the same query fails later."""
        query = squash(str(arguments.get("query") or ""))
        status, columns = ("error", frozenset()) if text is None else ("empty", frozenset())
        with contextlib.suppress(ValueError, KeyError, TypeError, AttributeError):
            rows = json.loads(text or "")["results"]["results"]
            if rows and isinstance(rows[0], dict):
                status, columns = "ok", frozenset(rows[0])
        if query and self.log_runs.get(query, ("", columns))[0] != "ok":
            self.log_runs[query] = (status, columns)

    def note_metric_query(self, arguments: Mapping[str, Any]) -> None:
        names = frozenset(name.strip().lower() for name in str(arguments.get("metricnames") or "").split(",") if name.strip())
        self.metric_runs.append(
            MetricRun(
                str(arguments.get("resource") or "").lower(),
                names,
                str(arguments.get("metricnamespace") or "").lower(),
                str(arguments.get("aggregation") or "").lower(),
            )
        )

    def note_shell(self, arguments: Mapping[str, Any]) -> None:
        if re.search(r"\bgit\s+clone\b", str(arguments.get("command") or "")):
            self.clone_attempted = True

    def call_returned(self, tool: str, arguments: Mapping[str, Any], text: str) -> None:
        """What a tool call that returned adds to the record. `arguments` are the call's own, names without separators."""
        if tool == INSPECT_TOOL:
            requested = arguments.get("entity")
            self.read_entities(text, requested if isinstance(requested, str) and requested else None)
        elif tool == LIST_TOOL:
            self.note_resources(text)
        elif tool in QUERY_TOOLS:
            self.queries.append(True)
            if tool == LOG_QUERY_TOOL:
                self.note_log_query(arguments, text)
            else:
                self.note_metric_query(arguments)
        elif tool == SHELL_TOOL:
            self.note_shell(arguments)

    def call_failed(self, tool: str, arguments: Mapping[str, Any]) -> None:
        if tool == INSPECT_TOOL:
            self.read_failures += 1
        elif tool in QUERY_TOOLS:
            self.queries.append(False)
            if tool == LOG_QUERY_TOOL:
                self.note_log_query(arguments, None)
        elif tool == SHELL_TOOL:
            self.note_shell(arguments)

    def repository_scan(self, folder: Path) -> RepoScan:
        """What the repositories cloned into the Task folder hold, scanned again when a clone appears."""
        signature = scan_signature(folder)
        if self.scan is None or self.scan[0] != signature:
            self.scan = (signature, scan_repository(folder))
        return self.scan[1]


CURRENT_RUN: contextvars.ContextVar[RunRecord | None] = contextvars.ContextVar("current_run", default=None)


@dataclass(frozen=True)
class ShellRun:
    exit_code: int | None
    output: bytes
    total_bytes: int
    timeout_seconds: int


@dataclass
class Capture:
    kept: bytearray = field(default_factory=bytearray)
    total: int = 0


def find_envelope(texts: Sequence[str]) -> dict[str, Any] | None:
    """The latest envelope `{"task": {"id": ...}, ...}` in the texts, with its other top-level keys such as `relationships`."""
    decoder = json.JSONDecoder()
    for text in reversed(texts):
        for start in reversed([match.start() for match in re.finditer(r"\{", text)]):
            try:
                value, _ = decoder.raw_decode(text, start)
            except ValueError:
                continue
            task = value.get("task") if isinstance(value, dict) else None
            if isinstance(task, dict) and isinstance(task.get("id"), str) and task["id"]:
                return value
    return None


def find_task(texts: Sequence[str]) -> dict[str, Any] | None:
    envelope = find_envelope(texts)
    return envelope["task"] if envelope else None


def task_nonce(envelope: dict[str, Any] | None) -> str:
    nonce = envelope["task"].get("nonce") if envelope else None
    return nonce if isinstance(nonce, str) else ""


def workload_repository(envelope: dict[str, Any] | None) -> str:
    workload = envelope["task"].get("workload") if envelope else None
    url = workload.get("repositoryUrl") if isinstance(workload, dict) else None
    return url if isinstance(url, str) else ""


def expected_reads(envelope: dict[str, Any] | None) -> frozenset[str]:
    """What the Task has to read before it submits: the entity of an explain, every entity of a review's model."""
    task = envelope["task"] if envelope else {}
    target = task.get("target") if isinstance(task.get("target"), dict) else {}
    names: set[Any] = set()
    if task.get("type") == "explain":
        names = {target.get("entity")}
    elif task.get("type") == "review":
        names = {target.get("name")}
        for edge in envelope.get("relationships") or []:
            names |= {edge.get("parent"), edge.get("child")} if isinstance(edge, dict) else set()
    return frozenset(name.lower() for name in names if isinstance(name, str) and name)


def task_folder(workspace: Path, task: dict[str, Any] | None) -> Path:
    task_id = re.sub(r"[^A-Za-z0-9_-]", "_", task["id"])[:64] if task else "adhoc"
    return workspace / "tasks" / task_id


def clamp_timeout(seconds: int) -> int:
    return max(1, min(seconds, SHELL_TIMEOUT_CAP))


def shell_env(parent: Mapping[str, str], folder: Path, run_id: str) -> dict[str, str]:
    """What a model-written command sees: no identity, token or connection string variables of the agent."""
    env = {key: parent[key] for key in SHELL_ENV_KEYS if key in parent}
    return {**env, "PWD": str(folder), "GIT_TERMINAL_PROMPT": "0", RUN_ID_KEY: run_id}


def limits_prelude(own_tasks: int | None) -> str:
    """ulimit calls that start the command line: CPU seconds, file size and, when known, tasks of this user."""
    limits = [f"-t {SHELL_CPU_SECONDS}", f"-f {SHELL_FILE_KIB}"]
    if own_tasks is not None:
        limits.append(f"-u {own_tasks + SHELL_TASK_HEADROOM}")
    return "".join(f"ulimit {limit} 2>/dev/null; " for limit in limits)


def marked_pids(environs: Mapping[int, bytes], run_id: str) -> list[int]:
    marker = f"{RUN_ID_KEY}={run_id}".encode()
    return [pid for pid, environ in environs.items() if marker in environ.split(b"\0")]


def render_shell_run(run: ShellRun) -> str:
    if run.exit_code is None:
        status = f"timed out after {run.timeout_seconds}s and was killed"
    else:
        status = f"exit code {run.exit_code}"
    text = run.output.decode("utf-8", errors="replace")
    notice = ""
    if run.total_bytes > len(run.output):
        notice = f"\n[output truncated: first {len(run.output)} of {run.total_bytes} bytes shown]"
    return f"{status}\n{text}{notice}"


async def run_command(command: str, folder: Path, timeout_seconds: int) -> ShellRun:
    folder.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    process = await asyncio.create_subprocess_exec(
        shutil.which("bash") or "/bin/bash",
        "-c",
        limits_prelude(count_own_tasks()) + command,
        cwd=folder,
        env=shell_env(os.environ, folder, run_id),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    capture = Capture()
    reader = asyncio.create_task(_drain(process.stdout, capture))
    exit_code: int | None = None
    try:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(process.wait(), timeout_seconds)
            exit_code = process.returncode
    finally:
        await _kill_run(process, run_id)
    await process.wait()
    done, _ = await asyncio.wait({reader}, timeout=DRAIN_SECONDS)
    if not done:
        await _kill_run(process, run_id)
        reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)
    return ShellRun(exit_code, bytes(capture.kept), capture.total, timeout_seconds)


def count_own_tasks() -> int | None:
    """Processes and threads of this user, which is what RLIMIT_NPROC counts. None without /proc."""
    proc = Path("/proc")
    if not proc.is_dir():
        return None
    uid = os.getuid()
    total = 0
    for status in proc.glob("[0-9]*/status"):
        with contextlib.suppress(OSError, KeyError, ValueError):
            fields = dict(line.split(":", 1) for line in status.read_text().splitlines() if ":" in line)
            if int(fields["Uid"].split()[0]) == uid:
                total += int(fields["Threads"])
    return total


def read_environs() -> dict[int, bytes]:
    environs: dict[int, bytes] = {}
    for path in Path("/proc").glob("[0-9]*/environ"):
        with contextlib.suppress(OSError, ValueError):
            environs[int(path.parent.name)] = path.read_bytes()
    return environs


async def _kill_run(process: asyncio.subprocess.Process, run_id: str) -> None:
    """Kill the process group, also when its leader is gone (a background job outlives it), then whatever still carries the run
    marker, which also finds setsid children. Every command ends here: nothing it started survives into a later Task."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, signal.SIGKILL)
    for _ in range(KILL_ROUNDS):
        pids = marked_pids(read_environs(), run_id)
        for pid in pids:
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)
        if not pids:
            return
        await asyncio.sleep(0.05)


async def _drain(stream: asyncio.StreamReader, capture: Capture) -> None:
    while chunk := await stream.read(65536):
        capture.total += len(chunk)
        capture.kept += chunk[: max(0, SHELL_OUTPUT_LIMIT - len(capture.kept))]


def asked_entity(envelope: dict[str, Any] | None) -> str:
    """The entity an explain Task asks about, lower case."""
    target = envelope["task"].get("target") if envelope else None
    entity = target.get("entity") if isinstance(target, dict) else None
    return entity.lower() if isinstance(entity, str) and envelope["task"].get("type") == "explain" else ""


def target_name(envelope: dict[str, Any] | None) -> str:
    """The model the Task is about, lower case. The root entity is named like it."""
    target = envelope["task"].get("target") if envelope else None
    name = target.get("name") if isinstance(target, dict) else None
    return name.lower() if isinstance(name, str) else ""


def edges_of(envelope: dict[str, Any] | None) -> dict[str, tuple[str, str]]:
    """The Task's relationships by lower-case name: (parent, child) in lower case."""
    edges = {}
    for edge in (envelope or {}).get("relationships") or []:
        if isinstance(edge, dict) and all(isinstance(edge.get(key), str) for key in ("name", "parent", "child")):
            edges[edge["name"].lower()] = (edge["parent"].lower(), edge["child"].lower())
    return edges


RESULT_KINDS = {"explain": "explain", "review": "diff", "design": "diff"}
HEALTH_STATES = ("Healthy", "Degraded", "Unhealthy", "Unknown")


def task_problems(result: dict[str, Any], record: RunRecord) -> list[str]:
    """The result answers this Task: the kind its type asks for and, for an explain, the entity that was asked."""
    wanted = RESULT_KINDS.get(record.task_type)
    if wanted and result["kind"] != wanted:
        return [
            f"this Task is a {record.task_type}: submit a result of kind `{wanted}`, not `{result['kind']}`. Work on the "
            "Task of your latest user message, whatever earlier Tasks asked"
        ]
    if record.task_type == "explain" and record.asked and result["entity"].lower() != record.asked:
        return [f"this Task explains '{record.asked}', but the result is about '{result['entity']}'"]
    return []


def endpoint_problems(result: dict[str, Any], record: RunRecord) -> list[str]:
    """A relationship joins entities that exist once the result is applied: the root, the ones read, the ones added."""
    if result["kind"] != "diff" or not record.entities:
        return []
    existing = set(record.entities) | ({record.root} if record.root else set())
    for change in result["changes"]:
        if change["kind"] == "entity":
            existing.add(change["name"].lower()) if change["op"] != "remove" else existing.discard(change["name"].lower())
    return [
        f"changes[{index}]: relationship '{change['name']}' has {role} '{end}', which the model does not have: `add` that "
        "entity in this result, or leave the relationship out"
        for index, change in enumerate(result["changes"])
        if change["kind"] == "relationship" and change["op"] != "remove"
        for role, end in (("parent", str(change["after"].get("parentEntityName", ""))), ("child", str(change["after"].get("childEntityName", ""))))
        if end.lower() not in existing
    ]


def design_problems(result: dict[str, Any], record: RunRecord) -> list[str]:
    """A design for a model that has only its root adds the workload tree: a note that it cannot is no design."""
    if not record.design or result["kind"] != "diff" or len(record.entities) != 1:
        return []
    added = {change["kind"] for change in result["changes"] if change["op"] == "add"}
    if {"entity", "relationship"} <= added:
        return []
    return [
        "design: the target model has only its root, so the design adds the workload tree: `add` entities for the "
        "user flows, components and resources you found, and a relationship for each. Record assumptions and gaps in "
        "`findings`, but propose the model"
    ]


def unread_problems(record: RunRecord) -> list[str]:
    """Earlier Tasks of the conversation do not stand in for reading: this Task reads what it judges."""
    unread = sorted(record.expected - record.entities.keys())
    if not unread:
        return []
    if len(record.expected) == 1:
        return [
            f"explain: entity '{unread[0]}' was not read in this Task; read it with {INSPECT_TOOL} "
            "(entity, walk Causes, include Signals), whatever earlier Tasks showed"
        ]
    return [
        f"review: {len(unread)} of the model's {len(record.expected)} entities were not read in this Task "
        f"(for example {', '.join(unread[:3])}); read the whole model with one {INSPECT_TOOL} (include Signals, "
        "top 500, every page; keep `entity.name` if you use `fields`) and review all of it, whatever earlier Tasks looked at"
    ]


MISSING_RESOURCE = re.compile(
    r"does not exist|doesn't exist|no longer exists?|not present|is missing|are missing|was deleted|not found", re.IGNORECASE
)


def contradiction_problems(result: dict[str, Any]) -> list[str]:
    """A finding that calls a resource missing cannot stand beside a row that read it."""
    read = {row["entity"].lower(): index for index, row in reversed(list(enumerate(result["verification"]))) if row["status"] == "verified"}
    problems = []
    for index, finding in enumerate(result["findings"]):
        entity = (finding["entity"] or "").lower()
        if entity in read and MISSING_RESOURCE.search(finding["text"]):
            problems.append(
                f"findings[{index}]: calls the resource of '{finding['entity']}' missing, but verification[{read[entity]}] read it. "
                "Findings follow your readings: correct the finding, and the summary if it says the same"
            )
    return problems


def verification_problems(result: dict[str, Any], record: RunRecord) -> list[str]:
    if result["kind"] != "diff":
        return []
    needed = {"verified": "value", "failing": "error", "not_run": "error"}
    problems = [
        f"verification[{index}]: a `{row['status']}` row needs `{needed[row['status']]}`"
        for index, row in enumerate(result["verification"])
        if row[needed[row["status"]]] is None
    ]
    statuses = {row["status"] for row in result["verification"]}
    if statuses & {"verified", "failing"} and not record.queries:
        problems.append(
            "verification: no metrics or log query ran in this Task, so no row can be `verified` or `failing`. Call "
            "monitor_metrics_query or monitor_workspace_log_query for each new or changed signal and keep those rows; "
            "remove every other row (unchanged signals get no row); then call submit_result again"
        )
    elif "verified" in statuses and not any(record.queries):
        problems.append(
            "verification: no query returned in this Task, so no row can be `verified`. Set each such row's status to "
            "`not_run` and put the reason in `error`, or run a query that returns and keep `verified` for that signal. "
            "`failing` is for a signal the model already has; a new signal whose query fails is left out. Then call "
            "submit_result again"
        )
    return problems + contradiction_problems(result)


def current_form(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: current_form(item) for key, item in value.items() if key not in READ_ONLY_KEYS}
    if isinstance(value, list):
        return [current_form(item) for item in value]
    return value


def left_out(current: Any, after: Any, path: str = "") -> list[str]:
    """Where `current` has a key or a named signal that `after` lacks."""
    missing: list[str] = []
    if isinstance(current, dict) and isinstance(after, dict):
        for key, value in current.items():
            here = f"{path}.{key}" if path else key
            missing += [here] if key not in after else left_out(value, after[key], here)
    elif isinstance(current, list) and isinstance(after, list):
        kept = {item["name"]: item for item in after if isinstance(item, dict) and "name" in item}
        for item in current:
            if isinstance(item, dict) and "name" in item:
                here = f"{path}[{item['name']}]"
                missing += left_out(item, kept[item["name"]], here) if item["name"] in kept else [here]
    return missing


def add_problems(index: int, change: dict[str, Any], record: RunRecord, gone: set[str] = frozenset()) -> list[str]:
    """What the run already read exists: an `add` of it is a `change`, or nothing. `gone` are the relationships this result
    removes: a relationship that replaces one of them is no twin."""
    name = change["name"]
    if change["kind"] == "entity" and name.lower() in record.entities:
        return [f"changes[{index}]: entity '{name}' already exists in the model (the root exists too); use op `change`, or leave it out"]
    if change["kind"] != "relationship":
        return []
    if name.lower() in record.edges:
        return [f"changes[{index}]: relationship '{name}' already exists; use op `change`, or leave it out"]
    after = change["after"]
    pair = (str(after.get("parentEntityName", "")).lower(), str(after.get("childEntityName", "")).lower())
    twin = next((listed for listed, edge in record.edges.items() if edge == pair and listed not in gone), None)
    if twin:
        return [f"changes[{index}]: relationship '{name}' repeats {pair[0]} -> {pair[1]}, which already exists as '{twin}'; use that name or leave it out"]
    return []


def relationship_change_problems(index: int, change: dict[str, Any], record: RunRecord) -> list[str]:
    name = change["name"]
    edge = record.edges.get(name.lower())
    if edge is None:
        return [f"changes[{index}]: relationship '{name}' is not in the Task's relationships; use op `add` for a new one"]
    after = change["after"]
    if (str(after.get("parentEntityName", "")).lower(), str(after.get("childEntityName", "")).lower()) == edge:
        return [f"changes[{index}]: relationship '{name}' is the same as in the model; leave this change out"]
    return []


def change_problems(result: dict[str, Any], record: RunRecord) -> list[str]:
    """A change of an entity starts from what the run read and keeps what its fix does not touch."""
    if result["kind"] != "diff":
        return []
    problems = []
    gone = removed_names(result, "relationship")
    for index, change in enumerate(result["changes"]):
        if change["op"] == "add":
            problems += add_problems(index, change, record, gone)
        if change["op"] == "change" and change["kind"] == "relationship":
            problems += relationship_change_problems(index, change, record)
        if change["op"] != "change" or change["kind"] != "entity":
            continue
        name = change["name"]
        current = record.entities.get(name.lower())
        if current is None:
            problems.append(
                f"changes[{index}]: entity '{name}' was not read in this Task; read it with {INSPECT_TOOL} first"
            )
            continue
        before, after = current_form(current), current_form(change["after"])
        if before == after:
            problems.append(
                f"changes[{index}]: entity '{name}' is the same as in the model; leave this change out "
                "and state the problem as a finding"
            )
            continue
        dropped = [
            path
            for path in left_out(before, after)
            if letters(re.split(r"[.\[\]]", path.rstrip("]"))[-1]) not in letters(change["reason"])
        ]
        if dropped:
            problems.append(
                f"changes[{index}].after: leaves out {', '.join(dropped[:5])}, which the model has. A change keeps "
                f"everything its fix does not touch: copy the entity from {INSPECT_TOOL} (include Signals) and edit "
                "it. If leaving something out is the fix, name it in the reason"
            )
    return problems


UNREADABLE_MODEL = "reading the model failed twice: the user may have no access to it, or it does not exist"


def unreadable(record: RunRecord) -> str:
    """Why nothing can be read: Azure is blocked for the run, or the model itself could not be read twice."""
    return record.blocked or (UNREADABLE_MODEL if record.read_failures >= 2 and not record.entities else "")


def blocked_problems(result: dict[str, Any], reason: str) -> list[str]:
    """Nothing could be read, so nothing in the result can rest on a reading: it says why and proposes nothing."""
    proposed = result["causes"] if result["kind"] == "explain" else [*result["changes"], *result["verification"]]
    if not proposed:
        return []
    return [
        f"Azure cannot be read for this Task ({reason}), so the result has no readings to rest on: leave "
        "`causes`, `changes` and `verification` empty, and say why in `summary` and one `high` finding"
    ]


DECIDE_AFTER_REPEATS = 1
REDUCE_AFTER_REPEATS = 2
REDUCE_AFTER_TOTAL = 5
MAX_IDLE = 3


def result_problems(result: dict[str, Any], record: RunRecord, folder: Path) -> list[str]:
    """Everything that keeps a result from being accepted: the schema, then the Task, what the run read and ran, what the web
    app would answer, what ties the result to this workload, and how it is written."""
    problems = validate_task_result(result)
    if problems:
        return problems
    if task := task_problems(result, record):
        return task
    if reason := unreadable(record):
        return blocked_problems(result, reason) + plain_problems(result, record) + window_problems(result, record.history_window)
    return (
        unread_problems(record)
        + design_problems(result, record)
        + verification_problems(result, record)
        + change_problems(result, record)
        + removal_problems(result, record)
        + endpoint_problems(result, record)
        + web_problems(result, record)
        + grounded_problems(result, record, folder)
        + plain_problems(result, record)
        + window_problems(result, record.history_window)
    )


def accept(folder: Path, result: dict[str, Any], *, partial: bool = False) -> str:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return json.dumps({"status": "accepted", **({"partial": True} if partial else {})}, separators=(",", ":"))


def log_rejection(folder: Path, record: RunRecord, problems: list[str]) -> None:
    """The problems name entities and rules only: they go to the log, where the web app's timeline (five problems of 200
    characters) cannot show them all."""
    logger.info(
        "submit_result rejected task=%s rejection=%d identical=%d problems=%d",
        folder.name,
        record.rejections,
        record.repeats + 1,
        len(problems),
    )
    for number, problem in enumerate(problems, 1):
        logger.info("submit_result problem %d: %s", number, redact(problem, [record.nonce]))


def read_state(record: RunRecord) -> str:
    """The health state the run read for the entity of an explain, else Unknown."""
    state = (record.entities.get(record.asked) or {}).get("healthState")
    return state if state in HEALTH_STATES else "Unknown"


def forced_result(record: RunRecord, folder: Path, why: str) -> dict[str, Any]:
    """What the agent submits for the model when the Task cannot go on: the parts of its last result that pass every check,
    the others as findings, or an empty result that says why. A Task whose Azure access is blocked proposes nothing."""
    last = record.last_result or {}
    kind = RESULT_KINDS.get(record.task_type) or (last.get("kind") if last.get("kind") in ("explain", "diff") else "diff")
    if reason := unreadable(record):
        last, why = {}, f"Azure cannot be read for this Task ({reason})"
    return reduce_result(
        last, lambda candidate: result_problems(candidate, record, folder), kind=kind, asked=record.asked, why=why, state=read_state(record)
    )


def submit(folder: Path, result: dict[str, Any], record: RunRecord) -> str:
    if record.reduced is not None and result == record.reduced:
        logger.info("submit_result partial result accepted task=%s", folder.name)
        return accept(folder, result, partial=True)
    problems = result_problems(result, record, folder)
    if not problems:
        return accept(folder, result)
    record.rejections += 1
    record.repeats = record.repeats + 1 if problems == record.rejected else 0
    record.rejected, record.last_result, record.idle = problems, result, 0
    log_rejection(folder, record, problems)
    if record.repeats >= REDUCE_AFTER_REPEATS or record.rejections >= REDUCE_AFTER_TOTAL:
        record.reduced = forced_result(record, folder, f"the proposal was rejected {record.rejections} times")
        lines = reduction_notice(result, record.reduced)
    elif record.repeats >= DECIDE_AFTER_REPEATS:
        lines = decision_lines(result, problems, left=REDUCE_AFTER_REPEATS - record.repeats)
    else:
        lines = problems
    return json.dumps({"status": "rejected", "problems": lines}, separators=(",", ":"))


SHELL_DESCRIPTION = (
    "Run a bash command in the Task folder: read files, jq, python. No stdin, no git: repositories are cloned with "
    "clone_repository. Output is capped; filter with grep, head or jq."
)
TYPE_TOOLS = {
    "explain": (SUBMIT_TOOL,),
    "review": (SUBMIT_TOOL,),
    "design": (SHELL_TOOL, CLONE_TOOL, SUBMIT_TOOL),
}


def task_tools(folder: Path, record: RunRecord, wanted: Sequence[str] = (SHELL_TOOL, CLONE_TOOL, SUBMIT_TOOL)) -> list[FunctionTool]:
    @tool(name=SHELL_TOOL, description=SHELL_DESCRIPTION, approval_mode="never_require")
    async def run_shell(
        command: Annotated[str, Field(description="Bash command line.")],
        timeout_seconds: Annotated[
            int, Field(description=f"Hard time limit in seconds, at most {SHELL_TIMEOUT_CAP}.")
        ] = SHELL_TIMEOUT_DEFAULT,
    ) -> str:
        return render_shell_run(await run_command(command, folder, clamp_timeout(timeout_seconds)))

    @tool(
        name=SUBMIT_TOOL,
        description=(
            "Submit the Task result described in the instructions. Returns accepted, or the problems to fix "
            "before submitting again."
        ),
        approval_mode="never_require",
    )
    def submit_result(result: Annotated[dict[str, Any], Field(description="The TaskResult object.")]) -> str:
        return submit(folder, result, record)

    tools = {SHELL_TOOL: run_shell, CLONE_TOOL: clone_tool(folder, record), SUBMIT_TOOL: submit_result}
    return [tools[name] for name in wanted]


def task_vocabulary(envelope: dict[str, Any] | None) -> set[str]:
    """The words the Task itself brings about the workload: its instruction, resource group and repository address."""
    task = envelope["task"] if envelope else {}
    workload = task.get("workload") if isinstance(task.get("workload"), dict) else {}
    texts = [task.get("instruction"), workload.get("resourceGroup"), workload.get("repositoryUrl")]
    return {word for text in texts if isinstance(text, str) for word in words_of(text)}


def task_scope(envelope: dict[str, Any] | None) -> tuple[tuple[str, str] | None, frozenset[str]]:
    """The subscription and resource group of the Task's target, and every resource group the Task names (lower case)."""
    task = envelope["task"] if envelope else {}
    target = task.get("target") if isinstance(task.get("target"), dict) else {}
    workload = task.get("workload") if isinstance(task.get("workload"), dict) else {}
    subscription, group = target.get("subscriptionId"), target.get("resourceGroup")
    scope = (subscription, group) if isinstance(subscription, str) and isinstance(group, str) and subscription and group else None
    groups = {name.lower() for name in (group, workload.get("resourceGroup")) if isinstance(name, str) and name}
    return scope, frozenset(groups)


class TaskTools(ContextProvider):
    """Gives each run the instructions and tools of its Task type, bound to the folder of the Task in its latest user
    message, and fetches the Task's token for the Azure MCP server before the run connects to it. Without a token the run
    goes on without Azure and says why."""

    def __init__(self, workspace: Path, tokens: TokenSource | None = None) -> None:
        super().__init__("task-tools")
        self._workspace = workspace
        self._tokens = tokens

    async def before_run(
        self,
        *,
        agent: SupportsAgentRun,
        session: AgentSession,
        context: SessionContext,
        state: dict[str, Any],
    ) -> None:
        texts = [message.text for message in context.input_messages if message.role == "user"]
        envelope = find_envelope(texts)
        folder = task_folder(self._workspace, envelope["task"] if envelope else None)
        scope, groups = task_scope(envelope)
        instruction = envelope["task"].get("instruction") if envelope else None
        record = RunRecord(
            expected=expected_reads(envelope),
            edges=edges_of(envelope),
            design=bool(envelope) and envelope["task"].get("type") == "design",
            root=target_name(envelope),
            task_type=envelope["task"].get("type", "") if envelope else "",
            asked=asked_entity(envelope),
            nonce=task_nonce(envelope),
            repository=workload_repository(envelope),
            vocabulary=task_vocabulary(envelope),
            folder=folder,
            instruction=instruction if isinstance(instruction, str) else "",
            scope=scope,
            groups=groups,
        )
        CURRENT_RUN.set(record)
        if self._tokens is not None:
            try:
                await self._tokens.token_for(record.nonce)
            except AzureUnavailable as error:
                record.blocked = str(error)
                context.extend_instructions(self.source_id, f"Azure cannot be read for this Task: {error}")
        if text := instructions_for(record.task_type):
            context.extend_instructions(self.source_id, text)
        context.extend_tools(self.source_id, task_tools(folder, record, TYPE_TOOLS.get(record.task_type, tuple(TYPE_TOOLS["design"]))))
