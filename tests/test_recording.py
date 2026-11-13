import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import recording  # noqa: E402

MINUTE = 60_000
DAY = 24 * 60 * MINUTE
WEEK = 7 * DAY
POLL = 30_000
LATE = 15 * MINUTE
DAY_ONE = 2898 * DAY  # a Thursday, so it begins a week too


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def structure(refresh="PT1M", extra=()):
    signals = [{"name": "cpu", "refreshInterval": refresh}, {"name": "web-ui-health-report", "refreshInterval": refresh}, *extra]
    return [{"name": "api", "signals": signals}, {"name": "db", "signals": []}]


RAMP = object()


def inventory(t, state="Healthy", every=MINUTE, signals=("cpu", "web-ui-health-report"), value=RAMP):
    evaluated = t // every * every + 7
    return {
        "entities": [
            {"name": "api", "healthState": state, "signals": [{"name": name, "reportedAt": iso(evaluated), "value": float(evaluated // every % 97) if value is RAMP else value, "healthState": "Healthy"} for name in signals]},
            {"name": "db", "healthState": "Healthy", "signals": []},
        ]
    }


def recorder(**overrides):
    settings = {"gap_ms": POLL * 3 // 2, "min_refresh_ms": 2 * POLL, "late_ms": LATE, "max_points": 100_000, "max_transitions": 1000, "states": True, **overrides}
    return recording.Recorder(**settings)


def watch(subject, start, end, gaps=(), shape=structure, **kwargs):
    """Polls every 30 s from `start` to `end`, each read taking a second, except inside `gaps`."""
    t = start
    while t <= end:
        if not any(first <= t < last for first, last in gaps):
            subject.observed(t - 1000, t, inventory(t, **kwargs), shape() if callable(shape) else shape)
        t += POLL


class DurationTests(unittest.TestCase):
    def test_a_refresh_interval_is_an_iso_duration(self):
        table = [("PT1M", 60_000), ("PT5M", 300_000), ("PT30S", 30_000), ("PT1H", 3_600_000), ("P1D", DAY), ("PT1.5S", 1500), ("PT0S", None), ("", None), (None, None), ("5m", None)]
        for text, expected in table:
            with self.subTest(text=text):
                self.assertEqual(recording.duration_ms(text), expected)

    def test_only_signals_a_poll_sees_every_evaluation_of_are_recorded(self):
        table = [
            ("evaluated every minute", "PT1M", {("api", "cpu")}),
            ("evaluated every five minutes", "PT5M", {("api", "cpu")}),
            ("evaluated faster than two polls", "PT45S", set()),
            ("no interval", None, set()),
        ]
        for label, refresh, expected in table:
            with self.subTest(label):
                self.assertEqual(set(recording.recordable(structure(refresh), 2 * POLL)), expected)


class CoverageTests(unittest.TestCase):
    def test_a_stretch_covers_from_its_first_poll_end_to_its_last_poll_start(self):
        table = [
            ("polls every 30 s", [(0, 1), (30, 31), (60, 61)], (1, 60), True),
            ("before the first poll ended", [(0, 1), (30, 31), (60, 61)], (0, 60), False),
            ("after the last poll began", [(0, 1), (30, 31), (60, 61)], (1, 61), False),
            ("a gap of a poll and a half is still one stretch", [(0, 1), (44, 45)], (1, 44), True),
            ("a longer gap is two", [(0, 1), (46, 47), (76, 77)], (1, 76), False),
        ]
        for label, polls, (start, end), expected in table:
            with self.subTest(label):
                coverage = recording.Coverage(45)
                for began, ended in polls:
                    coverage.observed(began, ended)

                self.assertEqual(coverage.covers(start, end), expected)


class RecorderTests(unittest.TestCase):
    def test_a_day_watched_whole_gives_every_evaluation_of_its_signals_and_nothing_else(self):
        subject = recorder()
        watch(subject, DAY_ONE - MINUTE, DAY_ONE + DAY + LATE + MINUTE)

        pieces = subject.closed(DAY_ONE + DAY + LATE + MINUTE)

        self.assertEqual([piece[:4] for piece in pieces], [("signal", "api", "cpu", DAY_ONE)])
        points = pieces[0][4]["points"]
        self.assertEqual(len(points), DAY // MINUTE)
        self.assertEqual((points[0][0], points[-1][0]), (DAY_ONE + 7, DAY_ONE + DAY - MINUTE + 7))
        self.assertEqual(pieces[0][4]["reports"], [])
        self.assertLess(subject.size[0], 20, "only the minutes of the next day are held")

    def test_a_day_is_given_up_to_azure_when_the_watch_did_not_cover_it(self):
        start, end = DAY_ONE - MINUTE, DAY_ONE + DAY + LATE + MINUTE
        table = [
            ("a gap of five minutes", start, end, {"gaps": [(DAY_ONE + 3 * 3600_000, DAY_ONE + 3 * 3600_000 + 5 * MINUTE)]}),
            ("the hub started after the day began", DAY_ONE + MINUTE, end, {}),
            ("the hub stopped before the late margin ended", start, DAY_ONE + DAY + LATE - MINUTE, {}),
            ("the poll is too slow for the signal", start, end, {"shape": structure("PT45S")}),
        ]
        for label, first, last, change in table:
            with self.subTest(label):
                subject = recorder()
                watch(subject, first, last, **change)

                self.assertEqual(subject.closed(end), [])

    def test_a_signal_that_appeared_during_the_day_is_left_to_azure_and_the_others_are_kept(self):
        subject = recorder()
        watch(subject, DAY_ONE - MINUTE, DAY_ONE + 3600_000)
        watch(subject, DAY_ONE + 3600_000 + POLL, DAY_ONE + DAY + LATE + MINUTE, shape=structure(extra=[{"name": "mem", "refreshInterval": "PT1M"}]), signals=("cpu", "mem"))

        pieces = subject.closed(DAY_ONE + DAY + LATE + MINUTE)

        self.assertEqual([piece[:4] for piece in pieces], [("signal", "api", "cpu", DAY_ONE)])

    def test_a_revised_evaluation_replaces_the_one_it_revises(self):
        subject = recorder()
        shape = structure()
        subject.observed(DAY_ONE - 2 * POLL, DAY_ONE - POLL, inventory(DAY_ONE, value=1.0), shape)
        subject.observed(DAY_ONE - POLL, DAY_ONE, inventory(DAY_ONE, value=2.0), shape)
        watch(subject, DAY_ONE + 10_000, DAY_ONE + DAY + LATE + MINUTE, value=2.0)

        points = subject.closed(DAY_ONE + DAY + LATE + MINUTE)[0][4]["points"]

        self.assertEqual(points[0], [DAY_ONE + 7, 2.0, 1])
        self.assertEqual(len(points), DAY // MINUTE)

    def test_no_data_is_kept_as_none_and_a_value_that_is_not_a_number_spoils_its_day(self):
        table = [("no data", None, [DAY_ONE + 7, None, 1]), ("not a number", "high", None)]
        for label, value, expected in table:
            with self.subTest(label):
                subject = recorder()
                watch(subject, DAY_ONE - MINUTE, DAY_ONE + DAY + LATE + MINUTE, value=value)

                pieces = subject.closed(DAY_ONE + DAY + LATE + MINUTE)

                self.assertEqual([piece[4]["points"][0] for piece in pieces], [expected] if expected else [])

    def test_more_points_than_allowed_give_the_oldest_day_up(self):
        subject = recorder(max_points=1000)
        watch(subject, DAY_ONE - MINUTE, DAY_ONE + DAY + LATE + MINUTE)

        self.assertLessEqual(subject.size[0], 1000)
        self.assertEqual(subject.closed(DAY_ONE + DAY + LATE + MINUTE), [])

    def test_a_week_watched_whole_gives_the_transitions_read_of_every_entity_unless_one_was_not_read(self):
        change = (DAY_ONE + 2 * DAY - POLL, DAY_ONE + 2 * DAY)
        table = [
            ("every change read", [], ["api", "db"]),
            ("a change of db never read", [("unsure", "db", change)], ["api"]),
            ("a change read from before it", [("unsure", "db", change), ("confirmed", "db", (change[0] - MINUTE,))], ["api", "db"]),
            ("a change read only from after it", [("unsure", "db", change), ("confirmed", "db", (change[0] + 1,))], ["api"]),
            ("a change seen in the next week", [("unsure", "db", (DAY_ONE + WEEK + LATE + 20 * MINUTE, DAY_ONE + WEEK + LATE + 21 * MINUTE))], ["api", "db"]),
            ("a change seen just before the week ended", [("unsure", "db", (DAY_ONE + WEEK - POLL, DAY_ONE + WEEK + 1))], ["api"]),
        ]
        for label, events, expected in table:
            with self.subTest(label):
                subject = recorder(gap_ms=15 * MINUTE, min_refresh_ms=20 * MINUTE)
                shape = structure("PT1H")
                t = DAY_ONE - MINUTE
                while t <= DAY_ONE + WEEK + LATE + 20 * MINUTE:
                    subject.observed(t - 1000, t, {"entities": [{"name": "api", "healthState": "Healthy", "signals": []}, {"name": "db", "healthState": "Healthy", "signals": []}]}, shape)
                    t += 10 * MINUTE
                subject.transitions([{"entity": "api", "t": DAY_ONE + DAY, "from": 1, "to": 2, "reason": "x"}, {"entity": "api", "t": DAY_ONE + DAY, "from": 1, "to": 2, "reason": "x"}])
                for event, name, times in events:
                    getattr(subject, event)(name, *times)

                pieces = subject.closed(DAY_ONE + WEEK + LATE + 20 * MINUTE)

                states = {piece[1]: piece[4]["transitions"] for piece in pieces if piece[0] == "states"}
                self.assertEqual(sorted(states), expected)
                self.assertEqual(states["api"], [{"t": DAY_ONE + DAY, "from": 1, "to": 2, "reason": "x"}])

    def test_no_transitions_are_recorded_when_the_hub_does_not_read_them(self):
        subject = recorder(states=False, gap_ms=15 * MINUTE)
        t = DAY_ONE - MINUTE
        while t <= DAY_ONE + WEEK + LATE + 20 * MINUTE:
            subject.observed(t - 1000, t, {"entities": [{"name": "api", "healthState": "Healthy", "signals": []}]}, [])
            t += 10 * MINUTE

        self.assertEqual(subject.closed(DAY_ONE + WEEK + LATE + 20 * MINUTE), [])


class OutOfTurnTests(unittest.TestCase):
    def test_a_signal_evaluated_sooner_than_its_refresh_interval_is_left_to_azure(self):
        table = [("every minute", MINUTE, True), ("a little early now and then", 59_500, True), ("every half minute", 30_000, False)]
        for label, every, kept in table:
            with self.subTest(label):
                subject = recorder()
                watch(subject, DAY_ONE - MINUTE, DAY_ONE + DAY + LATE + MINUTE, every=every)

                pieces = subject.closed(DAY_ONE + DAY + LATE + MINUTE)

                self.assertEqual([piece[:4] for piece in pieces], [("signal", "api", "cpu", DAY_ONE)] if kept else [])

    def test_a_change_the_app_made_to_the_model_leaves_the_days_around_it_to_azure(self):
        table = [
            ("during the day", DAY_ONE + 3 * 3600_000, []),
            ("in the margin after it", DAY_ONE + DAY + LATE // 2, []),
            ("the day before", DAY_ONE - DAY // 2, [("signal", "api", "cpu", DAY_ONE)]),
            ("after the margin", DAY_ONE + DAY + LATE + 1, [("signal", "api", "cpu", DAY_ONE)]),
        ]
        for label, at, expected in table:
            with self.subTest(label):
                subject = recorder()
                watch(subject, DAY_ONE - MINUTE, DAY_ONE + DAY + LATE + MINUTE)
                subject.spoil(at)

                self.assertEqual([piece[:4] for piece in subject.closed(DAY_ONE + DAY + LATE + MINUTE)], expected)


if __name__ == "__main__":
    unittest.main()
