import copy
from datetime import datetime, timezone
from types import SimpleNamespace

from azure.core.exceptions import ResourceNotFoundError

from fixture_history import REPORT_SIGNAL, SPECS, FixtureHistory, LiveScript, iso as iso_time, judge


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


INLINE_FIELDS = ("displayName", "evaluationRules", "dataUnit", "refreshInterval")


def signal(name, definition, state, value):
    inline = DEFINITIONS[definition]
    return {
        "name": name,
        "signalDefinitionName": definition,
        "signalKind": "AzureResourceMetric",
        **{key: copy.deepcopy(inline[key]) for key in INLINE_FIELDS},
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


def with_report_signal(properties):
    properties["signalGroups"]["external"] = {
        "signals": [
            {
                "name": REPORT_SIGNAL,
                "displayName": "Health report",
                "signalKind": "External",
                "status": {"healthState": "Healthy", "value": 1, "reportedAt": STAMP},
            }
        ]
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


DEFINITIONS = {
    "sd-http-5xx": metric_definition("HTTP 5xx", "Requests", 1, 5),
    "sd-order-errors": metric_definition("Order errors", "TotalErrors", 1, 5),
    "sd-db-cpu": metric_definition("Database CPU", "UsageNanoCores", 80, 95),
}


def signal_statuses(properties):
    return {
        (group_name, signal["name"]): signal["status"]
        for group_name, group in (properties.get("signalGroups") or {}).items()
        for signal in group.get("signals") or []
        if "status" in signal
    }


def keep_evaluation(existing, stored):
    """A real model keeps evaluating an entity whose definition changes: its state, the status of the signals it still has
    and the group the service owns (`external`) stay as they were. Only an entity that did not exist yet starts Unknown,
    and its signals start without a status."""
    previous = existing["properties"] if existing else {}
    stored.setdefault("healthState", previous.get("healthState", "Unknown"))
    if "external" in (previous.get("signalGroups") or {}):
        stored.setdefault("signalGroups", {}).setdefault("external", copy.deepcopy(previous["signalGroups"]["external"]))
    statuses = signal_statuses(previous)
    for group_name, group in (stored.get("signalGroups") or {}).items():
        for signal in group.get("signals") or []:
            if "status" not in signal and (group_name, signal.get("name")) in statuses:
                signal["status"] = copy.deepcopy(statuses[(group_name, signal["name"])])
    return stored


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
        make("entities", "payments", with_report_signal(entity_properties(scope, "Payments", "Healthy", "Limited", 600, 400))),
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
            make("signalDefinitions", name, copy.deepcopy(definition)) for name, definition in DEFINITIONS.items()
        ],
        "relationships": [
            make("relationships", f"{parent}-{child}", {"parentEntityName": parent, "childEntityName": child})
            for parent, child in links
        ],
    }


class FixtureHealthModels:
    def __init__(self, default, design, now=lambda: datetime.now(timezone.utc), live_seconds=None):
        """`live_seconds` makes the default model change over time: a scripted incident that repeats with that period."""
        self._now = now
        self.live = LiveScript(now, live_seconds) if live_seconds else None
        self.history = FixtureHistory(default[2], now, self.live)
        self._models = {}
        for ref, is_design in ((default, False), (design, True)):
            self._models[tuple(part.casefold() for part in ref)] = {
                name: {resource["name"]: resource for resource in resources}
                for name, resources in fixture_model(*ref, design=is_design).items()
            }
        self._refs = {tuple(part.casefold() for part in ref): ref for ref in (default, design)}
        self._denied = set()

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

    def deny(self, sub, rg, name):
        """The caller has no role on this model: `has_model` answers no for it, as the access check does for a user without one."""
        self._denied.add((sub.casefold(), rg.casefold(), name.casefold()))

    def has_model(self, sub, rg, name):
        key = (sub.casefold(), rg.casefold(), name.casefold())
        return key in self._models and key not in self._denied

    def present(self, resource):
        """The entity as it is now: with a live script, its state and the status of its signals follow the script."""
        if self.live is None or resource["name"] not in self.history_entities:
            return resource
        evaluated = int(self._now().timestamp() * 1000) // 10_000 * 10_000
        name = resource["name"]
        properties = resource["properties"]
        properties["healthState"] = self.history.entity_state(name, evaluated)
        for group in properties.get("signalGroups", {}).values():
            for signal in group.get("signals", []):
                if (name, signal["name"]) in SPECS:
                    value = self.history.value_at(name, signal["name"], evaluated)
                    rules = SPECS[(name, signal["name"])]["rules"]
                    signal["status"] = {"healthState": judge(value, rules), "value": value, "reportedAt": iso_time(datetime.fromtimestamp(evaluated / 1000, tz=timezone.utc))}
        return resource

    def state_at(self, entity, moment):
        """The state an entity of the default model had at a moment, from the same history the timeline is read from."""
        return self.history.entity_state(entity, int(moment.timestamp() * 1000))

    @property
    def history_entities(self):
        return {name for name, _ in SPECS} | {self.history._root, "payments", "web-frontend"}

    def read_model(self, sub, rg, name):
        model = self._model(sub, rg, name)
        out = copy.deepcopy({key: sorted(value.values(), key=lambda r: r["name"]) for key, value in model.items()})
        if self.live is not None and name.casefold() == self.history._root.casefold():
            out["entities"] = [self.present(resource) for resource in out["entities"]]
        return out

    def write_resource(self, sub, rg, model, kind, name, properties):
        collection = KINDS[kind]
        resources = self._model(sub, rg, model)[collection]
        stored = {"provisioningState": "Succeeded", **copy.deepcopy(properties)}
        if collection == "entities":
            stored = keep_evaluation(resources.get(name), stored)
        resources[name] = item(sub, rg, model, collection, name, stored)

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
            return models.present(copy.deepcopy(found))

        def get_model(rg, name, **_):
            root = models.present(copy.deepcopy(models._model(sub, rg, name)["entities"][name]))["properties"]
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
                get_history=lambda rg, model, entity, body, **_: models.history.get_history(entity, body),
                get_signal_history=lambda rg, model, entity, body, **_: models.history.get_signal_history(entity, body),
                get_data_annotations=lambda rg, model, entity, body, **_: models.history.get_data_annotations(entity, body),
                ingest_health_report=lambda *a, **_: None,
            ),
            relationships=SimpleNamespace(list_by_health_model=listing("relationships")),
        )
