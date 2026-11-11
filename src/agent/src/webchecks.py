"""The checks the web app applies to an accepted result (`src/web/app/model_diff.py`), so that a violation is corrected inside
the run instead of failing the Task after "accepted". Reimplemented here, with the same messages and limits, from what the
run read: `record.entities` and `record.edges` stand for the model the web app compares with."""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from typing import TYPE_CHECKING, Any

from grounding import listing, proposed_edges, signals_of

if TYPE_CHECKING:
    from tools import RunRecord

MAX_CHANGES = 200
MAX_AFTER_BYTES = 64 * 1024


def key(name: Any) -> str:
    return (name or "").casefold()


def folded(text: str) -> str:
    return text.strip().casefold()


def short(text: str, limit: int = 80) -> str:
    return text if len(text) <= limit else f"{text[:limit]}..."


def serialized(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def label_of(number: int, change: Mapping[str, Any]) -> str:
    return f"changes[{number}]: {change['kind']} '{change['name']}'"


def strings(value: Any, skip: tuple[str, ...] = ()) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for name, child in value.items():
            if name not in skip:
                yield from strings(child, skip)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from strings(child, skip)


def action_group_ids(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        for name, child in value.items():
            if name == "actionGroupIds":
                yield from strings(child)
            else:
                yield from action_group_ids(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from action_group_ids(child)


def present_in(record: RunRecord) -> set[str]:
    """Every text the model has, as the web app's base model would: what the entities and relationships read hold."""
    return {folded(text) for text in strings([record.entities, list(record.entities), record.edges, list(record.edges)])}


def in_target_scope(text: str, scope: tuple[str, str] | None) -> bool:
    if scope is None:
        return False
    parts = text.strip().split("/")
    wanted = ["", "subscriptions", scope[0], "resourcegroups", scope[1]]
    return [part.casefold() for part in parts[:5]] == [part.casefold() for part in wanted] and not {".", ".."} & set(parts)


def count_problems(changes: list[Mapping[str, Any]]) -> list[str]:
    if len(changes) > MAX_CHANGES:
        return [f"changes: {len(changes)} changes is more than the {MAX_CHANGES} allowed"]
    return []


def size_problems(changes: list[Mapping[str, Any]]) -> list[str]:
    return [
        f"{label_of(number, change)}: after is {size} bytes; at most {MAX_AFTER_BYTES} are allowed"
        for number, change in enumerate(changes)
        if (size := len(serialized(change["after"]).encode("utf-8"))) > MAX_AFTER_BYTES
    ]


def scope_problems(changes: list[Mapping[str, Any]], scope: tuple[str, str] | None, present: set[str]) -> list[str]:
    if scope is None:
        return []
    return [
        f"{label_of(number, change)}: resource id '{short(text)}' is outside the target's "
        "subscription and resource group and is not used in the model"
        for number, change in enumerate(changes)
        for text in strings(change["after"], skip=("actionGroupIds",))
        if folded(text).startswith("/subscriptions/") and not in_target_scope(text, scope) and folded(text) not in present
    ]


def action_group_problems(changes: list[Mapping[str, Any]], present: set[str]) -> list[str]:
    return [
        f"{label_of(number, change)}: action group '{short(text)}' is not already used in the model"
        for number, change in enumerate(changes)
        for text in action_group_ids(change["after"])
        if folded(text) not in present
    ]


def discovered_problems(changes: list[Mapping[str, Any]], record: RunRecord) -> list[str]:
    discovered = {name for name, properties in record.entities.items() if properties.get("discoveredBy")}
    return [
        f"{label_of(number, change)} was discovered automatically and cannot be {change['op']}d"
        for number, change in enumerate(changes)
        if change["kind"] == "entity" and change["op"] in ("change", "remove") and key(change["name"]) in discovered
    ]


def definitions_used(properties: Mapping[str, Any] | None) -> set[str]:
    """The signal definitions the signals of an entity name."""
    return {signal["signalDefinitionName"] for signal in signals_of(properties) if isinstance(signal.get("signalDefinitionName"), str) and signal["signalDefinitionName"]}


def definition_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """Every signal definition an entity names exists in the model once the result is applied. The run knows the definitions
    the entities it read use and the ones the result adds or removes; without a read entity it knows none. The entities of the
    model read are named in lower case, as `record.entities` has them."""
    if not record.entities:
        return []
    known = {key(name) for properties in record.entities.values() for name in definitions_used(properties)}
    entities = {name: (name, properties) for name, properties in record.entities.items()}
    for change in result["changes"]:
        if change["kind"] == "signalDefinition" and change["op"] == "remove":
            known.discard(key(change["name"]))
        elif change["kind"] == "signalDefinition":
            known.add(key(change["name"]))
        elif change["kind"] == "entity" and change["op"] == "remove":
            entities.pop(change["name"].lower(), None)
        elif change["kind"] == "entity":
            entities[change["name"].lower()] = (change["name"], change["after"] or {})
    return [
        f"entity '{name}' uses signal definition '{definition}', which does not exist in the proposed model; "
        "add the signal definition or stop using it"
        for name, properties in sorted(entities.values(), key=lambda entity: entity[0])
        for definition in sorted(definitions_used(properties), key=key)
        if key(definition) not in known
    ]


def duplicate_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """A relationship is the only one between its parent and child: not a second name for a pair the model has, and not two
    relationships of the result for one pair."""
    proposed = proposed_edges(result, record)
    touched = {change["name"].lower(): change["name"] for change in result["changes"] if change["kind"] == "relationship"}
    problems = []
    for number, change in enumerate(result["changes"]):
        if change["kind"] != "relationship" or change["op"] == "remove":
            continue
        name = change["name"].lower()
        twins = [other for other, ends in proposed.items() if ends == proposed.get(name) and other != name]
        existing = [other for other in twins if other not in touched]
        label = f"{label_of(number, change)} repeats {change['after'].get('parentEntityName')} -> {change['after'].get('childEntityName')}"
        if existing:
            problems.append(f"{label}, which already exists as '{existing[0]}'; use the existing name '{existing[0]}' instead of adding another relationship")
        elif twins:
            problems.append(f"{label}, also used by '{touched[twins[0]]}'; keep only one")
    return problems


def web_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """What the web app would answer to this diff: too many changes alone, else size, scope, action groups, discovery, the
    signal definitions the signals name and the relationships that repeat a pair."""
    if result["kind"] != "diff":
        return []
    changes = result["changes"]
    if too_many := count_problems(changes):
        return too_many
    present = present_in(record)
    return (
        size_problems(changes)
        + scope_problems(changes, record.scope, present)
        + action_group_problems(changes, present)
        + discovered_problems(changes, record)
        + definition_problems(result, record)
        + duplicate_problems(result, record)
    )


def removal_problems(result: Mapping[str, Any], record: RunRecord) -> list[str]:
    """Removing needs what exists to be removed and nothing left that names it: the root stays, an entity that is not in the
    model is not removed, and every relationship that names a removed entity is removed with it."""
    if result["kind"] != "diff":
        return []
    changes = result["changes"]
    problems = []
    removed: dict[str, int] = {}
    for number, change in enumerate(changes):
        name = key(change["name"])
        if change["kind"] == "entity" and change["op"] == "remove":
            removed[name] = number
            if name == record.root:
                problems.append(f"{label_of(number, change)} is the root of the model and cannot be removed")
            elif record.entities and name not in record.entities:
                problems.append(f"{label_of(number, change)} does not exist in the model: leave this change out")
        if change["kind"] == "relationship" and change["op"] == "remove" and record.edges and name not in record.edges:
            problems.append(f"{label_of(number, change)} does not exist in the Task's relationships: leave this change out")
    for name, number in removed.items():
        naming = [relationship for relationship, ends in proposed_edges(result, record).items() if name in ends]
        if naming:
            problems.append(
                f"{label_of(number, changes[number])} is removed, but relationship {listing(naming)} still names it: "
                "add a `remove` change for every relationship that names a removed entity"
            )
    return problems
