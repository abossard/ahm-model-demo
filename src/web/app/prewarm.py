"""Fills the closed history a model lacks in the background when a user opens its timeline (ADR 0011).

The fill reads as that user, with the credential of the request that opened the model, so it reads nothing the user could
not. What it reads goes into the history store, which is keyed by model and is only served to a request that passed the
same access check as that user. One fill runs per model at a time, a few calls at a time, within a budget shared by the
whole app, after every interactive call, and it stops when the user's sign-in is about to expire, when the service stays
busy, or after errors."""

import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

from opentelemetry import trace
from opentelemetry.trace import SpanKind

import history_store
from config import (
    PREWARM_BUSY_RETRIES,
    PREWARM_BUSY_SECONDS,
    PREWARM_CALLS_PER_MINUTE,
    PREWARM_ERROR_LIMIT,
    PREWARM_MAX_BACKOFF_SECONDS,
    PREWARM_MAX_CALLS,
    PREWARM_MAX_FILLS,
    PREWARM_MODELS,
    PREWARM_RETRY_SECONDS,
    PREWARM_TOKEN_MARGIN_SECONDS,
)
from model_hub import credential_problem, retry_after, status_of


logger = logging.getLogger("ahm-demo")
tracer = trace.get_tracer("ahm-demo")


@dataclass(frozen=True)
class PrewarmSettings:
    calls_per_minute: int = PREWARM_CALLS_PER_MINUTE
    max_calls: int = PREWARM_MAX_CALLS
    max_fills: int = PREWARM_MAX_FILLS
    retry_seconds: float = PREWARM_RETRY_SECONDS
    busy_seconds: float = PREWARM_BUSY_SECONDS
    max_backoff_seconds: float = PREWARM_MAX_BACKOFF_SECONDS
    busy_retries: int = PREWARM_BUSY_RETRIES
    error_limit: int = PREWARM_ERROR_LIMIT
    token_margin_seconds: float = PREWARM_TOKEN_MARGIN_SECONDS
    models: int = PREWARM_MODELS


