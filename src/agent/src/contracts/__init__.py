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


def submission_schema(kind: str | None, entity: str = "", builder: dict | None = None,
                      window: dict[str, str] | None = None, *, next_steps: bool = False) -> dict | None:
    """Describe only this Task's result in the hosted tool's existing result argument."""
    if kind is None:
        return None
    resources = builder.get("resources", []) if builder else []
    refs = [r["ref"] for r in resources] if all(r.get("ref") for r in resources) else []

    def inline(node):
        if isinstance(node, list):
            return [inline(item) for item in node]
        if isinstance(node, dict):
            if "$ref" in node:
                if refs and node["$ref"] == "#/$defs/builderResourceId":
                    return {"type": "string", "enum": refs}
                return inline(_SCHEMA["$defs"][node["$ref"].removeprefix("#/$defs/")])
            result = {key: inline(value) for key, value in node.items()}
            # Foundry function parameters require an explicit type for string consts and enums.
            if "type" not in node and (isinstance(node.get("const"), str)
                                       or (node.get("enum") and all(isinstance(v, str) for v in node["enum"]))):
                result["type"] = "string"
            return result
        return node

    result = inline(_SCHEMA["$defs"][kind])
    # The submit tool attaches the buttons the run actually prepared.
    result["properties"].pop("showMe", None)
    if not next_steps:
        result["properties"].pop("nextSteps", None)
    if kind == "explain":
        fields = result["properties"]
        if entity:
            fields["entity"] = {"type": "string", "const": entity}
        if window is None:
            del fields["window"]
        else:
            result["required"].append("window")
            for name, value in window.items():
                fields["window"]["properties"][name]["const"] = value
    if kind == "builderAnalysis" and builder and builder.get("resources"):
        fields = result["properties"]
        count = len(builder["resources"])
        fields["rows"].update(minItems=count, maxItems=count,
                              description=f"One row for each of the {count} resources in builder.resources, including resources without telemetry.")
        fields["plan"]["properties"]["flows"]["description"] = (
            f"Place all {count} selected resource IDs exactly once across the components of these flows.")
        choice = fields["plan"]["properties"]["decisions"]["items"]["properties"]["choice"]
        choice["description"] = f"Short title (at most {choice['maxLength']} characters). Put the explanation in reason."
        measured = len({m["resourceId"].casefold() for m in builder.get("observedMetrics", [])})
        fields["metrics"]["description"] = (
            f"Resources with observed metrics: {measured}. Account for each exactly once, "
            "in metrics with a measured signal or in omittedMetrics with its operational reason.")
    return {"type": "object", "required": ["result"], "additionalProperties": False,
            "properties": {"result": result}}


def validate_task_result(result: object) -> list[str]:
    """Problems that keep a TaskResult from being accepted, worded for the model. Empty when valid."""
    builder_analysis = isinstance(result, dict) and result.get("kind") == "builderAnalysis"
    problems = _unique((builder_correction(error) if builder_analysis else "") or describe(error)
                       for error in _VALIDATOR.iter_errors(result))
    if not problems:
        problems = semantic_problems(result)
    if len(problems) > MAX_PROBLEMS:
        problems = [*problems[:MAX_PROBLEMS], f"{len(problems) - MAX_PROBLEMS} more problems not shown"]
    return problems


def builder_correction(error: ValidationError) -> str:
    path = tuple(error.absolute_path)
    if error.validator == "maxLength" and path[-1:] == ("choice",):
        return (f"{path_text(path)}: shorten this decision title to {error.validator_value} characters "
                f"(currently {len(error.instance)}). Put its explanation in reason.")
    if path[:-1] == ("plan", "flows") and error.validator == "type":
        return f"{path_text(path)}: supply a flow object with name, objective, components and failureScenario."
    if error.validator != "additionalProperties" or not (path in ((), ("plan",)) or path[:-1] == ("plan", "flows")):
        return ""
    extra = error.instance.keys() - error.schema["properties"].keys()
    plan = _SCHEMA["$defs"]["builderPlan"]["properties"]
    locations = [("result", _SCHEMA["$defs"]["builderAnalysis"]["properties"]),
                 ("plan", plan), ("each flow", plan["flows"]["items"]["properties"])]
    destinations = [f"Move {name} to {location}" for name in sorted(extra)
                    for location, fields in locations if name in fields]
    # Keep the validator's names for every unrecognized field too.
    return describe(error) + ". " + ". ".join(destinations) if destinations else ""


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
    first: dict[tuple[str, str], tuple[str, str]] = {}
    for index, change in enumerate(result["changes"]):
        slot = (change["kind"], change["name"].lower())
        if slot in first:
            earlier, op = first[slot]
            problems.append(
                f"changes[{index}]: {change['kind']} '{change['name']}' is removed and added in one result, which would delete "
                "the new one (removals run after additions): add the replacement under another name"
                if {op, change["op"]} == {"remove", "add"}
                else f"changes[{index}]: {change['kind']} '{change['name']}' is already changed by '{earlier}'; put both fixes into one change"
            )
        first.setdefault(slot, (change["id"], change["op"]))
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
