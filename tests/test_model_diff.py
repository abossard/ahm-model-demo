import copy
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "web" / "app"))

import dto  # noqa: E402
import fixture_models  # noqa: E402
import model_diff  # noqa: E402

SUB = "11111111-1111-1111-1111-111111111111"
GROUP = "rg-fixture"
MODEL = "hm-base"
TARGET = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
SCOPE = f"/subscriptions/{SUB}/resourceGroups/{GROUP}"


def base_model():
    return fixture_models.fixture_model(SUB, GROUP, MODEL)


def change(id_, op, kind, name, after=None, reason="Because."):
    return {"id": id_, "op": op, "kind": kind, "name": name, "after": after, "reason": reason}


def watching(display, signal, definition):
    return {
        "displayName": display,
        "signalGroups": {
            "dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": True},
            "azureResource": {
                "authenticationSetting": "system-assigned",
                "azureResourceId": SCOPE,
                "signals": [{"name": signal, "signalDefinitionName": definition, "signalKind": "AzureResourceMetric"}],
            },
        },
    }


def watching_in(scope):
    return {
        "displayName": "Elsewhere",
        "signalGroups": {
            "azureResource": {
                "authenticationSetting": "system-assigned",
                "azureResourceId": scope,
                "signals": [{"name": "s", "signalDefinitionName": "sd-queue", "signalKind": "AzureResourceMetric"}],
            }
        },
    }


def link(parent, child):
    return {"parentEntityName": parent, "childEntityName": child}


def definition(display="Queue depth"):
    return fixture_models.metric_definition(display, "Depth", 1, 5)


def diff_result(changes, verification=(), findings=(), summary="Summary."):
    return {
        "kind": "diff",
        "summary": summary,
        "changes": list(changes),
        "verification": list(verification),
        "findings": list(findings),
    }


def validator_that_lets_the_optional_fields_through():
    """The shipped schema with `confidence` and `window` open to any value: what the web side does with them is under test, not their shape."""
    schema = json.loads(model_diff.SCHEMA_PATH.read_text(encoding="utf-8"))
    for kind, names in (("diff", ("confidence",)), ("explain", ("confidence", "window"))):
        schema["$defs"][kind]["properties"].update({name: {} for name in names})
    return Draft202012Validator(schema)


OPTIONAL_VALUES = [
    ("a word", "high"),
    ("a number", 0.5),
    ("a list", ["low", "why"]),
    ("an object", {"level": "medium", "asOf": "2026-11-11T10:00:00Z", "why": ["a", {"b": None}]}),
    ("an explicit null", None),
]


def entity_of(model, name):
    return next(item for item in model["entities"] if item["name"] == name)


def names(items):
    return [item["name"] for item in items]


class ContractTests(unittest.TestCase):
    def test_schema_copy_is_byte_identical_to_the_agent_schema(self):
        agent = (ROOT / "src/agent/src/contracts/task-result.schema.json").read_bytes()
        web = (ROOT / "src/web/app/contracts/task-result.schema.json").read_bytes()

        self.assertEqual(web, agent)


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_is_stable_under_reordering_and_system_field_noise(self):
        def reverse_collections(model):
            for items in model.values():
                items.reverse()

        def reverse_signals(model):
            group = entity_of(model, "orders-api")["properties"]["signalGroups"]
            group["azureResource"] = {
                "authenticationSetting": "system-assigned",
                "azureResourceId": "x",
                "signals": [
                    {"name": "a", "signalDefinitionName": "sd-db-cpu", "signalKind": "AzureResourceMetric"},
                    {"name": "b", "signalDefinitionName": "sd-db-cpu", "signalKind": "AzureResourceMetric"},
                ],
            }

        def noise(model):
            for item in model["entities"]:
                item["properties"]["healthState"] = "Unhealthy"
                item["properties"]["provisioningState"] = "Updating"
                item["properties"]["discoveredBy"] = "rule-1"
                item["properties"]["signalGroups"]["external"] = {"signals": [{"name": "x", "status": {"healthState": "Healthy"}}]}
                item["systemData"] = {"lastModifiedAt": "2030-01-01T00:00:00Z"}
                item["etag"] = "changed"
                for group in item["properties"]["signalGroups"].values():
                    for entry in group.get("signals", []):
                        entry["status"] = {"healthState": "Unhealthy", "value": 99.9, "reportedAt": "2030-01-01T00:00:00Z"}
            for item in model["signalDefinitions"] + model["relationships"]:
                item["properties"]["provisioningState"] = "Updating"
                item["systemData"] = {}

        def resource_health(model, status):
            entity_of(model, "payments")["properties"]["signalGroups"]["azureResource"] = {
                "authenticationSetting": "system-assigned",
                "azureResourceId": "x",
                "resourceHealth": {"enabled": "Enabled", "signalName": f"rh-{status}", "status": {"healthState": status}},
            }

        def aggregation(model, state):
            entity_of(model, "payments")["properties"]["signalAggregationGroups"] = [
                {"name": "g", "members": ["x"], "aggregatedHealthState": state, "unresolvedMembers": [state]}
            ]

        def pair(first, second):
            return first, second

        cases = []
        one, two = base_model(), base_model()
        reverse_collections(two)
        cases.append(("reversed collections", one, two))
        one, two = base_model(), base_model()
        reverse_signals(one)
        reverse_signals(two)
        entity_of(two, "orders-api")["properties"]["signalGroups"]["azureResource"]["signals"].reverse()
        cases.append(("reordered signals", one, two))
        one, two = base_model(), base_model()
        noise(two)
        cases.append(("system field noise", one, two))
        one, two = base_model(), base_model()
        resource_health(one, "Healthy")
        resource_health(two, "Unhealthy")
        two_group = entity_of(two, "payments")["properties"]["signalGroups"]["azureResource"]["resourceHealth"]
        two_group["signalName"] = "rh-Healthy"
        cases.append(("resource health status", one, two))
        one, two = base_model(), base_model()
        aggregation(one, "Healthy")
        aggregation(two, "Unhealthy")
        cases.append(("aggregation read-only parts", one, two))

        for label, first, second in cases:
            with self.subTest(label=label):
                self.assertEqual(model_diff.fingerprint(first), model_diff.fingerprint(second))

    def test_fingerprint_changes_with_real_configuration(self):
        def display(model):
            entity_of(model, "payments")["properties"]["displayName"] = "Payments (renamed)"

        def threshold(model):
            model["signalDefinitions"][0]["properties"]["evaluationRules"]["degradedRule"]["threshold"] = 7

        def add_entity(model):
            model["entities"].append(copy.deepcopy(entity_of(model, "payments")) | {"name": "extra"})

        def drop_relationship(model):
            model["relationships"].pop()

        def position(model):
            entity_of(model, "payments")["properties"]["canvasPosition"] = {"x": 1, "y": 2}

        def reference(model):
            entity_of(model, "orders-db")["properties"]["signalGroups"]["azureResource"]["signals"][0]["signalDefinitionName"] = "sd-other"

        original = model_diff.fingerprint(base_model())
        for label, mutate in [
            ("display name", display),
            ("threshold", threshold),
            ("added entity", add_entity),
            ("dropped relationship", drop_relationship),
            ("canvas position", position),
            ("signal definition reference", reference),
        ]:
            with self.subTest(label=label):
                model = base_model()
                mutate(model)
                self.assertNotEqual(model_diff.fingerprint(model), original)

    def test_fingerprint_is_a_sha256_hex_digest(self):
        value = model_diff.fingerprint(base_model())

        self.assertRegex(value, r"^[0-9a-f]{64}$")
        self.assertEqual(value, model_diff.fingerprint(json.loads(json.dumps(base_model()))))
        self.assertEqual(
            model_diff.fingerprint({}),
            model_diff.fingerprint({"entities": [], "signalDefinitions": [], "relationships": []}),
        )

    def test_strip_system_removes_only_read_only_paths(self):
        properties = {
            "displayName": "Kept",
            "healthState": "Healthy",
            "provisioningState": "Succeeded",
            "discoveredBy": "rule",
            "tags": {"healthState": "kept inside tags"},
            "signalGroups": {
                "external": {"signals": [{"name": "report"}]},
                "dependencies": {"aggregationType": "WorstOf"},
                "azureResource": {
                    "azureResourceId": "kept",
                    "resourceHealth": {"enabled": "Enabled", "signalName": "gone", "status": {"x": 1}},
                    "signals": [{"name": "cpu", "refreshInterval": "PT1M", "status": {"value": 1}}],
                },
                "azureLogAnalytics": {"signals": [{"name": "kql", "status": {"value": 2}}]},
            },
            "signalAggregationGroups": [{"name": "g", "aggregatedHealthState": "Healthy", "unresolvedMembers": [], "members": ["a"]}],
        }

        self.assertEqual(
            model_diff.strip_system(properties),
            {
                "displayName": "Kept",
                "tags": {"healthState": "kept inside tags"},
                "signalGroups": {
                    "dependencies": {"aggregationType": "WorstOf"},
                    "azureResource": {
                        "azureResourceId": "kept",
                        "resourceHealth": {"enabled": "Enabled"},
                        "signals": [{"name": "cpu", "refreshInterval": "PT1M"}],
                    },
                    "azureLogAnalytics": {"signals": [{"name": "kql"}]},
                },
                "signalAggregationGroups": [{"name": "g", "members": ["a"]}],
            },
        )
        self.assertIn("status", properties["signalGroups"]["azureResource"]["signals"][0])


