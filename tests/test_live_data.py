import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import live_data  # noqa: E402


def signal(name, state="Healthy", value=1.0, at="2026-11-11T10:00:00Z", **extra):
    return {"name": name, "healthState": state, "value": value, "reportedAt": at, **extra}


def entity(name, state="Healthy", signals=()):
    return {"name": name, "displayName": name.title(), "healthState": state, "signals": list(signals)}


def inventory(entities, relationships=(), model_state="Healthy"):
    return {
        "model": {"name": "m", "healthState": model_state},
        "observedAt": "x",
        "entities": list(entities),
        "relationships": [{"name": f"{a}-{b}", "parentEntityName": a, "childEntityName": b} for a, b in relationships],
        "reportOptions": {"values": [0, 1]},
    }


BASE = inventory([entity("a"), entity("b", signals=[signal("cpu")])], [("a", "b")])


class DiffTests(unittest.TestCase):
    def test_what_changed_is_the_delta_and_applying_it_leads_to_the_new_observation(self):
        changed = lambda *items: inventory(items, [("a", "b")])  # noqa: E731
        table = [
            ("nothing", BASE, BASE, None),
            ("an observation time only", {**BASE, "observedAt": "later"}, BASE, None),
            ("a state change", BASE, changed(entity("a", "Degraded"), BASE["entities"][1]), {"entities": {"upsert": [entity("a", "Degraded")]}}),
            (
                "a signal value",
                BASE,
                changed(entity("a"), entity("b", signals=[signal("cpu", value=2.0)])),
                {"entities": {"upsert": [entity("b", signals=[signal("cpu", value=2.0)])]}},
            ),
            (
                "an entity added",
                BASE,
                inventory([*BASE["entities"], entity("c")], [("a", "b"), ("a", "c")]),
                {
                    "entities": {"upsert": [entity("c")]},
                    "relationships": {"upsert": [{"name": "a-c", "parentEntityName": "a", "childEntityName": "c"}]},
                    "order": ["a", "b", "c"],
                },
            ),
            (
                "an entity removed",
                BASE,
                inventory([BASE["entities"][0]]),
                {"entities": {"remove": ["b"]}, "relationships": {"remove": ["a-b"]}, "order": ["a"]},
            ),
            ("the model state", BASE, {**BASE, "model": {"name": "m", "healthState": "Degraded"}}, {"model": {"healthState": "Degraded"}}),
        ]
        for label, old, new, expected in table:
            with self.subTest(label):
                delta = live_data.diff_inventory(BASE if label == "an observation time only" else old, new)

                self.assertEqual(delta, expected)
                if delta:
                    self.assertEqual(live_data.apply_delta(old, delta), new)

    def test_an_entity_keeps_its_place_when_it_changes_and_a_new_order_is_applied(self):
        old = inventory([entity("a"), entity("b"), entity("c")])
        new = inventory([entity("c"), entity("a", "Degraded"), entity("b")])

        delta = live_data.diff_inventory(old, new)

        self.assertEqual([item["name"] for item in live_data.apply_delta(old, delta)["entities"]], ["c", "a", "b"])

    def test_the_states_that_changed_are_where_history_is_read(self):
        old = inventory([entity("a"), entity("b", "Degraded")])
        new = inventory([entity("a", "Unhealthy"), entity("b", "Degraded"), entity("c")])

        self.assertEqual(live_data.changed_states(old, new), ["a", "c"])


class PointTests(unittest.TestCase):
    def test_an_evaluation_is_a_new_point_once_and_a_revised_one_again(self):
        first = inventory([entity("b", signals=[signal("cpu", value=1.0)])])
        known, points = live_data.new_points({}, first)
        t = live_data.to_ms("2026-11-11T10:00:00Z")

        self.assertEqual(points, [{"entity": "b", "signal": "cpu", "points": [[t, 1.0, 1]]}])
        self.assertEqual(live_data.new_points(known, first)[1], [])
        revised = inventory([entity("b", signals=[signal("cpu", value=3.0)])])
        later = inventory([entity("b", signals=[signal("cpu", value=3.0, at="2026-11-11T10:01:00Z")])])
        self.assertEqual(live_data.new_points(known, revised)[1][0]["points"], [[t, 3.0, 1]])
        self.assertEqual(live_data.new_points(known, later)[1][0]["points"][0][0], t + 60_000)

    def test_a_signal_without_a_time_is_no_point(self):
        none = inventory([entity("b", signals=[signal("cpu", at=None)])])

        self.assertEqual(live_data.new_points({}, none), ({}, []))

    def test_a_report_is_new_when_it_has_an_id_and_the_canonical_name(self):
        report = signal("web-ui-health-report", "Degraded", 0.5, reportId="r1", reason="Planned")
        table = [
            ("a report", [report], 1),
            ("not the canonical signal", [signal("cpu", reportId="r1")], 0),
            ("without a report id", [signal("web-ui-health-report")], 0),
        ]
        for label, signals, count in table:
            with self.subTest(label):
                self.assertEqual(len(live_data.new_reports(set(), inventory([entity("a", signals=signals)]))), count)

    def test_a_known_report_is_not_new(self):
        report = signal("web-ui-health-report", "Degraded", 0.5, reportId="r1")
        t = live_data.to_ms("2026-11-11T10:00:00Z")

        self.assertEqual(live_data.new_reports({("a", t, "r1")}, inventory([entity("a", signals=[report])])), [])


class MergeTests(unittest.TestCase):
    def test_only_items_with_a_new_natural_key_come_out_and_the_known_set_grows(self):
        known = {("a", 1, 1, 2)}
        rows = [{"entity": "a", "t": 1, "from": 1, "to": 2}, {"entity": "a", "t": 5, "from": 2, "to": 1}]

        fresh = live_data.merge_by_key(known, rows, live_data.transition_key)

        self.assertEqual(fresh, [rows[1]])
        self.assertEqual(live_data.merge_by_key(known, rows, live_data.transition_key), [])

    def test_an_empty_timeline_part_is_empty(self):
        self.assertTrue(live_data.empty_timeline({"transitions": [], "points": []}))
        self.assertFalse(live_data.empty_timeline({"points": [1]}))


class CursorTests(unittest.TestCase):
    def test_an_event_id_names_the_hub_life_and_the_sequence(self):
        table = [("abcd1234-17", ("abcd1234", 17)), ("abc-1", None), ("abcd1234-x", None), ("", None), (None, None), ("abcd1234-1; drop", None)]
        for text, expected in table:
            with self.subTest(text):
                self.assertEqual(live_data.parse_event_id(text), expected)

    def test_formatting_and_parsing_round_trip(self):
        self.assertEqual(live_data.parse_event_id(live_data.format_event_id("e1e1e1e1", 9)), ("e1e1e1e1", 9))

    def test_a_ring_replays_what_came_after_and_says_when_it_cannot(self):
        ring = live_data.Ring(3)
        for seq in range(1, 6):
            ring.append(seq, f"e{seq}")

        table = [(5, []), (4, ["e5"]), (2, ["e3", "e4", "e5"]), (1, None), (0, None), (9, [])]
        for seq, expected in table:
            with self.subTest(seq=seq):
                self.assertEqual(ring.since(seq), expected)

    def test_an_empty_ring_replays_only_from_the_start(self):
        ring = live_data.Ring(3)

        self.assertEqual(ring.since(0), [])
        self.assertIsNone(ring.since(4))


if __name__ == "__main__":
    unittest.main()
