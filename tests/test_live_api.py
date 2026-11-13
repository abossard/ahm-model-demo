import copy
import json
import threading
import time
import unittest
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi.testclient import TestClient
import uvicorn

import test_auth_api as entra
import test_sessions_api as base

FAST = dict(poll_seconds=0.02, grace_seconds=5.0, access_recheck_seconds=3600, annotation_seconds=3600)


class Server:
    """The app on a real socket: a test client buffers a whole response, which an event stream never ends."""

    def __init__(self, app):
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error", lifespan="on"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started and time.time() < deadline:
            time.sleep(0.02)
        port = self.server.servers[0].sockets[0].getsockname()[1]
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10)
        return self.client

    def __exit__(self, *exc):
        self.client.close()
        self.server.should_exit = True
        self.thread.join(10)


def frames(lines):
    """Groups the lines of an event stream into {event, id, data} frames; comments and `retry` are skipped."""
    frame = {}
    for line in lines:
        if line == "":
            if "data" in frame:
                yield {"event": frame.get("event", "message"), "id": frame.get("id"), "data": json.loads(frame["data"])}
            frame = {}
        elif not line.startswith(":") and ":" in line:
            name, value = line.split(":", 1)
            frame[name] = value.lstrip(" ")


class Fake:
    """What Azure shows for the model: an inventory the test changes, and how often it was read."""

    def __init__(self, module):
        self.module = module
        self.reads = 0
        self.lock = threading.Lock()
        self.inventory = module.inventory.inventory_from(
            *module.inventory.read_raw(module.health.as_user(None).client(base.SUB), base.GROUP, base.MODEL), base.MODEL
        )

    def read_state(self, user, selection):
        with self.lock:
            self.reads += 1
            return copy.deepcopy(self.inventory), []

    def set_state(self, name, state):
        with self.lock:
            for item in self.inventory["entities"]:
                if item["name"] == name:
                    item["healthState"] = state


def install(case, wall=time.time, **settings):
    fake = Fake(case.module)
    case.module.live_hub = case.model_hub.ModelHub(fake.read_state, None, case.model_hub.HubSettings(**{**FAST, **settings}), wall=wall)
    return fake


