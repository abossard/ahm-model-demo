import logging
from datetime import datetime, timezone

from config import (
    ARM_NAME,
    CANONICAL_SIGNAL_NAME,
    GUID,
    HEALTH_STATES,
    REASON_PRESETS,
    REPORT_EXPIRIES,
    REPORT_VALUES,
    RESOURCE_GROUP_NAME,
)
from dto import field, graph_dto, scalar
from obo import ConsentRequired, InteractionRequired


SELECTOR_KEYS = ("model", "resourceGroup", "subscription")

logger = logging.getLogger("ahm-demo")


def segment_after(resource_id, segment):
    if not isinstance(resource_id, str):
        return None
    parts = resource_id.split("/")
    for index in range(len(parts) - 1):
        if parts[index].casefold() == segment:
            return parts[index + 1] or None
    return None


def resource_group_from_id(resource_id):
    return segment_after(resource_id, "resourcegroups")


def subscription_from_id(resource_id):
    return segment_after(resource_id, "subscriptions")


def model_ref(row):
    resource_id = field(row, "id")
    name = field(row, "name")
    subscription_id = subscription_from_id(resource_id)
    resource_group = resource_group_from_id(resource_id)
    if not (name and subscription_id and resource_group):
        return None
    return {
        "id": resource_id,
        "name": name,
        "resourceGroup": resource_group,
        "subscriptionId": subscription_id,
        "location": field(row, "location"),
        "provisioningState": field(row, "provisioningState") or None,
    }


def fallback_ref(subscription_id, resource_group, model_name):
    return {
        "id": None,
        "name": model_name,
        "resourceGroup": resource_group,
        "subscriptionId": subscription_id,
        "location": None,
        "provisioningState": None,
    }


def sort_refs(refs):
    return sorted(
        refs,
        key=lambda item: (
            (item["name"] or "").casefold(),
            (item["resourceGroup"] or "").casefold(),
            (item["subscriptionId"] or "").casefold(),
        ),
    )


def list_models(health, default):
    fallback = [fallback_ref(*default)]
    try:
        rows = health.query_models()
    except (InteractionRequired, ConsentRequired):
        raise
    except Exception as error:
        logger.warning("model catalog query failed error_type=%s", type(error).__name__)
        return fallback
    refs = [ref for ref in map(model_ref, rows) if ref]
    return sort_refs(refs) or fallback


def well_formed(requested):
    return (
        (not requested["subscription"] or GUID.fullmatch(requested["subscription"]) is not None)
        and RESOURCE_GROUP_NAME.fullmatch(requested["resourceGroup"]) is not None
        and ARM_NAME.fullmatch(requested["model"]) is not None
    )


def resolve_selection(query_params, model_exists, default):
    requested = {key: query_params.get(key) for key in SELECTOR_KEYS}
    if not any(requested.values()):
        return default, None
    selection = (
        requested["subscription"] or default[0],
        requested["resourceGroup"],
        requested["model"],
    )
    if not all(selection) or not well_formed(requested) or not model_exists(*selection):
        return None, "unknown_model"
    return selection, None


def read_inventory(health_client, resource_group, model_name):
    model = health_client.health_models.get(resource_group, model_name)
    entities = list(
        health_client.entities.list_by_health_model(resource_group, model_name)
    )
    graph = graph_dto(
        entities,
        health_client.relationships.list_by_health_model(resource_group, model_name),
        model_name,
    )
    entity_dtos = graph["entities"]
    relationships = graph["relationships"]
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
