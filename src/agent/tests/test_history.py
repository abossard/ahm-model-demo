import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from history import (
    HistoryRefused,
    activity_arguments,
    asks_about_past,
    bounded_arguments,
    history_window,
    iso,
    log_arguments,
    metric_arguments,
    moment_window,
    period_named,
    query_at,
    widened,
    window_problems,
)

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
DAY = timedelta(days=1)
HOUR = timedelta(hours=1)


class PeriodTests(unittest.TestCase):
    def test_the_period_an_instruction_names_is_at_most_thirty_days(self):
        cases = [
            ("nothing", "Why is it unhealthy?", None),
            ("yesterday", "What happened yesterday?", 2 * DAY),
            ("last night", "Was it down last night?", DAY),
            ("last week", "What changed last week?", 7 * DAY),
            ("last month", "Any problem last month?", 30 * DAY),
            ("a counted period", "It broke 3 days ago", 3 * DAY),
            ("hours", "Since 5 hours", 5 * HOUR),
            ("more than the limit", "The last 12 weeks", 30 * DAY),
            ("the longest of several", "Last week, and 3 days before", 7 * DAY),
        ]
        for label, instruction, expected in cases:
            with self.subTest(label):
                self.assertEqual(period_named(instruction), expected)

    def test_a_question_about_the_past_is_told_from_one_about_now(self):
        cases = [
            ("now", "Why is checkout unhealthy?", False),
            ("empty", "", False),
            ("last week", "What changed last week?", True),
            ("recently", "Has it been healthy recently?", True),
            ("when", "When did it turn red?", True),
            ("a period", "The 2 days", True),
            ("history", "Show its history", True),
        ]
        for label, instruction, expected in cases:
            with self.subTest(label):
                self.assertEqual(asks_about_past(instruction), expected)


class WindowTests(unittest.TestCase):
    def test_the_window_is_the_last_day_unless_the_instruction_names_a_longer_period(self):
        cases = [
            ("nothing asked", "", None, None, (NOW - DAY, NOW)),
            ("a start before the limit", "", NOW - 30 * DAY, None, (NOW - DAY, NOW)),
            ("a start inside the limit", "", NOW - 6 * HOUR, None, (NOW - 6 * HOUR, NOW)),
            ("an end in the future", "", None, NOW + DAY, (NOW - DAY, NOW)),
            ("an end before the period", "", None, NOW - 3 * DAY, (NOW - DAY, NOW)),
            ("a start in the future", "", NOW + HOUR, None, (NOW - DAY, NOW)),
            ("a start after the end", "", NOW, NOW - HOUR, (NOW - DAY, NOW - HOUR)),
            ("an end inside", "", NOW - 6 * HOUR, NOW - 2 * HOUR, (NOW - 6 * HOUR, NOW - 2 * HOUR)),
            ("last week", "What changed last week?", None, None, (NOW - 7 * DAY, NOW)),
            ("last week with a start of 3 days ago", "last week", NOW - 3 * DAY, None, (NOW - 3 * DAY, NOW)),
            ("a period beyond thirty days", "the last 90 days", NOW - 60 * DAY, None, (NOW - 30 * DAY, NOW)),
            ("a period shorter than a day", "the last 2 hours", None, None, (NOW - DAY, NOW)),
        ]
        for label, instruction, start, end, expected in cases:
            with self.subTest(label):
                self.assertEqual(history_window(NOW, instruction, start, end), expected)

    def test_the_window_is_never_empty(self):
        cases = [
            ("an end before the limit", None, NOW - 3 * DAY),
            ("a start after the end", NOW, NOW - HOUR),
            ("an end a second after the limit", None, NOW - DAY + timedelta(seconds=1)),
            ("a start a second before the end", NOW - timedelta(seconds=1), None),
        ]
        for label, start, end in cases:
            with self.subTest(label):
                begin, finish = history_window(NOW, "", start, end)

                self.assertGreaterEqual(finish - begin, timedelta(minutes=1))
                self.assertLessEqual(finish, NOW)
                self.assertGreaterEqual(begin, NOW - DAY)

    def test_windows_read_so_far_are_one_period(self):
        first = (NOW - DAY, NOW - HOUR)
        second = (NOW - 3 * HOUR, NOW)

        self.assertEqual(widened(None, first), first)
        self.assertEqual(widened(first, second), (NOW - DAY, NOW))