class LiveStreamTests(base.ApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib

        cls.model_hub = importlib.import_module("model_hub")

    def wait_for_events(self, count):
        deadline = time.time() + 3
        while self.module.live_hub.warm((base.SUB, base.GROUP, base.MODEL)).seq < count and time.time() < deadline:
            time.sleep(0.02)

    def open(self, client, path="/api/health-model/stream", **kwargs):
        return client.stream("GET", path, **kwargs)

    def test_a_snapshot_comes_first_with_an_id_then_only_what_changed(self):
        fake = install(self)
        with Server(self.module.app) as client, self.open(client) as response:
            events = frames(response.iter_lines())
            first = next(events)
            fake.set_state("orders-api", "Unhealthy")
            second = next(events)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"].split(";")[0], "text/event-stream")
        self.assertEqual(first["event"], "snapshot")
        self.assertRegex(first["id"], r"^[0-9a-f]{8}-\d+$")
        self.assertEqual({item["name"] for item in first["data"]["entities"]} >= {"orders-api"}, True)
        self.assertEqual(second["event"], "delta")
        self.assertEqual([item["healthState"] for item in second["data"]["entities"]["upsert"]], ["Unhealthy"])
        self.assertEqual(second["data"]["observedAt"], fake.inventory["observedAt"])
        self.assertNotEqual(first["id"], second["id"])

    def test_a_stream_that_comes_back_with_its_last_id_gets_what_it_missed_and_no_snapshot(self):
        fake = install(self)
        with Server(self.module.app) as client:
            with self.open(client) as keeper:
                kept = frames(keeper.iter_lines())
                next(kept)
                with self.open(client) as response:
                    events = frames(response.iter_lines())
                    next(events)
                    fake.set_state("orders-api", "Unhealthy")
                    last = next(events)["id"]
                fake.set_state("orders-api", "Healthy")
                self.wait_for_events(2)
                fake.set_state("orders-db", "Degraded")
                self.wait_for_events(3)
                with self.open(client, headers={"Last-Event-ID": last}) as again:
                    resumed = []
                    for frame in frames(again.iter_lines()):
                        resumed.append(frame)
                        if len(resumed) == 2:
                            break

        self.assertEqual([frame["event"] for frame in resumed], ["delta", "delta"])
        self.assertEqual(resumed[-1]["id"].split("-")[1], "3")

    def test_the_model_is_served_from_the_hub_while_it_is_warm(self):
        fake = install(self)
        with Server(self.module.app) as client:
            with self.open(client) as response:
                events = frames(response.iter_lines())
                next(events)
                reads = fake.reads
                fake.set_state("orders-db", "Degraded")
                time.sleep(0.2)
                body = client.get("/api/health-model").json()

        self.assertEqual({item["name"]: item["healthState"] for item in body["entities"]}["orders-db"], "Degraded")
        self.assertGreaterEqual(fake.reads, reads)

    def test_a_refused_stream_is_an_error_envelope_not_a_stream(self):
        install(self)
        table = [
            ("an unknown model", "/api/health-model/stream?model=nope&resourceGroup=rg&subscription=" + base.SUB, {}, 400, "unknown_model"),
            ("another parameter", "/api/health-model/stream?since=1", {}, 400, "unsupported_query"),
            ("a bad Last-Event-ID", "/api/health-model/stream", {"Last-Event-ID": "x"}, 400, "invalid_last_event_id"),
        ]
        with Server(self.module.app) as client:
            for label, path, headers, status, code in table:
                with self.subTest(label):
                    response = client.get(path, headers=headers)

                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))

    def test_a_user_without_a_role_on_the_default_model_gets_nothing_of_it_from_a_warm_hub_on_any_route(self):
        install(self)
        with Server(self.module.app) as client, self.open(client) as keeper:
            next(frames(keeper.iter_lines()))
            sid = client.post("/api/sessions", json={}).json()["id"]
            self.health.deny(base.SUB, base.GROUP, base.MODEL)
            routes = [
                ("the model", "GET", "/api/health-model", {}),
                ("the live stream", "GET", "/api/health-model/stream", {}),
                ("the timeline", "GET", "/api/timeline", {}),
                ("the history of an entity", "GET", "/api/entities/orders-api", {}),
                ("a health report", "POST", "/api/entities/orders-api/health-reports", {"json": REPORT}),
                ("a task", "POST", f"/api/sessions/{sid}/tasks", {"json": {"type": "review", "target": base.TARGET}}),
            ]
            for label, method, path, arguments in routes:
                with self.subTest(label), client.stream(method, path, **arguments) as response:
                    code = None
                    if response.status_code >= 400:
                        response.read()
                        code = response.json()["error"]["code"]

                    self.assertEqual((response.status_code, code), (400, "unknown_model"))

    def test_too_many_models_watched_is_a_503_the_ui_can_fall_back_from(self):
        install(self, max_hubs=0)
        with Server(self.module.app) as client:
            response = client.get("/api/health-model/stream")

        self.assertEqual((response.status_code, response.json()["error"]["code"], response.json()["error"]["retryable"]), (503, "live_unavailable", True))

    def test_the_stream_route_is_asynchronous_and_leaves_no_viewer_behind(self):
        install(self)
        with Server(self.module.app) as client:
            with self.open(client) as response:
                events = frames(response.iter_lines())
                next(events)
            hub = self.module.live_hub.warm((base.SUB, base.GROUP, base.MODEL))
            deadline = time.time() + 2
            while hub.members and time.time() < deadline:
                time.sleep(0.02)

        self.assertEqual(hub.members, [])


