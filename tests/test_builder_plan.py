import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from test_task_runner import Env, OWNER, SUB, TARGET
import builder
import builder_design
import builder_mcp
import model_diff
from contracts.show_me import result_problem


HANDLES = [{"name": "builder", "description": "Inspect this workload.", "idDescription": "resource/Rn, signal/Rn or design/<proposalId>"}]
ACTION = {"handle": "builder", "id": "resource/R1"}


class PlannedModelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        prefix = f"/subscriptions/{SUB}/resourceGroups/other/providers/Microsoft.Web/sites/"
        self.ids = [prefix + name for name in ("web", "cache", "api", "excluded", "archive")]
        self.resources = [{"id": arm, "name": arm.split("/")[-1], "type": "Microsoft.Web/sites"} for arm in self.ids]
        self.rows = [{"resourceId": arm, "displayName": "Inferred application", "purpose": "User-confirmed purpose.",
                      "impact": "Limited"} for arm in self.ids]
        web, cache, api, excluded, archive = self.ids
        self.plan = {"objective": "Customers can complete orders.", "gaps": ["No checkout success event is available."],
                     "decisions": [
                         {"choice": "Watch failed requests", "reason": "A server error prevents a successful search.",
                          "basis": "measurement", "resourceIds": [web.upper()]},
                         {"choice": "Keep the archive separate", "reason": "The archive serves historical reads.",
                          "basis": "assumption", "resourceIds": [archive, api]}], "flows": [
            {"name": "Browse", "objective": "Find an item.", "failureScenario": "Customers see an empty list.", "components": [
                {"name": "Request handler", "resourceIds": [web.upper(), cache], "signal": "Successful searches"},
                {"name": "Excluded worker", "resourceIds": [excluded], "signal": "Queue length"}]},
            {"name": "Checkout", "objective": "Place an order.", "failureScenario": "Payments remain pending.", "components": [
                {"name": "Request handler", "resourceIds": [api], "signal": "Completed orders"}]},
            {"name": "Archive", "objective": "Read old orders.", "failureScenario": "Orders are unavailable.", "components": [
                {"name": "Archive bucket", "resourceIds": [archive], "signal": "Download errors"}]}]}
        self.metric = {"resourceId": web, "metricName": "Http5xx", "metricNamespace": "Microsoft.Web/sites",
                       "aggregation": "Total", "operator": "GreaterThan", "threshold": 5, "sample": 0}

    async def test_confirmation_prunes_empty_flows_components_and_observed_metrics(self):
        decision = self.plan["decisions"][0]
        marked = {**self.plan, "decisions": [{**decision, "reason": decision["reason"] + " [[show:1]]"}, *self.plan["decisions"][1:]]}
        analysis = {"seq": 7, "status": "done", "target": TARGET,
                    "builder": {"resources": self.resources, "observedMetrics": [self.metric], "signalChecks": []},
                    "result": {"rows": self.rows, "plan": marked, "showMe": {"1": ACTION},
                               "metrics": [self.metric, {**self.metric, "resourceId": self.ids[-1]}]}}
        service = AsyncMock()
        service.state.return_value = {"analysis": analysis}
        await builder.Builder.propose(service, "session", 7, self.rows[:3], HANDLES)
        reviewed = service.start.await_args.args[2]
        self.assertEqual(service.start.await_args.args[3], HANDLES)
        self.assertEqual(reviewed["observedMetrics"], [self.metric])
        self.assertIn("[[show:1]]", analysis["result"]["plan"]["decisions"][0]["reason"])
        self.assertEqual(reviewed["metrics"], [self.metric])
        self.assertEqual([f["name"] for f in reviewed["plan"]["flows"]], ["Browse", "Checkout"])
        self.assertEqual(reviewed["plan"]["flows"][0]["components"],
                         [{"name": "Request handler", "resourceIds": self.ids[:2], "signal": "Successful searches"}])
        self.assertEqual(reviewed["plan"]["gaps"], self.plan["gaps"])
        self.assertEqual(reviewed["plan"]["decisions"], self.plan["decisions"][:1])
        self.assertEqual(len(analysis["result"]["plan"]["flows"]), 3)
        self.assertEqual(reviewed["rows"][0]["displayName"], "web")
        self.assertEqual(reviewed["rows"][0]["purpose"], "User-confirmed purpose.")

    async def test_revision_reuses_server_evidence_and_keeps_the_previous_plan_after_a_failure(self):
        env = Env()
        sid = await env.session()
        service = builder.Builder(env.caller, env.store, env.runner, env.health)
        checks = [{"resourceId": arm, "status": "verified", "detail": "288 readings"} for arm in self.ids]
        source = {"phase": "analyze", "resources": self.resources, "signalChecks": checks, "observedMetrics": [self.metric],
                  "modelName": "orders", "destinationGroupId": self.ids[0].split("/providers/")[0]}
        original = await env.store.create_task(OWNER, sid, {"builder": source, "target": TARGET, "status": "done",
            "result": {"kind": "builderAnalysis", "rows": self.rows, "plan": self.plan, "metrics": [self.metric]}})

        async def fail_revision(session_id, target, fields, handles):
            await env.store.create_task(OWNER, session_id, {"builder": fields, "target": target, "status": "failed",
                "error": {"code": "timeout", "message": "The planning task timed out."}})

        service.start = AsyncMock(side_effect=fail_revision)
        prompt = "Keep the checkout flow.\nUse 4 errors as the threshold."
        state = await service.revise(sid, original["seq"], self.rows[:3], prompt, HANDLES)
        self.assertEqual(service.start.await_args.args[3], HANDLES)
        self.assertEqual(state["analysis"]["seq"], original["seq"])
        revision = state["failedRevision"]["builder"]
        self.assertEqual(revision["revision"], {"analysisSeq": original["seq"], "prompt": prompt})
        self.assertEqual(revision["previousMetrics"], [self.metric])
        self.assertEqual(revision["observedMetrics"], [self.metric])
        self.assertEqual(revision["signalChecks"], checks[:3])
        self.assertEqual(revision["resources"], self.resources[:3])
        self.assertEqual(revision["resourceIds"], self.ids[:3])
        self.assertEqual(revision["rows"][0], {**self.rows[0], "displayName": "web"})
        self.assertEqual([f["name"] for f in revision["previousPlan"]["flows"]], ["Browse", "Checkout"])
        self.assertEqual(await service.state(sid), state)
        await service.revise(sid, original["seq"], [self.rows[0]], "Change the threshold again.")
        self.assertEqual(service.start.await_count, 2)

    async def test_only_builder_task_start_tools_accept_handles_and_validate_them_before_reading_or_writing(self):
        env = Env()
        service = builder.Builder(env.caller, env.store, env.runner, env.health)
        for name, (action, _, schema) in builder_mcp.TOOLS.items():
            with self.subTest(name):
                starts = action in ("analyze", "revise", "propose")
                self.assertEqual("showMeHandles" in schema["properties"], starts)
                self.assertNotIn("showMeHandles", schema["required"])
                if starts:
                    with self.assertRaisesRegex(builder.BuilderInput, "unique"):
                        await service.perform(action, {"showMeHandles": HANDLES * 2})

    def test_a_registered_marker_cannot_be_copied_into_a_model_field_or_prepared_by_another_view(self):
        marked = {"kind": "builderAnalysis", "summary": "An API. [[show:1]]", "showMe": {"1": ACTION}}
        for label, result, handles, valid in (
            ("issued button", marked, HANDLES, True),
            ("field used for a model label", {**marked, "plan": {"objective": "Label [[show:1]]"}}, HANDLES, False),
            ("link without prose", {**marked, "summary": "[[show:1]]"}, HANDLES, False),
            ("different issued number", {**marked, "summary": "An API. [[show:2]]"}, HANDLES, False),
            ("different view", marked, [], False),
            ("old literal text", {"summary": "Example [[show:1]]"}, [], True),
        ):
            with self.subTest(label):
                self.assertEqual(result_problem(result, handles) == "", valid)

    async def test_revision_rejects_stale_locked_and_out_of_scope_inputs(self):
        analysis = {"seq": 7, "status": "done", "target": TARGET, "builder": {"resources": self.resources},
                    "result": {"rows": self.rows, "plan": self.plan, "metrics": [self.metric]}}
        for label, state, seq, rows, prompt in [
            ("stale", {"analysis": analysis}, 6, self.rows, "Change the name"),
            ("creating", {"analysis": analysis, "creation": {"status": "creating"}}, 7, self.rows, "Change the name"),
            ("running", {"analysis": {**analysis, "status": "running"}}, 7, self.rows, "Change the name"),
            ("empty", {"analysis": analysis}, 7, [], "Change the name"),
            ("foreign", {"analysis": analysis}, 7, [{**self.rows[0], "resourceId": "other"}], "Change the name"),
            ("blank", {"analysis": analysis}, 7, self.rows, "  "),
            ("length", {"analysis": analysis}, 7, self.rows, "x" * 2001),
        ]:
            with self.subTest(label):
                service = AsyncMock()
                service.state.return_value = state
                with self.assertRaises(builder.BuilderInput):
                    await builder.Builder.revise(service, "session", seq, rows, prompt)
                service.start.assert_not_called()

    async def test_revising_from_a_second_tab_observes_the_first_tabs_creation_claim(self):
        env = Env()
        first = builder.Builder(env.caller, env.store, env.runner, env.health)
        second = builder.Builder(env.caller, env.store, env.runner, env.health)
        claimed, release = asyncio.Event(), asyncio.Event()

        async def create(sessionId):
            claimed.set()
            await release.wait()

        first.create = create
        second.revise = AsyncMock()
        creating = asyncio.create_task(first.perform("create", {"sessionId": "s"}))
        await claimed.wait()
        revising = asyncio.create_task(second.perform("revise", {"sessionId": "s"}))
        await asyncio.sleep(0)
        second.revise.assert_not_called()
        release.set()
        await asyncio.gather(creating, revising)
        second.revise.assert_awaited_once_with(sessionId="s")

    def test_preview_diff_documents_and_monitoring_use_the_reviewed_plan_and_observations(self):
        ids = self.ids[:3]
        plan = builder_design.confirmed_plan(self.plan, ids)
        groups = [{"name": "Operation", "purpose": "Serve requests.", "resourceIds": ids}]
        proposals = [{"id": shape, "structure": shape, "groups": groups, "title": shape, "summary": "Serve users. [[show:1]]",
                      "tradeoff": "Operators can inspect the resource. [[show:1]]"} for shape in ("planned", "direct", "grouped")]
        task = {"target": TARGET, "builder": {"phase": "propose", "resources": self.resources[:3], "rows": self.rows[:3],
                                              "metrics": [self.metric], "plan": plan, "analysisSeq": 7,
                                              "revision": {"analysisSeq": 6, "prompt": "Focus on search reliability."}},
                "result": {"kind": "builderProposals", "proposals": proposals, "showMe": {"1": ACTION}}}
        expected_labels = {
            "planned": [TARGET["name"], "Browse", "Request handler", "web", "cache", "Checkout", "Request handler", "api"],
            "direct": [TARGET["name"], "web", "cache", "api"],
            "grouped": [TARGET["name"], "Operation", "web", "cache", "api"]}
        for shape, expected in expected_labels.items():
            with self.subTest(shape):
                design = builder_design.preview(task, shape)
                self.assertNotIn("[[show:", json.dumps(design))
                self.assertIn("[[show:1]]", task["result"]["proposals"][0]["summary"])
                entities = design["entities"]
                self.assertEqual([e["displayName"] for e in entities], expected)
                self.assertEqual(len({e["name"] for e in entities}), len(expected))
                self.assertEqual(len({(e["x"], e["y"]) for e in entities}), len(expected))
                writes = {c["name"]: c["after"] for c in design["diff"]["changes"] if c["kind"] == "entity"}
                leaves = [e for e in entities if e.get("resourceId")]
                self.assertEqual([e["resourceId"] for e in leaves], ids)
                self.assertTrue(all(e["impact"] == "Limited" and e["purpose"] == "User-confirmed purpose." for e in leaves))
                signal = writes[leaves[0]["name"]]["signalGroups"]["azureResource"]["signals"][0]
                self.assertEqual(signal["metricName"], "Http5xx")
                self.assertEqual(signal["evaluationRules"]["unhealthyRule"], {"operator": "GreaterThan", "threshold": 5})
                self.assertTrue(all("signals" not in writes[l["name"]]["signalGroups"]["azureResource"] for l in leaves[1:]))
                self.assertEqual(design["monitoringScopes"], [ids[0]])
                self.assertEqual(next(v for v in design["diff"]["verification"] if v["signal"] == "Http5xx")["value"], 0)
                for document in (design["plan"], design["modelspec"]):
                    self.assertTrue(all(t in document for t in ["Find an item.", "Payments remain pending.", "Successful searches",
                                                                "Http5xx", "No checkout success event is available."]))
                    self.assertNotIn("Archive bucket", document)
                    self.assertNotIn("Keep the archive separate", document)
                    self.assertNotIn("```mermaid", document)
                    self.assertIn("A server error prevents a successful search.", document)
                    self.assertIn("Focus on search reliability.", document)
                self.assertIn("| Entity | Depends on |", design["plan"])
                self.assertEqual(builder_design.preview(task, shape), design)
                if shape == "planned":
                    by_name = {e["name"]: e for e in entities}
                    parents = {r["child"]: r["parent"] for r in design["relationships"]}
                    for leaf, flow in zip(leaves, ("Browse", "Browse", "Checkout")):
                        component = parents[leaf["name"]]
                        self.assertEqual(by_name[component]["displayName"], "Request handler")
                        self.assertEqual(by_name[parents[component]]["displayName"], flow)
                        self.assertEqual(parents[parents[component]], TARGET["name"])
                self.assertEqual(model_diff.validate_result(design["diff"], target=TARGET, allowed_ids=ids), [])
