import json
import re
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceModifiedError, ResourceNotFoundError, ServiceRequestError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import history_store  # noqa: E402
import timeline  # noqa: E402
from test_timeline import NOW, Recording, Clock, entity, relationship  # noqa: E402

DAY = history_store.DAY_MS
WEEK = history_store.WEEK_MS
SCOPE = ("sub", "rg", "hm")
TILES_TS = Path(__file__).resolve().parents[1] / "src" / "web" / "ui" / "src" / "model" / "timelineTiles.ts"


class Container:
    """A blob container that keeps blobs with ETags and refuses a write over a version it was not given."""

    def __init__(self, upload_seconds=0.0):
        self.blobs = {}
        self.reads = []
        self.writes = []
        self.listings = []
        self.version = 0
        self.upload_seconds = upload_seconds
        # Set to an Event to hold every upload, or the next read, until it is set.
        self.uploads_wait = None
        self.read_waits = None
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()

    def download_blob(self, name):
        self.reads.append(name)
        waits, self.read_waits = self.read_waits, None
        found = self.blobs.get(name)
        if waits is not None:
            waits.wait(2)
        if found is None:
            raise ResourceNotFoundError("missing")
        data, etag = found
        return SimpleNamespace(readall=lambda: data, properties=SimpleNamespace(etag=etag))

    def upload_blob(self, name, data, overwrite=False, etag=None, match_condition=None):
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if self.uploads_wait is not None:
                self.uploads_wait.wait(2)
            time.sleep(self.upload_seconds)
            with self.lock:
                if not overwrite and name in self.blobs:
                    raise ResourceExistsError("exists")
                if etag is not None and self.blobs.get(name, (None, None))[1] != etag:
                    raise ResourceModifiedError("changed")
                self.version += 1
                self.blobs[name] = (data, f'"{self.version}"')
                self.writes.append(name)
                return {"etag": f'"{self.version}"'}
        finally:
            with self.lock:
                self.active -= 1

    def list_blobs(self, name_starts_with):
        self.listings.append(name_starts_with)
        return [SimpleNamespace(name=name) for name in self.blobs if name.startswith(name_starts_with)]

    def pieces(self, name):
        return json.loads(self.blobs[name][0])["pieces"]


def store(container=None, legacy=None, memory=None, **writers):
    return history_store.HistoryStore(
        memory or history_store.MemoryBuckets(),
        container and history_store.BlobBuckets(container),
        legacy and history_store.LegacyHistory(legacy),
        **writers,
    )


def one_piece(name="cpu", start=0, kind="signal"):
    batch = history_store.Batch()
    batch.add(SCOPE, kind, "api", name if kind == "signal" else None, start, history_store.AZURE, {0: {"points": [], "reports": []} if kind == "signal" else {"transitions": []}})
    return batch


