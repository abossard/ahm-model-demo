import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import requests
from azure.core.credentials import AccessToken
from azure.core.exceptions import HttpResponseError
from azure.core.pipeline.transport import RequestsTransport
from azure.mgmt.cloudhealth import CloudHealthMgmtClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import healthmodels  # noqa: E402
import obo  # noqa: E402
from auth import Caller  # noqa: E402

SUB = "11111111-1111-1111-1111-111111111111"
GROUP = "rg-ahm-demo"
MODEL = "hm-ahm-demo"
ARM = "https://management.azure.com"
OID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
OTHER_OID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
MODEL_PATH = f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/Microsoft.CloudHealth/healthmodels/{MODEL}"


class Adapter(requests.adapters.BaseAdapter):
    def __init__(self, handler):
        super().__init__()
        self.handler = handler
        self.calls = []

    def send(self, request, **kwargs):
        self.calls.append(request)
        status, headers, body = self.handler(request)
        response = requests.Response()
        response.status_code = status
        response.headers.update(headers)
        response._content = body if isinstance(body, bytes) else json.dumps(body).encode()
        response._content_consumed = True
        response.raw = SimpleNamespace()
        response.url = request.url
        response.request = request
        response.reason = "scripted"
        return response

    def close(self):
        pass


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class Harness:
    def __init__(self, handler, clock=time.monotonic):
        self.adapter = Adapter(handler)
        session = requests.Session()
        session.mount("https://", self.adapter)
        self.credential = SimpleNamespace(get_token=lambda *scopes, **kw: AccessToken("token", int(time.time()) + 3600))
        real = CloudHealthMgmtClient

        def client(credential, subscription_id, **kwargs):
            return real(credential, subscription_id, transport=RequestsTransport(session=session), **kwargs)

        self.patch = mock.patch.object(healthmodels, "CloudHealthMgmtClient", side_effect=client)
        self.clients = self.patch.start()
        self.resource_graph = mock.patch.object(healthmodels, "ResourceGraphClient")
        self.graphs = self.resource_graph.start()
        self.credentials_asked = []
        self.credentials_by_oid = {}

        def credential(caller):
            self.credentials_asked.append(caller.oid)
            return self.credentials_by_oid.get(caller.oid, self.credential)

        self.shared = healthmodels.HealthModels(SimpleNamespace(credential=credential), clock=clock)
        self.models = self.shared.as_user(Caller(OID, "A", "token-one"))

    def stop(self):
        self.patch.stop()
        self.resource_graph.stop()

    def paths(self):
        return [(r.method, r.url.replace(ARM, "")) for r in self.adapter.calls]


def resource(kind, name, **properties):
    return {"id": f"{MODEL_PATH}/{kind}/{name}", "name": name, "type": "t", "properties": {"provisioningState": "Succeeded", **properties}, "systemData": {"createdAt": "x"}}


