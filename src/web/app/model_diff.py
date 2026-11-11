import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator

from config import ARM_NAME, MAX_AFTER_BYTES, MAX_CHANGES
from dto import field, graph_dto, signal_group_values


SCHEMA_PATH = Path(__file__).resolve().parent / "contracts" / "task-result.schema.json"
VALIDATOR = Draft202012Validator(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))

COLLECTIONS = {
    "entity": "entities",
    "signalDefinition": "signalDefinitions",
    "relationship": "relationships",
}
WRITE_RANK = {"signalDefinition": 0, "entity": 1, "relationship": 2}
SYSTEM_PATHS = (
    ("provisioningState",),
    ("healthState",),
    ("discoveredBy",),
    ("signalGroups", "external"),
    ("signalGroups", "*", "signals", "[]", "status"),
    ("signalGroups", "azureResource", "resourceHealth", "signalName"),
    ("signalGroups", "azureResource", "resourceHealth", "status"),
    ("signalAggregationGroups", "[]", "aggregatedHealthState"),
    ("signalAggregationGroups", "[]", "unresolvedMembers"),
)
MAX_PROBLEMS = 20
MAX_PROBLEM_CHARS = 240
UNSEEN_PROPERTIES = ("canvasPosition", "icon", "alerts", "tags")


def key(name):
    return (name or "").casefold()


def model_id(target):
    return (
        f"/subscriptions/{target['subscriptionId']}/resourceGroups/{target['resourceGroup']}"
        f"/providers/Microsoft.CloudHealth/healthmodels/{target['name']}"
    )


def properties_of(item):
    return (item or {}).get("properties") or {}


def collection(raw_model, kind):
    return (raw_model or {}).get(COLLECTIONS[kind]) or []


def index_of(raw_model, kind):
    return {key(item["name"]): item for item in collection(raw_model, kind)}


def is_system(path):
    return any(
        len(rule) == len(path) and all(r in ("*", p) for r, p in zip(rule, path))
        for rule in SYSTEM_PATHS
    )


def strip_system(value, path=()):
    if isinstance(value, dict):
        return {
            name: strip_system(child, path + (name,))
            for name, child in value.items()
            if not is_system(path + (name,))
        }
    if isinstance(value, list):
        return [strip_system(child, path + ("[]",)) for child in value]
    return value


def canonical(value):
    if isinstance(value, dict):
        return {name: canonical(child) for name, child in value.items()}
    if isinstance(value, list):
        items = [canonical(child) for child in value]
        if items and all(
            isinstance(item, dict) and isinstance(item.get("name"), str) for item in items
        ):
            return sorted(items, key=lambda item: item["name"])
        return items
    return value


def normalize(raw_model):
    return {
        name: sorted(
            (
                {
                    "name": item["name"],
                    "properties": canonical(strip_system(properties_of(item))),
                }
                for item in collection(raw_model, kind)
            ),
            key=lambda item: item["name"],
        )
        for kind, name in COLLECTIONS.items()
    }


def fingerprint(raw_model):
    text = json.dumps(
        normalize(raw_model), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def references(properties):
    return {
        name
        for group in signal_group_values((properties or {}).get("signalGroups"))
        for signal in field(group, "signals", default=[]) or []
        if (name := field(signal, "signalDefinitionName"))
    }


def endpoints(properties):
    properties = properties or {}
    return properties.get("parentEntityName"), properties.get("childEntityName")


def pair_of(properties):
    return tuple(key(end) for end in endpoints(properties))


def touches(properties, entity_name):
    return key(entity_name) in {key(end) for end in endpoints(properties)}


def relationship_summaries(raw_model):
    return [
        {"name": item["name"], "parent": parent, "child": child}
        for item in sorted(collection(raw_model, "relationship"), key=lambda i: i["name"])
        for parent, child in [endpoints(properties_of(item))]
        if parent and child
    ]


def path_text(path):
    text = ""
    for part in path:
        text += f"[{part}]" if isinstance(part, int) else f".{part}"
    return text.lstrip(".") or "result"


def describe(error):
    message = error.message
    if len(message) > MAX_PROBLEM_CHARS:
        message = f"{message[:MAX_PROBLEM_CHARS]}..."
    return f"{path_text(error.absolute_path)}: {message}"


def strings(value, skip=()):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for name, child in value.items():
            if name not in skip:
                yield from strings(child, skip)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child, skip)


def action_group_ids(value):
    if isinstance(value, dict):
        for name, child in value.items():
            if name == "actionGroupIds":
                yield from strings(child)
            else:
                yield from action_group_ids(child)
    elif isinstance(value, list):
        for child in value:
            yield from action_group_ids(child)


def folded(text):
    return text.strip().casefold()


