import inspect
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from azure.core.exceptions import HttpResponseError
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import history_store  # noqa: E402
import test_sessions_api as base  # noqa: E402
import timeline  # noqa: E402

NOW = datetime(2026, 11, 11, 12, 0, 7, tzinfo=timezone.utc)
HOUR = timedelta(hours=1)
CALLER = SimpleNamespace(oid="ada", owner="ada")
OTHER = SimpleNamespace(oid="bob", owner="bob")
SELECTION = ("sub", "rg", "hm")
RULES = {"degradedRule": {"operator": "GreaterThan", "threshold": 1}, "unhealthyRule": {"operator": "GreaterThan", "threshold": 5}}


def stamp(minutes_ago):
    return NOW - timedelta(minutes=minutes_ago)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def azure_error(status):
    error = HttpResponseError(message="SECRET_AZURE_BODY")
    error.status_code = status
    return error


def entity(name, signals=(), state="Healthy"):
    return {
        "name": name,
        "properties": {
            "displayName": name.title(),
            "healthState": state,
            "signalGroups": {
                "azureResource": {"signals": [{"name": s, "displayName": s.upper(), "signalKind": "AzureResourceMetric", "evaluationRules": RULES} for s in signals]}
            },
        },
    }


def relationship(parent, child):
    return {"name": f"{parent}-{child}", "properties": {"parentEntityName": parent, "childEntityName": child}}


def point(minutes_ago, value, state="Healthy"):
    return {"occurredAt": stamp(minutes_ago), "value": value, "healthState": state}


class Recording:
    """A CloudHealth client that records every history call and serves scripted pages: `pages[(kind, entity, signal)]`."""

    def __init__(self, entities, relationships=(), pages=None, errors=None, delay=0.0):
        self.items = entities
        self.links = list(relationships)
        self.pages = pages or {}
        self.errors = errors or {}
        self.delay = delay
        self.calls = []
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()
        self.entities = SimpleNamespace(
            list_by_health_model=lambda group, model: list(self.items),
            get_history=lambda group, model, name, body: self.serve("states", name, None, body),
            get_signal_history=lambda group, model, name, body: self.serve("signal", name, body["signalName"], body),
            get_data_annotations=lambda group, model, name, body: self.serve("annotations", name, None, body),
        )
        self.relationships = SimpleNamespace(list_by_health_model=lambda group, model: list(self.links))

    def serve(self, kind, name, signal, body):
        with self.lock:
            self.calls.append((kind, name, signal, dict(body)))
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            time.sleep(self.delay)
            if (kind, name, signal) in self.errors:
                raise self.errors[(kind, name, signal)]
            pages = self.pages.get((kind, name, signal), [{}])
            marker = body.get("nextMarker")
            page = dict(pages[int(marker[1:]) if marker else 0])
            if marker is None and len(pages) > 1 or marker and int(marker[1:]) + 1 < len(pages):
                page["nextMarker"] = f"m{int(marker[1:]) + 1 if marker else 1}"
            return {
                "entityName": name,
                "history": page.get("history", []),
                "annotations": page.get("annotations", []),
                "nextMarker": page.get("nextMarker"),
            }
        finally:
            with self.lock:
                self.active -= 1

    def calls_of(self, kind):
        return [call for call in self.calls if call[0] == kind]

    def client(self, subscription):
        return self


def reader(now=NOW, clock=None):
    return timeline.TimelineReader(clock=clock or time.monotonic, now=lambda: now)


def read(subject, backend, params=None, names=(), caller=CALLER):
    return subject.read(caller, backend, SELECTION, {"from": (NOW - HOUR).isoformat(), **(params or {})}, names)


def model(**kwargs):
    return Recording([entity("root"), entity("api", ["errors", "latency"]), entity("db", ["cpu"])], [relationship("root", "api"), relationship("api", "db")], **kwargs)


