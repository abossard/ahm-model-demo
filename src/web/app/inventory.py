from datetime import datetime, timezone

from config import (
    CANONICAL_SIGNAL_NAME,
    HEALTH_STATES,
    REASON_PRESETS,
    REPORT_EXPIRIES,
    REPORT_VALUES,
)
from dto import entity_dto, entity_order, field, relationship_dto, scalar


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
