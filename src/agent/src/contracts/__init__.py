import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

SCHEMA_PATH = Path(__file__).with_name("task-result.schema.json")
RESOURCE_SCHEMA_PATH = Path(__file__).with_name("model-resources.schema.json")
MAX_PROBLEMS = 20
MAX_PROBLEM_CHARS = 240

_SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
_VALIDATOR = Draft202012Validator(_SCHEMA)
_NAME_PATTERN = _SCHEMA["$defs"]["armName"]["pattern"]
_RESOURCE_DEFS = json.loads(RESOURCE_SCHEMA_PATH.read_text(encoding="utf-8"))["$defs"]
_RESOURCE_VALIDATORS = {
    kind: Draft202012Validator({"$ref": f"#/$defs/{kind}", "$defs": _RESOURCE_DEFS})
    for kind in ("entity", "relationship", "signalDefinition")
}


def validate_task_result(result: object) -> list[str]:
    """Problems that keep a TaskResult from being accepted, worded for the model. Empty when valid."""
    problems = _unique(describe(error) for error in _VALIDATOR.iter_errors(result))
    if not problems:
        problems = semantic_problems(result)
    if len(problems) > MAX_PROBLEMS:
        problems = [*problems[:MAX_PROBLEMS], f"{len(problems) - MAX_PROBLEMS} more problems not shown"]
    return problems


def describe(error: ValidationError, prefix: tuple[str | int, ...] = ()) -> str:
    message = error.message
    if len(message) > MAX_PROBLEM_CHARS:
        message = f"{message[:MAX_PROBLEM_CHARS]}..."
    if error.validator == "required":
        message += " (add it)"
    return f"{path_text((*prefix, *error.absolute_path))}: {message}"


def path_text(path: Iterable[str | int]) -> str:
    text = ""
    for part in path:
        text += f"[{part}]" if isinstance(part, int) else f".{part}"
    return text.lstrip(".") or "result"


def semantic_problems(result: dict[str, Any]) -> list[str]:
    """What the result schema cannot say: unique change ids, one change per resource, findings naming existing ids,
    whole-string names and the shape of every `after` (the API's own property names, which the result schema leaves open).

    The schema pattern is checked with Python's `$`, which also accepts a trailing newline: names are matched again.
    """
    if result["kind"] != "diff":
        return []
    ids = [change["id"] for change in result["changes"]]
    problems = [f"changes: id '{id_}' is used more than once" for id_ in sorted({i for i in ids if ids.count(i) > 1})]
    problems += [
        f"changes[{index}].name: {change['name']!r} does not match {_NAME_PATTERN!r} as a whole"
        for index, change in enumerate(result["changes"])
        if not re.fullmatch(_NAME_PATTERN, change["name"])
    ]
    first: dict[tuple[str, str], str] = {}
    for index, change in enumerate(result["changes"]):
        slot = (change["kind"], change["name"].lower())
        if slot in first:
            problems.append(
                f"changes[{index}]: {change['kind']} '{change['name']}' is already changed by '{first[slot]}'; "
                "put both fixes into one change"
            )
        first.setdefault(slot, change["id"])
    for index, finding in enumerate(result["findings"]):
        problems += [
            f"findings[{index}].changeIds: no change has id '{id_}'" for id_ in finding["changeIds"] if id_ not in ids
        ]
    for index, change in enumerate(result["changes"]):
        if change["after"] is not None:
            problems += [
                describe(error, ("changes", index, "after"))
                for error in _RESOURCE_VALIDATORS[change["kind"]].iter_errors(change["after"])
            ]
    return problems


def _unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))
