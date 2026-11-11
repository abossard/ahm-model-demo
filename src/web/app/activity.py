import json
import re

from config import (
    ERROR_MESSAGE_CHARS,
    PROBLEM_CHARS,
    PROBLEM_LIMIT,
    PROBLEM_TEXT_CHARS,
    REDACTED_TOKEN,
    TOKEN_MARKER,
    TOKEN_PATTERN,
    TOKEN_RUN,
)


TEXT_LIMIT = 8000
ARGUMENT_LIMIT = 2000
SUMMARY_LIMIT = 160
IDLE_EVENTS = ("response.created", "response.in_progress", "response.queued", "response.failed", "error")
SERVER_ERROR_MESSAGE = (
    "The agent service reported an internal error. "
    "A busy model deployment is the usual cause, so try again in a few minutes."
)


def redact(text):
    pieces, copied, position = [], 0, text.find(TOKEN_MARKER)
    while position != -1:
        token = TOKEN_PATTERN.match(text, position)
        if token:
            pieces += [text[copied:position], REDACTED_TOKEN]
            copied = position = token.end()
            position = text.find(TOKEN_MARKER, position)
        else:
            run = TOKEN_RUN.match(text, position + len(TOKEN_MARKER))
            position = text.find(TOKEN_MARKER, run.end() if run else position + 1)
    return "".join([*pieces, text[copied:]]) if pieces else text


