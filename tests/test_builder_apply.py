import asyncio
import json
import unittest
from unittest import mock
from types import SimpleNamespace

from azure.core.exceptions import HttpResponseError, ServiceRequestError

from test_healthmodels import GROUP, OID, OTHER_OID, SUB, Harness
from test_sessions_store import StoreCase
from auth import Caller
from builder import Builder, BuilderInput
import builder_apply
import builder_design
from fake_agent import builder_result
from fixture_models import FixtureHealthModels
from task_runner import TaskRunner


class BuilderDiscoveryTests(unittest.TestCase):
    def test_monitoring_grant_uses_caller_credential_and_exact_resource(self):
        scope = f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/Microsoft.Web/sites/test"
        for existing, expected_methods in [(False, ["GET", "PUT"]), (True, ["GET"])]:
            with self.subTest(existing=existing):
                role = f"/subscriptions/{SUB}/providers/Microsoft.Authorization/roleDefinitions/43d0d8ad-25c7-4714-9337-8ba259a9fe05"
                assignment = {"id": scope + "/providers/Microsoft.Authorization/roleAssignments/assigned",
                              "properties": {"scope": scope, "principalId": OTHER_OID, "roleDefinitionId": role}}
                def respond(request):
                    self.assertEqual(request.headers["Authorization"], "Bearer token")
                    self.assertIn(scope + "/providers/Microsoft.Authorization/roleAssignments", request.url)
                    if request.method == "PUT":
                        self.assertEqual(json.loads(request.body)["properties"], {
                            "principalId": OTHER_OID, "principalType": "ServicePrincipal", "roleDefinitionId": role,
                        })
                    return 200, {"Content-Type": "application/json"}, (
                        {"value": [assignment] if existing else []} if request.method == "GET" else assignment)
                harness = Harness(respond)
                try:
                    self.assertEqual(harness.models.grant_monitoring_reader(SUB, OTHER_OID, scope), assignment["id"])
                    self.assertEqual([r.method for r in harness.adapter.calls], expected_methods)
                    self.assertEqual(harness.credentials_asked, [OID])
                finally:
                    harness.stop()

    def test_provider_region_and_parent_create_use_the_requested_subscription(self):
        tags = {builder_apply.OWNER_TAG: "intent"}
        parent = {"name": "fresh", "location": "swedencentral", "tags": tags, "properties": {"provisioningState": "Succeeded"}}
        regions = {"resourceTypes": [{"resourceType": "healthModels", "locations": ["Sweden Central", "East US"]}]}
        harness = Harness(lambda request: (200, {"Content-Type": "application/json"},
                                           regions if "api-version=2021-04-01" in request.url else parent))
        self.addCleanup(harness.stop)
        for preferred, wanted in [("Sweden Central", "swedencentral"), ("global", "eastus")]:
            with self.subTest(preferred=preferred):
                self.assertEqual(harness.models.builder_location(SUB, preferred), wanted)
        model = harness.models.create_builder_parent(SUB, GROUP, "fresh", "swedencentral", tags)
        self.assertEqual(model["tags"], tags)
        put = next(r for r in harness.adapter.calls if r.method == "PUT")
        self.assertIn(f"/subscriptions/{SUB}/resourceGroups/{GROUP}/", put.url)
        self.assertEqual(put.headers["If-None-Match"], "*")
        self.assertEqual(json.loads(put.body)["identity"], {"type": "SystemAssigned"})

    def test_group_resource_and_name_validation(self):
        harness = Harness(lambda _: self.fail("Unexpected ARM call"))
        self.addCleanup(harness.stop)
        for bad in [None, f"/subscriptions/{SUB}/resourceGroups/x' | count", f"/subscriptions/bad/resourceGroups/rg", ""]:
            with self.subTest(group=bad), self.assertRaises(ValueError):
                harness.models.builder_resources(bad)
        for bad in ["", "#bad", "bad-", "-bad", "a" * 28, "1start", None]:
            with self.subTest(prefix=bad), self.assertRaises(ValueError):
                builder_apply.model_name(bad)
        for prefix in ["a", "My-shop", "z" * 27]:
            with self.subTest(prefix=prefix):
                name = builder_apply.model_name(prefix)
                self.assertLessEqual(len(name), 44)
                self.assertRegex(name, rf"^{prefix}-[a-f0-9]{{16}}$")
                self.assertNotEqual(name, builder_apply.model_name(prefix))