class LiveWriteTests(base.DiffAndApplyCase):
    """The app's own writes show at once: the hub reads the model again after them, whatever its poll interval."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib

        cls.model_hub = importlib.import_module("model_hub")

    def watch(self, client):
        hub = self.model_hub.ModelHub(self.module.read_state, None, self.model_hub.HubSettings(**{**FAST, "poll_seconds": 30}))
        self.module.live_hub = hub
        sub = client.portal.call(hub.subscribe, SimpleNamespace(oid="local", owner="local"), self.health.as_user(None), (base.SUB, base.GROUP, base.MODEL))
        return hub, sub

    def names(self, response):
        return {item["name"]: item["displayName"] for item in response.json()["entities"]}

    def test_after_an_apply_the_next_read_and_the_next_delta_show_the_change(self):
        change = {"id": "c1", "op": "change", "kind": "entity", "name": "orders-api", "after": {"displayName": "Orders API (reviewed)"}, "reason": "r"}
        sid = self.stored_diff([change])
        with TestClient(self.module.app) as client:
            hub, sub = self.watch(client)
            self.assertEqual(self.names(client.get("/api/health-model"))["orders-api"], "Orders API")

            applied = self.post_apply(client, sid, ["c1"])
            after = client.get("/api/health-model")
            event = client.portal.call(sub.next, 2)

        self.assertEqual(applied.json()["outcome"], "applied")
        self.assertEqual(self.names(after)["orders-api"], "Orders API (reviewed)")
        self.assertEqual(event["event"], "delta")
        self.assertEqual([item["displayName"] for item in event["data"]["entities"]["upsert"]], ["Orders API (reviewed)"])

    def test_an_apply_tells_the_hub_the_model_itself_changed_and_a_health_report_does_not(self):
        change = {"id": "c1", "op": "change", "kind": "entity", "name": "orders-api", "after": {"displayName": "Renamed"}, "reason": "r"}
        sid = self.stored_diff([change])
        table = [
            ("an apply", lambda client: self.post_apply(client, sid, ["c1"]), True),
            ("a health report", lambda client: client.post("/api/entities/payments/health-reports", json=REPORT), False),
        ]
        with TestClient(self.module.app) as client:
            hub, _ = self.watch(client)
            for label, write, changed_model in table:
                with self.subTest(label), mock.patch.object(hub, "refresh", mock.Mock(wraps=hub.refresh)) as refresh:
                    self.assertLess(write(client).status_code, 300)

                    self.assertEqual(refresh.call_args.args[2], changed_model)

    def test_after_a_partial_apply_what_was_written_shows_and_nothing_more(self):
        good = {"id": "c1", "op": "change", "kind": "entity", "name": "orders-api", "after": {"displayName": "Written"}, "reason": "r"}
        bad = {"id": "c2", "op": "change", "kind": "entity", "name": "payments", "after": {"displayName": "Refused"}, "reason": "r"}
        sid = self.stored_diff([good, bad])
        original = self.health.write_resource

        def refuse_payments(sub, rg, model, kind, name, properties):
            if name == "payments":
                raise base.azure_error(400)
            return original(sub, rg, model, kind, name, properties)

        self.health.write_resource = refuse_payments
        with TestClient(self.module.app) as client:
            self.watch(client)
            with self.assertLogs("ahm-demo", level="WARNING"):
                body = self.post_apply(client, sid, ["c1", "c2"]).json()
            names = self.names(client.get("/api/health-model"))

        self.assertEqual(body["outcome"], "partial")
        self.assertEqual((names["orders-api"], names["payments"]), ("Written", "Payments"))

    def test_after_a_health_report_the_next_read_shows_what_the_service_now_says(self):
        original = self.module._ingest_health_report

        def report_and_change(entity_name, request, body, caller):
            response = original(entity_name, request, body, caller)
            for item in self.health._model(base.SUB, base.GROUP, base.MODEL)["entities"].values():
                if item["name"] == entity_name:
                    item["properties"]["healthState"] = "Unhealthy"
            return response

        self.module._ingest_health_report = report_and_change
        try:
            with TestClient(self.module.app) as client:
                hub, sub = self.watch(client)
                before = {item["name"]: item["healthState"] for item in client.get("/api/health-model").json()["entities"]}
                posted = client.post("/api/entities/web-frontend/health-reports", json=base.VALID_REPORT if hasattr(base, "VALID_REPORT") else REPORT)
                after = {item["name"]: item["healthState"] for item in client.get("/api/health-model").json()["entities"]}
                event = client.portal.call(sub.next, 2)
        finally:
            self.module._ingest_health_report = original

        self.assertEqual(posted.status_code, 202)
        self.assertEqual((before["web-frontend"], after["web-frontend"]), ("Healthy", "Unhealthy"))
        self.assertEqual(event["data"]["entities"]["upsert"][0]["healthState"], "Unhealthy")

    def test_the_refresh_parameter_reads_the_model_again_before_answering(self):
        with TestClient(self.module.app) as client:
            hub, sub = self.watch(client)
            for item in self.health._model(base.SUB, base.GROUP, base.MODEL)["entities"].values():
                if item["name"] == "payments":
                    item["properties"]["healthState"] = "Degraded"
            quiet = {item["name"]: item["healthState"] for item in client.get("/api/health-model").json()["entities"]}
            fresh = {item["name"]: item["healthState"] for item in client.get("/api/health-model?refresh=1").json()["entities"]}
            later = {item["name"]: item["healthState"] for item in client.get("/api/health-model").json()["entities"]}

        self.assertEqual((quiet["payments"], fresh["payments"], later["payments"]), ("Healthy", "Degraded", "Degraded"))


REPORT = {"signalName": "web-ui-health-report", "healthState": "Healthy", "value": 1, "expiresInMinutes": 30, "reasonPreset": "recovery"}


class LiveStreamAuthTests(entra.EntraCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib

        cls.model_hub = importlib.import_module("model_hub")

    def test_a_stream_ends_with_a_reconnect_when_the_token_that_opened_it_expires_and_the_next_one_resumes(self):
        clock = SimpleNamespace(now=time.time())
        raw = self.inventory.read_raw(self.health.client(entra.SUB), entra.GROUP, entra.MODEL)
        state = self.inventory.inventory_from(*raw, entra.MODEL)
        self.module.live_hub = self.model_hub.ModelHub(
            lambda user, selection: (copy.deepcopy(state), []), None, self.model_hub.HubSettings(**FAST), wall=lambda: clock.now
        )
        with Server(self.module.app) as client:
            with client.stream("GET", "/api/health-model/stream", headers=entra.bearer(entra.mint(entra.ADA))) as response:
                events = frames(response.iter_lines())
                first = next(events)
                clock.now += 7200
                closing = next(events)
            clock.now = time.time()
            with client.stream(
                "GET", "/api/health-model/stream", headers={**entra.bearer(entra.mint(entra.ADA)), "Last-Event-ID": first["id"]}
            ) as again:
                lines = []
                for line in again.iter_lines():
                    lines.append(line)
                    if len(lines) >= 2:
                        break

        self.assertEqual(first["event"], "snapshot")
        self.assertEqual((closing["event"], closing["data"]["reason"]), ("reconnect", "token_expired"))
        self.assertEqual(again.status_code, 200)
        self.assertFalse(any(line.startswith("event: snapshot") for line in lines), "the next stream resumes: no snapshot is sent again")

    def test_a_stream_needs_a_user_token(self):
        with Server(self.module.app) as client:
            response = client.get("/api/health-model/stream")

        self.assertEqual((response.status_code, response.headers["www-authenticate"]), (401, "Bearer"))


if __name__ == "__main__":
    unittest.main()
