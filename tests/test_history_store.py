import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError, ServiceRequestError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import history_store  # noqa: E402
import timeline  # noqa: E402
from test_timeline import NOW, Recording, Clock, entity, point, read, relationship  # noqa: E402

DAY = history_store.DAY_MS


class BucketTests(unittest.TestCase):
    def test_buckets_cover_a_window_newest_first_and_only_closed_ones(self):
        table = [
            ("two whole days", 0, 2 * DAY, 10 * DAY, [(DAY, 2 * DAY), (0, DAY)]),
            ("a window inside one day", 100, 200, 10 * DAY, [(0, DAY)]),
            ("an open day is left to the tail", 0, 3 * DAY, 2 * DAY, [(DAY, 2 * DAY), (0, DAY)]),
            ("nothing closed", 5 * DAY, 6 * DAY, 2 * DAY, []),
            ("a window that straddles the limit", DAY + 5, 4 * DAY, 3 * DAY, [(2 * DAY, 3 * DAY), (DAY, 2 * DAY)]),
        ]
        for label, start, end, limit, expected in table:
            with self.subTest(label):
                self.assertEqual(history_store.buckets(start, end, DAY, limit), expected)

    def test_a_bucket_is_closed_a_safety_margin_after_it_ends(self):
        now = 3 * DAY + 10 * 60_000

        self.assertEqual(history_store.closed_before(now, DAY, 15 * 60_000), 2 * DAY)
        self.assertEqual(history_store.closed_before(now + 6 * 60_000, DAY, 15 * 60_000), 3 * DAY)

    def test_a_blob_name_is_stable_lower_case_escaped_and_under_its_own_prefix(self):
        name = history_store.blob_name(("Sub", "RG", "HM"), "signal", "a/b c", None, 86400000)

        self.assertEqual(name, "history/v1/sub/rg/hm/signal/a%2Fb%20c/_/86400000.json")
        self.assertNotEqual(name, history_store.blob_name(("sub", "rg", "hm"), "signal", "a", "cpu", 0))

    def test_buckets_join_oldest_first(self):
        parts = [{"points": [[5, 1, 1], [6, 1, 1]], "reports": []}, {"points": [[1, 1, 1]], "reports": [{"t": 1}]}]

        merged = history_store.merge_parts("signal", parts)

        self.assertEqual([row[0] for row in merged["points"]], [1, 5, 6])
        self.assertEqual(merged["reports"], [{"t": 1}])


class StoreTests(unittest.TestCase):
    def test_memory_forgets_the_least_recently_used(self):
        memory = history_store.MemoryHistory(2)
        memory.put("a", 1)
        memory.put("b", 2)
        memory.get("a")
        memory.put("c", 3)

        self.assertEqual([memory.get(name) for name in "abc"], [1, None, 3])

    def test_the_durable_layer_fills_memory_and_writes_go_to_both(self):
        durable = history_store.MemoryHistory()
        durable.put("old", {"x": 1})
        layered = history_store.LayeredHistory(history_store.MemoryHistory(), durable)

        self.assertEqual(layered.get("old"), {"x": 1})
        layered.put("new", {"y": 2})
        self.assertEqual(durable.get("new"), {"y": 2})
        self.assertEqual(history_store.LayeredHistory(history_store.MemoryHistory(), durable).get("new"), {"y": 2})

    def test_a_blob_that_is_missing_or_unreadable_is_a_miss_and_a_failed_write_is_not_an_error(self):
        container = mock.Mock()
        store = history_store.BlobHistory(container)
        table = [(ResourceNotFoundError("x"), None), (ServiceRequestError("x"), None)]
        for error, expected in table:
            with self.subTest(type(error).__name__):
                container.download_blob.side_effect = error
                self.assertEqual(store.get("n"), expected)
        container.download_blob.side_effect = None
        container.download_blob.return_value.readall.return_value = b"not json"
        self.assertIsNone(store.get("n"))
        container.download_blob.return_value.readall.return_value = b'{"a":1}'
        self.assertEqual(store.get("n"), {"a": 1})
        container.upload_blob.side_effect = ServiceRequestError("x")
        store.put("n", {"a": 1})
        container.upload_blob.assert_called_once()
        self.assertEqual(container.upload_blob.call_args.kwargs, {"overwrite": True})