def piece(start, src, rows=None, kind="signal", entity="api", signal="cpu"):
    return (kind, entity, signal, start, src, json.dumps(rows or {"points": [[start, 1.0, 1]]}))


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

    def test_a_piece_lives_in_the_blob_of_its_model_family_level_and_tile(self):
        day = 20 * WEEK + 3 * DAY
        table = [
            ("every point of a signal, by the day", "signal", 0, day + 5, f"history/v2/sub/rg/hm/series/0/{day}.json"),
            ("slots of 15 minutes, by the day", "signal", 900, day, f"history/v2/sub/rg/hm/series/900/{day}.json"),
            ("slots of an hour, by the week", "signal", 3600, day, f"history/v2/sub/rg/hm/series/3600/{20 * WEEK}.json"),
            ("transitions, by the week", "states", 0, day, f"history/v2/sub/rg/hm/overview/{20 * WEEK}.json"),
            ("annotations, in the same blob", "annotations", 0, 20 * WEEK, f"history/v2/sub/rg/hm/overview/{20 * WEEK}.json"),
        ]
        for label, kind, level, start, expected in table:
            with self.subTest(label):
                self.assertEqual(history_store.bucket_name(SCOPE, kind, level, start), expected)
        self.assertEqual(history_store.bucket_name(("Sub", "R G", "HM"), "signal", 0, 0), "history/v2/sub/r%20g/hm/series/0/0.json")

    def test_the_first_layout_is_named_as_before(self):
        name = history_store.legacy_name(("Sub", "RG", "HM"), "signal", "a/b c", None, 86400000)

        self.assertEqual(name, "history/v1/sub/rg/hm/signal/a%2Fb%20c/_/86400000.json")

    def test_the_tiles_of_the_store_are_the_tiles_of_the_browser(self):
        source = TILES_TS.read_text(encoding="utf-8")
        units = {"DAY": DAY, "WEEK": WEEK, "HOUR": 3600_000, "MINUTE": 60_000}

        def ms(text):
            return eval(text, {"__builtins__": {}}, units)  # noqa: S307 - a product like `15 * MINUTE` from our own source

        levels = re.search(r"export const LEVELS: readonly Level\[\] = \[(.*?)\];", source, re.S).group(1)
        browser = [(ms(slot) // 1000, ms(tile)) for slot, tile in re.findall(r"\{ slot: ([^,]+), tile: ([^ ]+) \}", levels)]
        overview = ms(re.search(r"export const OVERVIEW_TILE = (\w+);", source).group(1))

        self.assertEqual(browser, [(level, history_store.SERIES_TILE_MS[level]) for level in history_store.LEVELS])
        self.assertEqual(overview, history_store.OVERVIEW_TILE_MS)

    def test_a_piece_holds_what_belongs_to_it_and_not_its_end(self):
        rows = {"points": [[0, 1, 1], [DAY - 1, 2, 1], [DAY, 3, 1]], "reports": [{"t": DAY}]}

        self.assertEqual(history_store.within("signal", rows, 0, DAY), {"points": [[0, 1, 1], [DAY - 1, 2, 1]], "reports": []})

    def test_buckets_join_oldest_first(self):
        parts = [{"points": [[5, 1, 1], [6, 1, 1]], "reports": []}, {"points": [[1, 1, 1]], "reports": [{"t": 1}]}]

        merged = history_store.merge_parts("signal", parts)

        self.assertEqual([row[0] for row in merged["points"]], [1, 5, 6])
        self.assertEqual(merged["reports"], [{"t": 1}])

    def test_a_piece_read_from_azure_replaces_a_recorded_one_and_nothing_else_replaces_a_piece(self):
        azure, recorded = history_store.AZURE, history_store.RECORDED
        table = [
            ("a new piece from Azure", None, azure, azure),
            ("a new recorded piece", None, recorded, recorded),
            ("Azure over a recording", recorded, azure, azure),
            ("a recording over Azure", azure, recorded, azure),
            ("Azure over Azure", azure, azure, azure),
            ("a recording over a recording", recorded, recorded, recorded),
        ]
        for label, before, incoming, winner in table:
            with self.subTest(label):
                bucket = history_store.Bucket()
                if before:
                    bucket, _ = bucket.merged([piece(0, before, {"points": [[0, "first", 1]]})])

                merged, changed = bucket.merged([piece(0, incoming, {"points": [[0, "second", 1]]})])

                src, text = merged.piece("signal", "api", "cpu", 0)
                self.assertEqual(src, winner)
                self.assertEqual(json.loads(text)["points"][0][1], "second" if changed else "first")
                self.assertEqual(changed, before is None or (before == recorded and incoming == azure))


class StoreTests(unittest.TestCase):
    def test_memory_forgets_the_least_recently_used_beyond_its_bytes(self):
        memory = history_store.MemoryBuckets(3 * (100 + 64 + 1))
        for name in "abc":
            memory.put(name, history_store.Bucket({}, None, 100))
        memory.get("a")
        memory.put("d", history_store.Bucket({}, None, 100))

        self.assertEqual([memory.get(name) is not None for name in "abcd"], [True, False, True, True])
        self.assertLessEqual(memory.size, 3 * (100 + 64 + 1))
        memory.put("huge", history_store.Bucket({}, None, 10_000))
        self.assertIsNone(memory.get("huge"))

    def test_pieces_written_at_once_land_in_one_blob_per_tile_and_survive_a_restart(self):
        container = Container()
        batch = history_store.Batch()
        for signal in ("cpu", "mem", "disk"):
            batch.add(SCOPE, "signal", "api", signal, DAY, history_store.AZURE, {0: {"points": [[DAY, 1.0, 1]], "reports": []}, 900: {"points": [[DAY, 1.0, 1]]}})

        written = store(container)
        written.write(batch)
        written.flush()
        tally = history_store.Tally()
        restarted = store(container)
        found = [restarted.piece(SCOPE, "signal", level, "api", signal, DAY, tally) for level in (0, 900) for signal in ("cpu", "mem", "disk")]

        self.assertEqual(sorted(container.writes), sorted([history_store.bucket_name(SCOPE, "signal", level, DAY) for level in (0, 900)]))
        self.assertTrue(all(item[0] == history_store.AZURE for item in found))
        self.assertEqual((tally.counts()["blob"], tally.counts()["memory"]), (2, 4))

    def test_two_writers_of_one_blob_keep_both_their_pieces(self):
        container = Container()
        first, second = store(container), store(container)
        first.bucket(history_store.bucket_name(SCOPE, "signal", 0, 0), history_store.Tally())
        second.bucket(history_store.bucket_name(SCOPE, "signal", 0, 0), history_store.Tally())

        for subject, signal in ((first, "cpu"), (second, "mem")):
            subject.write(one_piece(signal))
            subject.flush()

        self.assertEqual(sorted(container.pieces(history_store.bucket_name(SCOPE, "signal", 0, 0))["signal"]["api"]), ["cpu", "mem"])

    def test_a_blob_that_is_missing_or_unreadable_is_a_miss_and_a_failed_write_is_not_an_error(self):
        container = mock.Mock()
        blobs = history_store.BlobBuckets(container)
        table = [("missing", ResourceNotFoundError("x")), ("unreachable", ServiceRequestError("x"))]
        for label, error in table:
            with self.subTest(label):
                container.download_blob.side_effect = error
                self.assertEqual(history_store.HistoryStore(history_store.MemoryBuckets(), blobs).bucket("n", history_store.Tally()).pieces, {})
        container.download_blob.side_effect = None
        container.download_blob.return_value.readall.return_value = b"not json"
        self.assertEqual(history_store.HistoryStore(history_store.MemoryBuckets(), blobs).bucket("n", history_store.Tally()).pieces, {})
        container.download_blob.side_effect = ResourceNotFoundError("x")
        container.upload_blob.side_effect = ServiceRequestError("x")
        batch = history_store.Batch()
        batch.add(SCOPE, "states", "api", None, 0, history_store.AZURE, {0: {"transitions": []}})
        subject = history_store.HistoryStore(history_store.MemoryBuckets(), blobs)
        with self.assertLogs("ahm-demo", level="WARNING"):
            subject.write(batch)
            subject.flush()
        container.upload_blob.assert_called_once()
        self.assertEqual(container.upload_blob.call_args.kwargs, {"overwrite": False})
        self.assertIsNotNone(subject.piece(SCOPE, "states", 0, "api", None, 0, history_store.Tally()), "kept in memory all the same")

    def test_a_blob_asked_for_by_many_at_once_is_read_once(self):
        container = Container()
        gate = threading.Barrier(8)
        reads = []
        original = container.download_blob

        def slow(name):
            reads.append(name)
            return original(name)

        container.download_blob = slow
        subject = store(container)

        def ask():
            gate.wait()
            subject.bucket("x", history_store.Tally())

        threads = [threading.Thread(target=ask) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertLessEqual(len(reads), 2)
        subject.bucket("x", history_store.Tally())
        self.assertLessEqual(len(reads), 2, "a missing blob is remembered as empty")

    def test_a_read_that_began_before_a_write_does_not_put_the_older_blob_back(self):
        container = Container()
        name = history_store.bucket_name(SCOPE, "signal", 0, 0)
        container.blobs[name] = (history_store.Bucket().encode(), '"0"')
        subject = store(container)
        container.read_waits = threading.Event()
        held = container.read_waits
        reader = threading.Thread(target=lambda: subject.bucket(name, history_store.Tally()))
        reader.start()
        while not container.reads:
            time.sleep(0.001)

        subject.write(one_piece("cpu"))
        subject.flush()
        held.set()
        reader.join(2)

        found = subject.piece(SCOPE, "signal", 0, "api", "cpu", 0, history_store.Tally())
        self.assertIsNotNone(found, "the older version read before the write did not replace it")
        self.assertEqual(subject.bucket(name, history_store.Tally()).etag, container.blobs[name][1])

    def test_a_write_returns_before_the_blob_is_written_and_memory_serves_it_at_once(self):
        container = Container()
        container.uploads_wait = threading.Event()
        subject = store(container)
        name = history_store.bucket_name(SCOPE, "signal", 0, 0)
        subject.bucket(name, history_store.Tally())

        subject.write(one_piece("cpu"))

        self.assertIsNotNone(subject.piece(SCOPE, "signal", 0, "api", "cpu", 0, history_store.Tally()))
        self.assertFalse(subject.flush(0.05), "the blob is still being written")
        container.uploads_wait.set()
        self.assertTrue(subject.flush(2))
        self.assertEqual(container.writes, [name])

    def test_pieces_for_a_blob_that_waits_join_it_and_it_is_written_once_more(self):
        name = history_store.bucket_name(SCOPE, "signal", 0, 0)
        for later in (1, 3):
            with self.subTest(later=later):
                container = Container()
                container.uploads_wait = threading.Event()
                subject = store(container)
                subject.bucket(name, history_store.Tally())
                subject.write(one_piece("first"))
                while not container.active:
                    time.sleep(0.001)

                for index in range(later):
                    subject.write(one_piece(f"later{index}"))
                container.uploads_wait.set()
                subject.flush(2)

                self.assertEqual(len(container.writes), 2)
                self.assertEqual(sorted(container.pieces(name)["signal"]["api"]), sorted(["first", *(f"later{index}" for index in range(later))]))

    def test_beyond_the_blobs_that_may_wait_pieces_stay_in_memory_only(self):
        table = [("room for all", 1, 8, 5, 5), ("two may wait", 1, 2, 5, 3)]
        for label, workers, queue, blobs, written in table:
            with self.subTest(label):
                container = Container()
                container.uploads_wait = threading.Event()
                subject = store(container, workers=workers, queue=queue)
                names = [history_store.bucket_name(SCOPE, "signal", 0, day * DAY) for day in range(blobs)]
                for name in names:
                    subject.bucket(name, history_store.Tally())
                tally = history_store.Tally()

                subject.write(one_piece("cpu", 0), tally)
                while not container.active:
                    time.sleep(0.001)
                with self.assertLogs("ahm-demo", level="WARNING") if written < blobs else _quiet():
                    for day in range(1, blobs):
                        subject.write(one_piece("cpu", day * DAY), tally)
                container.uploads_wait.set()
                subject.flush(2)

                self.assertEqual((tally.counts()["written"], len(container.writes)), (written, written))
                self.assertTrue(all(subject.piece(SCOPE, "signal", 0, "api", "cpu", day * DAY, history_store.Tally()) for day in range(blobs)))

    def test_blobs_are_written_side_by_side_by_the_writers(self):
        for workers in (1, 3):
            with self.subTest(workers=workers):
                container = Container(upload_seconds=0.03)
                subject = store(container, workers=workers)
                for day in range(6):
                    subject.write(one_piece("cpu", day * DAY))
                subject.flush(5)

                self.assertEqual(len(container.writes), 6)
                self.assertLessEqual(container.peak, workers)
                self.assertEqual(container.peak > 1, workers > 1)

    def test_a_failed_listing_of_the_first_layout_is_asked_again_only_after_a_while(self):
        for label, later, listings in (("soon after", 10, 1), ("a minute later", 61, 2)):
            with self.subTest(label):
                container = Container()
                failures = [ServiceRequestError("down")]
                original = container.list_blobs

                def listing(name_starts_with, failures=failures, original=original):
                    if failures:
                        container.listings.append(name_starts_with)
                        raise failures.pop()
                    return original(name_starts_with)

                container.list_blobs = listing
                clock = SimpleNamespace(now=0.0)
                legacy = history_store.LegacyHistory(container, clock=lambda clock=clock: clock.now)
                with self.assertLogs("ahm-demo", level="WARNING"):
                    legacy.get(SCOPE, "signal", "api", "cpu", 0)
                clock.now += later
                legacy.get(SCOPE, "signal", "api", "cpu", 0)

                self.assertEqual(len([name for name in container.listings if name.startswith("history/v1")]), listings)


class _quiet:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Windowed(Recording):
    """A service that answers for the window asked: points of `data` inside startAt and endAt. It refuses a start more than
    30 days before its clock."""

    def __init__(self, entities, relationships, data, page_limit=1000):
        super().__init__(entities, relationships)
        self.data = data
        self.page_limit = page_limit
        self.now = lambda: NOW

    def serve(self, kind, name, signal, body):
        with self.lock:
            self.calls.append((kind, name, signal, dict(body)))
        failure = self.errors.get((kind, name, signal)) or self.errors.get(kind)
        error = failure() if callable(failure) else failure
        if error is not None:
            raise error
        if body.get("nextMarker"):
            offset, start, end = body["nextMarker"]
        else:
            offset, start, end = 0, body.get("startAt") or datetime.min.replace(tzinfo=timezone.utc), body.get("endAt") or datetime.max.replace(tzinfo=timezone.utc)
        rows = [row for row in self.data.get((kind, name, signal), []) if start <= row["occurredAt"] <= end]
        if body.get("startAt") and body["startAt"] < self.now() - timedelta(days=30):
            raise HttpResponseError(message="The value for startAt cannot be more than 30 days in the past.")
        newest_first = sorted(rows, key=lambda row: row["occurredAt"], reverse=True)
        more = offset + self.page_limit < len(newest_first)
        page = newest_first[offset : offset + self.page_limit]
        return {"entityName": name, "history": page, "annotations": [], "nextMarker": (offset + self.page_limit, start, end) if more else None}


def series(days=4, every_minutes=60):
    rows = []
    t = NOW - timedelta(days=days)
    while t <= NOW:
        rows.append({"occurredAt": t, "value": float((len(rows) * 7919) % 101), "healthState": "Healthy" if len(rows) % 7 else "Degraded"})
        t += timedelta(minutes=every_minutes)
    return rows


def backend(data=None, signals=("cpu",)):
    return Windowed([entity("root"), entity("api", list(signals))], [relationship("root", "api")], data or {("signal", "api", signal): series() for signal in signals})


def reader(history, clock=None):
    return timeline.TimelineReader(clock=clock or Clock(), now=lambda: NOW, history=history)


def signals(subject, source, hours=None, caller=None, resolution=0, to=None, start=None):
    begin = start or NOW - timedelta(hours=hours)
    params = {"include": "signals", "from": begin.isoformat(), "resolution": str(resolution), **({"to": to.isoformat()} if to else {})}
    return subject.read(caller or SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, params, ["api"])["series"][0]


def day_start(days_ago):
    return datetime.fromtimestamp(timeline.to_ms(NOW - timedelta(days=days_ago)) // DAY * DAY / 1000, tz=timezone.utc)


class ReaderCacheTests(unittest.TestCase):
    def test_closed_days_are_read_once_and_only_the_open_tail_is_read_again(self):
        source = backend()
        history = store()

        first = signals(reader(history), source, 72)
        reads = len(source.calls_of("signal"))
        second = signals(reader(history, Clock()), source, 72)

        self.assertEqual(first["points"], second["points"])
        self.assertTrue(first["complete"] and second["complete"])
        self.assertGreaterEqual(reads, 3)
        self.assertEqual(len(source.calls_of("signal")) - reads, 1, "one read of the tail")

    def test_a_window_back_to_the_retention_is_read_without_asking_for_more_than_the_service_keeps(self):
        source = backend({("signal", "api", "cpu"): series(days=30)})
        container = Container()

        history = store(container)
        result = signals(reader(history), source, 30 * 24 - 1)
        history.flush()

        starts = [int(start) for name in container.blobs for start in container.pieces(name)["signal"]["api"]["cpu"]]
        self.assertTrue(result["complete"])
        self.assertGreater(len(result["points"]), 600)
        self.assertGreaterEqual(min(starts), timeline.to_ms(NOW - timedelta(days=30)))

    def test_the_points_are_the_same_with_and_without_the_store_at_every_level(self):
        start, end = day_start(5), day_start(1)
        table = [("every point", 0), ("slots of 15 minutes", 900), ("slots of an hour", 3600), ("a slot no level keeps", 1800)]
        for label, resolution in table:
            with self.subTest(label):
                source = backend({("signal", "api", "cpu"): series(days=8, every_minutes=2)})
                plain = signals(timeline.TimelineReader(clock=Clock(), now=lambda: NOW), source, start=start, resolution=resolution, to=end)
                history = store()
                first = signals(reader(history), source, start=start, resolution=resolution, to=end)
                calls = len(source.calls)
                stored = signals(reader(history), source, start=start, resolution=resolution, to=end)

                self.assertEqual(plain["points"], first["points"])
                self.assertEqual(plain["points"], stored["points"])
                self.assertEqual(len(source.calls), calls, "a closed window comes from the store")

    def test_a_coarse_level_is_kept_for_every_day_read_at_any_level(self):
        source = backend()
        history = store()
        signals(reader(history), source, 72)
        calls = len(source.calls)

        for resolution in (900, 3600):
            with self.subTest(resolution=resolution):
                body = signals(reader(history), source, start=day_start(2), resolution=resolution, to=day_start(1))

                self.assertTrue(body["complete"])
        self.assertEqual(len(source.calls), calls)

    def test_nothing_outside_the_window_is_returned_from_a_bucket_that_reaches_beyond_it(self):
        source = backend()

        points = signals(reader(store()), source, 30)["points"]

        self.assertTrue(all(timeline.to_ms(NOW - timedelta(hours=30)) // 60_000 * 60_000 <= row[0] <= timeline.to_ms(NOW) for row in points))

    def test_a_restart_with_a_durable_layer_reads_no_closed_history_from_azure(self):
        container = Container()
        source = backend()
        first = store(container)
        signals(reader(first), source, 72)
        first.flush()
        calls = len(source.calls_of("signal"))

        signals(reader(store(container)), source, 72)

        self.assertEqual(len(source.calls_of("signal")) - calls, 1)

    def test_a_closed_tile_of_many_signals_is_one_blob_read_after_a_restart(self):
        names = [f"s{index}" for index in range(12)]
        source = backend(signals=names)
        container = Container()
        params = {"include": "signals", "from": day_start(2).isoformat(), "to": day_start(1).isoformat()}
        first = store(container)
        reader(first).read(SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, params, ["api"])
        first.flush()
        calls = len(source.calls)
        container.reads.clear()

        prepared = reader(store(container)).prepare(SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, params, ["api"])
        body = prepared.read()

        self.assertEqual(len(body["series"]), 12)
        self.assertEqual(len(source.calls), calls)
        self.assertEqual(container.reads, [history_store.bucket_name(SCOPE, "signal", 0, timeline.to_ms(day_start(2)))])
        self.assertEqual({key: prepared.tally.counts()[key] for key in ("azure_calls", "pieces_stored", "blob")}, {"azure_calls": 0, "pieces_stored": 12, "blob": 1})

    def test_a_day_that_could_not_be_read_in_full_is_not_kept_and_the_result_says_it_was_cut(self):
        many = [{"occurredAt": NOW - timedelta(days=2) + timedelta(seconds=i * 20), "value": 1.0, "healthState": "Healthy"} for i in range(4000)]
        source = Windowed([entity("root"), entity("api", ["cpu"])], [relationship("root", "api")], {("signal", "api", "cpu"): many}, page_limit=500)
        memory = history_store.MemoryBuckets()

        with mock.patch.object(timeline, "TIMELINE_SIGNAL_PAGES", 1):
            result = signals(reader(store(memory=memory)), source, 72)

        self.assertFalse(result["complete"])
        self.assertEqual(memory.size, 0)
        self.assertIsNotNone(result["earliest"])

    def test_closed_history_is_not_shared_between_models(self):
        source = backend()
        history = store()
        signals(reader(history), source, 72)
        calls = len(source.calls_of("signal"))

        other = timeline.TimelineReader(clock=Clock(), now=lambda: NOW, history=history)
        other.read(SimpleNamespace(oid="ada", owner="ada"), source, ("sub", "rg", "other"), {"include": "signals", "from": (NOW - timedelta(hours=72)).isoformat()}, ["api"])

        self.assertGreater(len(source.calls_of("signal")), calls + 1)

    def test_the_states_of_an_entity_are_kept_by_week_in_the_same_way(self):
        rows = [{"occurredAt": NOW - timedelta(days=d), "previousState": "Healthy", "newState": "Degraded"} for d in (1, 2, 3)]
        source = backend({("states", "api", None): rows})
        history = store()
        params = {"include": "states", "from": (NOW - timedelta(days=5)).isoformat()}

        first = reader(history).read(SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, params, ["api"])
        calls = len(source.calls_of("states"))
        second = reader(history, Clock()).read(SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, params, ["api"])

        self.assertEqual(first["states"][0]["transitions"], second["states"][0]["transitions"])
        self.assertEqual(len(first["states"][0]["transitions"]), 3)
        self.assertEqual(len(source.calls_of("states")) - calls, 1)

    def test_the_first_layout_is_read_where_the_new_one_has_nothing_and_moved_into_it(self):
        source = backend()
        container = Container()
        day = timeline.to_ms(day_start(2))
        kept = {"points": [[day + 60_000, 42.0, 1], [day + DAY, 7.0, 1]], "reports": []}
        container.blobs[history_store.legacy_name(SCOPE, "signal", "api", "cpu", day)] = (json.dumps(kept).encode(), '"0"')

        first = store(container, legacy=container)
        body = signals(reader(first), source, start=day_start(2), resolution=900, to=day_start(1))
        first.flush()
        moved = signals(reader(store(container)), source, start=day_start(2), resolution=900, to=day_start(1))

        self.assertEqual(body["points"], [[day + 60_000, 42.0, 1]])
        self.assertEqual(moved["points"], body["points"])
        self.assertEqual(source.calls_of("signal"), [])
        self.assertEqual(len(container.listings), 1)

    def test_what_a_hub_recorded_is_served_and_never_replaces_what_azure_gave(self):
        source = backend()
        recorded_day, azure_day = timeline.to_ms(day_start(2)), timeline.to_ms(day_start(3))
        recording = {"points": [[recorded_day + 60_000, 1.0, 1]], "reports": []}
        history = store()

        reader(history).keep(SCOPE, [("signal", "api", "cpu", recorded_day, recording)])
        served = signals(reader(history), source, start=day_start(2), to=day_start(1))
        from_azure = signals(reader(history), source, start=day_start(3), to=day_start(2))
        reader(history).keep(SCOPE, [("signal", "api", "cpu", azure_day, {"points": [[azure_day, 0.0, 0]], "reports": []})])
        again = signals(reader(history), source, start=day_start(3), to=day_start(2))

        self.assertEqual(served["points"], recording["points"])
        self.assertEqual(len(source.calls_of("signal")), 1, "only the day nobody recorded was read")
        self.assertGreater(len(from_azure["points"]), 1)
        self.assertEqual(again["points"], from_azure["points"])


class LargeModelTests(unittest.TestCase):
    """The overview of a model: the states and annotations of every entity for the 30 days the service keeps."""

    def source(self, count):
        return Windowed([entity(f"e{index}") for index in range(count)], [], {})

    def tiles(self):
        now_ms = timeline.to_ms(NOW)
        first = (now_ms - 30 * DAY) // WEEK * WEEK
        return [(start, start + WEEK) for start in range(first, now_ms, WEEK)]

    def test_a_month_of_sixty_entities_is_cut_in_one_request_and_complete_week_by_week(self):
        caller = SimpleNamespace(oid="ada", owner="ada")
        table = [("a model of 20 entities fits one request", 20, False), ("a model of 60 entities does not", 60, True)]
        for label, count, cut in table:
            with self.subTest(label):
                source = self.source(count)
                params = {"include": "states,annotations", "from": (NOW - timedelta(days=30)).isoformat()}

                whole = reader(store()).read(caller, source, SCOPE, params)

                self.assertEqual(whole["partial"], cut)
                self.assertLessEqual(len(source.calls), timeline.TIMELINE_MAX_CALLS)

        source = self.source(60)
        subject = reader(store())
        for start, end in self.tiles():
            with self.subTest(tile=timeline.iso_ms(start)):
                before = len(source.calls)

                body = subject.read(caller, source, SCOPE, {"include": "states,annotations", "from": timeline.iso_ms(start), "to": timeline.iso_ms(end)})

                self.assertFalse(body["partial"])
                self.assertEqual((len(body["states"]), all(item["complete"] for item in body["states"]), body["failures"]), (60, True, []))
                self.assertEqual(len(source.calls) - before, 120, "one read per entity and part")

    def test_a_week_that_was_read_costs_the_next_viewer_no_call(self):
        source = self.source(60)
        history = store()
        start, end = self.tiles()[2]
        params = {"include": "states,annotations", "from": timeline.iso_ms(start), "to": timeline.iso_ms(end)}
        reader(history).read(SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, params)
        calls = len(source.calls)

        body = reader(history, Clock()).read(SimpleNamespace(oid="bob", owner="bob"), source, SCOPE, params)

        self.assertEqual((len(source.calls) - calls, body["partial"]), (0, False))


class StructureFromTheHubTests(unittest.TestCase):
    def test_a_warm_hub_supplies_the_structure_and_no_entity_list_is_read(self):
        source = backend()
        listings = []
        source.entities.list_by_health_model = lambda *a: listings.append(1) or list(source.items)
        structure = timeline.build_structure(source.items, source.links, "hm")
        subject = timeline.TimelineReader(clock=Clock(), now=lambda: NOW, structure=lambda selection: structure)

        body = subject.read(SimpleNamespace(oid="ada", owner="ada"), source, SCOPE, {"include": "structure,states", "from": (NOW - timedelta(hours=1)).isoformat()}, [])

        self.assertEqual(listings, [])
        self.assertEqual([item["name"] for item in body["entities"]], ["root", "api"])


if __name__ == "__main__":
    unittest.main()
