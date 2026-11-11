import copy
import sys
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from contracts import MAX_PROBLEM_CHARS, MAX_PROBLEMS, SCHEMA_PATH, validate_task_result

EXPLAIN = {
    "kind": "explain",
    "entity": "checkout",
    "state": "Unhealthy",
    "summary": "Checkout is Unhealthy because the orders database CPU is above 95 percent.",
    "causes": [
        {
            "entity": "checkout",
            "signal": None,
            "state": "Unhealthy",
            "threshold": None,
            "value": None,
            "rollup": "WorstOf",
            "note": "Takes the worst state of its children.",
        },
        {
            "entity": "orders-db",
            "signal": "cpu",
            "state": "Unhealthy",
            "threshold": "> 95 Unhealthy",
            "value": 97.5,
            "rollup": None,
            "note": "CPU 97.5 percent, reported 2 minutes ago, no error.",
        },
    ],
}

RESOURCE_ID = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Web/sites/storefront"
WORKSPACE_ID = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law"

METRIC_DEFINITION = {
    "signalKind": "AzureResourceMetric",
    "metricNamespace": "Microsoft.Web/sites",
    "metricName": "HttpResponseTime",
    "aggregationType": "Average",
    "timeGrain": "PT5M",
    "evaluationRules": {"unhealthyRule": {"operator": "GreaterThan", "threshold": 2}},
}

INLINE_METRIC = {
    "name": "http-latency",
    "signalKind": "AzureResourceMetric",
    "displayName": "HTTP latency",
    "metricNamespace": "Microsoft.Web/sites",
    "metricName": "HttpResponseTime",
    "aggregationType": "Average",
    "timeGrain": "PT5M",
    "refreshInterval": "PT1M",
    "dataUnit": "Seconds",
    "evaluationRules": {
        "degradedRule": {"operator": "GreaterThan", "threshold": 1},
        "unhealthyRule": {"operator": "GreaterThan", "threshold": 2},
    },
}

INLINE_QUERY = {
    "name": "failed-requests",
    "signalKind": "LogAnalyticsQuery",
    "queryText": "AppRequests | summarize failed = countif(Success == false)",
    "valueColumnName": "failed",
    "timeGrain": "PT5M",
    "evaluationRules": {"unhealthyRule": {"operator": "GreaterThan", "threshold": 5}},
}

ENTITY = {
    "displayName": "Storefront API",
    "icon": {"iconName": "SystemComponent"},
    "healthObjective": 99.9,
    "impact": "Standard",
    "signalGroups": {
        "dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": True},
        "azureResource": {
            "authenticationSetting": "auth-system",
            "azureResourceId": RESOURCE_ID,
            "resourceHealth": {"enabled": "Enabled"},
            "signals": [INLINE_METRIC, {"name": "reused", "signalKind": "AzureResourceMetric", "signalDefinitionName": "http-latency"}],
        },
        "azureLogAnalytics": {"authenticationSetting": "auth-system", "logAnalyticsWorkspaceResourceId": WORKSPACE_ID, "signals": [INLINE_QUERY]},
    },
}

DIFF = {
    "kind": "diff",
    "summary": "Adds a latency signal and removes a stale relationship.",
    "changes": [
        {
            "id": "c1",
            "op": "add",
            "kind": "signalDefinition",
            "name": "http-latency",
            "after": METRIC_DEFINITION,
            "reason": "Latency is not covered.",
        },
        {
            "id": "c2",
            "op": "change",
            "kind": "entity",
            "name": "storefront-api",
            "after": ENTITY,
            "reason": "Uses the new signal.",
        },
        {
            "id": "c3",
            "op": "remove",
            "kind": "relationship",
            "name": "root-legacy",
            "after": None,
            "reason": "The legacy component is gone.",
        },
    ],
    "verification": [
        {"entity": "storefront-api", "signal": "http-latency", "status": "verified", "query": "Total PT5M", "value": 120, "error": None},
        {"entity": "storefront-api", "signal": "failed", "status": "failing", "query": "AppRequests", "value": None, "error": "no data"},
        {"entity": "orders-db", "signal": "cpu", "status": "not_run", "query": None, "value": "n/a", "error": "not deployed"},
    ],
    "findings": [
        {"severity": "high", "entity": "storefront-api", "text": "Latency is not covered.", "changeIds": ["c1", "c2"]},
        {"severity": "low", "entity": None, "text": "A relationship is stale.", "changeIds": []},
    ],
}