class ValidationTests(unittest.TestCase):
    def valid(self):
        return diff_result(
            [
                change("c1", "change", "entity", "payments", watching("Payments", "latency", "sd-queue")),
                change("c2", "add", "signalDefinition", "sd-queue", definition()),
                change("c3", "add", "entity", "queue-tier", watching("Queue", "depth", "sd-queue")),
                change("c4", "add", "relationship", "payments-queue-tier", link("payments", "queue-tier")),
                change("c5", "remove", "relationship", "orders-api-payments"),
            ],
            verification=[{"entity": "queue-tier", "signal": "depth", "status": "verified", "query": "q", "value": 1, "error": None}],
            findings=[{"severity": "low", "entity": None, "text": "Note.", "changeIds": ["c3"]}],
        )

    def test_valid_results_have_no_problems(self):
        explain = {
            "kind": "explain", "entity": "payments", "state": "Healthy", "summary": "Fine.",
            "causes": [{"entity": "payments", "signal": None, "state": "Healthy", "threshold": None, "value": None, "rollup": None, "note": "ok"}],
        }

        self.assertEqual(model_diff.validate_result(self.valid(), base_model(), TARGET), [])
        self.assertEqual(model_diff.validate_result(self.valid(), None, TARGET), [])
        self.assertEqual(model_diff.validate_result(explain, base_model(), TARGET), [])
        self.assertEqual(model_diff.validate_result(explain), [])

    def test_optional_fields_pass_validation_without_being_read_or_changed(self):
        explain = {
            "kind": "explain", "entity": "payments", "state": "Healthy", "summary": "Fine.",
            "causes": [{"entity": "payments", "signal": None, "state": "Healthy", "threshold": None, "value": None, "rollup": None, "note": "ok"}],
        }
        with mock.patch.object(model_diff, "VALIDATOR", validator_that_lets_the_optional_fields_through()):
            for label, value in OPTIONAL_VALUES:
                cases = [
                    ("a diff with confidence", {**self.valid(), "confidence": value}),
                    ("an explain with confidence", {**explain, "confidence": value}),
                    ("an explain with a window", {**explain, "window": value}),
                    ("an explain with both", {**explain, "confidence": value, "window": value}),
                ]
                for kind, result in cases:
                    with self.subTest(value=label, result=kind):
                        before = copy.deepcopy(result)

                        problems = model_diff.validate_result(result, base_model(), TARGET)

                        self.assertEqual(problems, [])
                        self.assertEqual(result, before)
            unknown = model_diff.validate_result({**self.valid(), "bogus": 1}, base_model(), TARGET)
            window_on_a_diff = model_diff.validate_result({**self.valid(), "window": "x"}, base_model(), TARGET)

        self.assertTrue(any("bogus" in problem for problem in unknown), unknown)
        self.assertTrue(any("window" in problem for problem in window_on_a_diff), window_on_a_diff)

    def test_each_rule_is_reported_with_the_text_the_agent_needs(self):
        def mutate(fn):
            result = self.valid()
            fn(result)
            return result

        def replace(index, **values):
            return lambda result: result["changes"][index].update(values)

        cases = [
            ("not an object", ["not", "an", "object"], "result: "),
            ("missing kind", {"summary": "x"}, "kind"),
            ("unknown op", mutate(replace(0, op="rename")), "changes[0].op"),
            ("short name", mutate(replace(0, name="ab")), "changes[0].name"),
            ("name with slash", mutate(replace(2, name="queue/tier")), "changes[2].name"),
            ("remove with properties", mutate(replace(4, after={"x": 1})), "changes[4].after"),
            ("add without properties", mutate(replace(1, after=None)), "changes[1].after"),
            ("empty reason", mutate(replace(0, reason="")), "changes[0].reason"),
            ("extra change key", mutate(replace(0, before={})), "changes[0]"),
            ("duplicate ids", mutate(replace(1, id="c1")), "id 'c1' is used more than once"),
            ("unknown finding id", mutate(lambda r: r["findings"][0].update(changeIds=["c9"])), "findings[0].changeIds: no change has id 'c9'"),
            ("same resource twice", mutate(lambda r: r["changes"].append(change("c6", "change", "entity", "PAYMENTS", watching("P", "a", "sd-queue")))), "already changed by 'c1'"),
            ("add that exists", mutate(replace(2, name="payments")), "entity 'payments' already exists in the model; use op 'change'"),
            ("change that is absent", mutate(replace(0, name="ghost-entity")), "entity 'ghost-entity' does not exist in the model; use op 'add'"),
            ("remove that is absent", mutate(replace(4, name="ghost-link")), "relationship 'ghost-link' does not exist in the model"),
            ("relationship without parent", mutate(replace(3, after={"childEntityName": "queue-tier"})), "needs the entity name in parentEntityName"),
            ("relationship with snake case names", mutate(replace(3, after={"parent_entity_name": "payments", "child_entity_name": "queue-tier"})), "needs the entity name in parentEntityName"),
            ("relationship to a missing entity", mutate(replace(3, after=link("payments", "nowhere"))), "child entity 'nowhere' does not exist in the proposed model"),
            ("relationship left dangling by a removal", mutate(lambda r: r["changes"].append(change("c6", "remove", "entity", "orders-db"))), "relationship 'orders-api-orders-db' child entity 'orders-db' does not exist"),
            ("signal of an entity naming a definition nothing defines", mutate(replace(0, after=watching("Payments", "latency", "sd-ghost"))), "entity 'payments' uses signal definition 'sd-ghost', which does not exist in the proposed model; add the signal definition or stop using it"),
            ("definition removed while an unchanged entity still uses it", mutate(lambda r: r["changes"].append(change("c6", "remove", "signalDefinition", "sd-db-cpu"))), "entity 'orders-db' uses signal definition 'sd-db-cpu', which does not exist in the proposed model"),
            ("same pair under a new name", mutate(replace(3, name="my-own-name", after=link("web-frontend", "orders-api"))), "use the existing name 'web-frontend-orders-api'"),
            ("same pair in another case", mutate(replace(3, name="my-own-name", after=link("WEB-Frontend", "Orders-API"))), "use the existing name 'web-frontend-orders-api'"),
            ("same pair added twice", mutate(lambda r: r["changes"].append(change("c6", "add", "relationship", "payments-queue-again", link("payments", "queue-tier")))), "also used by"),
            ("resource id outside the target", mutate(replace(0, after=watching_in("/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-fixture"))), "outside the target's subscription and resource group"),
            ("action group the model does not use", mutate(replace(0, after={"alerts": {"unhealthy": {"actionGroupIds": ["/subscriptions/x/resourceGroups/y/providers/microsoft.insights/actionGroups/new"]}}})), "is not already used in the model"),
            ("name with a trailing newline", mutate(replace(2, name="queue-tier\n")), "changes[2].name"),
        ]
        for label, result, expected in cases:
            with self.subTest(label=label):
                problems = model_diff.validate_result(result, base_model(), TARGET)

                self.assertTrue(problems, label)
                self.assertTrue(any(expected in problem for problem in problems), (expected, problems))

    def test_a_signal_definition_may_go_with_everything_that_used_it_and_names_match_in_any_case(self):
        cases = [
            ("the entity stops using it", [change("c1", "remove", "signalDefinition", "sd-db-cpu"), change("c2", "change", "entity", "orders-db", {"displayName": "Orders DB"})]),
            ("the entity goes too", [change("c1", "remove", "signalDefinition", "sd-db-cpu"), change("c2", "remove", "relationship", "orders-api-orders-db"), change("c3", "remove", "entity", "orders-db")]),
            ("the definition is written in another case", [change("c1", "change", "entity", "payments", watching("Payments", "latency", "SD-HTTP-5XX"))]),
            ("the definition is added by the same diff", [change("c1", "add", "signalDefinition", "sd-queue", definition()), change("c2", "change", "entity", "payments", watching("Payments", "latency", "sd-queue"))]),
        ]
        for label, changes in cases:
            with self.subTest(label=label):
                self.assertEqual(model_diff.validate_result(diff_result(changes), base_model(), TARGET), [])

    def test_replacing_a_relationship_under_a_new_name_is_allowed_when_the_old_one_goes(self):
        result = diff_result(
            [
                change("c1", "remove", "relationship", "web-frontend-orders-api"),
                change("c2", "add", "relationship", "frontend-to-orders", link("web-frontend", "orders-api")),
            ]
        )

        self.assertEqual(model_diff.validate_result(result, base_model(), TARGET), [])

    def test_base_rules_are_skipped_without_a_base_but_reference_rules_are_not(self):
        adds_existing = diff_result([change("c1", "add", "entity", "payments", watching("P", "a", "b"))])
        duplicate_ids = self.valid()
        duplicate_ids["changes"][1]["id"] = "c1"

        self.assertEqual(model_diff.validate_result(adds_existing, None, TARGET), [])
        self.assertTrue(model_diff.validate_result(adds_existing, base_model(), TARGET))
        self.assertEqual(
            model_diff.validate_result(duplicate_ids, None, TARGET),
            ["changes: id 'c1' is used more than once"],
        )

    def test_problems_are_capped(self):
        result = diff_result(
            [change(f"c{n}", "change", "entity", f"missing-{n:02d}", watching("x", "a", "sd-http-5xx")) for n in range(30)]
        )

        problems = model_diff.validate_result(result, base_model(), TARGET)

        self.assertEqual(len(problems), 21)
        self.assertEqual(problems[-1], "10 more problems not shown")