class Windowed(Recording):
    """A service that answers for the window asked: points of `data` inside startAt and endAt."""

    def __init__(self, entities, relationships, data, page_limit=1000):
        super().__init__(entities, relationships)
        self.data = data
        self.page_limit = page_limit

    def serve(self, kind, name, signal, body):
        with self.lock:
            self.calls.append((kind, name, signal, dict(body)))
        start = body.get("startAt") or datetime.min.replace(tzinfo=timezone.utc)
        end = body.get("endAt") or datetime.max.replace(tzinfo=timezone.utc)
        rows = [row for row in self.data.get((kind, name, signal), []) if start <= row["occurredAt"] <= end]
        if body.get("startAt") and body["startAt"] < NOW - timedelta(days=30):
            raise HttpResponseError(message="The value for startAt cannot be more than 30 days in the past.")
        newest_first = sorted(rows, key=lambda row: row["occurredAt"], reverse=True)
        cut = len(newest_first) > self.page_limit and "nextMarker" not in body
        return {"entityName": name, "history": newest_first[: self.page_limit], "annotations": [], "nextMarker": "more" if cut else None}


def series(days=4, every_minutes=60):
    rows = []
    t = NOW - timedelta(days=days)
    while t <= NOW:
        rows.append({"occurredAt": t, "value": float(len(rows)), "healthState": "Healthy"})
        t += timedelta(minutes=every_minutes)
    return rows


def backend(data=None):
    return Windowed([entity("root"), entity("api", ["cpu"])], [relationship("root", "api")], data or {("signal", "api", "cpu"): series()})


def reader(history, clock=None):
    return timeline.TimelineReader(clock=clock or Clock(), now=lambda: NOW, history=history)


def signals(subject, source, hours, caller=None):
    params = {"include": "signals", "from": (NOW - timedelta(hours=hours)).isoformat()}
    return subject.read(caller or SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "hm"), params, ["api"])["series"][0]


class ReaderCacheTests(unittest.TestCase):
    def test_closed_days_are_read_once_and_only_the_open_tail_is_read_again(self):
        source = backend()
        history = history_store.LayeredHistory(history_store.MemoryHistory())

        first = signals(reader(history), source, 72)
        reads = len(source.calls_of("signal"))
        second = signals(reader(history, Clock()), source, 72)

        self.assertEqual(first["points"], second["points"])
        self.assertTrue(first["complete"] and second["complete"])
        self.assertGreaterEqual(reads, 3)
        self.assertEqual(len(source.calls_of("signal")) - reads, 1, "one read of the tail")

    def test_a_window_back_to_the_retention_is_read_without_asking_for_more_than_the_service_keeps(self):
        source = backend({("signal", "api", "cpu"): series(days=30)})
        memory = history_store.MemoryHistory()

        result = signals(reader(history_store.LayeredHistory(memory)), source, 30 * 24 - 1)

        self.assertTrue(result["complete"])
        self.assertGreater(len(result["points"]), 600)
        oldest = min(memory._items, key=lambda name: int(name.rsplit("/", 1)[1].split(".")[0]))
        self.assertGreaterEqual(int(oldest.rsplit("/", 1)[1].split(".")[0]), timeline.to_ms(NOW - timedelta(days=30)))

    def test_the_points_are_the_same_with_and_without_the_cache(self):
        source = backend()
        plain = signals(timeline.TimelineReader(clock=Clock(), now=lambda: NOW), source, 72)
        cached = signals(reader(history_store.LayeredHistory(history_store.MemoryHistory())), source, 72)

        self.assertEqual(plain["points"], cached["points"])

    def test_nothing_outside_the_window_is_returned_from_a_bucket_that_reaches_beyond_it(self):
        source = backend()

        points = signals(reader(history_store.LayeredHistory(history_store.MemoryHistory())), source, 30)["points"]

        self.assertGreaterEqual(points[0][0], timeline.to_ms(NOW - timedelta(hours=30)) // 1000 * 1000 - 3600_000 * 24)
        self.assertTrue(all(timeline.to_ms(NOW - timedelta(hours=30)) // 60_000 * 60_000 <= row[0] <= timeline.to_ms(NOW) for row in points))

    def test_a_restart_with_a_durable_layer_reads_no_closed_history_from_azure(self):
        durable = history_store.MemoryHistory()
        source = backend()
        signals(reader(history_store.LayeredHistory(history_store.MemoryHistory(), durable)), source, 72)
        calls = len(source.calls_of("signal"))

        after_restart = reader(history_store.LayeredHistory(history_store.MemoryHistory(), durable))
        signals(after_restart, source, 72)

        self.assertEqual(len(source.calls_of("signal")) - calls, 1)

    def test_a_day_that_could_not_be_read_in_full_is_not_kept_and_the_result_says_it_was_cut(self):
        many = [{"occurredAt": NOW - timedelta(days=2) + timedelta(seconds=i * 20), "value": 1.0, "healthState": "Healthy"} for i in range(4000)]
        source = Windowed([entity("root"), entity("api", ["cpu"])], [relationship("root", "api")], {("signal", "api", "cpu"): many}, page_limit=500)
        memory = history_store.MemoryHistory()

        with mock.patch.object(timeline, "TIMELINE_SIGNAL_PAGES", 1):
            result = signals(reader(history_store.LayeredHistory(memory)), source, 72)

        self.assertFalse(result["complete"])
        self.assertEqual(memory._items, {})
        self.assertIsNotNone(result["earliest"])

    def test_closed_history_is_not_shared_between_models(self):
        source = backend()
        history = history_store.LayeredHistory(history_store.MemoryHistory())
        signals(reader(history), source, 72)
        calls = len(source.calls_of("signal"))

        other = timeline.TimelineReader(clock=Clock(), now=lambda: NOW, history=history)
        other.read(SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "other"), {"include": "signals", "from": (NOW - timedelta(hours=72)).isoformat()}, ["api"])

        self.assertGreater(len(source.calls_of("signal")), calls + 1)

    def test_the_states_of_an_entity_are_kept_by_week_in_the_same_way(self):
        rows = [{"occurredAt": NOW - timedelta(days=d), "previousState": "Healthy", "newState": "Degraded"} for d in (1, 2, 3)]
        source = backend({("states", "api", None): rows})
        history = history_store.LayeredHistory(history_store.MemoryHistory())
        params = {"include": "states", "from": (NOW - timedelta(days=5)).isoformat()}

        first = reader(history).read(SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "hm"), params, ["api"])
        calls = len(source.calls_of("states"))
        second = reader(history, Clock()).read(SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "hm"), params, ["api"])

        self.assertEqual(first["states"][0]["transitions"], second["states"][0]["transitions"])
        self.assertEqual(len(first["states"][0]["transitions"]), 3)
        self.assertEqual(len(source.calls_of("states")) - calls, 1)