class QueryTests(unittest.TestCase):
    def test_a_query_becomes_a_window_inside_the_last_30_days(self):
        floor = NOW - timedelta(days=30) + timeline.RETENTION_MARGIN
        table = [
            ("defaults to the last 24 hours", {}, NOW - 24 * HOUR, NOW),
            ("keeps what is asked", {"from": "2026-11-10T00:00:00Z", "to": "2026-11-10T06:00:00Z"}, datetime(2026, 11, 10, tzinfo=timezone.utc), datetime(2026, 11, 10, 6, tzinfo=timezone.utc)),
            ("clamps the future to now", {"from": "2026-11-11T10:00:00Z", "to": "2027-01-01T00:00:00Z"}, datetime(2026, 11, 11, 10, tzinfo=timezone.utc), NOW),
            ("clamps the past to the retention", {"from": "2025-01-01T00:00:00Z"}, floor, NOW),
            ("reads a time without a zone as UTC", {"from": "2026-11-11T09:00:00"}, datetime(2026, 11, 11, 9, tzinfo=timezone.utc), NOW),
            ("reads a zone offset", {"from": "2026-11-11T10:00:00+02:00"}, datetime(2026, 11, 11, 8, tzinfo=timezone.utc), NOW),
        ]
        for label, params, start, end in table:
            with self.subTest(label):
                query = timeline.parse_query(params, NOW)

                self.assertEqual((query["start"], query["end"]), (start, end))
                self.assertEqual(query["parts"], timeline.DEFAULT_PARTS)

    def test_a_bad_query_is_refused_with_its_code(self):
        table = [
            ("an unknown key", {"top": "5"}, "unsupported_query"),
            ("an unknown part", {"include": "states,bananas"}, "invalid_include"),
            ("an empty include", {"include": ","}, "invalid_include"),
            ("a word as resolution", {"resolution": "fine"}, "invalid_resolution"),
            ("a negative resolution", {"resolution": "-1"}, "invalid_resolution"),
            ("a huge resolution", {"resolution": "86401"}, "invalid_resolution"),
            ("a time that is not a time", {"from": "yesterday"}, "invalid_range"),
            ("less than a minute", {"from": "2026-11-11T11:59:30Z"}, "invalid_range"),
            ("a reversed range", {"from": "2026-11-11T11:00:00Z", "to": "2026-11-11T10:00:00Z"}, "invalid_range"),
            ("a range that ended before the retention", {"from": "2025-01-01T00:00:00Z", "to": "2025-01-02T00:00:00Z"}, "invalid_range"),
        ]
        for label, params, code in table:
            with self.subTest(label):
                with self.assertRaises(timeline.TimelineRequestError) as raised:
                    timeline.parse_query(params, NOW)

                self.assertEqual(raised.exception.code, code)

    def test_the_selector_is_not_a_timeline_parameter_but_is_allowed(self):
        query = timeline.parse_query({"model": "m", "resourceGroup": "g", "subscription": "s", "include": "signals", "resolution": "60"}, NOW)

        self.assertEqual((query["parts"], query["resolution"]), (("signals",), 60))

    def test_snapping_widens_the_window_to_a_grid_that_depends_on_its_span(self):
        floor = NOW - timedelta(days=30)
        table = [
            ("a minute grid for a short span", NOW - HOUR, NOW - 20 * timedelta(minutes=1), 60),
            ("five minutes for a day", NOW - 24 * HOUR, NOW - 12 * HOUR, 300),
            ("a quarter hour for weeks", NOW - timedelta(days=20), NOW - timedelta(days=10), 900),
        ]
        for label, start, end, quantum in table:
            with self.subTest(label):
                window = timeline.snap_window(start, end, NOW, floor)

                self.assertEqual(window["from"] % (quantum * 1000), 0)
                self.assertEqual(window["to"] % (quantum * 1000), 0)
                self.assertLessEqual(window["from"], timeline.to_ms(start))
                self.assertGreaterEqual(window["to"], timeline.to_ms(end))
                self.assertLess(window["to"] - timeline.to_ms(end), quantum * 1000)
                self.assertFalse(window["live"])

    def test_a_window_that_reaches_now_is_live_and_leaves_its_end_open(self):
        window = timeline.snap_window(NOW - HOUR, NOW, NOW, NOW - timedelta(days=30))

        self.assertEqual((window["live"], window["to"]), (True, None))

    def test_snapping_never_goes_before_the_retention_floor(self):
        floor = NOW - timedelta(days=30) + timeline.RETENTION_MARGIN
        window = timeline.snap_window(floor, NOW, NOW, floor)

        self.assertEqual(window["from"], timeline.to_ms(floor))