class SafetyRuleTests(unittest.TestCase):
    OTHER_SUB = "22222222-2222-2222-2222-222222222222"
    KNOWN_GROUP = f"/subscriptions/{OTHER_SUB}/resourceGroups/rg-monitor/providers/microsoft.insights/actionGroups/ops"
    NEW_GROUP = f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/microsoft.insights/actionGroups/new"
    FOREIGN = f"/subscriptions/{OTHER_SUB}/resourceGroups/rg-shared/providers/Microsoft.OperationalInsights/workspaces/logs"

    def base_with_foreign_id(self):
        base = base_model()
        entity_of(base, "payments")["properties"]["signalGroups"]["azureLogAnalytics"] = {
            "logAnalyticsWorkspaceResourceId": self.FOREIGN,
            "signals": [],
        }
        return base

    def test_resource_ids_must_stay_in_the_targets_subscription_and_group_unless_the_model_already_uses_them(self):
        present = model_diff.present_in(self.base_with_foreign_id())
        cases = [
            ("the scope itself", SCOPE, True),
            ("a resource inside it", f"{SCOPE}/providers/Microsoft.App/containerApps/web", True),
            ("in another case", f"/SUBSCRIPTIONS/{SUB.upper()}/RESOURCEGROUPS/{GROUP.upper()}/providers/x", True),
            ("with surrounding blanks", f"  {SCOPE}/providers/x ", True),
            ("a new id inside the target", f"{SCOPE}/providers/Microsoft.App/containerApps/brand-new", True),
            ("another subscription", f"/subscriptions/{self.OTHER_SUB}/resourceGroups/{GROUP}/providers/x", False),
            ("another group", f"/subscriptions/{SUB}/resourceGroups/rg-other/providers/x", False),
            ("a group that only starts the same", f"{SCOPE}-other/providers/x", False),
            ("the whole subscription", f"/subscriptions/{SUB}", False),
            ("a dot dot segment", f"{SCOPE}/../rg-other/providers/x", False),
            ("a dot segment", f"{SCOPE}/./providers/x", False),
            ("another group in another case", f"/Subscriptions/{SUB}/ResourceGroups/RG-OTHER", False),
            ("a query that only mentions an id", f"AzureDiagnostics | where ResourceId == '/subscriptions/{self.OTHER_SUB}/x'", True),
            ("text that is no id", "Orders API", True),
            ("an empty string", "", True),
            ("an id of another group that the model already uses", self.FOREIGN, True),
            ("the same id in another case", self.FOREIGN.upper(), True),
            ("the same id with surrounding blanks", f"  {self.FOREIGN} ", True),
            ("an id of another group that is new", self.FOREIGN.replace("workspaces/logs", "workspaces/other"), False),
            ("an id that only starts like one the model uses", f"{self.FOREIGN}/tables/x", False),
            ("an id that is only the start of one the model uses", self.FOREIGN.rsplit("/", 1)[0], False),
        ]
        for label, value, allowed in cases:
            with self.subTest(label=label):
                after = {"top": value, "nested": {"deeper": [{"here": value}]}, "list": [value], "count": 3, "flag": None}

                problems = model_diff.scope_problems([change("c1", "change", "entity", "payments", after)], TARGET, present)

                self.assertEqual(len(problems), 0 if allowed else 3, problems)
                self.assertTrue(all("changes[0]: entity 'payments'" in problem for problem in problems))
                self.assertTrue(all(problem.endswith("and is not used in the model") for problem in problems))

    def test_without_a_target_only_ids_the_model_already_uses_are_trusted(self):
        present = model_diff.present_in(self.base_with_foreign_id())
        after = {"used": self.FOREIGN, "new": f"{SCOPE}/providers/Microsoft.App/containerApps/brand-new", "text": "no id"}

        problems = model_diff.scope_problems([change("c1", "change", "entity", "payments", after)], None, present)

        self.assertEqual(len(problems), 1)
        self.assertIn(f"'{SCOPE}/pr", problems[0])
        self.assertNotIn("rg-shared", problems[0])
        self.assertTrue(model_diff.validate_result(diff_result([change("c1", "change", "entity", "payments", {"id": after["new"]})]), base_model()))
        self.assertEqual(model_diff.validate_result(diff_result([change("c1", "change", "entity", "payments", {"id": self.FOREIGN})]), self.base_with_foreign_id()), [])

    def test_a_review_may_keep_ids_of_other_groups_the_model_uses_but_not_add_new_ones(self):
        base = self.base_with_foreign_id()
        workspace = lambda id_: {"displayName": "Payments", "signalGroups": {"azureLogAnalytics": {"logAnalyticsWorkspaceResourceId": id_, "signals": []}}}
        cases = [
            ("a foreign id that is re-emitted", self.FOREIGN, 0),
            ("the same foreign id in another case", self.FOREIGN.upper(), 0),
            ("a new foreign id", self.FOREIGN.replace("workspaces/logs", "workspaces/other"), 1),
            ("a new id inside the target", f"{SCOPE}/providers/Microsoft.OperationalInsights/workspaces/mine", 0),
        ]
        for label, id_, expected in cases:
            with self.subTest(label=label):
                result = diff_result([change("c1", "change", "entity", "payments", workspace(id_))])

                problems = model_diff.validate_result(result, base, TARGET)

                self.assertEqual(len(problems), expected, problems)
                if expected:
                    self.assertIn("is outside the target's subscription and resource group and is not used in the model", problems[0])

    def test_removals_and_action_group_entries_are_not_scope_checked(self):
        outside = f"/subscriptions/{self.OTHER_SUB}/resourceGroups/rg-other"
        changes = [
            change("c1", "remove", "entity", "payments"),
            change("c2", "change", "entity", "web-frontend", {"alerts": {"unhealthy": {"actionGroupIds": [outside]}}}),
        ]

        self.assertEqual(model_diff.scope_problems(changes, TARGET, set()), [])

    def test_action_groups_must_already_be_used_somewhere_in_the_base_model(self):
        base = self.base_with_foreign_id()
        entity_of(base, "payments")["properties"]["alerts"] = {"unhealthy": {"actionGroupIds": [self.KNOWN_GROUP]}}
        present = model_diff.present_in(base)
        nested = lambda ids: {"alerts": {"degraded": {"severity": "Sev3", "actionGroupIds": ids}}, "other": [{"actionGroupIds": ids}]}
        cases = [
            ("an id the model uses", [self.KNOWN_GROUP], 0),
            ("the same id in another case", [self.KNOWN_GROUP.upper()], 0),
            ("the same id with surrounding blanks", [f" {self.KNOWN_GROUP} "], 0),
            ("an id the model uses outside any action group list", [self.FOREIGN], 0),
            ("a new id", [self.NEW_GROUP], 2),
            ("one known and one new", [self.KNOWN_GROUP, self.NEW_GROUP], 2),
            ("two new", [self.NEW_GROUP, f"{self.NEW_GROUP}-2"], 4),
            ("no ids", [], 0),
            ("entries that are no text", [5, None, {"x": 1}], 0),
        ]
        for label, ids, expected in cases:
            with self.subTest(label=label):
                problems = model_diff.action_group_problems([change("c1", "change", "entity", "web-frontend", nested(ids))], present)

                self.assertEqual(len(problems), expected, problems)
        removal = [change("c1", "remove", "entity", "payments")]
        self.assertEqual(model_diff.action_group_problems(removal, present), [])

    def test_a_known_action_group_in_another_group_is_fine_and_a_new_one_in_the_target_is_not(self):
        base = base_model()
        entity_of(base, "payments")["properties"]["alerts"] = {"unhealthy": {"actionGroupIds": [self.KNOWN_GROUP]}}
        keep = diff_result([change("c1", "change", "entity", "payments", {"alerts": {"unhealthy": {"actionGroupIds": [self.KNOWN_GROUP]}}})])
        add = diff_result([change("c1", "change", "entity", "payments", {"alerts": {"unhealthy": {"actionGroupIds": [self.NEW_GROUP]}}})])

        self.assertEqual(model_diff.validate_result(keep, base, TARGET), [])
        problems = model_diff.validate_result(add, base, TARGET)
        self.assertEqual(len(problems), 1)
        self.assertIn("is not already used in the model", problems[0])

    def test_ids_present_in_the_base_are_compared_without_case_or_blanks(self):
        base = {"entities": [{"name": "a", "properties": {"id": "  /Subscriptions/X/y ", "list": ["Z"], "n": 1, "k": None}}]}

        self.assertEqual(model_diff.present_in(base), {"a", "/subscriptions/x/y", "z"})
        self.assertEqual(model_diff.present_in({}), set())

    def test_entities_discovered_automatically_cannot_be_changed_or_removed(self):
        base = base_model()
        entity_of(base, "orders-db")["properties"]["discoveredBy"] = "rule-1"
        entity_of(base, "payments")["properties"]["discoveredBy"] = ""
        cases = [
            ("change", change("c1", "change", "entity", "orders-db", {"displayName": "x"}), 1),
            ("remove", change("c1", "remove", "entity", "orders-db"), 1),
            ("in another case", change("c1", "change", "entity", "ORDERS-DB", {"displayName": "x"}), 1),
            ("an entity nobody discovered", change("c1", "change", "entity", "web-frontend", {"displayName": "x"}), 0),
            ("an empty marker", change("c1", "change", "entity", "payments", {"displayName": "x"}), 0),
            ("a relationship of it", change("c1", "remove", "relationship", "orders-api-orders-db"), 0),
            ("a definition with the same name", change("c1", "change", "signalDefinition", "orders-db", definition()), 0),
            ("a new entity", change("c1", "add", "entity", "brand-new", {"displayName": "x"}), 0),
        ]
        for label, current, expected in cases:
            with self.subTest(label=label):
                problems = model_diff.discovered_problems([current], base)

                self.assertEqual(len(problems), expected, problems)
        self.assertIn("discovered automatically", model_diff.discovered_problems([cases[0][1]], base)[0])
        self.assertTrue(model_diff.validate_result(diff_result([cases[0][1]]), base, TARGET))

    def test_a_result_may_have_at_most_200_changes(self):
        import time

        def many(count, id_=None):
            return [change(id_ or f"c{n}", "add", "signalDefinition", f"sd-{n:04d}", definition()) for n in range(count)]

        cases = [("none", many(0), []), ("at the limit", many(200), []), ("one over", many(201), ["changes: 201 changes is more than the 200 allowed"]),
                 ("far over, same id everywhere", many(5000, "c"), ["changes: 5000 changes is more than the 200 allowed"])]
        for label, changes, expected in cases:
            with self.subTest(label=label):
                started = time.perf_counter()

                problems = model_diff.validate_result(diff_result(changes), base_model(), TARGET)

                self.assertEqual(problems, expected)
                self.assertLess(time.perf_counter() - started, 3)

    def test_the_change_limit_applies_before_anything_walks_the_changes(self):
        junk = {"kind": "diff", "summary": "s", "changes": [None] * 201, "verification": [], "findings": []}

        self.assertEqual(model_diff.validate_result(junk, base_model(), TARGET), ["changes: 201 changes is more than the 200 allowed"])
        self.assertTrue(model_diff.validate_result({**junk, "changes": [None] * 200}, base_model(), TARGET))
        self.assertTrue(model_diff.validate_result({"kind": "diff", "changes": "many"}, base_model(), TARGET))

    def test_a_single_after_may_be_at_most_64_kb_serialized(self):
        def sized(text, count):
            return {"x": text * count}

        cases = [
            ("small", sized("a", 100), 0),
            ("exactly the limit", sized("a", 65528), 0),
            ("one byte over", sized("a", 65529), 1),
            ("two byte characters count as bytes", sized("é", 32764), 0),
            ("two byte characters over", sized("é", 32765), 1),
            ("a huge value", sized("a", 5_000_000), 1),
        ]
        for label, after, expected in cases:
            with self.subTest(label=label):
                changes = [change("c1", "add", "signalDefinition", "sd-one", after), change("c2", "remove", "entity", "payments")]

                problems = model_diff.size_problems(changes)

                self.assertEqual(len(problems), expected, problems)
        self.assertIn("changes[0]: signalDefinition 'sd-one': after is 65537 bytes; at most 65536 are allowed",
                      model_diff.size_problems([change("c1", "add", "signalDefinition", "sd-one", sized("a", 65529))]))

    def test_names_must_match_the_resource_name_pattern_exactly(self):
        cases = [
            ("plain", "queue-tier", 0),
            ("two characters are too few", "ab", 1),
            ("trailing newline", "queue-tier\n", 1),
            ("leading newline", "\nqueue-tier", 1),
            ("newline inside", "queue\ntier", 1),
            ("trailing hyphen", "queue-tier-", 1),
            ("longest allowed", "a" * 260, 0),
            ("one too long", "a" * 261, 1),
            ("non ascii letters", "queue-tiér", 1),
        ]
        for label, name, expected in cases:
            with self.subTest(label=label):
                problems = model_diff.name_problems([change("c1", "add", "entity", name, {"displayName": "x"})])

                self.assertEqual(len(problems), expected, problems)

    def test_a_trailing_newline_passes_the_schema_but_not_the_result_check(self):
        result = diff_result([change("c1", "add", "signalDefinition", "sd-queue\n", definition())])

        self.assertEqual(list(model_diff.VALIDATOR.iter_errors(result)), [])
        problems = model_diff.validate_result(result, base_model(), TARGET)

        self.assertEqual(len(problems), 1)
        self.assertIn("changes[0].name: 'sd-queue\\n' is not a valid resource name", problems[0])


