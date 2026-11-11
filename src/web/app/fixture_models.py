import copy
from types import SimpleNamespace

from azure.core.exceptions import ResourceNotFoundError


STAMP = "2026-11-01T09:00:00Z"
TYPES = {
    "entities": "Microsoft.CloudHealth/healthmodels/entities",
    "signalDefinitions": "Microsoft.CloudHealth/healthmodels/signaldefinitions",
    "relationships": "Microsoft.CloudHealth/healthmodels/relationships",
}
PATHS = {"entities": "entities", "signalDefinitions": "signaldefinitions", "relationships": "relationships"}
KINDS = {"entity": "entities", "signalDefinition": "signalDefinitions", "relationship": "relationships"}


def not_found(what):
    error = ResourceNotFoundError(message=f"{what} was not found")
    error.status_code = 404
    return error


def model_id(sub, rg, name):
    return f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.CloudHealth/healthmodels/{name}"


def item(sub, rg, model, collection, name, properties):
    return {
        "id": f"{model_id(sub, rg, model)}/{PATHS[collection]}/{name}",
        "name": name,
        "type": TYPES[collection],
        "properties": {"provisioningState": "Succeeded", **properties},
        "systemData": {"createdAt": STAMP, "lastModifiedAt": STAMP},
    }


def signal(name, definition, state, value):
    return {
        "name": name,
        "signalDefinitionName": definition,
        "signalKind": "AzureResourceMetric",
        "status": {"healthState": state, "value": value, "reportedAt": STAMP},
    }


def scope_of(sub, rg):
    return f"/subscriptions/{sub}/resourceGroups/{rg}"


def entity_properties(scope, display, state, impact, x, y, signals=()):
    properties = {
        "displayName": display,
        "healthState": state,
        "impact": impact,
        "canvasPosition": {"x": x, "y": y},
        "signalGroups": {"dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": True}},
    }
    if signals:
        properties["signalGroups"]["azureResource"] = {
            "authenticationSetting": "system-assigned",
            "azureResourceId": scope,
            "signals": list(signals),
        }
    return properties


def metric_definition(display, metric, degraded, unhealthy):
    return {
        "signalKind": "AzureResourceMetric",
        "displayName": display,
        "metricNamespace": "Microsoft.App/containerApps",
        "metricName": metric,
        "aggregationType": "Total",
        "timeGrain": "PT5M",
        "dataUnit": "Count",
        "refreshInterval": "PT1M",
        "evaluationRules": {
            "degradedRule": {"operator": "GreaterThan", "threshold": degraded},
            "unhealthyRule": {"operator": "GreaterThan", "threshold": unhealthy},
        },
    }


def fixture_model(sub, rg, name, design=False):
    def make(collection, resource, properties):
        return item(sub, rg, name, collection, resource, properties)

    scope = scope_of(sub, rg)
    root = make("entities", name, entity_properties(scope, "Fixture Shop", "Degraded", "Standard", 400, 0))
    if design:
        return {"entities": [root], "signalDefinitions": [], "relationships": []}
    entities = [
        root,
        make("entities", "web-frontend", entity_properties(scope, "Web frontend", "Healthy", "Standard", 100, 200, [signal("http-5xx", "sd-http-5xx", "Healthy", 0.0)])),
        make("entities", "orders-api", entity_properties(scope, "Orders API", "Degraded", "Standard", 400, 200, [signal("order-errors", "sd-order-errors", "Degraded", 3.0)])),
        make("entities", "orders-db", entity_properties(scope, "Orders database", "Unhealthy", "Standard", 300, 400, [signal("cpu", "sd-db-cpu", "Unhealthy", 97.0)])),
        make("entities", "payments", entity_properties(scope, "Payments", "Healthy", "Limited", 600, 400)),
    ]
    links = [
        (name, "web-frontend"),
        ("web-frontend", "orders-api"),
        ("orders-api", "orders-db"),
        ("orders-api", "payments"),
    ]
    return {
        "entities": entities,
        "signalDefinitions": [
            make("signalDefinitions", "sd-http-5xx", metric_definition("HTTP 5xx", "Requests", 1, 5)),
            make("signalDefinitions", "sd-order-errors", metric_definition("Order errors", "TotalErrors", 1, 5)),
            make("signalDefinitions", "sd-db-cpu", metric_definition("Database CPU", "UsageNanoCores", 80, 95)),
        ],
        "relationships": [
            make("relationships", f"{parent}-{child}", {"parentEntityName": parent, "childEntityName": child})
            for parent, child in links
        ],
    }


class FixtureHealthModels:
    def __init__(self, default, design):
        self._models = {}
        for ref, is_design in ((default, False), (design, True)):
            self._models[tuple(part.casefold() for part in ref)] = {
                name: {resource["name"]: resource for resource in resources}
                for name, resources in fixture_model(*ref, design=is_design).items()
            }
        self._refs = {tuple(part.casefold() for part in ref): ref for ref in (default, design)}

    def as_user(self, caller):
        return self

    def _model(self, sub, rg, name):
        found = self._models.get((sub.casefold(), rg.casefold(), name.casefold()))
        if found is None:
            raise not_found("The health model")
        return found

    def query_models(self):
        return [
            {"id": model_id(*ref), "name": ref[2], "location": "northeurope", "provisioningState": "Succeeded"}
            for ref in self._refs.values()
        ]

    def has_model(self, sub, rg, name):
        return (sub.casefold(), rg.casefold(), name.casefold()) in self._models

    def read_model(self, sub, rg, name):
        model = self._model(sub, rg, name)
        return copy.deepcopy({key: sorted(value.values(), key=lambda r: r["name"]) for key, value in model.items()})

    def write_resource(self, sub, rg, model, kind, name, properties):
        collection = KINDS[kind]
        stored = {"provisioningState": "Succeeded", **copy.deepcopy(properties)}
        if collection == "entities":
            stored.setdefault("healthState", "Unknown")
        self._model(sub, rg, model)[collection][name] = item(sub, rg, model, collection, name, stored)

    def delete_resource(self, sub, rg, model, kind, name):
        self._model(sub, rg, model)[KINDS[kind]].pop(name, None)

    def client(self, sub):
        models = self

        def listing(collection):
            return lambda rg, model, **_: models.read_model(sub, rg, model)[collection]

        def entity(rg, model, name, **_):
            found = models._model(sub, rg, model)["entities"].get(name)
            if found is None:
                raise not_found("The entity")
            return copy.deepcopy(found)

        def get_model(rg, name, **_):
            root = models._model(sub, rg, name)["entities"][name]["properties"]
            return {
                "id": model_id(sub, rg, name),
                "name": name,
                "location": "northeurope",
                "properties": {"provisioningState": "Succeeded", "healthState": root.get("healthState")},
            }

        return SimpleNamespace(
            health_models=SimpleNamespace(get=get_model),
            entities=SimpleNamespace(
                list_by_health_model=listing("entities"),
                get=entity,
                get_history=lambda *a, **_: {"history": []},
                get_signal_history=lambda *a, **_: {"history": []},
                ingest_health_report=lambda *a, **_: None,
            ),
            relationships=SimpleNamespace(list_by_health_model=listing("relationships")),
        )
