import asyncio
import sys
import threading
import unittest
from pathlib import Path

from azure.core.exceptions import (
    AzureError,
    HttpResponseError,
    ResourceNotFoundError,
    ServiceRequestError,
    ServiceResponseError,
    ServiceResponseTimeoutError,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import apply  # noqa: E402
import fake_agent  # noqa: E402
import fixture_models  # noqa: E402
import model_diff  # noqa: E402
import sessions_store  # noqa: E402

SUB = "11111111-1111-1111-1111-111111111111"
GROUP = "rg-fixture"
MODEL = "hm-fixture"
TARGET = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
ALL = ["c1", "c2", "c3", "c4"]
ORDER = ["c2", "c1", "c3", "c4"]


UNSEEN = {
    "canvasPosition": ({"x": 600, "y": 400}, {"x": 1, "y": 2}),
    "icon": ({"iconName": "Database"}, {"iconName": "Queue"}),
    "alerts": ({"unhealthy": {"severity": "Sev1", "actionGroupIds": ["/subscriptions/x/resourceGroups/y/providers/microsoft.insights/actionGroups/ops"]}}, {"degraded": {"severity": "Sev3"}}),
    "tags": ({"team": "orders"}, {"team": "other"}),
}


def http_error(status):
    error = HttpResponseError(message="SECRET")
    error.status_code = status
    return error


class Env:
    def __init__(self):
        self.store = sessions_store.MemorySessionsStore()
        self.health = fixture_models.FixtureHealthModels((SUB, GROUP, MODEL), (SUB, GROUP, f"{MODEL}-design"))
        self.writes = []

    async def seeded(self):
        base = self.health.read_model(SUB, GROUP, MODEL)
        relationships = model_diff.relationship_summaries(base)
        result = fake_agent.review_result({"type": "review", "target": TARGET}, relationships)
        session = await self.store.create_session(OWNER, "S")
        task = await self.store.create_task(
            OWNER,
            session["id"],
            {
                "type": "review",
                "target": TARGET,
                "status": "done",
                "result": result,
                "base": {"fingerprint": model_diff.fingerprint(base)},
            },
        )
        await self.store.save_base(OWNER, session["id"], task["seq"], base)
        return session["id"], task

    async def seeded_changes(self, changes, live=None):
        for name, properties in (live or {}).items():
            for collection, found in (("entities", name), ("signalDefinitions", name)):
                stored = self.health._model(SUB, GROUP, MODEL)[collection].get(found)
                if stored:
                    stored["properties"].update(properties)
        base = self.health.read_model(SUB, GROUP, MODEL)
        result = {"kind": "diff", "summary": "s", "changes": changes, "verification": [], "findings": []}
        session = await self.store.create_session(OWNER, "S")
        task = await self.store.create_task(
            OWNER,
            session["id"],
            {"type": "review", "target": TARGET, "status": "done", "result": result, "base": {"fingerprint": model_diff.fingerprint(base)}},
        )
        await self.store.save_base(OWNER, session["id"], task["seq"], base)
        return session["id"], task

    def recorded_writes(self):
        sent = []
        original = self.health.write_resource

        def write(sub, group, model, kind, name, properties):
            sent.append((kind, name, properties))
            return original(sub, group, model, kind, name, properties)

        self.health.write_resource = write
        return sent

    def fail_write(self, number, error):
        original = self.health.write_resource

        def write(*args):
            self.writes.append(args[4])
            if len(self.writes) == number:
                raise error
            return original(*args)

        self.health.write_resource = write

    async def apply(self, sid, task, ids=ALL):
        return await apply.apply_changes(self.store, self.health, OWNER, sid, task, ids)


class UnseenPropertyTests(unittest.IsolatedAsyncioTestCase):
    def edit(self, **after):
        return {"id": "c1", "op": "change", "kind": "entity", "name": "orders-api", "after": {"displayName": "Edited", **after}, "reason": "r"}

    async def test_a_change_does_not_erase_the_four_properties_the_agent_never_sees(self):
        for name, (kept, explicit) in UNSEEN.items():
            cases = [
                ("omitted", {}, kept),
                ("set to another value", {name: explicit}, explicit),
                ("set to null", {name: None}, None),
                ("set to the same value", {name: kept}, kept),
            ]
            for label, extra, expected in cases:
                with self.subTest(property=name, case=label):
                    env = Env()
                    sid, task = await env.seeded_changes([self.edit(**extra)], live={"orders-api": {name: kept}})
                    sent = env.recorded_writes()

                    outcome = await env.apply(sid, task, ["c1"])

                    live = {e["name"]: e["properties"] for e in env.health.read_model(SUB, GROUP, MODEL)["entities"]}["orders-api"]
                    ((kind, written, properties),) = sent
                    self.assertEqual(outcome["outcome"], "applied")
                    self.assertEqual((kind, written), ("entity", "orders-api"))
                    self.assertEqual(properties[name], expected)
                    self.assertEqual(live[name], expected)

    async def test_all_four_are_carried_together_and_nothing_else_is(self):
        env = Env()
        live = {name: values[0] for name, values in UNSEEN.items()}
        sid, task = await env.seeded_changes([self.edit()], live={"orders-api": live})
        sent = env.recorded_writes()

        await env.apply(sid, task, ["c1"])

        ((_, _, properties),) = sent
        self.assertEqual(properties, {"displayName": "Edited", **live})
        stored = {e["name"]: e["properties"] for e in env.health.read_model(SUB, GROUP, MODEL)["entities"]}["orders-api"]
        for gone in ("impact", "signalGroups"):
            self.assertNotIn(gone, stored)

    async def test_a_property_the_live_entity_does_not_have_is_not_invented(self):
        env = Env()
        sid, task = await env.seeded_changes([self.edit()], live={"orders-api": {"icon": {"iconName": "Database"}}})
        position = {e["name"]: e["properties"] for e in env.health.read_model(SUB, GROUP, MODEL)["entities"]}["orders-api"]["canvasPosition"]
        sent = env.recorded_writes()

        await env.apply(sid, task, ["c1"])

        ((_, _, properties),) = sent
        self.assertEqual(properties, {"displayName": "Edited", "icon": {"iconName": "Database"}, "canvasPosition": position})

    async def test_an_add_writes_exactly_what_the_agent_sent(self):
        env = Env()
        add = {"id": "c1", "op": "add", "kind": "entity", "name": "brand-new", "after": {"displayName": "New"}, "reason": "r"}
        sid, task = await env.seeded_changes([add], live={"orders-api": {name: values[0] for name, values in UNSEEN.items()}})
        sent = env.recorded_writes()

        await env.apply(sid, task, ["c1"])

        self.assertEqual(sent, [("entity", "brand-new", {"displayName": "New"})])

    async def test_other_kinds_are_written_as_sent(self):
        env = Env()
        definition = env.health.read_model(SUB, GROUP, MODEL)["signalDefinitions"][0]
        change = {"id": "c1", "op": "change", "kind": "signalDefinition", "name": definition["name"], "after": {"displayName": "Edited"}, "reason": "r"}
        sid, task = await env.seeded_changes([change], live={definition["name"]: {"tags": {"team": "orders"}}})
        sent = env.recorded_writes()

        await env.apply(sid, task, ["c1"])

        self.assertEqual(sent, [("signalDefinition", definition["name"], {"displayName": "Edited"})])


class FailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_any_azure_failure_after_a_write_is_recorded_as_a_partial_outcome(self):
        cases = [
            ("could not connect", ServiceRequestError("SECRET"), "azure_error", "(ServiceRequestError)"),
            ("connection broke", ServiceResponseError("SECRET"), "azure_error", "(ServiceResponseError)"),
            ("timed out", ServiceResponseTimeoutError("SECRET"), "azure_error", "(ServiceResponseTimeoutError)"),
            ("a poller gave up", AzureError("SECRET"), "azure_error", "(AzureError)"),
            ("an http error", http_error(500), "unavailable", "(HTTP 500)"),
            ("a refused request", http_error(400), "change_rejected", "(HTTP 400)"),
            ("not found", ResourceNotFoundError("SECRET"), "azure_error", "(ResourceNotFoundError)"),
        ]
        for label, error, code, detail in cases:
            for number in (1, 2, 3):
                with self.subTest(label=label, failing_write=number):
                    env = Env()
                    sid, task = await env.seeded()
                    env.fail_write(number, error)

                    with self.assertLogs("ahm-demo", level="WARNING"):
                        outcome = await env.apply(sid, task)

                    self.assertEqual(outcome["outcome"], "partial")
                    self.assertEqual(outcome["written"], ORDER[: number - 1])
                    self.assertEqual(outcome["failed"]["changeId"], ORDER[number - 1])
                    self.assertEqual(outcome["failed"]["code"], code)
                    self.assertIn(detail, outcome["failed"]["message"])
                    self.assertNotIn("SECRET", str(outcome))
                    self.assertEqual(await env.store.read_applies(OWNER, sid, task["seq"]), [outcome])

    async def test_an_unexpected_failure_is_recorded_too_and_hides_its_text(self):
        cases = [("runtime error", RuntimeError("SECRET")), ("key error", KeyError("SECRET")), ("type error", TypeError("SECRET"))]
        for label, error in cases:
            with self.subTest(label=label):
                env = Env()
                sid, task = await env.seeded()
                env.fail_write(2, error)

                with self.assertLogs("ahm-demo", level="ERROR"):
                    outcome = await env.apply(sid, task)

                self.assertEqual((outcome["outcome"], outcome["written"]), ("partial", ["c2"]))
                self.assertEqual((outcome["failed"]["changeId"], outcome["failed"]["code"]), ("c1", "internal_error"))
                self.assertEqual(outcome["failed"]["message"], "The change of entity orders-api failed unexpectedly.")
                self.assertEqual(await env.store.read_applies(OWNER, sid, task["seq"]), [outcome])

    async def test_failure_messages_are_at_most_300_characters(self):
        env = Env()
        sid, task = await env.seeded()
        long_name = "a" * 260
        change = {"id": "c1", "op": "change", "kind": "entity", "name": long_name, "after": {}, "reason": "r"}
        error = http_error(400)
        error.error = type("E", (), {"code": "E" * 400})()

        failure = apply.failure_for(change, error)

        self.assertLessEqual(len(failure["message"]), 300)
        self.assertTrue(failure["message"].endswith("..."))
        self.assertLessEqual(len(apply.unexpected_failure(change)["message"]), 300)

    async def test_an_apply_that_is_cancelled_midway_still_records_what_was_written(self):
        env = Env()
        sid, task = await env.seeded()
        holding, release, calls = threading.Event(), threading.Event(), []
        original = env.health.write_resource

        def write(*args):
            calls.append(args[4])
            if len(calls) == 2:
                holding.set()
                release.wait(5)
            return original(*args)

        env.health.write_resource = write
        running = asyncio.create_task(env.apply(sid, task))
        await asyncio.to_thread(holding.wait, 5)

        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        release.set()

        (recorded,) = await env.store.read_applies(OWNER, sid, task["seq"])
        self.assertEqual((recorded["outcome"], recorded["written"]), ("partial", ["c2"]))
        self.assertEqual((recorded["failed"]["changeId"], recorded["failed"]["code"]), ("c1", "interrupted"))
        self.assertIn("whether it was written is unknown", recorded["failed"]["message"])
        self.assertEqual(recorded["expanded"], ORDER)

    async def test_nothing_is_recorded_when_nothing_was_attempted(self):
        cases = [
            ("the live model cannot be read", lambda env: setattr(env.health, "read_model", _raising(ServiceRequestError("SECRET"))), ServiceRequestError),
            ("the live model changed since the snapshot", lambda env: env.health.write_resource(SUB, GROUP, MODEL, "entity", "extra-one", {"displayName": "x"}), apply.BaseChanged),
        ]
        for label, prepare, expected in cases:
            with self.subTest(label=label):
                env = Env()
                sid, task = await env.seeded()
                prepare(env)

                with self.assertRaises(expected):
                    await env.apply(sid, task)

                self.assertEqual(await env.store.read_applies(OWNER, sid, task["seq"]), [])

    async def test_a_clean_apply_is_recorded_as_applied(self):
        env = Env()
        sid, task = await env.seeded()

        outcome = await env.apply(sid, task)

        self.assertEqual((outcome["outcome"], outcome["written"], outcome["failed"]), ("applied", ORDER, None))
        self.assertEqual(await env.store.read_applies(OWNER, sid, task["seq"]), [outcome])

    async def test_an_outcome_that_cannot_be_stored_is_still_returned(self):
        env = Env()
        sid, task = await env.seeded()

        async def broken(*args):
            raise sessions_store.StoreUnavailable("append_apply")

        env.store.append_apply = broken
        with self.assertLogs("ahm-demo", level="ERROR"):
            outcome = await env.apply(sid, task)

        self.assertEqual(outcome["outcome"], "applied")


def _raising(error):
    def raiser(*args):
        raise error

    return raiser


if __name__ == "__main__":
    unittest.main()