class ProposedModelTests(unittest.TestCase):
    def test_each_op_per_kind(self):
        new_entity = watching("Brand new", "depth", "sd-new")
        cases = [
            ("add entity", change("c", "add", "entity", "brand-new", new_entity), "entities", "brand-new", True),
            ("change entity", change("c", "change", "entity", "payments", {"displayName": "Renamed"}), "entities", "payments", True),
            ("remove entity", change("c", "remove", "entity", "payments"), "entities", "payments", False),
            ("add signal definition", change("c", "add", "signalDefinition", "sd-new", definition()), "signalDefinitions", "sd-new", True),
            ("change signal definition", change("c", "change", "signalDefinition", "sd-db-cpu", definition("Renamed")), "signalDefinitions", "sd-db-cpu", True),
            ("remove signal definition", change("c", "remove", "signalDefinition", "sd-db-cpu"), "signalDefinitions", "sd-db-cpu", False),
            ("add relationship", change("c", "add", "relationship", "payments-new", link("payments", "orders-db")), "relationships", "payments-new", True),
            ("change relationship", change("c", "change", "relationship", "orders-api-payments", link("web-frontend", "payments")), "relationships", "orders-api-payments", True),
            ("remove relationship", change("c", "remove", "relationship", "orders-api-payments"), "relationships", "orders-api-payments", False),
        ]
        for label, one, collection, name, present in cases:
            with self.subTest(label=label):
                base = base_model()
                before = copy.deepcopy(base)

                proposed = model_diff.proposed_model(base, [one])

                self.assertEqual(base, before)
                self.assertEqual(name in names(proposed[collection]), present)
                self.assertEqual(
                    len(proposed[collection]),
                    len(base[collection]) + (1 if one["op"] == "add" else -1 if one["op"] == "remove" else 0),
                )
                if present:
                    stored = next(i for i in proposed[collection] if i["name"] == name)
                    self.assertEqual(stored["properties"].get("displayName"), (one["after"] or {}).get("displayName"))

    def test_changes_keep_the_live_state_and_adds_are_unknown_in_the_graph(self):
        base = base_model()
        proposed = model_diff.proposed_model(
            base,
            [
                change("c1", "change", "entity", "orders-api", watching("Orders (renamed)", "order-errors", "sd-order-errors")),
                change("c2", "add", "entity", "queue-tier", watching("Queue", "depth", "sd-new")),
            ],
        )

        kept = entity_of(proposed, "orders-api")
        added = entity_of(proposed, "queue-tier")

        self.assertEqual(kept["properties"]["healthState"], "Degraded")
        self.assertEqual(kept["id"], entity_of(base, "orders-api")["id"])
        self.assertNotIn("healthState", added["properties"])
        graph = dto.graph_dto(proposed["entities"], proposed["relationships"], MODEL)
        states = {item["name"]: item["healthState"] for item in graph["entities"]}
        self.assertEqual(states["queue-tier"], "Unknown")
        self.assertEqual(states["orders-api"], "Degraded")

    def test_relationship_summaries_name_parent_and_child(self):
        summaries = model_diff.relationship_summaries(base_model())

        self.assertEqual(
            summaries,
            [
                {"name": "hm-base-web-frontend", "parent": "hm-base", "child": "web-frontend"},
                {"name": "orders-api-orders-db", "parent": "orders-api", "child": "orders-db"},
                {"name": "orders-api-payments", "parent": "orders-api", "child": "payments"},
                {"name": "web-frontend-orders-api", "parent": "web-frontend", "child": "orders-api"},
            ],
        )
        self.assertEqual(model_diff.relationship_summaries({}), [])