class BuilderCreationTests(StoreCase):
    async def example(self, store):
        session = await store.create_session(OID, "Orders design")
        target = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": builder_apply.model_name("orders"), "location": "northeurope"}
        task = await store.create_task(OID, session["id"], {"type": "design", "status": "done", "target": target})
        health = FixtureHealthModels((SUB, GROUP, "live"), (SUB, GROUP, "demo-design"))
        changes = [
            {"id": "link", "op": "add", "kind": "relationship", "name": "orders-link",
             "after": {"parentEntityName": target["name"], "childEntityName": "orders-api"}},
            {"id": "root", "op": "change", "kind": "entity", "name": target["name"],
             "after": {"canvasPosition": {"x": 305, "y": 40}}},
            {"id": "api", "op": "add", "kind": "entity", "name": "orders-api",
             "after": {"displayName": "Orders API", "canvasPosition": {"x": 305, "y": 210}}},
        ]
        args = (store, health, OID, session["id"], task, "service-view", changes)
        return args, health, target

    async def test_create_round_trip_and_repeated_confirmation(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                args, health, target = await self.example(store)
                one, two = await asyncio.gather(builder_apply.create_model(*args), builder_apply.create_model(*args))
                self.assertEqual(one, two)
                self.assertEqual(one["status"], "created")
                self.assertEqual(one["written"], ["root", "api", "link"])
                self.assertEqual(one["steps"], ["model", "authentication"])
                self.assertEqual(one["target"], target)
                raw = health.read_model(SUB, GROUP, target["name"])
                self.assertEqual(raw["relationships"][0]["properties"]["parentEntityName"], target["name"])
                self.assertEqual({e["name"]: e["properties"]["canvasPosition"]["y"] for e in raw["entities"]},
                                 {target["name"]: 40, "orders-api": 210})
                self.assertIn(target["name"], [m["name"] for m in health.query_models()])
                self.assertIsNone(await builder_apply.creation_status(store, "other", args[3], 1))
                with self.assertRaises(builder_apply.BuilderConflict):
                    await builder_apply.create_model(*args[:5], "another-choice", args[-1])

    async def test_retry_reconciles_writes_when_response_was_lost(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                args, health, _ = await self.example(store)
                put = health.write_resource
                writes = []

                def write(*params):
                    put(*params)
                    writes.append(params[4])
                    if params[4] == "orders-api":
                        raise ServiceRequestError("response lost")

                with mock.patch.object(health, "write_resource", side_effect=write):
                    partial = await builder_apply.create_model(*args)
                    complete = await builder_apply.create_model(*args)
                self.assertEqual(partial["status"], "partial")
                self.assertEqual(complete["status"], "created")
                self.assertEqual(writes.count("orders-api"), 1)
                self.assertEqual(await builder_apply.creation_status(store, OID, args[3], 1), complete)

    async def test_conflicting_model_or_modified_child_is_preserved(self):
        stores, _ = self.make_stores()
        for state in ("occupied name", "changed child"):
            with self.subTest(state=state):
                args, health, target = await self.example(stores["memory"])
                if state == "occupied name":
                    health.create_builder_parent(SUB, GROUP, target["name"], target["location"], {"another": "model"})
                else:
                    put = health.write_resource

                    def stop(*params):
                        if params[3] == "relationship":
                            raise ServiceRequestError("offline")
                        return put(*params)

                    with mock.patch.object(health, "write_resource", side_effect=stop):
                        self.assertEqual((await builder_apply.create_model(*args))["status"], "partial")
                    put(SUB, GROUP, target["name"], "entity", "orders-api", {"displayName": "User edit"})
                before = health.read_model(SUB, GROUP, target["name"])
                with self.assertRaises(builder_apply.BuilderConflict):
                    await builder_apply.create_model(*args)
                self.assertEqual(before, health.read_model(SUB, GROUP, target["name"]))


class BuilderAccessTests(StoreCase):
    async def prepared(self, store):
        caller = Caller(OID, "Owner", "signed-in-user")
        sid = (await store.create_session(caller.owner, "Workload"))["id"]
        health = FixtureHealthModels((SUB, GROUP, "live"), (SUB, GROUP, "design"))
        runner = TaskRunner(store, None, health)
        builder = Builder(caller, store, runner, health)
        target = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": "resource-model", "location": "northeurope"}
        resources = health.builder_resources(health.builder_groups()[0]["id"])
        for item in resources[:2]:
            item["availabilityState"] = "Available"
        analysis = {"phase": "analyze", "resources": resources}
        result = builder_result(analysis)
        task = {"type": "design", "status": "done", "target": target}
        await store.create_task(caller.owner, sid, {**task, "builder": analysis, "result": result})
        proposal = {**analysis, "phase": "propose", "rows": result["rows"], "analysisSeq": 1}
        alternatives = builder_result(proposal)
        await store.create_task(caller.owner, sid, {**task, "builder": proposal, "result": alternatives})
        proposal_id = alternatives["proposals"][0]["id"]
        return builder, sid, proposal_id, [r["id"] for r in resources[:2]]

    async def test_monitoring_grants_require_session_owner_current_receipt_and_same_live_identity(self):
        store = self.make_stores()[0]["memory"]
        builder, sid, design, _ = await self.prepared(store)
        users = [Caller("another", "Other", "other-token"),
                 Caller(OID, "Other directory", "other-directory-token", tenant_id=SUB, in_home_tenant=False)]
        with mock.patch.object(builder.user, "grant_monitoring_reader") as grant:
            with self.assertRaises(BuilderInput):
                await builder.grant_monitoring(sid, 2, True)
            await builder.create(sid, 2, design, True)
            for user in users:
                with self.subTest(owner=user.owner), self.assertRaises(BuilderInput):
                    await Builder(user, store, builder.runner, builder.user).grant_monitoring(sid, 2, True)
            for seq, confirm in [(1, True), (3, True), (2, False)]:
                with self.subTest(seq=seq, confirm=confirm), self.assertRaises(BuilderInput):
                    await builder.grant_monitoring(sid, seq, confirm)
            parent = builder.user.builder_parent(SUB, GROUP, "resource-model")
            for changed in [None, {**parent, "identity": {"principalId": "different"}},
                            {**parent, "tags": {builder_apply.OWNER_TAG: "replaced"}}]:
                with self.subTest(parent=changed), mock.patch.object(builder.user, "builder_parent", return_value=changed):
                    with self.assertRaises(BuilderInput):
                        await builder.grant_monitoring(sid, 2, True)
            grant.assert_not_called()

    async def test_only_failed_resource_is_retried_and_recorded_grants_restore(self):
        for label, store in self.make_stores()[0].items():
            with self.subTest(store=label):
                builder, sid, design, scopes = await self.prepared(store)
                result = await builder.create(sid, 2, design, True)
                principal = result["creation"]["principalId"]
                denied = HttpResponseError(response=SimpleNamespace(status_code=403, reason="Forbidden"))
                with mock.patch.object(builder.user, "grant_monitoring_reader",
                                       side_effect=["first-role", denied, "second-role"]) as grant:
                    partial = (await builder.grant_monitoring(sid, 2, True))["creation"]
                    self.assertEqual(partial["status"], "created")
                    reports = partial["monitoringAccess"]
                    self.assertEqual(reports[scopes[0]]["assignmentId"], "first-role")
                    self.assertEqual(reports[scopes[1]]["status"], "failed")
                    self.assertIn("permission", reports[scopes[1]]["message"])
                    restored = Builder(builder.caller, store, builder.runner, builder.user)
                    self.assertEqual((await restored.state(sid))["creation"], partial)
                    finished = (await restored.grant_monitoring(sid, 2, True))["creation"]
                    # A concurrent attempt that was denied before replication can append its outcome later.
                    await store.append_apply(builder.owner, sid, 2, reports[scopes[1]])
                    again = (await restored.grant_monitoring(sid, 2, True))["creation"]
                    self.assertEqual(finished, again)
                    self.assertEqual({scope: row["assignmentId"] for scope, row in finished["monitoringAccess"].items()},
                                     dict(zip(scopes, ["first-role", "second-role"])))
                    self.assertEqual(grant.call_args_list,
                                     [mock.call(SUB, principal, scope) for scope in [*scopes, scopes[1]]])

    async def test_restoring_workload_shows_recorded_activity_for_this_analysis_only(self):
        store = self.make_stores()[0]["memory"]
        builder, sid, _, _ = await self.prepared(store)
        for task, kind, seq, summary, payload in [
            (1, "status", 1, "Task started", {}),
            (1, "text", 2, "Private assistant text", {}),
            (1, "tool_call", 3, "Query metrics", {"callId": "a", "name": "monitor_metrics_query",
                "arguments": '{"resource":"orders-api","Authorization":"unneeded"}'}),
            (1, "tool_result", 4, "Query metrics succeeded", {"callId": "a", "name": "monitor_metrics_query",
                "size": 230, "ok": True, "detail": "CPU · average 3.5", "raw": "unneeded"}),
            (1, "status", 5, "Foundry stopped", {"responseId": "r1", "usage": {"totalTokens": 532, "outputTokens": 15}}),
            (1, "status", 6, "Repeated snapshot", {"responseId": "r1", "usage": {"totalTokens": 532, "outputTokens": 15}}),
            (1, "status", 7, "Foundry finished", {"responseId": "r2", "usage": {"totalTokens": 113}}),
            (2, "status", 1, "Another task", {}),
        ]:
            await store.append_event(builder.owner, sid, task, {
                "seq": seq, "ts": "2026-11-19T10:00:00Z", "kind": kind, "summary": summary, "payload": payload})
        state = await builder.state(sid)
        steps = state["analysis"]["activity"]
        self.assertEqual([s["seq"] for s in steps], [1, 3, 4, 5, 6, 7])
        self.assertEqual(steps[1]["resource"], "orders-api")
        self.assertEqual(steps[1]["payload"]["callId"], steps[2]["payload"]["callId"])
        self.assertEqual(steps[2]["payload"]["detail"], "CPU · average 3.5")
        self.assertNotIn("unneeded", str(steps))
        self.assertEqual(state["analysis"]["usage"], {"totalTokens": 645})
        self.assertNotIn("usage", state["proposal"])
        self.assertEqual([e["summary"] for e in state["proposal"]["activity"]], ["Another task"])

    async def test_grant_scopes_are_pinned_and_older_receipts_require_the_same_approved_diff(self):
        store = self.make_stores()[0]["memory"]
        builder, sid, design, scopes = await self.prepared(store)
        creation = (await builder.create(sid, 2, design, True))["creation"]
        with mock.patch.object(builder_design, "preview", side_effect=AssertionError("Recompiled an approved grant")):
            self.assertEqual((await builder.state(sid))["creation"]["monitoringScopes"], scopes)

        legacy = {key: value for key, value in creation.items() if key != "monitoringScopes"}
        await store.append_apply(builder.owner, sid, 2, legacy)
        self.assertEqual((await builder.state(sid))["creation"]["monitoringScopes"], scopes)
        proposal = await store.get_task(builder.owner, sid, 2)
        proposal["builder"]["rows"][0]["impact"] = "Limited"
        await store.save_task(builder.owner, sid, proposal)
        self.assertEqual((await builder.state(sid))["creation"]["monitoringScopes"], [])
        self.assertEqual((await builder.open_model(sid, 2))["target"], creation["target"])
        with self.assertRaises(BuilderInput):
            await builder.grant_monitoring(sid, 2, True)