def present_in(base):
    return {folded(text) for text in strings(base)}


def in_target_scope(text, target):
    if target is None:
        return False
    parts = text.strip().split("/")
    scope = ["", "subscriptions", target["subscriptionId"], "resourcegroups", target["resourceGroup"]]
    return [part.casefold() for part in parts[:5]] == [part.casefold() for part in scope] and not {
        ".",
        "..",
    } & set(parts)


def label_of(number, change):
    return f"changes[{number}]: {change['kind']} '{change['name']}'"


def short(text, limit=80):
    return text if len(text) <= limit else f"{text[:limit]}..."


def serialized(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def count_problems(changes):
    if len(changes) > MAX_CHANGES:
        return [f"changes: {len(changes)} changes is more than the {MAX_CHANGES} allowed"]
    return []


def name_problems(changes):
    return [
        f"changes[{number}].name: {change['name']!r} is not a valid resource name"
        for number, change in enumerate(changes)
        if not ARM_NAME.fullmatch(change["name"])
    ]


def size_problems(changes):
    return [
        f"{label_of(number, change)}: after is {size} bytes; at most {MAX_AFTER_BYTES} are allowed"
        for number, change in enumerate(changes)
        if (size := len(serialized(change["after"]).encode("utf-8"))) > MAX_AFTER_BYTES
    ]


def scope_problems(changes, target, present):
    return [
        f"{label_of(number, change)}: resource id '{short(text)}' is outside the target's "
        "subscription and resource group and is not used in the model"
        for number, change in enumerate(changes)
        for text in strings(change["after"], skip=("actionGroupIds",))
        if folded(text).startswith("/subscriptions/")
        and not in_target_scope(text, target)
        and folded(text) not in present
    ]


def action_group_problems(changes, present):
    return [
        f"{label_of(number, change)}: action group '{short(text)}' is not already used in the model"
        for number, change in enumerate(changes)
        for text in action_group_ids(change["after"])
        if folded(text) not in present
    ]


def discovered_problems(changes, base):
    discovered = {
        key(item["name"])
        for item in collection(base, "entity")
        if properties_of(item).get("discoveredBy")
    }
    return [
        f"{label_of(number, change)} was discovered automatically and cannot be {change['op']}d"
        for number, change in enumerate(changes)
        if change["kind"] == "entity"
        and change["op"] in ("change", "remove")
        and key(change["name"]) in discovered
    ]


def reference_problems(result):
    changes = result["changes"]
    ids = [change["id"] for change in changes]
    problems = [
        f"changes: id '{id_}' is used more than once"
        for id_ in sorted({i for i in ids if ids.count(i) > 1})
    ]
    for number, finding in enumerate(result["findings"]):
        problems += [
            f"findings[{number}].changeIds: no change has id '{id_}'"
            for id_ in finding["changeIds"]
            if id_ not in ids
        ]
    seen = {}
    for number, change in enumerate(changes):
        slot = (change["kind"], key(change["name"]))
        if slot in seen:
            problems.append(
                f"changes[{number}]: {change['kind']} '{change['name']}' is already "
                f"changed by '{seen[slot]}'"
            )
        seen.setdefault(slot, change["id"])
        if change["kind"] == "relationship" and change["op"] != "remove":
            for name in ("parentEntityName", "childEntityName"):
                value = (change["after"] or {}).get(name)
                if not isinstance(value, str) or not value:
                    problems.append(
                        f"changes[{number}].after: relationship '{change['name']}' "
                        f"needs the entity name in {name}"
                    )
    return problems


def base_problems(result, base):
    changes = result["changes"]
    problems = []
    for number, change in enumerate(changes):
        exists = key(change["name"]) in index_of(base, change["kind"])
        label = f"changes[{number}]: {change['kind']} '{change['name']}'"
        if change["op"] == "add" and exists:
            problems.append(f"{label} already exists in the model; use op 'change'")
        if change["op"] in ("change", "remove") and not exists:
            problems.append(f"{label} does not exist in the model; use op 'add'")
    proposed = proposed_model(base, changes)
    entity_names = {key(item["name"]) for item in proposed["entities"]}
    for item in proposed["relationships"]:
        for role, name in zip(("parent", "child"), endpoints(properties_of(item))):
            if name and key(name) not in entity_names:
                problems.append(
                    f"relationship '{item['name']}' {role} entity '{name}' does not "
                    "exist in the proposed model; remove the relationship or add the entity"
                )
    touched = {key(c["name"]) for c in changes if c["kind"] == "relationship"}
    for number, change in enumerate(changes):
        if change["kind"] != "relationship" or change["op"] == "remove":
            continue
        parent, child = endpoints(change["after"])
        twins = [
            item["name"]
            for item in proposed["relationships"]
            if pair_of(properties_of(item)) == pair_of(change["after"])
            and key(item["name"]) != key(change["name"])
        ]
        existing = [name for name in twins if key(name) not in touched]
        label = f"changes[{number}]: relationship '{change['name']}' repeats {parent} -> {child}"
        if existing:
            problems.append(
                f"{label}, which already exists as '{existing[0]}'; use the existing "
                f"name '{existing[0]}' instead of adding another relationship"
            )
        elif twins:
            problems.append(f"{label}, also used by '{twins[0]}'; keep only one")
    return problems


def validate_result(result, base=None, target=None):
    changes = result.get("changes") if isinstance(result, dict) else None
    too_many = count_problems(changes) if isinstance(changes, list) else []
    if too_many:
        return too_many
    errors = sorted(
        VALIDATOR.iter_errors(result), key=lambda e: (path_text(e.absolute_path), e.message)
    )
    problems = list(dict.fromkeys(describe(error) for error in errors))
    if not problems and result["kind"] == "diff":
        present = present_in(base) if base is not None else set()
        problems = (
            reference_problems(result)
            + name_problems(result["changes"])
            + size_problems(result["changes"])
            + scope_problems(result["changes"], target, present)
        )
        if base is not None:
            problems += (
                base_problems(result, base)
                + action_group_problems(result["changes"], present)
                + discovered_problems(result["changes"], base)
            )
    if len(problems) > MAX_PROBLEMS:
        problems = [*problems[:MAX_PROBLEMS], f"{len(problems) - MAX_PROBLEMS} more problems not shown"]
    return problems


def carry_group(old, group):
    if not (
        isinstance(old, dict)
        and isinstance(group, dict)
        and isinstance(group.get("signals"), list)
    ):
        return group
    statuses = {
        signal["name"]: signal["status"]
        for signal in old.get("signals") or []
        if isinstance(signal, dict) and "status" in signal and "name" in signal
    }
    return {
        **group,
        "signals": [
            {**signal, "status": statuses[signal["name"]]}
            if isinstance(signal, dict)
            and signal.get("name") in statuses
            and "status" not in signal
            else signal
            for signal in group["signals"]
        ],
    }


def carry_system(previous, after):
    carried = dict(after)
    for name in ("healthState", "provisioningState", "discoveredBy"):
        if name in previous and name not in after:
            carried[name] = previous[name]
    groups, old = after.get("signalGroups"), previous.get("signalGroups")
    if isinstance(groups, dict) and isinstance(old, dict):
        carried["signalGroups"] = {
            name: carry_group(old.get(name), group) for name, group in groups.items()
        }
    return carried


def carry_unseen(change, existing):
    after = change["after"]
    if after is None or change["kind"] != "entity" or change["op"] != "change" or existing is None:
        return after
    previous = properties_of(existing)
    return {**after, **{name: previous[name] for name in UNSEEN_PROPERTIES if name in previous and name not in after}}


def proposed_model(base, changes):
    model = {kind: dict(index_of(base, kind)) for kind in COLLECTIONS}
    for change in changes:
        bucket = model[change["kind"]]
        slot = key(change["name"])
        if change["op"] == "remove":
            bucket.pop(slot, None)
            continue
        previous = bucket.get(slot)
        after = carry_unseen(change, previous) or {}
        envelope = {k: v for k, v in (previous or {}).items() if k != "properties"}
        bucket[slot] = {
            **envelope,
            "name": change["name"],
            "properties": carry_system(properties_of(previous), after) if previous else after,
        }
    return {
        COLLECTIONS[kind]: sorted(bucket.values(), key=lambda item: item["name"])
        for kind, bucket in model.items()
    }


def keyed(items):
    names = [item.get("name") for item in items if isinstance(item, dict)]
    return (
        bool(items)
        and len(names) == len(items)
        and all(isinstance(name, str) for name in names)
        and len(set(names)) == len(names)
    )


def diff_values(before, after, path):
    if before is None and isinstance(after, dict):
        before = {}
    if after is None and isinstance(before, dict):
        after = {}
    if isinstance(before, dict) and isinstance(after, dict):
        for name in sorted(set(before) | set(after)):
            yield from diff_values(
                before.get(name), after.get(name), f"{path}.{name}" if path else name
            )
    elif isinstance(before, list) and isinstance(after, list) and keyed(before) and keyed(after):
        old = {item["name"]: item for item in before}
        new = {item["name"]: item for item in after}
        for name in [*old, *[n for n in new if n not in old]]:
            yield from diff_values(old.get(name), new.get(name), f"{path}[{name}]")
    elif before != after:
        yield {"path": path, "before": before, "after": after}


def change_details(before, after):
    return list(diff_values(strip_system(before), strip_system(after), ""))


def dependencies(changes, base):
    by_slot = {(c["kind"], key(c["name"])): c for c in changes}

    def before(change):
        return properties_of(index_of(base, change["kind"]).get(key(change["name"])))

    def after(change):
        return change.get("after") or {}

    needs = {}
    for change in changes:
        kind, op = change["kind"], change["op"]
        wanted = set()
        if kind == "entity" and op != "remove":
            for name in references(after(change)):
                other = by_slot.get(("signalDefinition", key(name)))
                if other and (other["op"] == "add" or (op == "add" and other["op"] == "change")):
                    wanted.add(other["id"])
        if kind == "entity" and op == "add":
            wanted |= {
                other["id"]
                for other in changes
                if other["kind"] == "relationship"
                and other["op"] != "remove"
                and touches(after(other), change["name"])
            }
        if kind == "entity" and op == "remove":
            wanted |= {
                other["id"]
                for other in changes
                if other["kind"] == "relationship"
                and other["op"] == "remove"
                and touches(before(other), change["name"])
            }
        if kind == "relationship" and op != "remove":
            for end in endpoints(after(change)):
                other = by_slot.get(("entity", key(end)))
                if other and other["op"] == "add":
                    wanted.add(other["id"])
        if kind == "signalDefinition" and op == "remove":
            for other in changes:
                if other["kind"] != "entity" or other["op"] == "add":
                    continue
                held = {key(name) for name in references(before(other))}
                kept = {key(name) for name in references(after(other))}
                if key(change["name"]) in held and (
                    other["op"] == "remove" or key(change["name"]) not in kept
                ):
                    wanted.add(other["id"])
        needs[change["id"]] = wanted
    return needs


def closure(needs, selected_ids, changes):
    chosen = set()
    pending = [id_ for id_ in selected_ids if id_ in needs]
    while pending:
        current = pending.pop()
        if current not in chosen:
            chosen.add(current)
            pending.extend(needs[current])
    return [change["id"] for change in changes if change["id"] in chosen]


def expand_selection(changes, selected_ids, base):
    return closure(dependencies(changes, base), selected_ids, changes)


def apply_order(changes):
    writes = [change for change in changes if change["op"] != "remove"]
    removals = [change for change in changes if change["op"] == "remove"]
    return sorted(writes, key=lambda change: WRITE_RANK[change["kind"]]) + sorted(
        removals, key=lambda change: -WRITE_RANK[change["kind"]]
    )


def signal_references(model):
    return {
        (key(entity["name"]), key(field(signal, "name"))): key(field(signal, "signalDefinitionName"))
        for entity in collection(model, "entity")
        for group in signal_group_values(properties_of(entity).get("signalGroups"))
        for signal in field(group, "signals", default=[]) or []
        if field(signal, "signalDefinitionName")
    }


def verification_rows(rows, changes, proposed):
    by_signal = signal_references(proposed)
    result = {}
    for change in changes:
        if change["kind"] == "entity":
            result[change["id"]] = [r for r in rows if key(r["entity"]) == key(change["name"])]
        elif change["kind"] == "signalDefinition":
            result[change["id"]] = [
                r
                for r in rows
                if by_signal.get((key(r["entity"]), key(r["signal"]))) == key(change["name"])
            ]
        else:
            result[change["id"]] = []
    return result


def diff_view(result, base, model_name, target, applies, appliable):
    changes = result["changes"]
    proposed = proposed_model(base, changes)
    needs = dependencies(changes, base)
    rows = verification_rows(result["verification"], changes, proposed)
    view = []
    for change in changes:
        existing = index_of(base, change["kind"]).get(key(change["name"]))
        before = strip_system(properties_of(existing)) if existing else None
        after = strip_system(carry_unseen(change, existing)) if change["after"] is not None else None
        view.append(
            {
                "id": change["id"],
                "op": change["op"],
                "kind": change["kind"],
                "name": change["name"],
                "reason": change["reason"],
                "before": before,
                "after": after,
                "details": change_details(before, after),
                "dependsOn": [
                    id_ for id_ in closure(needs, [change["id"]], changes) if id_ != change["id"]
                ],
                "verification": rows[change["id"]],
            }
        )
    return {
        "base": graph_dto(collection(base, "entity"), collection(base, "relationship"), model_name),
        "proposed": graph_dto(proposed["entities"], proposed["relationships"], model_name),
        "changes": view,
        "verification": result["verification"],
        "findings": result["findings"],
        "summary": result["summary"],
        **({"confidence": result["confidence"]} if "confidence" in result else {}),
        "target": target,
        "appliable": appliable,
        "applies": applies,
    }