class DetailsTests(unittest.TestCase):
    def test_details_list_leaf_differences_and_ignore_system_fields(self):
        cases = [
            ("scalar change", {"a": 1}, {"a": 2}, [{"path": "a", "before": 1, "after": 2}]),
            ("nested change", {"a": {"b": {"c": "x"}}}, {"a": {"b": {"c": "y"}}}, [{"path": "a.b.c", "before": "x", "after": "y"}]),
            ("int equals float", {"a": 1.0}, {"a": 1}, []),
            ("equal", {"a": [1, 2]}, {"a": [1, 2]}, []),
            ("added key", {"a": 1}, {"a": 1, "b": 2}, [{"path": "b", "before": None, "after": 2}]),
            ("removed key", {"a": 1, "b": 2}, {"a": 1}, [{"path": "b", "before": 2, "after": None}]),
            ("add lists every leaf", None, {"a": 1, "b": {"c": 2}}, [{"path": "a", "before": None, "after": 1}, {"path": "b.c", "before": None, "after": 2}]),
            ("remove lists every leaf", {"a": 1, "b": {"c": 2}}, None, [{"path": "a", "before": 1, "after": None}, {"path": "b.c", "before": 2, "after": None}]),
            ("unkeyed list is one value", {"a": [1, 2]}, {"a": [1, 3]}, [{"path": "a", "before": [1, 2], "after": [1, 3]}]),
            (
                "keyed list by name",
                {"signals": [{"name": "cpu", "x": 1}, {"name": "mem", "x": 2}]},
                {"signals": [{"name": "mem", "x": 5}, {"name": "cpu", "x": 1}, {"name": "net", "x": 3}]},
                [
                    {"path": "signals[mem].x", "before": 2, "after": 5},
                    {"path": "signals[net].name", "before": None, "after": "net"},
                    {"path": "signals[net].x", "before": None, "after": 3},
                ],
            ),
            (
                "removed keyed item",
                {"signals": [{"name": "cpu", "x": 1}, {"name": "mem", "x": 2}]},
                {"signals": [{"name": "cpu", "x": 1}]},
                [{"path": "signals[mem].name", "before": "mem", "after": None}, {"path": "signals[mem].x", "before": 2, "after": None}],
            ),
            (
                "system fields never show",
                {"healthState": "Healthy", "provisioningState": "Succeeded", "signalGroups": {"azureResource": {"signals": [{"name": "c", "status": {"value": 1}}]}}},
                {"healthState": "Unhealthy", "provisioningState": "Failed", "signalGroups": {"azureResource": {"signals": [{"name": "c", "status": {"value": 9}}]}}},
                [],
            ),
        ]
        for label, before, after, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(model_diff.change_details(before, after), expected)


