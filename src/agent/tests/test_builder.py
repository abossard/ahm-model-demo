import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from builder import measurement_problems, note_samples, selected_resource
from contracts import validate_task_result
from contracts.builder_rules import builder_problems, expand_resource_refs, referenced_resources

ARM = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/web"
RESOURCE = {"id": ARM, "name": "web", "type": "Microsoft.App/containerApps"}
BUILDER = {"phase": "propose", "resources": [RESOURCE], "rows": [{"resourceId": ARM}]}
ARGS = {"resource": "web", "subscription": "s", "resourcegroup": "rg", "resourcetype": RESOURCE["type"],
        "aggregation": "Average", "interval": "PT5M", "metricnames": "CpuPercentage", "metricnamespace": RESOURCE["type"]}
METRIC = {"resourceId": ARM, "sample": 2.5, "threshold": 90, "aggregation": "Average",
          "metricNamespace": RESOURCE["type"], "metricName": "CpuPercentage", "operator": "GreaterThan"}


class BuilderTests(unittest.TestCase):
    def test_task_local_references_bind_only_inventory_fields(self):
        resources = [RESOURCE, {**RESOURCE, "id": ARM + "-worker"}]
        self.assertEqual([row["ref"] for row in referenced_resources(resources)], ["R1", "R2"])
        for given, expected in [("R2", ARM + "-worker"), (ARM, ARM), ("R99", "R99")]:
            with self.subTest(ref=given):
                reply = {"rows": [{"resourceId": given, "purpose": "R2"}],
                         "plan": {"flows": [{"components": [{"resourceIds": [given]}]}]}}
                expanded = expand_resource_refs(reply, resources)
                self.assertEqual(expanded["rows"][0], {"resourceId": expected, "purpose": "R2"})
                self.assertEqual(expanded["plan"]["flows"][0]["components"][0]["resourceIds"], [expected])
                self.assertEqual(reply["rows"][0]["resourceId"], given)

    def test_names_each_missing_resource_once_with_its_missing_fields(self):
        resources = [{**RESOURCE, "id": ARM + name, "name": name} for name in ("store", "jobs", "ingress")]
        store, jobs, ingress = [r["id"] for r in resources]
        builder = {"phase": "analyze", "resources": resources,
                   "observedMetrics": [{"resourceId": store}, {"resourceId": ingress}]}
        for case, rows, bound, actual, expected in (
            ("overlap", [jobs], [jobs], [], ["Missing from rows and component resourceIds and metrics or omittedMetrics (2): ingress, store"]),
            ("different", [jobs, ingress], [jobs, store], [store],
             ["Missing from rows (1): store", "Missing from component resourceIds and metrics or omittedMetrics (1): ingress"]),
            ("complete", [jobs, ingress, store], [store, jobs, ingress], [ingress, store], []),
        ):
            with self.subTest(case=case):
                result = {"kind": "builderAnalysis", "rows": [{"resourceId": arm} for arm in rows],
                          "plan": {"flows": [{"components": [{"resourceIds": bound}]}]},
                          "metrics": [{"resourceId": arm} for arm in actual]}
                self.assertCountEqual(builder_problems(result, builder), expected)

    def test_tells_the_model_where_to_move_misplaced_fields_and_shorten_a_title(self):
        flow = {"name": "Checkout", "objective": "Serve users", "components": [], "failureScenario": "Timeout"}
        for case, plan, expected in (
            ("inside plan", {"flows": [flow], "gaps": [], "metrics": [], "omittedMetrics": []},
             ["Move metrics to result", "Move omittedMetrics to result"]),
            ("inside flow", {"flows": [{**flow, "gaps": [], "metrics": []}]}, ["Move gaps to plan", "Move metrics to result"]),
            ("decision title", {"flows": [flow], "decisions": [{"choice": "a" * 150}]},
             ["shorten this decision title to 120 characters (currently 150)", "Put its explanation in reason"]),
            ("text in flows", {"flows": ['gaps":[{']}, ["plan.flows[0]: supply a flow object"]),
        ):
            with self.subTest(case=case):
                errors = validate_task_result({"kind": "builderAnalysis", "plan": {"objective": "Serve", **plan}})
                for message in expected:
                    self.assertTrue(any(message in error for error in errors), (message, errors))

    def test_plan_preserves_measured_resources_and_tree_coverage(self):
        row = {"resourceId": ARM}
        flow = {"components": [{"resourceIds": [ARM]}]}
        analysis = {"kind": "builderAnalysis", "plan": {"flows": [flow]}, "rows": [row], "metrics": [METRIC]}
        builder = {"phase": "analyze", "resources": [RESOURCE], "observedMetrics": [METRIC]}
        for result, valid in [
            (analysis, True),
            ({**analysis, "metrics": []}, False),
            ({**analysis, "metrics": [], "omittedMetrics": [{**row, "reason": "Does not measure user impact."}]}, True),
            ({**analysis, "plan": {"flows": [flow, flow]}}, False),
        ]:
            with self.subTest(valid=valid, result=result):
                self.assertEqual(not builder_problems(result, builder), valid)
        self.assertFalse(measurement_problems(analysis, {}, [METRIC]))
        self.assertTrue(measurement_problems(analysis, {}, [{**METRIC, "sample": 42}]))

    def test_metrics_require_the_confirmed_scope_and_an_observed_sample(self):
        valid = {"interval": "PT5M", "avgBuckets": [0, 2.5]}
        for label, args, series, verified in (
            ("sample", ARGS, valid, True),
            ("different reading", ARGS, {**valid, "avgBuckets": [3]}, False),
            ("no samples", ARGS, {**valid, "avgBuckets": []}, False),
            ("different group", {**ARGS, "resourcegroup": "elsewhere"}, valid, False),
            ("different aggregation", ARGS, {"interval": "PT5M", "maxBuckets": [2.5]}, False),
            ("different interval", ARGS, {**valid, "interval": "PT1H"}, False),
            ("per instance", ARGS, {**valid, "metadata": {"instance": "one"}}, False),
        ):
            with self.subTest(label):
                data = json.dumps({"status": 200, "results": {"results": [{"name": "CpuPercentage", "timeSeries": [series]}]}})
                samples = {}
                note_samples(samples, BUILDER, args, data)
                self.assertEqual(not measurement_problems({"metrics": [METRIC]}, samples), verified)
        self.assertIsNone(selected_resource(BUILDER, {**ARGS, "resource": "someone-elses-web"}))

    def test_plan_decisions_cite_scoped_evidence(self):
        result = {"kind": "builderAnalysis", "rows": [{"resourceId": ARM}], "metrics": [],
                  "plan": {"flows": [{"components": [{"resourceIds": [ARM]}]}]}}
        for basis, arm, context, valid in (
            ("inventory", ARM, {}, True),
            ("assumption", ARM + "-outside", {}, False),
            ("measurement", ARM, {}, False),
            ("measurement", ARM, {"resources": [{**RESOURCE, "availabilityState": "Available"}]}, True),
            ("userInput", ARM, {}, False),
            ("userInput", ARM, {"revision": {"prompt": "Focus on checkout."}}, True),
        ):
            with self.subTest(basis=basis, arm=arm, context=context):
                plan = {**result["plan"], "decisions": [{"basis": basis, "resourceIds": [arm]}]}
                builder = {"phase": "analyze", "resources": [RESOURCE], "planVersion": 2, **context}
                self.assertEqual(not builder_problems({**result, "plan": plan}, builder), valid)
        self.assertTrue(builder_problems(result, {"phase": "analyze", "resources": [RESOURCE], "planVersion": 2}))

    def test_proposal_topology_covers_the_confirmed_workload(self):
        direct = {"id": "direct", "title": "Resources", "structure": "direct", "groups": [{"resourceIds": [ARM]}]}
        grouped = {**direct, "id": "grouped", "title": "Orders", "structure": "grouped"}
        for label, second, valid in (
            ("two useful options for one resource", grouped, True),
            ("different title but same graph", {**grouped, "structure": "direct"}, False),
            ("an extra unconfirmed resource", {**grouped, "groups": [{"resourceIds": [ARM, ARM + "-other"]}]}, False),
            ("a resource assigned twice", {**grouped, "groups": [{"resourceIds": [ARM]}, {"resourceIds": [ARM.upper()]}]}, False),
        ):
            with self.subTest(label):
                self.assertEqual(not builder_problems({"kind": "builderProposals", "proposals": [direct, second]}, BUILDER), valid)