def mutated(base, change):
    result = copy.deepcopy(base)
    change(result)
    return result


def set_at(path, value):
    def apply(result):
        target = result
        for part in path[:-1]:
            target = target[part]
        target[path[-1]] = value

    return apply


def drop_at(path):
    def apply(result):
        target = result
        for part in path[:-1]:
            target = target[part]
        del target[path[-1]]

    return apply


class TaskResultValidationTests(unittest.TestCase):
    def test_schema_is_a_valid_draft_2020_12_schema(self):
        import json

        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

        Draft202012Validator.check_schema(schema)
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")

    def test_valid_results_have_no_problems(self):
        cases = {
            "explain": EXPLAIN,
            "explain without causes": mutated(EXPLAIN, set_at(["causes"], [])),
            "explain with string value": mutated(EXPLAIN, set_at(["causes", 1, "value"], "97.5%")),
            "diff": DIFF,
            "diff without anything": {"kind": "diff", "summary": "Nothing to change.", "changes": [], "verification": [], "findings": []},
            "minimum name length": mutated(DIFF, set_at(["changes", 0, "name"], "abc")),
            "entity with only a name": mutated(DIFF, set_at(["changes", 1, "after"], {"displayName": "Checkout"})),
            "entity read from the api with its read-only fields": mutated(
                DIFF,
                set_at(
                    ["changes", 1, "after"],
                    {
                        "provisioningState": "Succeeded",
                        "healthState": "Healthy",
                        "discoveredBy": "rule-1",
                        "displayName": "Discovered",
                        "canvasPosition": {"x": 200.0, "y": 490.0},
                        "signalGroups": {
                            "external": {"signals": []},
                            "azureResource": {
                                "authenticationSetting": "auth-system",
                                "azureResourceId": RESOURCE_ID,
                                "resourceHealth": {"enabled": "Enabled", "signalName": "ResourceHealth-1", "status": {"healthState": "Unknown"}},
                                "signals": [{**INLINE_METRIC, "status": {"healthState": "Healthy", "value": 0.0}}],
                            },
                        },
                        "signalAggregationGroups": [{"name": "latency", "aggregationType": "WorstOf", "members": ["http-latency"], "aggregatedHealthState": "Healthy"}],
                    },
                ),
            ),
            "entity with alerts and a prometheus group": mutated(
                DIFF,
                set_at(
                    ["changes", 1, "after"],
                    {
                        "alerts": {"unhealthy": {"severity": "Sev1", "description": "Down", "actionGroupIds": [RESOURCE_ID]}},
                        "signalGroups": {
                            "azureMonitorWorkspace": {
                                "authenticationSetting": "auth-system",
                                "azureMonitorWorkspaceResourceId": WORKSPACE_ID,
                                "signals": [{"name": "up-check", "signalKind": "PrometheusMetricsQuery", "queryText": "up", "evaluationRules": {"unhealthyRule": {"operator": "LessThan", "threshold": 1}}}],
                            }
                        },
                    },
                ),
            ),
            "relationship": mutated(
                DIFF,
                set_at(["changes", 2], {"id": "c3", "op": "add", "kind": "relationship", "name": "checkout-storefront-api", "after": {"parentEntityName": "checkout", "childEntityName": "storefront-api"}, "reason": "Part of checkout."}),
            ),
            "log query signal definition": mutated(
                DIFF,
                set_at(["changes", 0, "after"], {"signalKind": "LogAnalyticsQuery", "queryText": "AppRequests | count", "evaluationRules": {"unhealthyRule": {"operator": "GreaterThan", "threshold": 1}}}),
            ),
        }
        for label, result in cases.items():
            with self.subTest(label):
                self.assertEqual(validate_task_result(result), [])

    def test_invalid_results_name_the_problem_and_its_place(self):
        cases = [
            ("not an object", [], "result: [] is not of type 'object'"),
            ("missing kind", {"summary": "x"}, "result: 'kind' is a required property"),
            ("unknown kind", {"kind": "report"}, "kind: 'report' is not one of"),
            ("explain missing summary", mutated(EXPLAIN, drop_at(["summary"])), "result: 'summary' is a required property"),
            ("explain extra property", mutated(EXPLAIN, set_at(["extra"], 1)), "'extra' was unexpected"),
            ("explain state", mutated(EXPLAIN, set_at(["state"], "Green")), "state: 'Green' is not one of"),
            ("explain empty entity", mutated(EXPLAIN, set_at(["entity"], "")), "entity: '' should be non-empty"),
            ("cause missing note", mutated(EXPLAIN, drop_at(["causes", 0, "note"])), "causes[0]: 'note' is a required property"),
            ("a missing property says to add it", mutated(DIFF, drop_at(["changes", 1, "reason"])), "changes[1]: 'reason' is a required property (add it)"),
            ("a missing property inside after says to add it", mutated(DIFF, set_at(["changes", 2], {"id": "c3", "op": "add", "kind": "relationship", "name": "a-b", "after": {"childEntityName": "b"}, "reason": "x"})), "'parentEntityName' is a required property (add it)"),
            ("cause extra property", mutated(EXPLAIN, set_at(["causes", 1, "unit"], "%")), "causes[1]: Additional properties"),
            ("cause boolean value", mutated(EXPLAIN, set_at(["causes", 1, "value"], True)), "causes[1].value: True is not of type"),
            ("cause empty signal", mutated(EXPLAIN, set_at(["causes", 1, "signal"], "")), "causes[1].signal: '' should be non-empty"),
            ("diff missing verification", mutated(DIFF, drop_at(["verification"])), "result: 'verification' is a required property"),
            ("diff extra property", mutated(DIFF, set_at(["base"], {})), "'base' was unexpected"),
            ("change op", mutated(DIFF, set_at(["changes", 0, "op"], "delete")), "changes[0].op: 'delete' is not one of"),
            ("change kind", mutated(DIFF, set_at(["changes", 0, "kind"], "alert")), "changes[0].kind: 'alert' is not one of"),
            ("change name with spaces", mutated(DIFF, set_at(["changes", 0, "name"], "Storefront API")), "changes[0].name: 'Storefront API' does not match"),
            ("change name too short", mutated(DIFF, set_at(["changes", 0, "name"], "ab")), "changes[0].name: 'ab' does not match"),
            ("change name underscore", mutated(DIFF, set_at(["changes", 0, "name"], "http_latency")), "changes[0].name"),
            ("change name trailing newline", mutated(DIFF, set_at(["changes", 0, "name"], "http-latency\n")), "changes[0].name: 'http-latency\\n' does not match '^[a-zA-Z0-9][a-zA-Z0-9-]{1,258}[a-zA-Z0-9]$' as a whole"),
            ("change name leading newline", mutated(DIFF, set_at(["changes", 0, "name"], "\nhttp-latency")), "changes[0].name"),
            ("change name inner newline", mutated(DIFF, set_at(["changes", 0, "name"], "http\nlatency")), "changes[0].name"),
            ("add without after", mutated(DIFF, set_at(["changes", 0, "after"], None)), "changes[0].after: None is not of type 'object'"),
            ("remove with after", mutated(DIFF, set_at(["changes", 2, "after"], {"x": 1})), "changes[2].after: {'x': 1} is not of type 'null'"),
            ("change with string after", mutated(DIFF, set_at(["changes", 1, "after"], "text")), "changes[1].after: 'text' is not of type 'object'"),
            ("change missing after", mutated(DIFF, drop_at(["changes", 1, "after"])), "changes[1]: 'after' is a required property"),
            ("change extra property", mutated(DIFF, set_at(["changes", 0, "before"], {})), "changes[0]: Additional properties"),
            ("verification status", mutated(DIFF, set_at(["verification", 0, "status"], "ok")), "verification[0].status: 'ok' is not one of"),
            ("verification missing error", mutated(DIFF, drop_at(["verification", 1, "error"])), "verification[1]: 'error' is a required property"),
            ("finding severity", mutated(DIFF, set_at(["findings", 0, "severity"], "critical")), "findings[0].severity: 'critical' is not one of"),
            ("finding change id type", mutated(DIFF, set_at(["findings", 0, "changeIds"], [1])), "findings[0].changeIds[0]: 1 is not of type 'string'"),
            ("duplicate change ids", mutated(DIFF, set_at(["changes", 1, "id"], "c1")), "changes: id 'c1' is used more than once"),
            ("finding names unknown change", mutated(DIFF, set_at(["findings", 1, "changeIds"], ["c9"])), "findings[1].changeIds: no change has id 'c9'"),
            ("one resource changed twice", mutated(DIFF, set_at(["changes", 2], {"id": "c3", "op": "change", "kind": "entity", "name": "Storefront-API", "after": ENTITY, "reason": "Again."})), "changes[2]: entity 'Storefront-API' is already changed by 'c2'; put both fixes into one change"),
            ("an entity removed and added under one name", mutated(DIFF, lambda result: (set_at(["changes", 1, "op"], "add")(result), set_at(["changes", 2], {"id": "c3", "op": "remove", "kind": "entity", "name": "Storefront-API", "after": None, "reason": "Replaces it."})(result))), "changes[2]: entity 'Storefront-API' is removed and added in one result, which would delete the new one (removals run after additions): add the replacement under another name"),
            ("unknown property in after", mutated(DIFF, set_at(["changes", 1, "after"], {"entityKind": "UserFlow"})), "changes[1].after: Additional properties are not allowed ('entityKind' was unexpected)"),
            ("signal groups as a list", mutated(DIFF, set_at(["changes", 1, "after"], {"signalGroups": [{"signals": []}]})), "changes[1].after.signalGroups: [{'signals': []}] is not of type 'object'"),
            ("unknown signal group", mutated(DIFF, set_at(["changes", 1, "after"], {"signalGroups": {"metrics": {}}})), "changes[1].after.signalGroups: Additional properties are not allowed ('metrics' was unexpected)"),
            ("group without its resource", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureResource", "azureResourceId"], None)), "changes[1].after.signalGroups.azureResource.azureResourceId: None is not of type 'string'"),
            ("group without authentication", mutated(DIFF, drop_at(["changes", 1, "after", "signalGroups", "azureLogAnalytics", "authenticationSetting"])), "changes[1].after.signalGroups.azureLogAnalytics: 'authenticationSetting' is a required property"),
            ("query signal in a resource group", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureResource", "signals", 0], INLINE_QUERY)), "changes[1].after.signalGroups.azureResource.signals[0].signalKind: 'AzureResourceMetric' was expected"),
            ("signal kind spelling", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureLogAnalytics", "signals", 0, "signalKind"], "LogQuery")), "signals[0].signalKind: 'LogAnalyticsQuery' was expected"),
            ("signal fields of another shape", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureLogAnalytics", "signals", 0], {**INLINE_QUERY, "window": "PT5M", "degraded": {"operator": ">", "value": 0}})), "signals[0]: Additional properties are not allowed ('degraded', 'window' were unexpected)"),
            ("inline signal without rules", mutated(DIFF, drop_at(["changes", 1, "after", "signalGroups", "azureLogAnalytics", "signals", 0, "evaluationRules"])), "signals[0]: 'evaluationRules' is a required property"),
            ("inline metric without metric name", mutated(DIFF, drop_at(["changes", 1, "after", "signalGroups", "azureResource", "signals", 0, "metricName"])), "signals[0]: 'metricName' is a required property"),
            ("rule operator", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureResource", "signals", 0, "evaluationRules", "unhealthyRule", "operator"], ">")), "unhealthyRule.operator: '>' is not one of"),
            ("rules without an unhealthy rule", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureResource", "signals", 0, "evaluationRules"], {"degradedRule": {"operator": "GreaterThan", "threshold": 1}})), "evaluationRules: 'unhealthyRule' is a required property"),
            ("refresh interval", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureResource", "signals", 0, "refreshInterval"], "PT3M")), "signals[0].refreshInterval: 'PT3M' is not one of"),
            ("aggregation type", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "azureResource", "signals", 0, "aggregationType"], "Avg")), "signals[0].aggregationType: 'Avg' is not one of"),
            ("impact", mutated(DIFF, set_at(["changes", 1, "after", "impact"], "High")), "changes[1].after.impact: 'High' is not one of ['Limited', 'Standard', 'Suppressed']"),
            ("health objective", mutated(DIFF, set_at(["changes", 1, "after", "healthObjective"], 120)), "changes[1].after.healthObjective: 120 is greater than the maximum of 100"),
            ("dependencies without aggregation", mutated(DIFF, set_at(["changes", 1, "after", "signalGroups", "dependencies"], {"ignoreUnknown": True})), "signalGroups.dependencies: 'aggregationType' is a required property"),
            ("icon without a name", mutated(DIFF, set_at(["changes", 1, "after", "icon"], {})), "changes[1].after.icon: 'iconName' is a required property"),
            ("relationship without a child", mutated(DIFF, set_at(["changes", 2], {"id": "c3", "op": "add", "kind": "relationship", "name": "a-b", "after": {"parentEntityName": "a"}, "reason": "x"})), "changes[2].after: 'childEntityName' is a required property"),
            ("relationship with other properties", mutated(DIFF, set_at(["changes", 2], {"id": "c3", "op": "add", "kind": "relationship", "name": "a-b", "after": {"parentEntityName": "a", "childEntityName": "b", "weight": 1}, "reason": "x"})), "changes[2].after: Additional properties are not allowed ('weight' was unexpected)"),
            ("signal definition without a kind", mutated(DIFF, set_at(["changes", 0, "after"], {"metricName": "x"})), "changes[0].after: 'signalKind' is a required property"),
            ("signal definition kind", mutated(DIFF, set_at(["changes", 0, "after", "signalKind"], "Metric")), "changes[0].after.signalKind: 'Metric' is not one of"),
            ("metric definition without a name", mutated(DIFF, drop_at(["changes", 0, "after", "metricName"])), "changes[0].after: 'metricName' is a required property"),
            ("signal definition without rules", mutated(DIFF, drop_at(["changes", 0, "after", "evaluationRules"])), "changes[0].after: 'evaluationRules' is a required property"),
            ("query definition with metric fields", mutated(DIFF, set_at(["changes", 0, "after"], {"signalKind": "LogAnalyticsQuery", "queryText": "x", "metricName": "m", "evaluationRules": {"unhealthyRule": {"operator": "Equal"}}})), "changes[0].after: Additional properties are not allowed ('metricName' was unexpected)"),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                problems = validate_task_result(result)

                self.assertTrue(any(expected in problem for problem in problems), problems)

    def test_problems_stay_short(self):
        cases = {
            "many problems": (
                mutated(DIFF, set_at(["changes"], [{"id": str(i)} for i in range(30)])),
                lambda problems: self.assertEqual(len(problems), MAX_PROBLEMS + 1),
            ),
            "huge value": (
                mutated(DIFF, set_at(["changes", 0, "after"], "x" * 50_000)),
                lambda problems: self.assertLessEqual(max(map(len, problems)), MAX_PROBLEM_CHARS + 40),
            ),
        }
        for label, (result, check) in cases.items():
            with self.subTest(label):
                check(validate_task_result(result))

    def test_reference_checks_wait_for_a_structurally_valid_result(self):
        result = mutated(DIFF, set_at(["findings", 0, "changeIds"], ["c9"]))
        result["findings"][1]["severity"] = "critical"

        problems = validate_task_result(result)

        self.assertEqual(len(problems), 1)
        self.assertIn("findings[1].severity", problems[0])


if __name__ == "__main__":
    unittest.main()