class RowTests(unittest.TestCase):
    def test_decimating_keeps_real_points_that_stay_evenly_spaced_with_both_extremes_and_the_worst_state(self):
        step = 60_000
        ramp = [[index * 5000, float(index), 1] for index in range(12)]
        table = [
            ("no step keeps everything", 0, [[0, 1, 1], [1000, 2, 1]], [[0, 1, 1], [1000, 2, 1]]),
            ("a slot of five points is kept whole", step, [[index, index, 1] for index in range(5)], [[index, index, 1] for index in range(5)]),
            ("a ramp keeps its first point, the last of each half and its top", step, ramp, [ramp[0], ramp[5], ramp[11]]),
            (
                "the lowest and the highest value are kept where they are",
                step,
                [[0, 5, 1], [10_000, 9, 1], [20_000, 1, 1], [29_000, 4, 1], [40_000, 5, 1], [59_000, 6, 1]],
                [[10_000, 9, 1], [20_000, 1, 1], [29_000, 4, 1], [59_000, 6, 1]],
            ),
            (
                "a worse state than any kept point is kept too",
                step,
                [[0, 5, 1], [10_000, 5, 3], [20_000, 5, 1], [29_000, 5, 1], [40_000, 5, 1], [59_000, 5, 1]],
                [[0, 5, 1], [10_000, 5, 3], [29_000, 5, 1], [59_000, 5, 1]],
            ),
            (
                "a gap in the data outranks healthy points",
                step,
                [[0, 5, 1], [10_000, None, 0], [20_000, 5, 1], [29_000, 5, 1], [40_000, 5, 1], [59_000, 5, 1]],
                [[0, 5, 1], [10_000, None, 0], [29_000, 5, 1], [59_000, 5, 1]],
            ),
            ("a slot of gaps keeps the last of each half", step, [[index * 10_000, None, 0] for index in range(6)], [[20_000, None, 0], [50_000, None, 0]]),
            ("slots stay separate", step, [[0, 1, 1], [step, 2, 1]], [[0, 1, 1], [step, 2, 1]]),
        ]
        for label, size, points, expected in table:
            with self.subTest(label):
                self.assertEqual(timeline.decimate(points, size), expected)

    def test_decimated_points_are_never_further_apart_than_half_a_slot_of_regular_data(self):
        table = [("one minute apart", 60_000), ("five minutes apart", 300_000)]
        for label, every in table:
            with self.subTest(label):
                points = [[index * every, float((index * 7919) % 101), 1] for index in range(24 * 3600_000 // every)]

                kept = timeline.decimate(points, 3600_000)

                self.assertLessEqual(max(b[0] - a[0] for a, b in zip(kept, kept[1:])), 1800_000)
                self.assertLessEqual(len(kept), 5 * 24)
                self.assertEqual((max(row[1] for row in kept), min(row[1] for row in kept)), (max(row[1] for row in points), min(row[1] for row in points)))

    def test_a_validator_names_a_closed_window_without_the_structure_and_nothing_else(self):
        now_ms = timeline.to_ms(NOW)
        closed = {"from": now_ms - 7_200_000, "to": now_ms - 3_600_000, "live": False}
        query = {"parts": ("signals",), "resolution": 0, "asked": ("a", "b"), "only": frozenset()}
        jobs = [("signal", "db", "cpu")]
        scope = ("sub", "rg", "hm")
        limit = now_ms - 900_000
        base_tag = timeline.validator(scope, query, closed, jobs, limit)
        table = [
            ("a closed window has one", query, closed, jobs, True),
            ("an open window has none", query, {**closed, "to": None, "live": True}, jobs, False),
            ("a window inside the safety margin has none", query, {**closed, "to": limit + 1}, jobs, False),
            ("an answer with the structure has none", {**query, "parts": ("structure", "signals")}, closed, jobs, False),
            ("an answer that reads nothing has none", query, closed, [], False),
        ]
        for label, asked, window, wanted, expected in table:
            with self.subTest(label):
                self.assertEqual(timeline.validator(scope, asked, window, wanted, limit) is not None, expected)
        different = [
            ("another model", (("sub", "rg", "other"), query, closed, jobs)),
            ("another window", (scope, query, {**closed, "from": closed["from"] - 1}, jobs)),
            ("another resolution", (scope, {**query, "resolution": 900}, closed, jobs)),
            ("another signal", (scope, query, closed, [("signal", "db", "memory")])),
            ("a narrowed request", (scope, {**query, "only": frozenset({"cpu"})}, closed, jobs)),
        ]
        for label, arguments in different:
            with self.subTest(label):
                self.assertNotEqual(timeline.validator(*arguments, limit), base_tag)
        self.assertEqual(timeline.validator(scope, query, closed, jobs, limit), base_tag)

    def test_if_none_match_is_read_as_a_list_of_strong_or_weak_names(self):
        table = [
            ("the same name", '"abc"', True),
            ("a weak name", 'W/"abc"', True),
            ("one of several", '"x", W/"abc"', True),
            ("any", "*", True),
            ("another name", '"abd"', False),
            ("no header", None, False),
        ]
        for label, header, expected in table:
            with self.subTest(label):
                self.assertEqual(timeline.matches(header, '"abc"'), expected)
        self.assertFalse(timeline.matches('"abc"', None))

    def test_a_service_item_becomes_a_compact_row(self):
        report = {"occurredAt": stamp(5), "value": 0.5, "healthState": "Degraded", "additionalContext": '{"source": "health-pulse-web", "reportId": "r1", "reason": "Maintenance"}'}
        table = [
            ("transition", timeline.transition_row({"occurredAt": stamp(1), "previousState": "Healthy", "newState": "Unhealthy", "reason": "SignalTransition"}), {"t": timeline.to_ms(stamp(1)), "from": 1, "to": 3, "reason": "SignalTransition"}),
            ("point", timeline.point_row(point(2, 3.5, "Degraded")), [timeline.to_ms(stamp(2)), 3.5, 2]),
            ("point without a value", timeline.point_row({"occurredAt": stamp(2), "healthState": "Unknown"}), [timeline.to_ms(stamp(2)), None, 0]),
            ("report", timeline.report_row(report), {"t": timeline.to_ms(stamp(5)), "state": 2, "value": 0.5, "reason": "Maintenance", "reportId": "r1"}),
            ("a point from another submitter is no report", timeline.report_row(point(5, 1)), None),
            ("annotation", timeline.annotation_row({"annotationId": "a1", "createdAt": stamp(9), "description": "Deploy", "annotationDetails": {"k": "v"}}), {"id": "a1", "t": timeline.to_ms(stamp(9)), "description": "Deploy", "details": {"k": "v"}}),
            ("annotation without a time", timeline.annotation_row({"annotationId": "a2", "annotationDetails": {}}), None),
        ]
        for label, actual, expected in table:
            with self.subTest(label):
                self.assertEqual(actual, expected)

    def test_a_signal_catalog_carries_the_thresholds_and_the_kind(self):
        catalog = timeline.signal_catalog(entity("api", ["errors"]))

        self.assertEqual(
            catalog,
            [
                {
                    "name": "errors",
                    "displayName": "ERRORS",
                    "kind": "AzureResourceMetric",
                    "unit": None,
                    "refreshInterval": None,
                    "rules": {
                        "degraded": {"operator": "GreaterThan", "threshold": 1},
                        "unhealthy": {"operator": "GreaterThan", "threshold": 5},
                        "dynamic": False,
                    },
                }
            ],
        )

    def test_a_dynamic_threshold_is_flagged_without_numbers(self):
        raw = entity("api", ["errors"])
        raw["properties"]["signalGroups"]["azureResource"]["signals"][0]["evaluationRules"] = {"dynamicDetectionRule": {"modelType": "AnomalyDetection"}}

        rules = timeline.signal_catalog(raw)[0]["rules"]

        self.assertEqual(rules, {"degraded": None, "unhealthy": None, "dynamic": True})

    def test_an_error_maps_to_a_code_without_the_azure_text(self):
        table = [(401, "forbidden", False), (403, "forbidden", False), (404, "not_found", False), (429, "busy", True), (500, "unavailable", True), (None, "unavailable", True)]
        for status, code, retryable in table:
            with self.subTest(status=status):
                shown = timeline.series_error(azure_error(status))

                self.assertEqual((shown["code"], shown["retryable"]), (code, retryable))
                self.assertNotIn("SECRET", str(shown))


class ReaderTests(unittest.TestCase):
    def test_every_part_is_read_once_per_entity_and_signal(self):
        backend = model()

        body = read(reader(), backend, {"include": "structure,states,annotations,signals"})

        self.assertEqual([item["entity"] for item in body["states"]], ["root", "api", "db"])
        self.assertEqual([(item["entity"], item["signal"]) for item in body["series"]], [("api", "errors"), ("api", "latency"), ("db", "cpu")])
        self.assertEqual((len(backend.calls_of("states")), len(backend.calls_of("annotations")), len(backend.calls_of("signal"))), (3, 3, 3))
        self.assertEqual([item["name"] for item in body["entities"]], ["root", "api", "db"])
        self.assertEqual(body["entities"][2]["parents"], ["api"])

    def test_the_default_parts_do_not_read_signals(self):
        backend = model()

        body = read(reader(), backend)

        self.assertEqual(backend.calls_of("signal"), [])
        self.assertEqual(body["series"], [])
        self.assertEqual(len(body["entities"]), 3)

    def test_the_structure_comes_only_when_it_is_asked_for(self):
        table = [("by default", {}, 3), ("named", {"include": "structure"}, 3), ("with other parts", {"include": "structure,signals"}, 3), ("left out", {"include": "states,signals"}, 0)]
        for label, params, expected in table:
            with self.subTest(label):
                self.assertEqual(len(read(reader(), model(), params)["entities"]), expected)

    def test_the_structure_alone_reads_no_history(self):
        backend = model()

        read(reader(), backend, {"include": "structure"})

        self.assertEqual(backend.calls, [])

    def test_signal_names_narrow_the_series_of_the_entities_asked_for(self):
        table = [
            ("no name reads every signal", (), [("api", "errors"), ("api", "latency"), ("db", "cpu")]),
            ("one name", ("latency",), [("api", "latency")]),
            ("names of several entities", ("errors", "cpu"), [("api", "errors"), ("db", "cpu")]),
            ("a name nothing has", ("nope",), []),
        ]
        for label, signals, expected in table:
            with self.subTest(label):
                backend = model()

                body = reader().read(CALLER, backend, SELECTION, {"from": (NOW - HOUR).isoformat(), "include": "signals"}, (), signals)

                self.assertEqual([(item["entity"], item["signal"]) for item in body["series"]], expected)
                self.assertEqual(len(backend.calls_of("signal")), len(expected))

    def test_a_service_page_is_followed_by_its_marker_without_the_window(self):
        first = {"history": [point(1, 9.0, "Unhealthy"), point(2, 8.0, "Unhealthy")]}
        second = {"history": [point(3, 1.0), point(4, 0.5)]}
        backend = model(pages={("signal", "db", "cpu"): [first, second]})

        body = read(reader(), backend, {"include": "signals"}, ["db"])

        calls = backend.calls_of("signal")
        self.assertEqual(len(calls), 2)
        self.assertEqual(set(calls[0][3]), {"signalName", "startAt"})
        self.assertEqual(calls[1][3], {"nextMarker": "m1", "signalName": "cpu"})
        series = body["series"][0]
        self.assertEqual([row[1] for row in series["points"]], [0.5, 1.0, 8.0, 9.0])
        self.assertEqual((series["complete"], series["earliest"]), (True, timeline.to_ms(stamp(4))))

    def test_a_series_longer_than_the_page_budget_is_cut_at_the_old_end_and_says_so(self):
        pages = [{"history": [point(index, 1.0)]} for index in range(timeline.TIMELINE_SIGNAL_PAGES + 3)]
        backend = model(pages={("signal", "db", "cpu"): pages})

        body = read(reader(), backend, {"include": "signals"}, ["db"])

        series = body["series"][0]
        self.assertEqual(len(backend.calls_of("signal")), timeline.TIMELINE_SIGNAL_PAGES)
        self.assertEqual((len(series["points"]), series["complete"]), (timeline.TIMELINE_SIGNAL_PAGES, False))
        self.assertTrue(body["partial"])

    def test_one_failing_history_is_reported_in_its_series_and_the_rest_comes_back(self):
        backend = model(errors={("signal", "api", "latency"): azure_error(500), ("annotations", "db", None): azure_error(403)})

        body = read(reader(), backend, {"include": "states,annotations,signals"})

        failed = [item for item in body["series"] if "error" in item]
        self.assertEqual([(item["entity"], item["signal"], item["error"]["code"], item["points"]) for item in failed], [("api", "latency", "unavailable", [])])
        self.assertEqual([item["entity"] for item in body["series"] if "error" not in item], ["api", "db"])
        self.assertEqual(body["failures"], [{"entity": "db", "part": "annotations", "error": {"code": "forbidden", "message": "Your account cannot read this history.", "retryable": False}}])
        self.assertTrue(body["partial"])
        self.assertEqual(len(body["states"]), 3)

    def test_when_every_history_fails_the_azure_error_is_raised_for_the_route_to_map(self):
        backend = model(errors={("states", name, None): azure_error(403) for name in ("root", "api", "db")})

        with self.assertRaises(HttpResponseError) as raised:
            read(reader(), backend, {"include": "states"})

        self.assertEqual(raised.exception.status_code, 403)

    def test_health_reports_come_from_the_report_signal_only_where_it_exists(self):
        context = '{"source": "health-pulse-web", "reportId": "r9", "reason": "Planned"}'
        backend = Recording(
            [entity("root"), entity("api", ["web-ui-health-report", "errors"])],
            [relationship("root", "api")],
            pages={("signal", "api", "web-ui-health-report"): [{"history": [{**point(10, 0.5, "Degraded"), "additionalContext": context}]}]},
        )

        body = read(reader(), backend)

        self.assertEqual([call[:3] for call in backend.calls_of("signal")], [("signal", "api", "web-ui-health-report")])
        self.assertEqual(body["reports"], [{"entity": "api", "t": timeline.to_ms(stamp(10)), "state": 2, "value": 0.5, "reason": "Planned", "reportId": "r9"}])
        self.assertEqual(body["series"], [])

    def test_annotations_follow_their_pages(self):
        notes = [{"annotationId": f"a{i}", "createdAt": stamp(i + 1), "description": f"n{i}", "annotationDetails": {}} for i in range(3)]
        backend = model(pages={("annotations", "api", None): [{"annotations": notes[:2]}, {"annotations": notes[2:]}]})

        body = read(reader(), backend, {"include": "annotations"}, ["api"])

        self.assertEqual([item["id"] for item in body["annotations"]], ["a2", "a1", "a0"])
        self.assertEqual(backend.calls_of("annotations")[0][3]["top"], timeline.TIMELINE_ANNOTATION_PAGE_SIZE)
        self.assertNotIn("top", backend.calls_of("annotations")[1][3])

    def test_transitions_are_sorted_oldest_first(self):
        history = [{"occurredAt": stamp(1), "previousState": "Healthy", "newState": "Degraded"}, {"occurredAt": stamp(30), "previousState": "Unknown", "newState": "Healthy"}]
        backend = model(pages={("states", "api", None): [{"history": history}]})

        body = read(reader(), backend, {"include": "states"}, ["api"])

        self.assertEqual([(row["from"], row["to"]) for row in body["states"][0]["transitions"]], [(0, 1), (1, 2)])

    def test_the_window_in_the_response_is_the_snapped_one_and_a_live_window_has_no_end(self):
        backend = model()

        live = read(reader(), backend, {"include": "states"}, ["api"])
        past = read(reader(), backend, {"include": "states", "to": "2026-11-11T10:30:00Z", "from": "2026-11-11T10:03:00Z"}, ["api"])

        self.assertEqual(live["range"]["to"], "2026-11-11T12:00:07.000Z")
        self.assertNotIn("endAt", backend.calls_of("states")[0][3])
        self.assertEqual(past["range"], {"from": "2026-11-11T10:03:00.000Z", "to": "2026-11-11T10:30:00.000Z"})
        self.assertIn("endAt", backend.calls_of("states")[1][3])

    def test_a_resolution_thins_the_series_but_not_the_states(self):
        dense = [point(index / 10, float(index % 7)) for index in range(300)]
        backend = model(pages={("signal", "db", "cpu"): [{"history": dense}]})

        raw = read(reader(), backend, {"include": "signals"}, ["db"])["series"][0]["points"]
        thin = read(reader(), backend, {"include": "signals", "resolution": "600"}, ["db"])["series"][0]["points"]

        self.assertEqual(len(raw), 300)
        self.assertLess(len(thin), 60)
        self.assertEqual((max(row[1] for row in thin), min(row[1] for row in thin)), (6.0, 0.0))

    def test_a_second_identical_request_costs_no_azure_call(self):
        backend = model()
        subject = reader()

        read(subject, backend, {"include": "states,signals"})
        calls = len(backend.calls)
        read(subject, backend, {"include": "states,signals"})

        self.assertEqual(len(backend.calls), calls)

    def test_a_cached_history_belongs_to_the_user_who_read_it(self):
        backend = model()
        subject = reader()

        read(subject, backend, {"include": "states"})
        read(subject, backend, {"include": "states"}, caller=OTHER)

        self.assertEqual(len(backend.calls_of("states")), 6)

    def test_a_live_history_is_cached_for_less_time_than_a_closed_one(self):
        table = [("live", {}, timeline.TIMELINE_LIVE_CACHE_SECONDS), ("closed", {"to": "2026-11-11T10:00:00Z", "from": "2026-11-11T08:00:00Z"}, timeline.TIMELINE_PAST_CACHE_SECONDS)]
        for label, params, seconds in table:
            with self.subTest(label):
                backend = model()
                clock = Clock()
                subject = reader(clock=clock)
                read(subject, backend, {"include": "states", **params}, ["api"])

                clock.now += seconds - 1
                read(subject, backend, {"include": "states", **params}, ["api"])
                self.assertEqual(len(backend.calls_of("states")), 1)

                clock.now += 2
                read(subject, backend, {"include": "states", **params}, ["api"])
                self.assertEqual(len(backend.calls_of("states")), 2)

    def test_a_failed_history_is_not_cached(self):
        backend = model(errors={("states", "api", None): azure_error(500)})
        subject = reader()

        read(subject, backend, {"include": "states"}, ["api", "db"])
        backend.errors.clear()
        body = read(subject, backend, {"include": "states"}, ["api", "db"])

        self.assertEqual([("error" in item) for item in body["states"]], [False, False])
        self.assertEqual(len(backend.calls_of("states")), 3)

    def test_azure_is_never_called_by_more_than_the_concurrency_cap_at_once(self):
        names = [f"e{i}" for i in range(30)]
        backend = Recording([entity("root")] + [entity(name, ["cpu"]) for name in names], delay=0.01)

        read(reader(), backend, {"include": "states,signals"})

        self.assertGreater(backend.peak, 1)
        self.assertLessEqual(backend.peak, timeline.TIMELINE_CALL_CONCURRENCY)

    def test_too_many_signals_in_one_request_are_refused_before_any_history_call(self):
        backend = Recording([entity("root")] + [entity(f"e{i}", ["a", "b"]) for i in range(timeline.TIMELINE_MAX_SERIES)])

        with self.assertRaises(timeline.TimelineRequestError) as raised:
            read(reader(), backend, {"include": "signals"})

        self.assertEqual(raised.exception.code, "too_many_series")
        self.assertEqual(backend.calls, [])

    def test_an_unknown_entity_is_refused(self):
        with self.assertRaises(timeline.TimelineRequestError) as raised:
            read(reader(), model(), {}, ["nope"])

        self.assertEqual(raised.exception.code, "unknown_entity")

    def test_an_unknown_entity_among_known_ones_is_reported_by_itself_and_the_known_ones_are_read(self):
        gone = {"code": "unknown_entity", "message": "This entity is not in the Health Model.", "retryable": False}
        table = [
            ("states", "states", {"states": [("api", None), ("db", None), ("ghost", gone)], "failures": []}),
            ("annotations", "annotations", {"states": [], "failures": [("ghost", "annotations", gone)]}),
            ("reports", "reports", {"states": [], "failures": [("ghost", "reports", gone)]}),
            ("signals", "signals", {"states": [], "failures": []}),
        ]
        for label, include, expected in table:
            with self.subTest(label):
                backend = model()

                body = read(reader(), backend, {"include": include}, ["api", "ghost", "db"])

                self.assertEqual([(item["entity"], item.get("error")) for item in body["states"]], expected["states"])
                self.assertEqual([(item["entity"], item["part"], item["error"]) for item in body["failures"]], expected["failures"])
                self.assertTrue(body["partial"])
                self.assertNotIn("ghost", [call[1] for call in backend.calls])
        self.assertEqual({item["entity"] for item in read(reader(), model(), {"include": "signals"}, ["api", "ghost"])["series"]}, {"api"})

    def test_an_unknown_entity_is_never_a_closed_answer_the_browser_may_keep(self):
        subject = reader()
        params = {"include": "states", "from": (NOW - 72 * HOUR).isoformat(), "to": (NOW - 48 * HOUR).isoformat()}
        for names in (["api"], ["api", "ghost"]):
            with self.subTest(names=names):
                prepared = subject.prepare(CALLER, model(), SELECTION, params, names)

                self.assertEqual(prepared.etag is None, "ghost" in names)

    def test_a_request_that_needs_more_calls_than_the_budget_reports_the_rest_per_series(self):
        backend = model()

        with mock.patch.object(timeline, "TIMELINE_MAX_CALLS", 2):
            body = read(reader(), backend, {"include": "states"})

        codes = [item.get("error", {}).get("code") for item in body["states"]]
        self.assertEqual(sorted(codes, key=str), [None, None, "call_budget"])
        self.assertEqual(len(backend.calls), 2)
        self.assertTrue(body["partial"])

    def test_a_request_past_its_deadline_reports_the_unread_series_and_caches_nothing(self):
        backend = model()
        subject = reader()

        with mock.patch.object(timeline, "TIMELINE_DEADLINE_SECONDS", -1):
            late = read(subject, backend, {"include": "states"})
        again = read(subject, backend, {"include": "states"})

        self.assertEqual([item["error"]["code"] for item in late["states"]], ["deadline"] * 3)
        self.assertEqual([("error" in item) for item in again["states"]], [False] * 3)

    def test_the_structure_is_read_once_per_user_and_model(self):
        listing = []
        backend = model()
        backend.entities.list_by_health_model = lambda group, name: listing.append(1) or list(backend.items)
        subject = reader()

        read(subject, backend, {"include": "states"})
        read(subject, backend, {"include": "states", "from": (NOW - 2 * HOUR).isoformat()})

        self.assertEqual(len(listing), 1)


class TailTests(unittest.TestCase):
    def test_an_entity_that_is_gone_adds_nothing_and_does_not_fail_the_others_but_other_errors_do(self):
        moved = {"occurredAt": stamp(1), "previousState": "Healthy", "newState": "Degraded"}
        since = {"api": timeline.to_ms(stamp(60)), "db": timeline.to_ms(stamp(60))}
        cases = [
            ("a 404 on the history of one entity", {("states", "db", None): azure_error(404)}, ["api"], None),
            ("a 404 on the annotations of one entity", {("annotations", "db", None): azure_error(404)}, ["api"], None),
            ("a 429", {("states", "db", None): azure_error(429)}, None, 429),
            ("a 500", {("states", "db", None): azure_error(500)}, None, 500),
            ("a 403", {("states", "db", None): azure_error(403)}, None, 403),
        ]
        for label, errors, rows_of, failed_with in cases:
            with self.subTest(label):
                backend = model(pages={("states", "api", None): [{"history": [moved]}]}, errors=errors)

                if failed_with:
                    with self.assertRaises(HttpResponseError) as raised:
                        reader().read_tail(backend, SELECTION, since, ["db"])
                    self.assertEqual(raised.exception.status_code, failed_with)
                else:
                    found = reader().read_tail(backend, SELECTION, since, ["db"])
                    self.assertEqual([row["entity"] for row in found["transitions"]], rows_of)
                    self.assertEqual(found["annotations"], [])


class TimelineApiTests(base.ApiCase):
    def setUp(self):
        super().setUp()
        self.module.timeline = timeline.TimelineReader()

    def get(self, query=""):
        with TestClient(self.module.app) as client:
            return client.get(f"/api/timeline{query}")

    def test_the_overview_has_every_entity_with_its_states_and_markers(self):
        response = self.get("?from=" + (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ"))

        body = response.json()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(body["entities"][0]["name"], MODEL)
        self.assertEqual(sorted(item["name"] for item in body["entities"]), sorted([MODEL, "web-frontend", "orders-api", "orders-db", "payments"]))
        self.assertEqual(len(body["states"]), 5)
        self.assertTrue(all(item["complete"] for item in body["states"]))
        self.assertGreater(len(next(item for item in body["states"] if item["entity"] == "orders-db")["transitions"]), 2)
        self.assertTrue(body["annotations"])
        self.assertEqual([item["entity"] for item in body["reports"]], ["payments"] * len(body["reports"]))
        self.assertEqual(body["series"], [])

    def test_signals_come_with_their_thresholds_and_a_value_per_point(self):
        body = self.get("?include=signals&entity=orders-db&from=" + (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")).json()

        signal = self.get("?include=structure&entity=orders-db").json()["entities"][0]["signals"][0]
        series = body["series"][0]
        self.assertEqual(body["entities"], [])
        self.assertEqual((signal["name"], signal["rules"]["unhealthy"]), ("cpu", {"operator": "GreaterThan", "threshold": 95}))
        self.assertEqual((series["entity"], series["signal"], series["complete"]), ("orders-db", "cpu", True))
        self.assertGreater(len(series["points"]), 50)
        self.assertEqual(series["points"][-1][2], 3)

    def test_the_fixture_incident_is_visible_in_the_root_history(self):
        body = self.get("?include=structure,states&entity=" + MODEL).json()

        states = [row["to"] for row in body["states"][0]["transitions"]]
        self.assertIn(2, states)
        self.assertEqual(body["entities"][0]["state"], 2)

    def test_a_bad_query_is_a_400_with_the_error_envelope(self):
        table = [("?top=5", "unsupported_query"), ("?include=x", "invalid_include"), ("?entity=nope", "unknown_entity"), ("?from=soon", "invalid_range"), ("?model=nope&resourceGroup=rg&subscription=" + base.SUB, "unknown_model")]
        for query, code in table:
            with self.subTest(query):
                response = self.get(query)

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], code)

    def test_one_failing_signal_does_not_fail_the_response(self):
        original = self.health.history.get_signal_history

        def flaky(entity, body):
            if entity == "orders-api":
                raise base.azure_error(500)
            return original(entity, body)

        with mock.patch.object(self.health.history, "get_signal_history", flaky):
            response = self.get("?include=signals&from=" + (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual({item["entity"]: item.get("error", {}).get("code") for item in body["series"]}, {"web-frontend": None, "orders-api": "unavailable", "orders-db": None, "payments": None})
        self.assertTrue(body["partial"])
        self.assertNotIn("SECRET_AZURE_BODY", response.text)

    def test_when_azure_refuses_everything_the_route_answers_like_the_other_routes(self):
        def refuse(entity, body):
            raise base.azure_error(403)

        with mock.patch.object(self.health.history, "get_history", refuse):
            response = self.get("?include=states")

        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "forbidden"))

    def test_a_closed_window_is_kept_by_the_browser_and_checked_again_while_an_open_one_is_never_kept(self):
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        closed = f"&from={(day - timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ')}&to={(day - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')}"
        table = [
            ("a closed window of signals", "?include=signals&entity=orders-db" + closed, True),
            ("a closed window of states", "?include=states,annotations,reports" + closed, True),
            ("a closed window with the structure", "?include=structure,states" + closed, False),
            ("a window that reaches now", "?include=signals&entity=orders-db", False),
        ]
        for label, query, kept in table:
            with self.subTest(label):
                response = self.get(query)

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers["cache-control"], "private, no-cache" if kept else "no-store")
                self.assertEqual("etag" in response.headers, kept)

    def test_a_window_the_browser_holds_is_answered_304_without_a_history_call_and_another_one_in_full(self):
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        window = lambda back: f"?include=signals&entity=orders-db&from={(day - timedelta(days=back + 1)).strftime('%Y-%m-%dT%H:%M:%SZ')}&to={(day - timedelta(days=back)).strftime('%Y-%m-%dT%H:%M:%SZ')}"  # noqa: E731
        with TestClient(self.module.app) as client:
            first = client.get("/api/timeline" + window(1))
            calls = mock.Mock(wraps=self.health.history.get_signal_history)
            with mock.patch.object(self.health.history, "get_signal_history", calls):
                same = client.get("/api/timeline" + window(1), headers={"If-None-Match": first.headers["etag"]})
                other = client.get("/api/timeline" + window(2), headers={"If-None-Match": first.headers["etag"]})

        self.assertEqual((same.status_code, same.content, same.headers["etag"], same.headers["cache-control"]), (304, b"", first.headers["etag"], "private, no-cache"))
        self.assertEqual(other.status_code, 200)
        self.assertNotEqual(other.headers["etag"], first.headers["etag"])
        self.assertEqual(calls.call_count, 1, "only the other window was read")

    def test_an_answer_with_a_failed_series_is_not_kept(self):
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        closed = f"&from={(day - timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ')}&to={(day - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')}"
        original = self.health.history.get_signal_history

        def flaky(entity, body):
            if entity == "orders-api":
                raise base.azure_error(500)
            return original(entity, body)

        with mock.patch.object(self.health.history, "get_signal_history", flaky):
            response = self.get("?include=signals" + closed)

        self.assertEqual((response.status_code, response.headers["cache-control"], "etag" in response.headers), (200, "no-store", False))

    def test_a_model_the_caller_cannot_read_is_refused_whatever_the_browser_holds(self):
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        closed = f"?include=signals&entity=orders-db&from={(day - timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ')}&to={(day - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')}"
        with TestClient(self.module.app) as client:
            held = client.get("/api/timeline" + closed).headers["etag"]
            refused = client.get(f"/api/timeline{closed}&model=nope&resourceGroup=rg&subscription={base.SUB}", headers={"If-None-Match": held})
            star = client.get(f"/api/timeline{closed}&model=nope&resourceGroup=rg&subscription={base.SUB}", headers={"If-None-Match": "*"})

        self.assertEqual([(response.status_code, response.json()["error"]["code"]) for response in (refused, star)], [(400, "unknown_model")] * 2)

    def test_the_route_does_not_run_on_the_event_loop(self):
        self.assertFalse(inspect.iscoroutinefunction(self.module.timeline_history))

    def closed_day(self):
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        return f"&from={(day - timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ')}&to={(day - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')}"

    def test_every_request_says_what_it_cost_on_its_span_and_in_one_log_line(self):
        kept = history_store.HistoryStore(history_store.MemoryBuckets())
        query = "?include=signals&entity=orders-db" + self.closed_day()
        costs = []
        with mock.patch.object(self.module, "prewarm", mock.Mock()):
            for label in ("first read", "another reader of the same store"):
                self.module.timeline = timeline.TimelineReader(history=kept)
                self.spans.clear()
                with self.subTest(label), self.assertLogs("ahm-demo", level="INFO") as logs:
                    response = self.get(query)

                    self.assertEqual(response.status_code, 200, response.text)
                    (span,) = [span for span in self.spans.get_finished_spans() if span.name == "healthmodel.timeline"]
                    costs.append({key: span.attributes[f"timeline.{key}"] for key in ("azure_calls", "pieces_read", "pieces_stored", "memory", "written")})
                    self.assertIn("timeline.duration_ms", span.attributes)
                    self.assertTrue(any(f"timeline read model={MODEL} status=200 calls=" in line for line in logs.output))

        self.assertEqual(costs[0], {"azure_calls": 1, "pieces_read": 1, "pieces_stored": 0, "memory": 0, "written": 3})
        self.assertEqual(costs[1], {"azure_calls": 0, "pieces_read": 0, "pieces_stored": 1, "memory": 1, "written": 0})

    def test_a_warm_store_serves_nobody_who_fails_the_access_check_and_only_an_admitted_request_starts_a_fill(self):
        self.module.timeline = timeline.TimelineReader(history=history_store.HistoryStore(history_store.MemoryBuckets()))
        opened = mock.Mock(return_value=False)
        query = "/api/timeline?include=signals,states" + self.closed_day()
        with mock.patch.object(self.module, "prewarm", SimpleNamespace(opened=opened, close=lambda: None)), TestClient(self.module.app) as client:
            warm = client.get(query)
            self.health.deny(base.SUB, base.GROUP, MODEL)
            refused = [
                client.get(query),
                client.get(query, headers={"If-None-Match": warm.headers["etag"]}),
                client.get(query.replace("include=signals,states", "include=structure")),
            ]

        self.assertEqual(warm.status_code, 200)
        self.assertEqual([(response.status_code, response.json()["error"]["code"]) for response in refused], [(400, "unknown_model")] * 3)
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(opened.call_args.args[3], (base.SUB, base.GROUP, MODEL))


MODEL = base.MODEL


if __name__ == "__main__":
    unittest.main()