class RawReadTests(unittest.TestCase):
    def test_raw_reads_follow_paging_and_keep_every_property_untouched(self):
        future = {"futureField": {"nested": [1, 2.5, None, {"deep": "é"}]}, "signalGroups": {"brandNewGroup": {"x": 1}, "azureResource": {"signals": [{"name": "s", "mysteryOption": True}]}}}
        first = [resource("entities", "a", **future)]
        second = [resource("entities", "b", displayName="B")]
        next_link = f"{ARM}{MODEL_PATH}/entities?api-version=2026-11-01&$skiptoken=page2"

        def handler(request):
            url = request.url
            if "/entities" in url and "skiptoken" not in url:
                return 200, {"Content-Type": "application/json"}, {"value": first, "nextLink": next_link}
            if "/entities" in url:
                return 200, {"Content-Type": "application/json"}, {"value": second}
            if "/signaldefinitions" in url:
                return 200, {"Content-Type": "application/json"}, {"value": [resource("signaldefinitions", "sd-x", queryText="q")]}
            return 200, {"Content-Type": "application/json"}, {"value": []}

        harness = Harness(handler)
        self.addCleanup(harness.stop)

        raw = harness.models.read_model(SUB, GROUP, MODEL)

        self.assertEqual(set(raw), {"entities", "signalDefinitions", "relationships"})
        self.assertEqual([e["name"] for e in raw["entities"]], ["a", "b"])
        self.assertEqual(raw["entities"][0], first[0])
        self.assertEqual(json.dumps(raw["entities"][0], sort_keys=True), json.dumps(first[0], sort_keys=True))
        self.assertEqual(raw["signalDefinitions"][0]["properties"]["queryText"], "q")
        self.assertEqual(raw["relationships"], [])
        urls = [r.url for r in harness.adapter.calls]
        self.assertEqual(
            urls,
            [
                f"{ARM}{MODEL_PATH}/entities?api-version=2026-11-01",
                next_link,
                f"{ARM}{MODEL_PATH}/signaldefinitions?api-version=2026-11-01",
                f"{ARM}{MODEL_PATH}/relationships?api-version=2026-11-01",
            ],
        )
        self.assertEqual(harness.adapter.calls[0].headers["Authorization"], "Bearer token")

    def test_hostile_names_stay_inside_their_path_segments(self):
        harness = Harness(lambda request: (200, {}, {"value": []}))
        self.addCleanup(harness.stop)

        harness.models.read_model(SUB, "rg/../x?y#z", "m%2Fm")

        path = harness.adapter.calls[0].url.split("?")[0]
        self.assertIn("/resourceGroups/rg%2F..%2Fx%3Fy%23z/", path)
        self.assertIn("/healthmodels/m%252Fm/entities", path)

    def test_a_refused_read_raises_with_its_status(self):
        harness = Harness(lambda request: (403, {"Content-Type": "application/json"}, {"error": {"code": "AuthorizationFailed", "message": "SECRET"}}))
        self.addCleanup(harness.stop)

        with self.assertRaises(HttpResponseError) as caught:
            harness.models.read_model(SUB, GROUP, MODEL)

        self.assertEqual(caught.exception.status_code, 403)
        self.assertFalse(harness.models.has_model(SUB, GROUP, MODEL))


class WriteTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(healthmodels, "POLL_SECONDS", 0)
        patch.start()
        self.addCleanup(patch.stop)

    def immediate(self, request):
        headers = {"Content-Type": "application/json"}
        if request.method == "DELETE":
            return 204, {}, b""
        return 200, headers, resource("x", "y")

    def test_each_kind_is_put_to_its_own_collection_with_exactly_the_given_properties(self):
        properties = {"displayName": "Edited", "futureField": {"a": [1, 2]}, "signalGroups": {"azureResource": {"signals": [{"name": "cpu", "mystery": True}]}}}
        kinds = [("entity", "entities"), ("signalDefinition", "signaldefinitions"), ("relationship", "relationships")]
        for kind, collection in kinds:
            with self.subTest(kind=kind):
                harness = Harness(self.immediate)
                self.addCleanup(harness.stop)

                harness.models.write_resource(SUB, GROUP, MODEL, kind, "thing-1", properties)

                (call,) = harness.adapter.calls
                self.assertEqual(call.method, "PUT")
                self.assertEqual(call.url, f"{ARM}{MODEL_PATH}/{collection}/thing-1?api-version=2026-11-01")
                self.assertEqual(json.loads(call.body), {"properties": properties})
                self.assertEqual(call.headers["Content-Type"], "application/json")
                self.assertEqual(call.headers["Authorization"], "Bearer token")

    def test_deletes_go_to_the_right_resource(self):
        kinds = [("entity", "entities"), ("signalDefinition", "signaldefinitions"), ("relationship", "relationships")]
        for kind, collection in kinds:
            with self.subTest(kind=kind):
                harness = Harness(self.immediate)
                self.addCleanup(harness.stop)

                harness.models.delete_resource(SUB, GROUP, MODEL, kind, "thing-1")

                self.assertEqual(
                    harness.paths(), [("DELETE", f"{MODEL_PATH}/{collection}/thing-1?api-version=2026-11-01")]
                )

    def test_asynchronous_writes_are_awaited_before_the_call_returns(self):
        operation = f"{ARM}/subscriptions/{SUB}/providers/Microsoft.CloudHealth/operationStatuses/op-1?api-version=2026-11-01"
        polls = []

        def handler(request):
            headers = {"Content-Type": "application/json"}
            if request.method == "PUT":
                return 201, {**headers, "Azure-AsyncOperation": operation}, resource("entities", "thing-1", provisioningState="Creating")
            if request.url == operation:
                polls.append(1)
                return 200, headers, {"status": "InProgress" if len(polls) < 2 else "Succeeded"}
            return 200, headers, resource("entities", "thing-1")

        harness = Harness(handler)
        self.addCleanup(harness.stop)

        started = time.monotonic()
        harness.models.write_resource(SUB, GROUP, MODEL, "entity", "thing-1", {"displayName": "x"})

        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(len(polls), 2)
        self.assertEqual(harness.adapter.calls[0].method, "PUT")

    def test_asynchronous_deletes_are_awaited_and_gone_resources_are_reported_by_the_error(self):
        operation = f"{ARM}/subscriptions/{SUB}/providers/Microsoft.CloudHealth/operationStatuses/op-2?api-version=2026-11-01"

        def handler(request):
            headers = {"Content-Type": "application/json"}
            if request.method == "DELETE":
                return 202, {"Azure-AsyncOperation": operation, "Location": operation}, b""
            return 200, headers, {"status": "Succeeded"}

        harness = Harness(handler)
        self.addCleanup(harness.stop)

        harness.models.delete_resource(SUB, GROUP, MODEL, "relationship", "thing-1")

        self.assertEqual(harness.adapter.calls[0].method, "DELETE")
        self.assertTrue(any(r.url == operation for r in harness.adapter.calls[1:]))

        missing = Harness(lambda request: (404, {"Content-Type": "application/json"}, {"error": {"code": "ResourceNotFound", "message": "gone"}}))
        self.addCleanup(missing.stop)
        with self.assertRaises(HttpResponseError) as caught:
            missing.models.delete_resource(SUB, GROUP, MODEL, "entity", "thing-1")
        self.assertEqual(caught.exception.status_code, 404)

    def test_refused_writes_raise_with_status_and_azure_code(self):
        harness = Harness(lambda request: (400, {"Content-Type": "application/json"}, {"error": {"code": "InvalidRequestContent", "message": "bad SECRET"}}))
        self.addCleanup(harness.stop)

        with self.assertRaises(HttpResponseError) as caught:
            harness.models.write_resource(SUB, GROUP, MODEL, "entity", "thing-1", {"x": 1})

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.error.code, "InvalidRequestContent")

    def test_one_client_is_used_for_reads_and_writes_of_a_subscription(self):
        created = []
        harness = Harness(self.immediate)
        self.addCleanup(harness.stop)

        harness.models.read_model = lambda *a: {"entities": [], "signalDefinitions": [], "relationships": []}
        harness.models.write_resource(SUB, GROUP, MODEL, "entity", "a-b", {})
        harness.models.write_resource(SUB, GROUP, MODEL, "entity", "c-d", {})
        created.append(harness.clients.call_count)

        self.assertEqual(created, [1])