def scrub(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {name: scrub(child) for name, child in value.items()}
    if isinstance(value, list):
        return [scrub(child) for child in value]
    return value


def clip(text, limit):
    if len(text) <= limit:
        return text
    return f"{text[:limit]}... [{len(text) - limit} more characters]"


def clip_problems(problems, each=PROBLEM_TEXT_CHARS):
    """Every problem, redacted and clipped, until the count or the total size is reached. A last line counts the rest."""
    shown, used = [], 0
    for problem in problems:
        text = redact(str(problem))
        text = text if each is None else clip(text, each)
        if len(shown) >= PROBLEM_LIMIT or used + len(text) > PROBLEM_CHARS:
            break
        shown.append(text)
        used += len(text)
    left = len(problems) - len(shown)
    return [*shown, f"{left} more problems not shown"] if left else shown


def listed(value):
    if isinstance(value, list):
        return value
    return [value] if value else []


def safe_message(text, limit=ERROR_MESSAGE_CHARS):
    text = redact(str(text))
    return text if len(text) <= limit else f"{text[: limit - 3]}..."


def draft(kind, summary, payload=None):
    return {
        "kind": kind,
        "summary": clip(redact(summary), SUMMARY_LIMIT),
        "payload": scrub(payload or {}),
    }


def new_state():
    return {
        "texts": {},
        "emitted": frozenset(),
        "calls": {},
        "accepted": None,
        "failure": None,
        "rejection": None,
        "worked": False,
    }


def parse_json(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def first_document(text):
    try:
        return json.JSONDecoder().raw_decode(text.lstrip())[0]
    except ValueError:
        return None


def parse_arguments(text):
    value = first_document(text) if isinstance(text, str) else text
    return value if isinstance(value, dict) else {}


def lookup(arguments):
    names = {re.sub(r"[-_]", "", name).lower(): value for name, value in arguments.items()}

    def arg(*wanted):
        for name in wanted:
            value = names.get(name)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    return arg


def result_from(arguments):
    value = arguments.get("result")
    if isinstance(value, dict):
        return value
    return arguments if "kind" in arguments else None


def result_label(result):
    if not isinstance(result, dict):
        return "result"
    if result.get("kind") == "diff":
        return f"diff, {len(result.get('changes') or [])} changes"
    if result.get("kind") == "explain":
        return f"explain, {len(result.get('causes') or [])} causes"
    return "result"


def tool_title(name, arguments):
    arg = lookup(arguments)
    model = arg("healthmodel", "model", "healthmodelname")
    if name == "load_skill":
        return f"Load skill {arg('name', 'skill', 'skillname') or ''}".strip()
    if name == "read_skill_resource":
        parts = [arg("skill", "skillname"), arg("resource", "resourcename", "path", "name")]
        return "Read skill resource" + (f" {'/'.join(p for p in parts if p)}" if any(parts) else "")
    if name == "run_shell":
        return f"Run shell: {clip(arg('command') or '', 80)}".rstrip(": ")
    if name == "submit_result":
        return f"Submit result ({result_label(result_from(arguments))})"
    if name == "monitor_healthmodels_list":
        return "List health models"
    if name == "monitor_healthmodels_get":
        return f"Get health model {model}" if model else "Get health model"
    if name == "monitor_healthmodels_inspect":
        details = [
            f"entity {arg('entity')}" if arg("entity") else None,
            f"walk {arg('walk')}" if arg("walk") else None,
        ]
        details = ", ".join(d for d in details if d)
        return (
            "Inspect health model"
            + (f" {model}" if model else "")
            + (f" ({details})" if details else "")
        )
    if name == "monitor_metrics_definitions":
        return "List metric definitions"
    if name == "monitor_metrics_query":
        metric = arg("metricnames", "metricname", "metrics")
        return "Query metrics" + (f" {clip(metric, 60)}" if metric else "")
    if name == "monitor_workspace_log_query":
        return "Run log query" + (f" on {arg('table')}" if arg("table") else "")
    if name == "group_resource_list":
        group = arg("resourcegroup")
        return f"List resources in {group}" if group else "List resources"
    if name == "monitor_activitylog_list":
        return "List activity log"
    if name == "clone_repository":
        repository = (arg("url") or "").removeprefix("https://github.com/").strip("/")
        return f"Clone repository {clip(repository, 80)}".rstrip()
    return name or "tool"


def output_text(output):
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in output
        )
    return "" if output is None else json.dumps(output)


def looks_failed(text):
    if text.lstrip()[:5].lower() == "error":
        return True
    value = parse_json(text)
    if not isinstance(value, dict):
        return False
    return bool(
        value.get("error")
        or value.get("isError")
        or value.get("is_error")
        or str(value.get("status", "")).lower() in ("error", "failed")
    )


def size_text(size):
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def mark(state, *keys):
    return {**state, "emitted": state["emitted"] | frozenset(keys)}


def on_created(state, data):
    response = data.get("response") or {}
    return state, [draft("status", "Agent started", {"responseId": response.get("id")})]


def on_text_delta(state, data):
    item, delta = data.get("item_id"), data.get("delta")
    if not isinstance(item, str) or not isinstance(delta, str):
        return state, []
    texts = {**state["texts"], item: state["texts"].get(item, "") + delta}
    return {**state, "texts": texts}, []


def text_draft(text):
    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return draft("text", first_line, {"text": clip(redact(text), TEXT_LIMIT)})


def finish_message(state, item):
    item_id = item.get("id")
    if ("text", item_id) in state["emitted"]:
        return state, []
    parts = [
        part.get("text", "")
        for part in item.get("content") or []
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    text = "".join(parts) or state["texts"].get(item_id, "")
    state = mark(state, ("text", item_id))
    return state, [text_draft(text)] if text.strip() else []


def record_call(state, item):
    call_id = item.get("call_id") or item.get("id")
    known = state["calls"].get(call_id, {})
    arguments = redact(item["arguments"]) if isinstance(item.get("arguments"), str) else None
    call = {
        "name": item.get("name") or known.get("name"),
        "arguments": arguments if arguments else known.get("arguments", ""),
    }
    return call_id, {**state, "calls": {**state["calls"], call_id: call}}


def finish_call(state, item):
    call_id, state = record_call(state, item)
    if ("call", call_id) in state["emitted"]:
        return state, []
    call = state["calls"][call_id]
    parsed = parse_arguments(call["arguments"])
    event = draft(
        "tool_call",
        tool_title(call["name"], parsed),
        {
            "callId": call_id,
            "name": call["name"],
            "arguments": clip(call["arguments"], ARGUMENT_LIMIT),
        },
    )
    return mark(state, ("call", call_id)), [event]


def finish_output(state, item):
    call_id = item.get("call_id") or item.get("id")
    if ("result", call_id) in state["emitted"]:
        return state, []
    call = state["calls"].get(call_id, {})
    name = item.get("name") or call.get("name")
    text = output_text(item.get("output"))
    size = len(text.encode("utf-8"))
    title = tool_title(name, parse_arguments(call.get("arguments")))
    payload = {"callId": call_id, "name": name, "size": size}
    state = mark(state, ("result", call_id))
    if name == "submit_result":
        return finish_submission(state, call, title, text, payload)
    ok = not looks_failed(text)
    summary = f"{title}: {'ok' if ok else 'failed'}, {size_text(size)}"
    return state, [draft("tool_result", summary, {**payload, "ok": ok})]


def finish_submission(state, call, title, text, payload):
    status = parse_json(text)
    status = status if isinstance(status, dict) else {}
    if status.get("status") != "accepted":
        problems = listed(status.get("problems"))
        shown = clip_problems(problems)
        summary = f"{title}: rejected ({len(problems)} {'problem' if len(problems) == 1 else 'problems'})"
        payload = {**payload, "ok": False, "problems": shown}
        rejection = {"problems": shown, "count": len(problems)}
        return {**state, "rejection": rejection}, [draft("tool_result", summary, payload)]
    events = [draft("tool_result", f"{title}: accepted", {**payload, "ok": True})]
    result = result_from(parse_arguments(call.get("arguments")))
    if result is None:
        return state, events
    label = result_label(result)
    events.append(
        draft("result", f"Result accepted ({label})", {"resultKind": result.get("kind")})
    )
    return {**state, "accepted": result}, events


def on_item_added(state, data):
    item = data.get("item")
    if not isinstance(item, dict):
        return state, []
    if item.get("type") == "function_call":
        return record_call(state, item)[1], []
    if item.get("type") == "function_call_output" and item.get("output") is not None:
        return finish_output(state, item)
    return state, []


def on_item_done(state, data):
    item = data.get("item")
    if not isinstance(item, dict):
        return state, []
    kind = item.get("type")
    if kind == "message":
        return finish_message(state, item)
    if kind == "function_call":
        return finish_call(state, item)
    if kind == "function_call_output":
        return finish_output(state, item)
    return state, []


def on_completed(state, data):
    response = data.get("response") or {}
    return state, [draft("status", "Agent finished", {"responseId": response.get("id")})]


def on_incomplete(state, data):
    response = data.get("response") or {}
    reason = safe_message((response.get("incomplete_details") or {}).get("reason") or "unknown reason")
    return state, [draft("status", f"Agent stopped early ({reason})", {"reason": reason})]


def failed(state, error):
    error = error if isinstance(error, dict) else {}
    detail = str(error.get("message") or "The agent failed.")
    code = safe_message(error.get("code") or "agent_failed")
    failure = {"code": code, "message": SERVER_ERROR_MESSAGE if code == "server_error" else safe_message(detail)}
    state = {**state, "failure": {**failure, "detail": redact(detail)}}
    if state["accepted"] is not None:
        summary = f"Agent reported a failure after the result was accepted ({code})"
        return state, [draft("status", summary, failure)]
    return state, [draft("error", failure["message"], failure)]


def on_failed(state, data):
    return failed(state, (data.get("response") or {}).get("error"))


def on_error(state, data):
    return failed(state, data)


HANDLERS = {
    "response.created": on_created,
    "response.output_text.delta": on_text_delta,
    "response.output_item.added": on_item_added,
    "response.output_item.done": on_item_done,
    "response.completed": on_completed,
    "response.incomplete": on_incomplete,
    "response.failed": on_failed,
    "error": on_error,
}


def reduce_event(state, name, data):
    if name not in IDLE_EVENTS and not state["worked"]:
        state = {**state, "worked": True}
    handler = HANDLERS.get(name)
    if handler is None or not isinstance(data, dict):
        return state, []
    return handler(state, data)


def finish(state):
    events = []
    for item_id, text in state["texts"].items():
        if ("text", item_id) not in state["emitted"] and text.strip():
            events.append(text_draft(text))
            state = mark(state, ("text", item_id))
    return state, events


def accepted_result(state):
    return state["accepted"]


def failure(state):
    return state["failure"]


def last_rejection(state):
    return state["rejection"]


def is_busy(state):
    """The service failed with `server_error`, which is how a busy model deployment answers, and nothing has run yet."""
    failed_with = state["failure"]
    return failed_with is not None and failed_with["code"] == "server_error" and not state["worked"]
