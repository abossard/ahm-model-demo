import sys
import threading
import time
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

from azure.core.exceptions import ClientAuthenticationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import prewarm  # noqa: E402
import timeline  # noqa: E402
from test_history_store import SCOPE, Windowed, series, store  # noqa: E402
from test_timeline import NOW, Clock, azure_error, entity, relationship  # noqa: E402

FAST = dict(busy_seconds=0.001, max_backoff_seconds=0.01, retry_seconds=60)


def source():
    data = {("signal", "api", name): series(days=31, every_minutes=60) for name in ("cpu", "mem")}
    return Windowed([entity("root"), entity("api", ["cpu", "mem"])], [relationship("root", "api")], data)


def reader(history=None, now=lambda: NOW):
    return timeline.TimelineReader(clock=Clock(), now=now, history=history if history is not None else store())


def caller(expires_at=None):
    return SimpleNamespace(oid="ada", owner="ada", expires_at=expires_at)


def warm(starts=None, clock=None, **settings):
    """A prewarm that runs a fill at once in the caller's thread, or hands it to `starts` to run later."""
    run = (lambda work: starts.append(work)) if starts is not None else (lambda work: work())
    return prewarm.Prewarm(prewarm.PrewarmSettings(**{**FAST, **settings}), clock=clock or Clock(), wall=lambda: NOW.timestamp(), start=run)


def outcome(test, subject, *arguments):
    with test.assertLogs("ahm-demo", level="INFO") as logs:
        subject.opened(*arguments)
    line = next(line for line in logs.output if "timeline prewarm model" in line)
    return line.split("outcome=")[1].split()[0]


class FillTests(unittest.TestCase):
    def test_a_fill_reads_every_missing_closed_piece_once_newest_first_and_a_month_then_costs_only_the_open_ends(self):
        backend = source()
        history = store()

        self.assertEqual(outcome(self, warm(), reader(history), caller(), backend, SCOPE), "done")

        asked = [(kind, name, signal, body["startAt"]) for kind, name, signal, body in backend.calls]
        days = [start for kind, _, signal, start in asked if signal == "cpu"]
        self.assertEqual(len(asked), len(set(asked)), "no piece is read twice")
        self.assertEqual(days, sorted(days, reverse=True), "newest first")
        self.assertGreaterEqual(len(days), 29)
        before = len(backend.calls)
        params = {"include": "states,annotations,signals", "from": (NOW - timeline.timedelta(days=30)).isoformat(), "resolution": "3600"}
        body = reader(history).read(caller(), backend, SCOPE, params)
        self.assertFalse(body["partial"])
        histories = 2 * 2 + 2
        self.assertEqual(len(backend.calls) - before, 2 * histories, "the open end and the part of the oldest piece the service still keeps, per history")
        self.assertEqual(outcome(self, warm(), reader(history), caller(), backend, ("sub", "rg", "other")), "done")

    def test_a_second_fill_of_a_filled_model_reads_nothing(self):
        backend = source()
        history = store()
        warm().opened(reader(history), caller(), backend, SCOPE)
        calls = len(backend.calls)

        warm().opened(reader(history), caller(), backend, SCOPE)

        self.assertEqual(len(backend.calls), calls)

    def test_a_fill_stops_when_the_sign_in_ends_or_the_service_refuses_or_keeps_failing(self):
        at_once = timeline.PREWARM_CONCURRENCY
        table = [
            ("the sign-in is about to expire", None, NOW.timestamp() + prewarm.PREWARM_TOKEN_MARGIN_SECONDS - 1, "token_expired", 0),
            ("no role on the history", azure_error(403), None, "forbidden", at_once),
            ("the exchange fails", ClientAuthenticationError("x"), None, "signed_out", at_once),
            ("the service stays busy", azure_error(429), None, "throttled", (prewarm.PREWARM_BUSY_RETRIES + 1) * at_once),
            ("the service keeps failing", azure_error(500), None, "errors", prewarm.PREWARM_ERROR_LIMIT + at_once - 1),
        ]
        for label, error, expires_at, reason, most in table:
            with self.subTest(label):
                backend = source()
                if error is not None:
                    backend.errors.update({kind: error for kind in ("states", "annotations", "signal")})

                self.assertEqual(outcome(self, warm(), reader(), caller(expires_at), backend, SCOPE), reason)
                self.assertLessEqual(len(backend.calls), most)

    def test_a_busy_service_is_waited_out_and_the_piece_read_again(self):
        backend = source()
        busy = [azure_error(429)]
        backend.errors["states"] = lambda: busy.pop() if busy else None

        self.assertEqual(outcome(self, warm(), reader(), caller(), backend, SCOPE), "done")
        states = [(call[1], call[3]["startAt"]) for call in backend.calls if call[0] == "states"]
        self.assertEqual(len(states), len(set(states)) + 1, "one piece was read twice")

    def test_a_piece_that_ages_out_of_the_service_during_a_fill_is_skipped_without_failing_it(self):
        table = [("time stands still", timedelta(0), 0), ("an hour passes at every look at the clock", timedelta(hours=1), 1)]
        for label, step, fewer in table:
            with self.subTest(label):
                backend = source()
                moments = [NOW]

                def now(moments=moments, step=step):
                    moments.append(moments[-1] + step)
                    return moments[-1]

                backend.now = lambda moments=moments: moments[-1]
                with self.assertNoLogs("ahm-demo", level="WARNING"):
                    self.assertEqual(outcome(self, warm(), reader(now=now), caller(), backend, SCOPE), "done")
                days = {call[3]["startAt"] for call in backend.calls if call[0] == "signal"}
                self.assertEqual(len(days) < 29, bool(fewer), "the oldest days aged out on the way and were not asked for")

    def test_a_fill_that_stops_wakes_a_worker_that_waits_out_a_busy_service(self):
        table = [("another worker is refused", azure_error(403), None, "forbidden"), ("the app closes", azure_error(429), 0.2, "shutdown")]
        for label, other, close_after, reason in table:
            with self.subTest(label):
                backend = source()
                backend.errors[("states", "root", None)] = azure_error(429)
                backend.errors[("annotations", "root", None)] = other
                subject = warm(busy_seconds=5, max_backoff_seconds=5)
                if close_after is not None:
                    threading.Timer(close_after, subject.close).start()
                started = time.monotonic()

                self.assertEqual(outcome(self, subject, reader(), caller(), backend, SCOPE), reason)
                self.assertLess(time.monotonic() - started, 2)

    def test_a_history_that_is_gone_is_skipped(self):
        backend = source()
        backend.errors[("signal", "api", "mem")] = azure_error(404)

        self.assertEqual(outcome(self, warm(), reader(), caller(), backend, SCOPE), "done")