class LargeModelTests(unittest.TestCase):
    """The overview of a model: the states and annotations of every entity for the 30 days the service keeps."""

    WEEK = 7 * DAY

    def source(self, count):
        return Windowed([entity(f"e{index}") for index in range(count)], [], {})

    def tiles(self):
        now_ms = timeline.to_ms(NOW)
        first = (now_ms - 30 * DAY) // self.WEEK * self.WEEK
        return [(start, start + self.WEEK) for start in range(first, now_ms, self.WEEK)]

    def test_a_month_of_sixty_entities_is_cut_in_one_request_and_complete_week_by_week(self):
        caller = SimpleNamespace(oid="ada", owner="ada")
        table = [("a model of 20 entities fits one request", 20, False), ("a model of 60 entities does not", 60, True)]
        for label, count, cut in table:
            with self.subTest(label):
                source = self.source(count)
                params = {"include": "states,annotations", "from": (NOW - timedelta(days=30)).isoformat()}

                whole = reader(history_store.LayeredHistory(history_store.MemoryHistory())).read(caller, source, ("sub", "rg", "hm"), params)

                self.assertEqual(whole["partial"], cut)
                self.assertLessEqual(len(source.calls), timeline.TIMELINE_MAX_CALLS)

        source = self.source(60)
        subject = reader(history_store.LayeredHistory(history_store.MemoryHistory()))
        for start, end in self.tiles():
            with self.subTest(tile=timeline.iso_ms(start)):
                before = len(source.calls)

                body = subject.read(caller, source, ("sub", "rg", "hm"), {"include": "states,annotations", "from": timeline.iso_ms(start), "to": timeline.iso_ms(end)})

                self.assertFalse(body["partial"])
                self.assertEqual((len(body["states"]), all(item["complete"] for item in body["states"]), body["failures"]), (60, True, []))
                self.assertEqual(len(source.calls) - before, 120, "one read per entity and part")

    def test_a_week_that_was_read_costs_the_next_viewer_no_call(self):
        source = self.source(60)
        history = history_store.LayeredHistory(history_store.MemoryHistory())
        start, end = self.tiles()[2]
        params = {"include": "states,annotations", "from": timeline.iso_ms(start), "to": timeline.iso_ms(end)}
        reader(history).read(SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "hm"), params)
        calls = len(source.calls)

        body = reader(history, Clock()).read(SimpleNamespace(oid="bob", owner="bob"), source, ("sub", "rg", "hm"), params)

        self.assertEqual((len(source.calls) - calls, body["partial"]), (0, False))


class StructureFromTheHubTests(unittest.TestCase):
    def test_a_warm_hub_supplies_the_structure_and_no_entity_list_is_read(self):
        source = backend()
        listings = []
        source.entities.list_by_health_model = lambda *a: listings.append(1) or list(source.items)
        structure = timeline.build_structure(source.items, source.links, "hm")
        subject = timeline.TimelineReader(clock=Clock(), now=lambda: NOW, structure=lambda selection: structure)

        body = subject.read(SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "hm"), {"include": "structure,states", "from": (NOW - timedelta(hours=1)).isoformat()}, [])

        self.assertEqual(listings, [])
        self.assertEqual([item["name"] for item in body["entities"]], ["root", "api"])


if __name__ == "__main__":
    unittest.main()