class BoundedArgumentsTests(unittest.TestCase):
    def test_a_read_without_history_is_left_alone(self):
        cases = [
            ("no include", {"entity": "checkout"}),
            ("signals", {"entity": "checkout", "include": ["Signals"], "walk": "Causes"}),
            ("another entity", {"entity": "orders-db", "include": "Signals", "start-at": "2020-01-01T00:00:00Z"}),
        ]
        for label, arguments in cases:
            with self.subTest(label):
                bounded, window = bounded_arguments(arguments, task_type="review", asked="", instruction="", now=NOW)

                self.assertEqual((bounded, window), (arguments, None))

    def test_history_of_the_asked_entity_gets_the_window_and_loses_walk_and_timestamp(self):
        asked = {"subscription": "s", "entity": "Checkout", "include": ["History", "Signals"], "walk": "Causes", "timestamp": "2026-01-01T00:00:00Z", "start-at": "2020-01-01T00:00:00Z"}

        bounded, window = bounded_arguments(asked, task_type="explain", asked="checkout", instruction="", now=NOW)

        self.assertEqual(window, (NOW - DAY, NOW))
        self.assertEqual(
            bounded, {"subscription": "s", "entity": "Checkout", "include": ["History", "Signals"], "start-at": iso(NOW - DAY), "end-at": iso(NOW)}
        )

    def test_the_names_of_the_arguments_may_use_other_separators_and_the_include_a_list_or_a_text(self):
        cases = [
            ("underscores", {"entity": "checkout", "include": ["History"], "start_at": "2020-01-01T00:00:00Z"}),
            ("a text", {"entity": "checkout", "include": "Signals, History"}),
            ("lower case", {"entity": "checkout", "include": ["history"]}),
        ]
        for label, arguments in cases:
            with self.subTest(label):
                bounded, window = bounded_arguments(arguments, task_type="explain", asked="checkout", instruction="", now=NOW)

                self.assertEqual(window, (NOW - DAY, NOW))
                self.assertEqual((bounded["start-at"], bounded["end-at"]), (iso(NOW - DAY), iso(NOW)))
                self.assertNotIn("start_at", bounded)

    def test_a_longer_window_needs_an_instruction_that_names_the_period(self):
        arguments = {"entity": "checkout", "include": ["SignalHistory"], "start-at": "2026-10-01T00:00:00Z"}

        _, window = bounded_arguments(arguments, task_type="explain", asked="checkout", instruction="What changed last week?", now=NOW)

        self.assertEqual(window, (NOW - 7 * DAY, NOW))

    def test_a_read_the_rule_does_not_allow_is_refused_and_says_what_to_ask_instead(self):
        cases = [
            ("a review", "review", "", {"entity": "checkout", "include": ["History"]}, "History is read only for an Explain Task"),
            ("a design", "design", "", {"include": ["History"]}, "read the current state instead"),
            ("another entity", "explain", "checkout", {"entity": "orders-db", "include": ["History"]}, "pass `entity` 'checkout' and call again"),
            ("no entity", "explain", "checkout", {"include": ["History"]}, "pass `entity` 'checkout' and call again"),
            ("signal history", "explain", "checkout", {"entity": "checkout", "include": ["SignalHistory"]}, "are read only when the instruction asks about the past"),
            ("annotations", "explain", "checkout", {"entity": "checkout", "include": ["Annotations"]}, "Use `History` of the asked entity"),
        ]
        for label, task_type, asked, arguments, expected in cases:
            with self.subTest(label):
                with self.assertRaises(HistoryRefused) as refused:
                    bounded_arguments(arguments, task_type=task_type, asked=asked, instruction="", now=NOW)

                self.assertIn(expected, str(refused.exception))