class OpenedTests(unittest.TestCase):
    def test_one_fill_runs_per_model_and_a_model_is_filled_again_only_after_a_day_closed_or_a_while_after_a_stop(self):
        starts = []
        clock = Clock()
        subject = warm(starts, clock, max_fills=2)
        backend = source()
        history = store()

        self.assertTrue(subject.opened(reader(history), caller(), backend, SCOPE))
        self.assertFalse(subject.opened(reader(history), caller(), backend, SCOPE), "it runs")
        self.assertTrue(subject.opened(reader(history), caller(), backend, ("sub", "rg", "two")))
        self.assertFalse(subject.opened(reader(history), caller(), backend, ("sub", "rg", "three")), "two run already")
        self.assertFalse(subject.opened(reader(None), caller(), backend, ("sub", "rg", "four")), "nothing keeps history")
        for work in starts:
            work()
        self.assertFalse(subject.opened(reader(history), caller(), backend, SCOPE), "it finished since the last day closed")

        expiring = caller(NOW.timestamp())
        self.assertTrue(subject.opened(reader(history), expiring, backend, ("sub", "rg", "five")))
        starts[-1]()
        self.assertFalse(subject.opened(reader(history), caller(), backend, ("sub", "rg", "five")), "it stopped a moment ago")
        clock.now += 61
        self.assertTrue(subject.opened(reader(history), caller(), backend, ("sub", "rg", "five")))

    def test_a_fill_that_cannot_start_does_not_fail_the_request_or_count_as_running(self):
        clock = Clock()
        attempts = []

        def start(work):
            attempts.append(work)
            if len(attempts) == 1:
                raise RuntimeError("can't start new thread")

        subject = prewarm.Prewarm(prewarm.PrewarmSettings(**FAST), clock=clock, wall=lambda: NOW.timestamp(), start=start)
        table = [("it cannot start", 0, False, 1), ("a moment later", 1, False, 1), ("after the retry period", 61, True, 2)]
        for label, later, started, tries in table:
            with self.subTest(label):
                clock.now += later
                with self.assertLogs("ahm-demo", level="WARNING") if tries == 1 and later == 0 else _quiet():
                    self.assertEqual(subject.opened(reader(), caller(), source(), SCOPE), started)
                self.assertEqual((len(attempts), subject.running(SCOPE)), (tries, started))

    def test_nothing_starts_once_the_app_is_closing(self):
        subject = warm([])
        subject.close()

        self.assertFalse(subject.opened(reader(), caller(), source(), SCOPE))


class _quiet:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class PaceTests(unittest.TestCase):
    def test_calls_a_minute_are_shared_by_the_whole_app(self):
        clock = Clock()
        rate = prewarm.Rate(60, clock)

        waits = [rate.wait_time() for _ in range(61)]
        clock.now += 1

        self.assertEqual((waits[:60], waits[60] > 0, rate.wait_time()), ([0.0] * 60, True, 0.0))

    def test_a_background_call_waits_while_an_interactive_one_runs(self):
        gate = timeline.Gate(4, 2)
        order = []
        started = threading.Event()

        def background():
            started.set()
            with gate.background(lambda: None):
                order.append("background")

        with gate.interactive():
            thread = threading.Thread(target=background)
            thread.start()
            started.wait(1)
            time.sleep(0.05)
            order.append("interactive")
        thread.join(2)

        self.assertEqual(order, ["interactive", "background"])

    def test_a_background_call_gives_up_waiting_when_told_to(self):
        gate = timeline.Gate(4, 2)

        def stop():
            raise prewarm.Stop("shutdown")

        with gate.interactive(), self.assertRaises(prewarm.Stop):
            with gate.background(stop):
                pass


if __name__ == "__main__":
    unittest.main()
