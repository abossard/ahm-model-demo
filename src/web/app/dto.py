import json
from collections.abc import Mapping
from datetime import datetime, timezone

from config import CANONICAL_SIGNAL_NAME


def field(value, *names, default=None):
    if value is None:
        return default
    for name in names:
        if isinstance(value, Mapping) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return default


def scalar(value):
    return getattr(value, "value", value)


def iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def history_items(response):
    for name in ("history", "value", "items"):
        value = field(response, name)
        if value is not None and not callable(value):
            return list(value)
    if response is None:
        return []
    if isinstance(response, (list, tuple)):
        return list(response)
    return list(response)


def signal_group_values(groups):
    if groups is None:
        return []
    if isinstance(groups, Mapping):
        return list(groups.values())
    values = []
    for snake, camel in (
        ("azure_resource", "azureResource"),
        ("azure_log_analytics", "azureLogAnalytics"),
        ("azure_monitor_workspace", "azureMonitorWorkspace"),
        ("dependencies", "dependencies"),
        ("external", "external"),
    ):
        group = field(groups, snake, camel)
        if group is not None:
            values.append(group)
    return values


def context_fields(additional_context):
    if not additional_context:
        return {}
    try:
        value = json.loads(additional_context)
    except (TypeError, ValueError):
        return {}
    if not isinstance(value, dict) or value.get("source") != "health-pulse-web":
        return {}
    return {
        "source": "health-pulse-web",
        "reportId": value.get("reportId"),
        "reason": value.get("reason"),
    }


def entity_signals(current_entity):
    properties = field(current_entity, "properties")
    groups = field(properties, "signal_groups", "signalGroups")
    result = []
    for group in signal_group_values(groups):
        for current_signal in field(group, "signals", default=[]) or []:
            status = field(current_signal, "status")
            additional_context = field(
                status, "additional_context", "additionalContext"
            )
            result.append(
                {
                    "name": field(current_signal, "name"),
                    "displayName": field(
                        current_signal, "display_name", "displayName"
                    ),
                    "kind": scalar(
                        field(current_signal, "signal_kind", "signalKind")
                    ),
                    "healthState": scalar(
                        field(status, "health_state", "healthState")
                    ),
                    "value": field(status, "value"),
                    "reportedAt": iso(
                        field(status, "reported_at", "reportedAt")
                    ),
                    "writable": (
                        field(current_signal, "name") == CANONICAL_SIGNAL_NAME
                    ),
                    **context_fields(additional_context),
                }
            )
    return result


def relationship_dto(current_relationship):
    properties = field(current_relationship, "properties")
    return {
        "name": field(current_relationship, "name"),
        "displayName": field(properties, "display_name", "displayName"),
        "parentEntityName": field(
            properties, "parent_entity_name", "parentEntityName"
        ),
        "childEntityName": field(
            properties, "child_entity_name", "childEntityName"
        ),
    }


def entity_order(entities, relationships, model_name):
    names = {field(item, "name") for item in entities}
    children = {name: [] for name in names}
    incoming = {name: 0 for name in names}
    linked = set()
    for relation in relationships:
        parent = relation["parentEntityName"]
        child = relation["childEntityName"]
        if parent in names and child in names:
            children[parent].append(child)
            incoming[child] += 1
            linked.update((parent, child))
    roots = sorted(
        (name for name in names if incoming[name] == 0),
        key=lambda name: (name != model_name, name.casefold()),
    )
    depth = {}
    frontier = [(name, 0) for name in roots]
    while frontier:
        name, current_depth = frontier.pop(0)
        if name in depth and depth[name] <= current_depth:
            continue
        depth[name] = current_depth
        frontier.extend((child, current_depth + 1) for child in children[name])
    display_names = {
        field(item, "name"): (
            field(
                field(item, "properties"),
                "display_name",
                "displayName",
                default=field(item, "name"),
            )
            or field(item, "name")
        )
        for item in entities
    }
    return sorted(
        names,
        key=lambda name: (
            name != model_name,
            name not in linked,
            depth.get(name, 10_000),
            display_names[name].casefold(),
            name.casefold(),
        ),
    )


def entity_dto(current_entity, parent_names, child_names):
    properties = field(current_entity, "properties")
    position = field(properties, "canvas_position", "canvasPosition")
    signals = entity_signals(current_entity)
    reported = [item["reportedAt"] for item in signals if item["reportedAt"]]
    state = scalar(field(properties, "health_state", "healthState")) or "Unknown"
    entity_name = field(current_entity, "name")
    return {
        "name": entity_name,
        "displayName": field(
            properties, "display_name", "displayName", default=entity_name
        )
        or entity_name,
        "healthState": state,
        "impact": scalar(field(properties, "impact")) or "Unknown",
        "canvasPosition": (
            {
                "x": field(position, "x"),
                "y": field(position, "y"),
            }
            if position is not None
            else None
        ),
        "discoveredBy": field(properties, "discovered_by", "discoveredBy"),
        "parents": sorted(parent_names),
        "children": sorted(child_names),
        "unlinked": not parent_names and not child_names,
        "latestEvaluationAt": max(reported) if reported else None,
        "latestTransitionAt": None,
        "signals": signals,
        "report": {
            "eligible": state != "Deleted",
            "signalName": CANONICAL_SIGNAL_NAME if state != "Deleted" else None,
        },
    }


def transition_dto(item):
    return {
        "previousState": scalar(
            field(item, "previous_state", "previousState")
        ),
        "healthState": scalar(field(item, "new_state", "newState")),
        "occurredAt": iso(field(item, "occurred_at", "occurredAt")),
    }


def signal_history_dto(item):
    additional_context = field(
        item, "additional_context", "additionalContext"
    )
    return {
        "healthState": scalar(field(item, "health_state", "healthState")),
        "value": field(item, "value"),
        "occurredAt": iso(field(item, "occurred_at", "occurredAt")),
        **context_fields(additional_context),
    }