class MomentTests(unittest.TestCase):
    """A Task about a past moment (`asOf`): every read is made for that moment, not for now."""

    AT = NOW - 26 * HOUR
    MOMENT = "2026-11-10T10:00:00Z"
    DAY_BEFORE = "2026-11-09T10:00:00Z"

    def test_the_window_ends_at_the_moment_and_never_begins_before_what_the_service_keeps(self):
        old = NOW - 30 * DAY + HOUR
        cases = [
            ("the day before the moment", self.AT, "", None, None, (self.AT - DAY, self.AT)),
            ("the period the instruction names", self.AT, "What changed last week?", None, None, (self.AT - 7 * DAY, self.AT)),
            ("a start inside", self.AT, "", self.AT - 2 * HOUR, None, (self.AT - 2 * HOUR, self.AT)),
            ("an end after the moment", self.AT, "", None, NOW, (self.AT - DAY, self.AT)),
            ("a moment a clock ahead of now", NOW + HOUR, "", None, None, (NOW - DAY, NOW)),
            ("a moment at the edge of what is kept", old, "", None, None, (NOW - 30 * DAY + timedelta(minutes=5), old)),
        ]
        for label, moment, instruction, start, end, expected in cases:
            with self.subTest(label):
                self.assertEqual(moment_window(NOW, moment, instruction, start, end), expected)

    def test_the_model_is_read_as_it_was_at_the_moment(self):
        cases = [
            ("the entity and its causes", {"entity": "checkout", "walk": "Causes", "include": ["Signals"]}, {"entity": "checkout", "walk": "Causes", "include": ["Signals"], "timestamp": self.MOMENT}),
            ("no include", {"entity": "checkout"}, {"entity": "checkout", "timestamp": self.MOMENT}),
            ("a timestamp of the model's own", {"entity": "orders-db", "timestamp": "2026-11-11T11:59:00Z"}, {"entity": "orders-db", "timestamp": self.MOMENT}),
        ]
        for label, arguments, expected in cases:
            with self.subTest(label):
                bounded, window = bounded_arguments(arguments, task_type="explain", asked="checkout", instruction="", now=NOW, as_of=self.AT)

                self.assertEqual((bounded, window), (expected, None))

    def test_history_is_read_for_the_window_that_ends_at_the_moment(self):
        cases = [
            ("history", {"entity": "checkout", "include": ["History"], "walk": "Causes"}, "", self.DAY_BEFORE),
            ("signal history needs no words about the past", {"entity": "checkout", "include": ["SignalHistory"]}, "", self.DAY_BEFORE),
            ("annotations", {"entity": "checkout", "include": "Annotations", "end-at": "2026-11-11T12:00:00Z"}, "", self.DAY_BEFORE),
            ("the period the instruction names", {"entity": "checkout", "include": ["History"]}, "the 3 days before", "2026-11-07T10:00:00Z"),
        ]
        for label, arguments, instruction, start in cases:
            with self.subTest(label):
                bounded, window = bounded_arguments(arguments, task_type="explain", asked="checkout", instruction=instruction, now=NOW, as_of=self.AT)

                self.assertEqual((bounded["start-at"], bounded["end-at"], bounded["timestamp"]), (start, self.MOMENT, self.MOMENT))
                self.assertEqual(window[1], self.AT)
                self.assertNotIn("walk", bounded)

    def test_history_of_another_entity_is_refused_at_a_moment_too(self):
        with self.assertRaises(HistoryRefused):
            bounded_arguments({"entity": "orders-db", "include": ["History"]}, task_type="explain", asked="checkout", instruction="", now=NOW, as_of=self.AT)

    def test_metrics_are_read_for_the_window_that_ends_at_the_moment(self):
        cases = [
            ("no times", {"resource": "db", "metric-names": "cpu", "interval": "PT1H"}, "", (self.DAY_BEFORE, self.MOMENT)),
            ("times of now", {"resource": "db", "start-time": "2026-11-11T00:00:00Z", "end-time": "2026-11-11T12:00:00Z"}, "", (self.DAY_BEFORE, self.MOMENT)),
            ("a start inside the window", {"resource": "db", "start_time": "2026-11-10T09:00:00Z"}, "", ("2026-11-10T09:00:00Z", self.MOMENT)),
            ("the period the instruction names", {"resource": "db"}, "the 7 days before", ("2026-11-03T10:00:00Z", self.MOMENT)),
        ]
        for label, arguments, instruction, expected in cases:
            with self.subTest(label):
                bounded = metric_arguments(arguments, as_of=self.AT, instruction=instruction, now=NOW)

                self.assertEqual((bounded["start-time"], bounded["end-time"]), expected)
                self.assertEqual(bounded["resource"], "db")
                self.assertNotIn("start_time", bounded)

    def test_a_query_runs_as_it_would_have_at_the_moment(self):
        at = f"datetime({self.MOMENT})"
        cases = [
            ("everything since an ago", "AppRequests | where TimeGenerated > ago(5m) | summarize count()", f"AppRequests | where TimeGenerated between (({at} - 5m) .. {at}) | summarize count()"),
            ("since an ago, inclusive", "T | where TimeGenerated >= ago( 1h )", f"T | where TimeGenerated between (({at} - 1h) .. {at})"),
            ("a range to now", "T | where TimeGenerated between (ago(1h) .. now())", f"T | where TimeGenerated between (({at} - 1h) .. {at})"),
            ("no spaces", "T | where TimeGenerated>ago(1h) | count", f"T | where TimeGenerated between (({at} - 1h) .. {at}) | count"),
            ("no spaces, inclusive", "T | where TimeGenerated>=ago(1h)", f"T | where TimeGenerated between (({at} - 1h) .. {at})"),
            ("tabs and newlines", "T\n| where TimeGenerated\t>\nago( 1h )", f"T\n| where TimeGenerated between (({at} - 1h) .. {at})"),
            ("now with an offset", "T | where TimeGenerated < now(-1h)", f"T | where TimeGenerated < ({at} + -1h)"),
            ("an ago elsewhere", "T | extend old = Created < ago(7d)", f"T | extend old = Created < ({at} - 7d)"),
            ("its own times", "T | where TimeGenerated between (datetime(2026-11-10T09:00:00Z) .. datetime(2026-11-10T10:00:00Z))", None),
            ("no time at all", "T | getschema", None),
            ("a word that ends in ago", "T | extend lumbago(1)", None),
        ]
        for label, query, expected in cases:
            with self.subTest(label):
                self.assertEqual(query_at(query, self.AT), expected or query)

    def test_a_log_query_reaches_back_to_the_window_and_stops_at_the_moment(self):
        at = f"datetime({self.MOMENT})"
        cases = [
            ("since an ago", "T | where TimeGenerated > ago(5m) | count", "", f"T | where TimeGenerated between (({at} - 5m) .. {at}) | count", 50),
            ("bounded by the query", f"T | where TimeGenerated <= {at} | count", "", f"T | where TimeGenerated <= {at} | count", 50),
            ("the columns of a table", "T | getschema", "", "T | getschema", 50),
            ("a longer period", f"T | where TimeGenerated < {at}", "the 3 days before", f"T | where TimeGenerated < {at}", 98),
            ("a lookback longer than the window", f"T | where TimeGenerated < {at} and X > ago(7d)", "", f"T | where TimeGenerated < {at} and X > ({at} - 7d)", 194),
        ]
        for label, query, instruction, expected, hours in cases:
            with self.subTest(label):
                bounded = log_arguments({"workspace": "w", "table": "T", "query": query, "hours": 1}, as_of=self.AT, instruction=instruction, now=NOW)

                self.assertEqual(bounded, {"workspace": "w", "table": "T", "query": expected, "hours": hours})

    def test_a_log_call_keeps_the_hours_it_asked_for_counted_from_the_moment(self):
        for label, asked, hours in [("a few hours", 3, 50), ("a week", 168, 194), ("none", None, 50)]:
            with self.subTest(label):
                arguments = {"table": "T", "query": "T | getschema"} | ({} if asked is None else {"hours": asked})
                self.assertEqual(log_arguments(arguments, as_of=self.AT, instruction="", now=NOW)["hours"], hours)

    def test_a_malformed_bound_does_not_count_as_a_bound(self):
        for label, query in [("glued", "T | where TimeGeneratedbetween(a .. b)"), ("no parentheses", "T | where TimeGenerated between a .. b")]:
            with self.subTest(label):
                with self.assertRaises(HistoryRefused):
                    log_arguments({"table": "T", "query": query}, as_of=self.AT, instruction="", now=NOW)

    def test_a_log_query_that_would_read_up_to_now_is_refused_and_says_what_to_add(self):
        for label, query in [("no time", "T | summarize count()"), ("only a start", "T | where TimeGenerated > datetime(2026-11-10T09:00:00Z)"), ("a named query", "recent")]:
            with self.subTest(label):
                with self.assertRaises(HistoryRefused) as refused:
                    log_arguments({"table": "T", "query": query}, as_of=self.AT, instruction="", now=NOW)

                self.assertIn(f"| where TimeGenerated between (datetime({self.DAY_BEFORE}) .. datetime({self.MOMENT}))", str(refused.exception))

    def test_the_activity_log_reaches_back_to_the_window(self):
        cases = [("the day before the moment", "", 50), ("a week before", "the 7 days before", 194)]
        for label, instruction, hours in cases:
            with self.subTest(label):
                bounded = activity_arguments({"resource-name": "db", "hours": 2, "top": 20}, as_of=self.AT, instruction=instruction, now=NOW)

                self.assertEqual(bounded, {"resource-name": "db", "top": 20, "hours": hours})


