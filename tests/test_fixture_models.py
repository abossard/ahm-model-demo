import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import fixture_models  # noqa: E402
import model_diff  # noqa: E402

SUB = "11111111-1111-1111-1111-111111111111"
GROUP = "rg-fixture"
MODEL = "hm-fixture"
DESIGN = "hm-fixture-design"
REPORT = "web-ui-health-report"
STATUS = {"healthState": "Unhealthy", "value": 7, "reportedAt": "2031-01-01T00:00:00Z"}


def models():
    return fixture_models.FixtureHealthModels((SUB, GROUP, MODEL), (SUB, GROUP, DESIGN))


def entities(health):
    return {e["name"]: e["properties"] for e in health.read_model(SUB, GROUP, MODEL)["entities"]}


def statuses(properties):
    return {
        (group_name, signal["name"]): signal.get("status")
        for group_name, group in properties.get("signalGroups", {}).items()
        for signal in group.get("signals", [])
    }


def signals_of(properties, group):
    return properties["signalGroups"][group]["signals"]


class WriteTests(unittest.TestCase):
    def rewrite(self, name, edit):
        """What an Apply sends for an entity: its properties without the fields the service owns, edited."""
        health = models()
        before = entities(health)[name]
        properties = model_diff.strip_system(copy.deepcopy(before))
        edit(properties)
        health.write_resource(SUB, GROUP, MODEL, "entity", name, properties)
        return before, entities(health)[name]

    def test_a_changed_entity_keeps_its_state_and_the_status_of_the_signals_it_still_has(self):
        def rename(properties):
            properties["displayName"] = "Edited"

        def another_signal_too(properties):
            signals_of(properties, "azureResource").append({"name": "extra", "signalDefinitionName": "sd-order-errors", "signalKind": "AzureResourceMetric"})

        def signal_renamed(properties):
            signals_of(properties, "azureResource")[0]["name"] = "order-errors-2"

        def signal_removed(properties):
            del properties["signalGroups"]["azureResource"]

        def signal_in_another_group(properties):
            properties["signalGroups"]["azureLogAnalytics"] = {"signals": [{"name": "order-errors", "signalDefinitionName": "sd-order-errors", "signalKind": "LogAnalyticsQuery"}]}

        def another_external_group(properties):
            properties["signalGroups"]["external"] = {"signals": [{"name": "other", "signalKind": "External"}]}

        def state_and_status_given(properties):
            properties["healthState"] = "Healthy"
            signals_of(properties, "azureResource")[0]["status"] = STATUS

        def only_the_status_given(properties):
            signals_of(properties, "azureResource")[0]["status"] = STATUS

        cases = [
            ("a rename", "orders-api", rename, "Degraded", {("azureResource", "order-errors"): "kept"}),
            ("an unhealthy entity", "orders-db", rename, "Unhealthy", {("azureResource", "cpu"): "kept"}),
            ("a healthy entity", "web-frontend", rename, "Healthy", {("azureResource", "http-5xx"): "kept"}),
            ("the root of the model", MODEL, rename, "Degraded", {}),
            ("an entity with an external signal", "payments", rename, "Healthy", {("external", REPORT): "kept"}),
            ("an external group given by the write", "payments", another_external_group, "Healthy", {("external", "other"): None}),
            ("a signal added", "orders-api", another_signal_too, "Degraded", {("azureResource", "order-errors"): "kept", ("azureResource", "extra"): None}),
            ("a signal renamed", "orders-api", signal_renamed, "Degraded", {("azureResource", "order-errors-2"): None}),
            ("the signals removed", "orders-api", signal_removed, "Degraded", {}),
            ("a signal of the same name in another group", "orders-api", signal_in_another_group, "Degraded", {("azureResource", "order-errors"): "kept", ("azureLogAnalytics", "order-errors"): None}),
            ("a state and a status given by the write", "orders-api", state_and_status_given, "Healthy", {("azureResource", "order-errors"): STATUS}),
            ("only a status given by the write", "orders-api", only_the_status_given, "Degraded", {("azureResource", "order-errors"): STATUS}),
        ]
        for label, name, edit, state, expected in cases:
            with self.subTest(label=label):
                before, after = self.rewrite(name, edit)

                self.assertEqual(after["healthState"], state)
                kept = statuses(before)
                self.assertEqual(
                    statuses(after),
                    {key: kept.get(key) if value == "kept" else value for key, value in expected.items()},
                )

    def test_only_an_entity_that_did_not_exist_starts_unknown_and_without_signal_statuses(self):
        new = {"displayName": "Queue", "signalGroups": {"azureResource": {"signals": [{"name": "depth", "signalDefinitionName": "sd-order-errors"}]}}}
        health = models()

        health.write_resource(SUB, GROUP, MODEL, "entity", "queue-tier", new)
        health.write_resource(SUB, GROUP, MODEL, "entity", "queue-tier", {**new, "displayName": "Queue again"})
        health.delete_resource(SUB, GROUP, MODEL, "entity", "orders-api")
        health.write_resource(SUB, GROUP, MODEL, "entity", "orders-api", {"displayName": "Back", "signalGroups": {"azureResource": {"signals": [{"name": "order-errors", "signalDefinitionName": "sd-order-errors"}]}}})

        found = entities(health)
        self.assertEqual((found["queue-tier"]["healthState"], found["orders-api"]["healthState"]), ("Unknown", "Unknown"))
        self.assertEqual(statuses(found["queue-tier"]), {("azureResource", "depth"): None})
        self.assertEqual(statuses(found["orders-api"]), {("azureResource", "order-errors"): None})

    def test_a_state_set_on_a_new_or_an_existing_entity_is_taken_as_given(self):
        health = models()

        health.write_resource(SUB, GROUP, MODEL, "entity", "queue-tier", {"displayName": "Queue", "healthState": "Healthy"})
        health.write_resource(SUB, GROUP, MODEL, "entity", "orders-api", {"displayName": "Orders", "healthState": "Unhealthy"})

        found = entities(health)
        self.assertEqual((found["queue-tier"]["healthState"], found["orders-api"]["healthState"]), ("Healthy", "Unhealthy"))

    def test_other_kinds_are_stored_as_written_and_nothing_is_evaluated_for_them(self):
        health = models()

        health.write_resource(SUB, GROUP, MODEL, "signalDefinition", "sd-new", {"displayName": "New"})
        health.write_resource(SUB, GROUP, MODEL, "signalDefinition", "sd-db-cpu", {"displayName": "CPU again"})
        health.write_resource(SUB, GROUP, MODEL, "relationship", "orders-api-queue", {"parentEntityName": "orders-api", "childEntityName": "queue-tier"})

        raw = health.read_model(SUB, GROUP, MODEL)
        definitions = {d["name"]: d["properties"] for d in raw["signalDefinitions"]}
        relationships = {r["name"]: r["properties"] for r in raw["relationships"]}
        self.assertEqual(definitions["sd-new"], {"provisioningState": "Succeeded", "displayName": "New"})
        self.assertEqual(definitions["sd-db-cpu"], {"provisioningState": "Succeeded", "displayName": "CPU again"})
        self.assertEqual(relationships["orders-api-queue"], {"provisioningState": "Succeeded", "parentEntityName": "orders-api", "childEntityName": "queue-tier"})

    def test_a_write_does_not_share_anything_with_what_it_was_given_or_what_was_read(self):
        health = models()
        given = {"displayName": "Edited", "signalGroups": {"azureResource": {"signals": [{"name": "order-errors", "signalDefinitionName": "sd-order-errors"}]}}}

        health.write_resource(SUB, GROUP, MODEL, "entity", "orders-api", given)
        read = entities(health)["orders-api"]
        signals_of(read, "azureResource")[0]["status"]["healthState"] = "Unhealthy"
        read["healthState"] = "Unhealthy"

        self.assertNotIn("status", given["signalGroups"]["azureResource"]["signals"][0])
        found = entities(health)["orders-api"]
        self.assertEqual(found["healthState"], "Degraded")
        self.assertEqual(statuses(found)[("azureResource", "order-errors")]["healthState"], "Degraded")


if __name__ == "__main__":
    unittest.main()
