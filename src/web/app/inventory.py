from datetime import datetime, timezone

from config import (
    CANONICAL_SIGNAL_NAME,
    HEALTH_STATES,
    REASON_PRESETS,
    REPORT_EXPIRIES,
    REPORT_VALUES,
)
from dto import entity_dto, entity_order, field, relationship_dto, scalar


SELECTOR_KEYS = ("model", "resourceGroup")


def resource_group_from_id(resource_id):
    if not isinstance(resource_id, str):
        return None
    parts = resource_id.split("/")
    for index in range(len(parts) - 1):
        if parts[index].casefold() == "resourcegroups":
            return parts[index + 1] or None
    return None


def model_ref(item):
    resource_id = field(item, "id")
    properties = field(item, "properties")
    return {
        "id": resource_id,
        "name": field(item, "name"),
        "resourceGroup": resource_group_from_id(resource_id),
        "location": field(item, "location"),
        "provisioningState": scalar(
            field(properties, "provisioning_state", "provisioningState")
        ),
    }


def fallback_ref(resource_group, model_name):
    return {
        "id": None,
        "name": model_name,
        "resourceGroup": resource_group,
        "location": None,
        "provisioningState": None,
    }


def sort_refs(refs):
    return sorted(
        refs,
        key=lambda item: (
            (item["resourceGroup"] or "").casefold(),
            (item["name"] or "").casefold(),
        ),
    )


def list_models(health_client, resource_group, model_name):
    fallback = [fallback_ref(resource_group, model_name)]
    try:
        items = list(health_client.health_models.list_by_subscription())
    except Exception:
        return fallback
    refs = [
        model_ref(item)
        for item in items
        if field(item, "name") and resource_group_from_id(field(item, "id"))
    ]
    return sort_refs(refs) or fallback


def resolve_selection(query_params, list_models_now, resource_group, model_name):
    requested = {key: query_params.get(key) for key in SELECTOR_KEYS}
    if not any(requested.values()):
        return (resource_group, model_name), None
    match = next(
        (
            item
            for item in list_models_now()
            if item["name"] == requested["model"]
            and item["resourceGroup"] == requested["resourceGroup"]
        ),
        None,
    )
    if match is None:
        return None, "unknown_model"
    return (match["resourceGroup"], match["name"]), None


def read_inventory(health_client, resource_group, model_name):
    model = health_client.health_models.get(resource_group, model_name)
    entities = list(
        health_client.entities.list_by_health_model(resource_group, model_name)
    )
    relationships = [
        relationship_dto(item)
        for item in health_client.relationships.list_by_health_model(
            resource_group, model_name
        )
    ]
    order = entity_order(entities, relationships, model_name)
    entity_by_name = {field(item, "name"): item for item in entities}
    parent_names = {name: [] for name in entity_by_name}
    child_names = {name: [] for name in entity_by_name}
    for relation in relationships:
        parent = relation["parentEntityName"]
        child = relation["childEntityName"]
        if parent in child_names and child in parent_names:
            child_names[parent].append(child)
            parent_names[child].append(parent)
    entity_dtos = [
        entity_dto(entity_by_name[name], parent_names[name], child_names[name])
        for name in order
    ]
    order_index = {name: index for index, name in enumerate(order)}
    relationships.sort(
        key=lambda item: (
            order_index.get(item["parentEntityName"], 10_000),
            order_index.get(item["childEntityName"], 10_000),
            (item["name"] or "").casefold(),
        )
    )
    model_properties = field(model, "properties")
    root_state = next(
        (
            item["healthState"]
            for item in entity_dtos
            if item["name"] == model_name
        ),
        "Unknown",
    )
    model_state = scalar(
        field(model_properties, "health_state", "healthState", default=root_state)
    )
    return {
        "model": {
            "id": field(model, "id"),
            "name": field(model, "name", default=model_name),
            "location": field(model, "location"),
            "provisioningState": scalar(
                field(
                    model_properties,
                    "provisioning_state",
                    "provisioningState",
                )
            ),
            "healthState": model_state or root_state,
        },
        "observedAt": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "entities": entity_dtos,
        "relationships": relationships,
        "reportOptions": {
            "signalName": CANONICAL_SIGNAL_NAME,
            "healthStates": list(HEALTH_STATES),
            "values": list(REPORT_VALUES),
            "expiries": list(REPORT_EXPIRIES),
            "reasonPresets": [
                {"value": key, "label": label or "Custom reason"}
                for key, label in REASON_PRESETS.items()
            ],
        },
    }


def find_current_entity(health_client, resource_group, model_name, entity_name):
    entities = list(
        health_client.entities.list_by_health_model(resource_group, model_name)
    )
    return next(
        (item for item in entities if field(item, "name") == entity_name),
        None,
    )