class CacheTests(unittest.TestCase):
    def harness(self, handler=lambda request: (200, {}, {})):
        self.clock = Clock()
        harness = Harness(handler, self.clock)
        self.addCleanup(harness.stop)
        return harness

    def test_the_catalog_is_queried_once_per_30_seconds(self):
        harness = self.harness()
        graph = harness.graphs.return_value
        rows = [{"id": "x", "name": "hm-a"}]
        graph.resources.return_value = SimpleNamespace(data=rows, skip_token=None)

        results = []
        for advance in (0, 0, 29.9, 0.1, 29.9, 0.1):
            self.clock.advance(advance)
            results.append(harness.models.query_models())

        self.assertEqual(graph.resources.call_count, 3)
        self.assertTrue(all(result == rows for result in results))

    def test_a_failed_catalog_query_is_not_cached(self):
        harness = self.harness()
        graph = harness.graphs.return_value
        graph.resources.side_effect = [HttpResponseError("429"), SimpleNamespace(data=[{"name": "hm-a"}], skip_token=None)]

        with self.assertRaises(HttpResponseError):
            harness.models.query_models()
        first = harness.models.query_models()
        second = harness.models.query_models()

        self.assertEqual(first, second)
        self.assertEqual(graph.resources.call_count, 2)

    def test_model_checks_are_cached_for_60_seconds_whether_positive_or_negative(self):
        cases = [
            (200, True, True),
            (400, False, True),
            (403, False, True),
            (404, False, True),
            (401, HttpResponseError, False),
            (429, HttpResponseError, False),
            (500, HttpResponseError, False),
        ]
        for status, expected, cached in cases:
            with self.subTest(status=status):
                harness = self.harness()
                calls = []

                def get(resource_group, model_name, **kwargs):
                    calls.append(1)
                    if status == 200:
                        return {"name": model_name}
                    error = HttpResponseError(message="m")
                    error.status_code = status
                    raise error

                harness.models.client = lambda subscription_id: SimpleNamespace(health_models=SimpleNamespace(get=get))

                def check():
                    if expected is HttpResponseError:
                        with self.assertRaises(HttpResponseError):
                            harness.models.has_model(SUB, GROUP, MODEL)
                        return
                    self.assertIs(harness.models.has_model(SUB, GROUP, MODEL), expected)

                check()
                self.clock.advance(59.9)
                check()
                after_first_minute = len(calls)
                self.clock.advance(0.1)
                check()

                self.assertEqual(after_first_minute, 1 if cached else 2)
                self.assertEqual(len(calls), 2 if cached else 3)

    def test_a_check_is_remembered_per_model_and_ignores_case(self):
        harness = self.harness(lambda request: (200, {"Content-Type": "application/json"}, {"name": MODEL}))

        harness.models.has_model(SUB, GROUP, MODEL)
        harness.models.has_model(SUB.upper(), GROUP.upper(), MODEL.upper())
        harness.models.has_model(SUB, GROUP, "hm-other")
        harness.models.has_model(SUB, "rg-other", MODEL)

        self.assertEqual(len(harness.adapter.calls), 3)

    def test_the_model_cache_stays_within_its_size(self):
        with mock.patch.object(healthmodels, "MODEL_CACHE_SIZE", 3):
            harness = self.harness(lambda request: (200, {"Content-Type": "application/json"}, {"name": MODEL}))
        names = [f"hm-{n}" for n in range(5)]

        for name in names:
            harness.models.has_model(SUB, GROUP, name)
        calls = len(harness.adapter.calls)
        harness.models.has_model(SUB, GROUP, names[-1])
        harness.models.has_model(SUB, GROUP, names[2])
        newest_cached = len(harness.adapter.calls)
        harness.models.has_model(SUB, GROUP, names[0])

        self.assertEqual(calls, 5)
        self.assertEqual(newest_cached, 5)
        self.assertEqual(len(harness.adapter.calls), 6)
        self.assertLessEqual(len(harness.shared.known._items), 3)

    def test_expired_entries_are_dropped_when_they_are_met(self):
        harness = self.harness(lambda request: (200, {"Content-Type": "application/json"}, {"name": MODEL}))

        harness.models.has_model(SUB, GROUP, MODEL)
        self.clock.advance(61)
        harness.models.has_model(SUB, GROUP, MODEL)

        self.assertEqual(len(harness.adapter.calls), 2)
        self.assertEqual(len(harness.shared.known._items), 1)