class SelectionTests(unittest.TestCase):
    def changes(self):
        return [
            change("sd1", "add", "signalDefinition", "sd-queue", definition()),
            change("sd2", "change", "signalDefinition", "sd-db-cpu", definition("Tuned")),
            change("e1", "add", "entity", "queue-tier", watching("Queue", "depth", "sd-queue")),
            change("e2", "change", "entity", "payments", watching("Payments", "latency", "sd-queue")),
            change("e3", "add", "entity", "audit-log", {"displayName": "Audit"}),
            change("r1", "add", "relationship", "payments-queue-tier", link("payments", "queue-tier")),
            change("r2", "add", "relationship", "audit-log-queue-tier", link("queue-tier", "audit-log")),
            change("r3", "remove", "relationship", "orders-api-orders-db"),
            change("e4", "remove", "entity", "orders-db"),
            change("sd3", "remove", "signalDefinition", "sd-db-cpu-old"),
        ]

    def test_expansion_brings_dependents_in_change_order(self):
        cases = [
            ("a lone signal definition change", ["sd2"], ["sd2"]),
            ("an added entity brings its definitions and relationships", ["e1"], ["sd1", "e1", "e3", "r1", "r2"]),
            ("a relationship brings its added endpoints", ["r1"], ["sd1", "e1", "e3", "r1", "r2"]),
            ("a changed entity needs only added definitions", ["e2"], ["sd1", "e2"]),
            ("a removed entity brings its relationship removals", ["e4"], ["r3", "e4"]),
            ("a relationship removal stands alone", ["r3"], ["r3"]),
            ("unknown ids are ignored", ["nope"], []),
            ("order follows the diff, not the selection", ["r2", "sd2"], ["sd1", "sd2", "e1", "e3", "r1", "r2"]),
        ]
        for label, selected, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(
                    model_diff.expand_selection(self.changes(), selected, base_model()), expected
                )

    def test_removing_an_entity_brings_every_relationship_change_that_moves_off_it(self):
        changes = [
            change("move-parent", "change", "relationship", "web-frontend-orders-api", link("hm-base", "orders-api")),
            change("move-child", "change", "relationship", "orders-api-orders-db", link("orders-api", "payments")),
            change("drop", "remove", "relationship", "hm-base-web-frontend"),
            change("gone-frontend", "remove", "entity", "web-frontend"),
            change("gone-db", "remove", "entity", "orders-db"),
            change("elsewhere", "change", "relationship", "orders-api-payments", link("orders-api", "payments")),
        ]
        cases = [
            ("the parent end moved away", ["gone-frontend"], ["move-parent", "drop", "gone-frontend"]),
            ("the child end moved away", ["gone-db"], ["move-child", "gone-db"]),
            ("the relationship change alone", ["move-parent"], ["move-parent"]),
        ]
        for label, selected, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(model_diff.expand_selection(changes, selected, base_model()), expected)

    def test_removing_a_definition_brings_the_entities_that_stop_using_it(self):
        base = base_model()
        changes = [
            change("sd", "remove", "signalDefinition", "sd-db-cpu"),
            change("keep", "change", "entity", "orders-db", {"displayName": "Orders DB"}),
            change("unrelated", "change", "entity", "payments", {"displayName": "P"}),
        ]

        self.assertEqual(model_diff.expand_selection(changes, ["sd"], base), ["sd", "keep"])
        self.assertEqual(model_diff.expand_selection(changes, ["keep"], base), ["keep"])

        dropped = [change("sd", "remove", "signalDefinition", "sd-db-cpu"), change("gone", "remove", "entity", "orders-db")]
        self.assertEqual(model_diff.expand_selection(dropped, ["sd"], base), ["sd", "gone"])

    def test_apply_order_writes_definitions_entities_relationships_then_removes_in_reverse(self):
        shuffled = [
            change("1", "remove", "signalDefinition", "a-sd"),
            change("2", "add", "relationship", "a-rel", link("x", "y")),
            change("3", "remove", "entity", "a-ent"),
            change("4", "change", "entity", "b-ent", {}),
            change("5", "add", "signalDefinition", "b-sd", {}),
            change("6", "remove", "relationship", "b-rel"),
            change("7", "add", "entity", "c-ent", {}),
            change("8", "change", "signalDefinition", "c-sd", {}),
        ]

        ordered = [c["id"] for c in model_diff.apply_order(shuffled)]

        self.assertEqual(ordered, ["5", "8", "4", "7", "2", "6", "3", "1"])
        self.assertEqual(model_diff.apply_order([]), [])