class WindowProblemsTests(unittest.TestCase):
    WINDOW = (NOW - DAY, NOW)
    SAID = {"from": "2026-11-10T12:00:00Z", "to": "2026-11-11T12:00:00Z"}

    def test_an_explain_names_the_period_it_read_and_only_then(self):
        wanted = "window: history was read for this period: set `window` to 2026-11-10T12:00:00Z and 2026-11-11T12:00:00Z as `from` and `to`"
        cases = [
            ("no history and no window", {"kind": "explain"}, None, []),
            ("no history but a window", {"kind": "explain", "window": self.SAID}, None, ["window: no history was read in this Task: leave `window` out"]),
            ("history and the window", {"kind": "explain", "window": self.SAID}, self.WINDOW, []),
            ("history and no window", {"kind": "explain"}, self.WINDOW, [wanted]),
            ("history and another window", {"kind": "explain", "window": {"from": "2026-11-01T00:00:00Z", "to": self.SAID["to"]}}, self.WINDOW, [wanted]),
            ("a window a minute off", {"kind": "explain", "window": {"from": "2026-11-10T12:01:00Z", "to": "2026-11-11T11:59:30+00:00"}}, self.WINDOW, []),
            ("a window that is no date", {"kind": "explain", "window": {"from": "yesterday", "to": "now"}}, self.WINDOW, [wanted]),
            ("a diff", {"kind": "diff"}, self.WINDOW, []),
        ]
        for label, result, window, expected in cases:
            with self.subTest(label):
                self.assertEqual(window_problems(result, window), expected)


if __name__ == "__main__":
    unittest.main()