class CallerTests(unittest.TestCase):
    def harness(self, handler=lambda request: (200, {"Content-Type": "application/json"}, {"name": MODEL})):
        self.clock = Clock()
        harness = Harness(handler, self.clock)
        self.addCleanup(harness.stop)
        return harness

    def test_every_caller_has_their_own_credential_catalog_and_model_checks(self):
        harness = self.harness()
        graph = harness.graphs.return_value
        graph.resources.return_value = SimpleNamespace(data=[{"name": "hm-a"}], skip_token=None)
        harness.credentials_asked.clear()
        alice = harness.shared.as_user(Caller(OID, "Alice", "token-a"))
        bob = harness.shared.as_user(Caller(OTHER_OID, "Bob", "token-b"))

        for models in (alice, alice, bob, bob, alice):
            models.query_models()
        for models in (alice, alice, bob, bob):
            self.assertTrue(models.has_model(SUB, GROUP, MODEL))

        self.assertEqual(harness.credentials_asked, [OID, OTHER_OID])
        self.assertEqual(graph.resources.call_count, 2)
        self.assertEqual(harness.graphs.call_count, 2)
        self.assertEqual(len(harness.adapter.calls), 2)

    def test_refusals_of_the_exchange_reach_the_caller_unchanged_through_the_sdk_and_nothing_is_sent(self):
        cases = [("sign in again", obo.InteractionRequired('{"access_token":{}}')), ("consent", obo.ConsentRequired())]
        for label, error in cases:
            with self.subTest(label=label):
                harness = self.harness()

                def refuse(*scopes, _error=error, **kwargs):
                    raise _error

                harness.credentials_by_oid[OID] = SimpleNamespace(get_token=refuse)
                models = harness.shared.as_user(Caller(OID, "A", "token-a"))
                calls = [
                    lambda: models.read_model(SUB, GROUP, MODEL),
                    lambda: models.has_model(SUB, GROUP, MODEL),
                    lambda: models.write_resource(SUB, GROUP, MODEL, "entity", "api", {"displayName": "x"}),
                    lambda: models.delete_resource(SUB, GROUP, MODEL, "entity", "api"),
                    lambda: models.client(SUB).health_models.get(GROUP, MODEL),
                ]
                for call in calls:
                    with self.assertRaises(type(error)) as caught:
                        call()

                    self.assertIs(caught.exception, error)
                self.assertEqual(harness.adapter.calls, [])

    def test_a_check_one_caller_passed_is_not_taken_on_trust_for_another(self):
        harness = self.harness(lambda request: (403 if "Authorization" in request.headers and request.headers["Authorization"] == "Bearer denied" else 200, {"Content-Type": "application/json"}, {"name": MODEL}))
        harness.credentials_by_oid[OTHER_OID] = SimpleNamespace(get_token=lambda *scopes, **kw: AccessToken("denied", int(time.time()) + 3600))
        allowed = harness.shared.as_user(Caller(OID, "A", "token-a"))
        denied = harness.shared.as_user(Caller(OTHER_OID, "B", "token-b"))

        self.assertTrue(allowed.has_model(SUB, GROUP, MODEL))
        self.assertFalse(denied.has_model(SUB, GROUP, MODEL))
        self.assertTrue(allowed.has_model(SUB, GROUP, MODEL))

    def test_a_new_token_of_the_same_caller_gets_a_new_client_but_keeps_the_catalog(self):
        harness = self.harness()
        graph = harness.graphs.return_value
        graph.resources.return_value = SimpleNamespace(data=[{"name": "hm-a"}], skip_token=None)
        first = harness.shared.as_user(Caller(OID, "A", "token-one"))
        same = harness.shared.as_user(Caller(OID, "A", "token-one"))
        later = harness.shared.as_user(Caller(OID, "A", "token-two"))

        for models in (first, same, later):
            models.client(SUB)
            models.query_models()

        self.assertEqual(harness.clients.call_count, 2)
        self.assertEqual(graph.resources.call_count, 1)
        self.assertEqual(harness.graphs.call_count, 1)

    def test_clients_are_kept_per_subscription(self):
        harness = self.harness()
        models = harness.shared.as_user(Caller(OID, "A", "token-one"))

        for subscription in (SUB, SUB, "33333333-3333-3333-3333-333333333333"):
            models.client(subscription)

        self.assertEqual(harness.clients.call_count, 2)

    def test_the_client_cache_is_small_and_expires(self):
        with mock.patch.object(healthmodels, "CLIENT_CACHE_SIZE", 3):
            harness = self.harness()
        for number in range(8):
            harness.shared.as_user(Caller(f"{number:08d}-0000-0000-0000-000000000000", "U", f"token-{number}")).client(SUB)

        self.assertEqual(harness.clients.call_count, 8)
        self.assertLessEqual(len(harness.shared.clients._items), 3)
        self.clock.advance(healthmodels.CLIENT_CACHE_SECONDS + 1)
        harness.shared.as_user(Caller("00000007-0000-0000-0000-000000000000", "U", "token-7")).client(SUB)
        self.assertEqual(harness.clients.call_count, 9)

    def test_the_catalog_cache_holds_a_bounded_number_of_callers(self):
        with mock.patch.object(healthmodels, "CALLER_CACHE_SIZE", 2):
            harness = self.harness()
        graph = harness.graphs.return_value
        graph.resources.return_value = SimpleNamespace(data=[], skip_token=None)

        for number in range(5):
            harness.shared.as_user(Caller(f"{number:08d}-0000-0000-0000-000000000000", "U", "t")).query_models()

        self.assertLessEqual(len(harness.shared.catalogs._items), 2)


if __name__ == "__main__":
    unittest.main()