UNSEEN = {
    "canvasPosition": ({"x": 600, "y": 400}, {"x": 1, "y": 2}),
    "icon": ({"iconName": "Database"}, {"iconName": "Queue"}),
    "alerts": ({"unhealthy": {"severity": "Sev1", "description": "Down", "actionGroupIds": ["/subscriptions/x/resourceGroups/y/providers/microsoft.insights/actionGroups/ops"]}}, {"degraded": {"severity": "Sev3"}}),
    "tags": ({"team": "payments"}, {"team": "other"}),
}


class UnseenPropertyTests(unittest.TestCase):
    def base_with(self, **properties):
        base = base_model()
        entity_of(base, "payments")["properties"].update(properties)
        return base

    def test_the_four_properties_the_agent_never_sees_are_carried_unless_after_sets_them(self):
        for name, (kept, explicit) in UNSEEN.items():
            cases = [
                ("after omits it", {"displayName": "Renamed"}, kept),
                ("after sets another value", {"displayName": "Renamed", name: explicit}, explicit),
                ("after sets it to null", {"displayName": "Renamed", name: None}, None),
                ("after sets it to the same value", {"displayName": "Renamed", name: kept}, kept),
            ]
            for label, after, expected in cases:
                with self.subTest(property=name, case=label):
                    base = self.base_with(**{name: kept})
                    existing = entity_of(base, "payments")
                    current = change("c1", "change", "entity", "payments", after)
                    original = copy.deepcopy(after)

                    carried = model_diff.carry_unseen(current, existing)
                    proposed = {e["name"]: e for e in model_diff.proposed_model(base, [current])["entities"]}["payments"]
                    view = model_diff.diff_view(diff_result([current]), base, MODEL, TARGET, [], True)["changes"][0]

                    shown = [d for d in view["details"] if d["path"].split(".")[0] == name]
                    self.assertEqual(carried[name], expected)
                    self.assertEqual(proposed["properties"][name], expected)
                    self.assertEqual(view["after"][name], expected)
                    self.assertEqual(bool(shown), expected != kept)
                    self.assertEqual(after, original)

    def test_a_change_that_leaves_the_four_properties_out_does_not_show_them_as_removed(self):
        kept = {name: values[0] for name, values in UNSEEN.items()}
        base = self.base_with(**kept)
        current = change("c1", "change", "entity", "payments", {"displayName": "Renamed", "impact": "Standard"})

        view = model_diff.diff_view(diff_result([current]), base, MODEL, TARGET, [], True)["changes"][0]

        self.assertEqual(
            {d["path"] for d in view["details"]},
            {"displayName", "impact", "signalGroups.dependencies.aggregationType", "signalGroups.dependencies.ignoreUnknown"},
        )
        self.assertEqual([(d["path"], d["before"], d["after"]) for d in view["details"] if d["path"] == "displayName"], [("displayName", "Payments", "Renamed")])

    def test_only_those_four_are_carried(self):
        base = self.base_with(**{name: values[0] for name, values in UNSEEN.items()})
        existing = entity_of(base, "payments")
        current = change("c1", "change", "entity", "payments", {"displayName": "Renamed"})

        carried = model_diff.carry_unseen(current, existing)

        self.assertEqual(set(carried), {"displayName", *UNSEEN})
        for name in ("impact", "signalGroups", "healthState"):
            self.assertNotIn(name, carried)

    def test_other_ops_and_kinds_are_left_alone(self):
        base = self.base_with(**{name: values[0] for name, values in UNSEEN.items()})
        entity = entity_of(base, "payments")
        definition_item = base["signalDefinitions"][0]
        definition_item["properties"]["tags"] = {"team": "payments"}
        link_item = base["relationships"][0]
        link_item["properties"]["tags"] = {"team": "payments"}
        cases = [
            ("an add that finds nothing live", change("c1", "add", "entity", "brand-new", {"displayName": "x"}), None),
            ("an add of a name that already exists", change("c1", "add", "entity", "payments", {"displayName": "x"}), entity),
            ("a removal", change("c1", "remove", "entity", "payments"), entity),
            ("a change of something that is not there", change("c1", "change", "entity", "ghost-entity", {"displayName": "x"}), None),
            ("a signal definition", change("c1", "change", "signalDefinition", definition_item["name"], definition()), definition_item),
            ("a relationship", change("c1", "change", "relationship", link_item["name"], link("payments", "orders-db")), link_item),
        ]
        for label, current, existing in cases:
            with self.subTest(case=label):
                self.assertEqual(model_diff.carry_unseen(current, existing), current["after"])

    def test_an_add_leaves_them_absent_in_the_proposal_and_the_view(self):
        base = self.base_with(**{name: values[0] for name, values in UNSEEN.items()})
        current = change("c1", "add", "entity", "brand-new", {"displayName": "New"})

        proposed = {e["name"]: e for e in model_diff.proposed_model(base, [current])["entities"]}["brand-new"]
        view = model_diff.diff_view(diff_result([current]), base, MODEL, TARGET, [], True)["changes"][0]

        self.assertEqual(proposed["properties"], {"displayName": "New"})
        self.assertEqual(view["after"], {"displayName": "New"})

    def test_a_property_the_live_entity_does_not_have_is_not_invented(self):
        base = self.base_with(icon={"iconName": "Database"})
        current = change("c1", "change", "entity", "payments", {"displayName": "Renamed"})

        carried = model_diff.carry_unseen(current, entity_of(base, "payments"))

        self.assertEqual(set(carried) - {"displayName"}, {"icon", "canvasPosition"})