class Stop(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class Rate:
    """Calls a minute across the app, as a bucket that refills evenly and holds a minute's worth."""

    def __init__(self, per_minute, clock):
        self._per_minute = per_minute
        self._tokens = float(per_minute)
        self._at = clock()
        self._clock = clock
        self._lock = threading.Lock()

    def wait_time(self):
        """Takes a call and returns 0, or returns how many seconds to wait before asking again."""
        with self._lock:
            now = self._clock()
            self._tokens = min(self._per_minute, self._tokens + (now - self._at) * self._per_minute / 60)
            self._at = now
            if self._tokens >= 1:
                self._tokens -= 1
                return 0.0
            return (1 - self._tokens) * 60 / self._per_minute


class Pace:
    """When one fill may make its next call, and when it has to stop."""

    def __init__(self, prewarm, expires_at):
        self._prewarm = prewarm
        self._settings = prewarm.settings
        self._expires_at = expires_at
        self._busy = 0
        self._errors = 0
        self._stopped = None
        self._lock = threading.Lock()
        self.calls = 0
        # Set when the fill stops, for whatever reason: a worker that waits wakes at once.
        self.stopping = threading.Event()

    def stop(self, reason):
        self._stopped = self._stopped or reason
        self.stopping.set()
        raise Stop(self._stopped)

    def check(self):
        if self._prewarm.closing.is_set():
            self.stop("shutdown")
        if self._stopped:
            raise Stop(self._stopped)
        if self._expires_at is not None and self._prewarm.wall() >= self._expires_at - self._settings.token_margin_seconds:
            self.stop("token_expired")

    def call(self):
        with self._lock:
            if self.calls >= self._settings.max_calls:
                self.stop("budget")
            self.calls += 1
        while True:
            self.check()
            delay = self._prewarm.rate.wait_time()
            if not delay:
                return
            self.stopping.wait(delay)

    def failed(self, error):
        """True to read the piece again after waiting out a busy service, False to skip it. Raises Stop to end the fill."""
        if isinstance(error, Stop):
            raise error
        status = status_of(error)
        if credential_problem(error):
            self.stop("signed_out")
        if status == 403:
            self.stop("forbidden")
        if status == 404:
            return False
        if status in (429, 503):
            with self._lock:
                self._busy += 1
                busy = self._busy
            if busy > self._settings.busy_retries:
                self.stop("throttled")
            self.stopping.wait(min(self._settings.max_backoff_seconds, max(retry_after(error) or 0, self._settings.busy_seconds * busy)))
            self.check()
            return True
        with self._lock:
            self._errors += 1
            errors = self._errors
        logger.warning("timeline prewarm read failed status=%s type=%s", status, type(error).__name__)
        if errors >= self._settings.error_limit:
            self.stop("errors")
        return False

    def succeeded(self):
        with self._lock:
            self._busy = 0
            self._errors = 0


class Prewarm:
    def __init__(self, settings=None, clock=time.monotonic, wall=time.time, start=None):
        self.settings = settings or PrewarmSettings()
        self.clock = clock
        self.wall = wall
        self.rate = Rate(self.settings.calls_per_minute, clock)
        self.closing = threading.Event()
        self._paces = set()
        self._fills = OrderedDict()
        self._lock = threading.Lock()
        self._start = start or (lambda work: threading.Thread(target=work, name="timeline-prewarm", daemon=True).start())

    def opened(self, reader, caller, user, selection):
        """A user who passed the access check for `selection` reads its timeline: start a fill unless one runs, finished
        since the last day closed, or stopped a short while ago, or too many run. True when one was started. It never fails
        the request that asked."""
        try:
            return self._open(reader, caller, user, selection)
        except Exception as error:  # a fill is an extra: the request it came with goes on without it
            logger.warning("timeline prewarm not started model=%s type=%s", selection[2], type(error).__name__)
            return False

    def _open(self, reader, caller, user, selection):
        if not reader.keeps_history or self.closing.is_set():
            return False
        key = tuple(part.casefold() for part in selection)
        through = history_store.closed_before(int(self.wall() * 1000), history_store.DAY_MS)
        with self._lock:
            state = self._fills.get(key)
            if state is not None and (state["running"] or state["through"] >= through or self.clock() < state["retry_at"]):
                return False
            if sum(1 for item in self._fills.values() if item["running"]) >= self.settings.max_fills:
                return False
            self._fills[key] = {"running": True, "through": state["through"] if state else 0, "retry_at": 0.0}
            self._fills.move_to_end(key)
            for old in [name for name, item in self._fills.items() if not item["running"]][: max(0, len(self._fills) - self.settings.models)]:
                del self._fills[old]
        try:
            self._start(lambda: self._run(reader, caller, user, selection, key, through))
        except Exception:
            with self._lock:
                self._fills[key] = {"running": False, "through": state["through"] if state else 0, "retry_at": self.clock() + self.settings.retry_seconds}
            raise
        return True

    def running(self, selection):
        state = self._fills.get(tuple(part.casefold() for part in selection))
        return bool(state and state["running"])

    def close(self):
        self.closing.set()
        with self._lock:
            for pace in self._paces:
                pace.stopping.set()

    def _run(self, reader, caller, user, selection, key, through):
        pace = Pace(self, getattr(caller, "expires_at", None))
        with self._lock:
            self._paces.add(pace)
        tally = history_store.Tally()
        started = time.monotonic()
        outcome = "done"
        with tracer.start_as_current_span("healthmodel.timeline.prewarm", kind=SpanKind.CLIENT) as span:
            span.set_attribute("cloudhealth.operation", "timeline.prewarm")
            span.set_attribute("cloudhealth.model", selection[2])
            try:
                reader.fill(caller, user, selection, pace, tally)
            except Stop as stop:
                outcome = stop.reason
            except Exception as error:  # a fill that fails is retried later, it never takes the app down
                outcome = "failed"
                logger.warning("timeline prewarm failed model=%s type=%s", selection[2], type(error).__name__)
            counts = tally.counts()
            elapsed = int((time.monotonic() - started) * 1000)
            span.set_attribute("timeline.outcome", outcome)
            span.set_attribute("timeline.duration_ms", elapsed)
            for name, value in counts.items():
                span.set_attribute(f"timeline.{name}", value)
        with self._lock:
            self._paces.discard(pace)
            self._fills[key] = {
                "running": False,
                "through": through if outcome == "done" else self._fills.get(key, {}).get("through", 0),
                "retry_at": 0.0 if outcome == "done" else self.clock() + self.settings.retry_seconds,
            }
        logger.info(
            "timeline prewarm model=%s outcome=%s calls=%d read=%d stored=%d written=%d ms=%d",
            selection[2], outcome, counts["azure_calls"], counts["pieces_read"], counts["pieces_stored"], counts["written"], elapsed,
        )
