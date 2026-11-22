"""The wire contract shared by the web and agent images. Only the browser executes a handle."""

import json
import re
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator

_DEFS = json.loads(Path(__file__).with_name("task-result.schema.json").read_text(encoding="utf-8"))["$defs"]
HANDLES_SCHEMA = _DEFS["showMeHandles"]
_HANDLES = Draft202012Validator(HANDLES_SCHEMA)
_ACTION = Draft202012Validator(_DEFS["showMeAction"])
_CONTROL = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")
_MARKER = re.compile(r"[ \t]*\[\[show:([0-9]+)\]\]")
MAX_ACTIONS = _DEFS["showMe"]["maxProperties"]


def catalog_problem(handles):
    if not _HANDLES.is_valid(handles):
        return "Use up to 16 handles with a lowercase kebab-case name, description and idDescription."
    if len({h["name"] for h in handles}) != len(handles):
        return "Each handle needs a unique name."
    if any(_CONTROL.search(s) for h in handles for s in h.values()):
        return "Handle descriptions and names must be single-line text."
    if any(h["idDescription"] and not h["idDescription"].strip() for h in handles):
        return "Describe the id or use an empty string when the handle takes no id."
    return ""


def tool_schema(handles):
    schema = _DEFS["showMeAction"]
    return {**schema, "properties": {**schema["properties"], "handle": {"type": "string", "enum": [h["name"] for h in handles]}}}


def action_problem(action, handles):
    if not _ACTION.is_valid(action):
        return "Use handle, optional id and optional highlight with a palette color or short label."
    handle = next((h for h in handles if h["name"] == action["handle"]), None)
    if handle is None:
        return "Choose a handle offered by this Task."
    if bool(handle["idDescription"]) != ("id" in action):
        return "Supply an id as described by the handle." if handle["idDescription"] else "This handle takes no id."
    if any(_CONTROL.search(s) for s in (action.get("id", ""), action.get("highlight", {}).get("label", ""))):
        return "Use single-line text for the id and label."
    return ""


def prose_fields(result):
    """Fields rendered as interactive prose. Identifiers and deployment properties stay plain."""
    if "summary" in result:
        yield result, "summary"
    for collection, field in (("causes", "note"), ("findings", "text"), ("changes", "reason")):
        for row in result.get(collection, []):
            yield row, field
    for decision in result.get("plan", {}).get("decisions", []):
        yield decision, "reason"
    for proposal in result.get("proposals", []):
        yield proposal, "summary"
        yield proposal, "tradeoff"


def referenced_keys(result):
    prose = {key for row, field in prose_fields(result) for key in _MARKER.findall(row[field])}
    return prose | {step["id"] for step in result.get("nextSteps", [])}


def reference_problem(result, buttons):
    if not referenced_keys(result) <= buttons.keys():
        return "Use only Show me ids returned by show_me for this Task."
    labels, targets = set(), set()
    for step in result.get("nextSteps", []):
        label = step["label"].strip().casefold()
        if _CONTROL.search(step["label"]) or "[[show:" in label:
            return "Use plain single-line text for each next step label."
        action = buttons[step["id"]]
        target = (action["handle"], action.get("id"))
        if label in labels or target in targets:
            return "Give each next step a distinct label and destination."
        labels.add(label)
        targets.add(target)
    return placement_problem(result)


def _without_buttons(result):
    clean = deepcopy(result)
    clean.pop("showMe", None)
    clean.pop("nextSteps", None)
    for row, field in prose_fields(clean):
        if _MARKER.search(row[field]):
            row[field] = _MARKER.sub("", row[field]).strip()
    return clean


def plain_result(result):
    """A semantic copy for subsequent Tasks, previews and Azure writes. Old answers can contain literal bracket text."""
    return _without_buttons(result) if result.get("showMe") else result


def placement_problem(result):
    """Catch button syntax in model properties, IDs and other fields that never display buttons."""
    if "[[show:" not in json.dumps(result):
        return ""
    plain = _without_buttons(result)
    if _MARKER.search(json.dumps(plain)):
        return "Place Show me markers only in the answer's supported prose fields."
    if any(not plain_row[key].strip() for plain_row, key in prose_fields(plain)):
        return "Keep an explanation beside each Show me button."
    return ""


def result_problem(result, handles):
    actions = result.get("showMe", {})
    # Older answers may contain literal marker-like text. They have no clickable references.
    if not actions and not handles and "nextSteps" not in result:
        return ""
    if problem := reference_problem(result, actions):
        return problem
    if referenced_keys(result) != actions.keys():
        return "Every saved Show me action must appear in the answer or its next steps."
    return next((p for action in actions.values() if (p := action_problem(action, handles))), "")