class ScalingTests(unittest.TestCase):
    def test_a_large_design_diff_is_viewed_in_well_under_a_second(self):
        import time

        count = 99
        changes = [change("sd1", "add", "signalDefinition", "sd-shared", definition())]
        for n in range(count):
            changes.append(change(f"e{n}", "add", "entity", f"svc-{n:03d}", watching(f"S{n}", "s", "sd-shared")))
            parent = MODEL if n == 0 else f"svc-{(n - 1) // 2:03d}"
            changes.append(change(f"r{n}", "add", "relationship", f"{parent}-svc-{n:03d}", link(parent, f"svc-{n:03d}")))
        result = diff_result(changes)
        target = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}

        started = time.perf_counter()
        view = model_diff.diff_view(result, base_model(), MODEL, target, [], True)
        problems = model_diff.validate_result(result, base_model(), TARGET)
        elapsed = time.perf_counter() - started

        self.assertEqual(problems, [])
        self.assertEqual(len(view["changes"]), 2 * count + 1)
        self.assertLess(elapsed, 2.0)


class DiffViewTests(unittest.TestCase):
    def view(self, **overrides):
        result = diff_result(
            [
                change("c1", "change", "entity", "payments", watching("Payments (renamed)", "latency", "sd-queue")),
                change("c2", "add", "signalDefinition", "sd-queue", definition()),
                change("c3", "add", "entity", "queue-tier", watching("Queue", "depth", "sd-queue")),
                change("c4", "add", "relationship", "payments-queue-tier", link("payments", "queue-tier")),
                change("c5", "remove", "relationship", "orders-api-payments"),
            ],
            verification=[
                {"entity": "queue-tier", "signal": "depth", "status": "verified", "query": "q", "value": 1, "error": None},
                {"entity": "payments", "signal": "latency", "status": "failing", "query": "q2", "value": None, "error": "no data"},
            ],
            findings=[{"severity": "high", "entity": "payments", "text": "Look.", "changeIds": ["c1"]}],
            summary="The summary.",
        )
        target = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
        arguments = {"applies": [{"outcome": "applied"}], "appliable": True, **overrides}
        return model_diff.diff_view(result, base_model(), MODEL, target, arguments["applies"], arguments["appliable"])

    def test_view_has_the_contract_shape(self):
        view = self.view()

        self.assertEqual(
            set(view),
            {"base", "proposed", "changes", "verification", "findings", "summary", "target", "appliable", "applies"},
        )
        self.assertEqual(view["summary"], "The summary.")
        self.assertEqual(view["appliable"], True)
        self.assertEqual(view["applies"], [{"outcome": "applied"}])
        self.assertEqual(view["target"], {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL})
        self.assertEqual(set(view["base"]), {"entities", "relationships"})
        self.assertEqual(len(view["base"]["entities"]), 5)
        self.assertEqual(len(view["proposed"]["entities"]), 6)
        self.assertEqual(len(view["base"]["relationships"]), 4)
        self.assertEqual(len(view["proposed"]["relationships"]), 4)
        proposed = {item["name"]: item for item in view["proposed"]["entities"]}
        self.assertEqual(proposed["queue-tier"]["healthState"], "Unknown")
        self.assertEqual(proposed["payments"]["healthState"], "Healthy")
        self.assertEqual(proposed["payments"]["displayName"], "Payments (renamed)")
        self.assertEqual({item["name"]: item["healthState"] for item in view["base"]["entities"]}["orders-db"], "Unhealthy")

    def test_an_optional_confidence_is_passed_to_the_view_untouched_and_only_when_present(self):
        changes = [change("c1", "change", "entity", "payments", watching("Payments (renamed)", "latency", "sd-queue"))]
        target = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
        cases = [*OPTIONAL_VALUES, ("absent", "__absent__")]
        for label, value in cases:
            with self.subTest(value=label):
                result = diff_result(changes)
                if value != "__absent__":
                    result["confidence"] = value
                before = copy.deepcopy(result)

                view = model_diff.diff_view(result, base_model(), MODEL, target, [], True)

                self.assertEqual(result, before)
                if value == "__absent__":
                    self.assertNotIn("confidence", view)
                else:
                    self.assertEqual(view["confidence"], value)
                    self.assertEqual(json.dumps(view["confidence"], sort_keys=True), json.dumps(value, sort_keys=True))

    def test_each_change_carries_before_after_details_dependencies_and_verification(self):
        changes = {item["id"]: item for item in self.view()["changes"]}

        self.assertEqual(set(changes["c1"]), {"id", "op", "kind", "name", "reason", "before", "after", "details", "dependsOn", "verification"})
        self.assertEqual(changes["c1"]["before"]["displayName"], "Payments")
        self.assertNotIn("healthState", changes["c1"]["before"])
        self.assertEqual(changes["c1"]["after"]["displayName"], "Payments (renamed)")
        self.assertIn({"path": "displayName", "before": "Payments", "after": "Payments (renamed)"}, changes["c1"]["details"])
        self.assertEqual(changes["c1"]["dependsOn"], ["c2"])
        self.assertEqual([row["status"] for row in changes["c1"]["verification"]], ["failing"])
        self.assertIsNone(changes["c3"]["before"])
        self.assertEqual(changes["c3"]["dependsOn"], ["c2", "c4"])
        self.assertEqual([row["entity"] for row in changes["c3"]["verification"]], ["queue-tier"])
        self.assertEqual(sorted(row["entity"] for row in changes["c2"]["verification"]), ["payments", "queue-tier"])
        self.assertEqual(changes["c4"]["dependsOn"], ["c2", "c3"])
        self.assertIsNone(changes["c5"]["after"])
        self.assertEqual(changes["c5"]["verification"], [])
        self.assertTrue(all(detail["after"] is None for detail in changes["c5"]["details"]))


if __name__ == "__main__":
    unittest.main()
