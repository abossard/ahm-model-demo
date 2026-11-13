"""What a live hub saw of a model, kept until the day or week it belongs to has closed and then handed to the history
store as pieces (ADR 0011). Calculations and data only: the hub tells it what it read and when, and writes what it returns.

A day of a signal (or a week of an entity's transitions) is handed over only when the hub's polls covered all of it and
the safety margin after it, each poll ending no more than `gap` after the previous one began, and only for the signals
the hub can see every evaluation of (evaluated at most once per `min_refresh`) that were there at every poll of it, never
evaluated sooner than their refresh interval says and not around a change the app made to the model. The values are the
snapshot's latest evaluation of each signal, which is the newest point of the signal's history. The transitions are the
history's own, which the hub reads when it sees a state change; a week holds them only when every change seen in it was
found in the history."""

import math
import re
from array import array

import live_data
from config import CANONICAL_SIGNAL_NAME
from history_store import DAY_MS, WEEK_MS, bucket_start


DURATION = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?")
MAX_SPANS = 1000
MAX_HOLES = 50
# Two evaluations closer than this share of the refresh interval mean the signal was evaluated sooner than it says.
EARLY_SHARE = 0.9


def duration_ms(text):
    """An ISO 8601 duration such as PT1M in milliseconds, None when it is not one or is zero."""
    match = DURATION.fullmatch(text) if isinstance(text, str) else None
    if match is None:
        return None
    days, hours, minutes, seconds = (float(part or 0) for part in match.groups())
    total = int(((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000)
    return total or None


def recordable(structure, min_refresh_ms):
    """The (entity, signal) pairs a poll every `min_refresh_ms` or more often sees every evaluation of, with their refresh
    interval. Health reports arrive whenever someone sends one, so the report signal never is."""
    return {
        (entity["name"], signal["name"]): refresh
        for entity in structure or []
        for signal in entity.get("signals", [])
        if signal["name"] != CANONICAL_SIGNAL_NAME and (refresh := duration_ms(signal.get("refreshInterval")) or 0) >= min_refresh_ms
    }


def starts_around(t, size, before, after):
    """The pieces of `size` whose span, widened by `before` and `after`, holds `t`."""
    first = -(-(t - size - after) // size) * size
    return range(first, bucket_start(t + before, size) + 1, size)


class Coverage:
    """The stretches the hub watched: each a run of polls where one ended no more than `gap` after the previous one began.
    A stretch covers from the end of its first poll to the start of its last one, the times its snapshots surely show."""

    def __init__(self, gap_ms):
        self._gap = gap_ms
        self._spans = []

    def observed(self, started, ended):
        if self._spans and ended - self._spans[-1][1] <= self._gap:
            self._spans[-1][1] = started
        else:
            self._spans.append([ended, started])
            del self._spans[:-MAX_SPANS]

    def covers(self, start, end):
        return any(first <= start and end <= last for first, last in self._spans)

    def forget(self, before):
        self._spans = [span for span in self._spans[:-1] if span[1] >= before] + self._spans[-1:]


class Recorder:
    def __init__(self, gap_ms, min_refresh_ms, late_ms, max_points, max_transitions, states=True):
        self.coverage = Coverage(gap_ms)
        self._gap = gap_ms
        self._min_refresh = min_refresh_ms
        self._late = late_ms
        self._max_points = max_points
        self._max_transitions = max_transitions
        self._states = states
        self._points = {}
        self._count = 0
        self._signals = {}
        self._entities = {}
        self._transitions = {}
        self._holes = {}
        self._last = {}
        self._given_up = set()
        self._spoiled = set()

    @property
    def size(self):
        return self._count, sum(len(rows) for rows in self._transitions.values())

    def observed(self, started, ended, inventory, structure):
        """A poll that began at `started` and returned `inventory` at `ended` (epoch ms)."""
        self.coverage.observed(started, ended)
        refresh = recordable(structure, self._min_refresh)
        signals = frozenset(refresh)
        entities = frozenset(item["name"] for item in inventory["entities"])
        for day in starts_around(ended, DAY_MS, self._gap, self._late):
            self._signals[day] = signals & self._signals.get(day, signals)
        for week in starts_around(ended, WEEK_MS, self._gap, self._late):
            self._entities[week] = entities & self._entities.get(week, entities)
        for key, (t, value, state) in live_data.signal_marks(inventory).items():
            if key in signals:
                self._early(key, t, refresh[key])
                self._point(*key, t, value, state)
        while self._count > self._max_points:
            self._give_up(min(day for (_, _, day) in self._points), "signal")

    def _early(self, key, t, refresh_ms):
        """A new evaluation sooner after the last one than the refresh interval allows (or than a poll can tell apart): one
        between them may have been missed, so the days of both are not recorded for this signal."""
        last = self._last.get(key)
        self._last[key] = max(t, last or t)
        if last is not None and last < t and t - last < max(self._gap, refresh_ms * EARLY_SHARE):
            self._spoiled.update({(*key, bucket_start(last, DAY_MS)), (*key, bucket_start(t, DAY_MS))})

    def spoil(self, at):
        """The app changed the model at `at`: its signals may be evaluated out of turn, so the days around it are left to Azure."""
        for day in starts_around(at, DAY_MS, self._gap, self._late):
            self._give_up(day, "signal")

    def _point(self, entity, signal, t, value, state):
        day = bucket_start(t, DAY_MS)
        if ("signal", day) in self._given_up:
            return
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            self._spoiled.add((entity, signal, day))
            return
        times, values, states = self._points.setdefault((entity, signal, day), (array("q"), array("d"), bytearray()))
        number = math.nan if value is None else float(value)
        if times and t <= times[-1]:
            if t == times[-1]:
                values[-1], states[-1] = number, state
            return
        times.append(t)
        values.append(number)
        states.append(state)
        self._count += 1

    def transitions(self, rows):
        """Transitions the hub read from the history: kept by entity and week, each once."""
        for row in rows:
            week = bucket_start(row["t"], WEEK_MS)
            if ("states", week) in self._given_up:
                continue
            self._transitions.setdefault((row["entity"], week), {})[(row["t"], row["from"], row["to"])] = {key: row[key] for key in ("t", "from", "to", "reason")}
        while sum(len(rows) for rows in self._transitions.values()) > self._max_transitions:
            self._give_up(min(week for (_, week) in self._transitions), "states")

    def unsure(self, name, after, seen):
        """The hub saw `name` change at some time after `after` and up to `seen`, and has not found that in its history yet."""
        holes = self._holes.setdefault(name, [])
        holes.append((after, seen))
        if len(holes) > MAX_HOLES:
            self._holes[name] = [(min(hole[0] for hole in holes), max(hole[1] for hole in holes))]

    def confirmed(self, name, start):
        """The history of `name` was read from `start` and showed its latest change: the changes seen after `start` are in it."""
        holes = [hole for hole in self._holes.get(name, []) if hole[0] < start]
        if holes:
            self._holes[name] = holes
        else:
            self._holes.pop(name, None)

    def _hole_in(self, entity, start, end):
        return any(after <= end and seen >= start for after, seen in self._holes.get(entity, []))

    def _give_up(self, start, kind):
        self._given_up.add((kind, start))
        if kind == "signal":
            for key in [key for key in self._points if key[2] == start]:
                self._count -= len(self._points.pop(key)[0])
        else:
            for key in [key for key in self._transitions if key[1] == start]:
                del self._transitions[key]

    def closed(self, now):
        """The pieces of the days and weeks that closed by `now` and were watched whole, as (kind, entity, signal, start,
        rows). What closed without being watched whole is dropped: the history store reads it from Azure."""
        out = []
        for day in sorted({key[2] for key in self._points} | set(self._signals) | {start for kind, start in self._given_up if kind == "signal"}):
            end = day + DAY_MS
            if now < end + self._late:
                continue
            if ("signal", day) not in self._given_up and self.coverage.covers(day, end + self._late):
                for entity, signal in sorted(self._signals.get(day, ())):
                    series = self._points.get((entity, signal, day))
                    if series and series[0] and (entity, signal, day) not in self._spoiled:
                        out.append(("signal", entity, signal, day, {"points": rows_of(series), "reports": []}))
            for key in [key for key in self._points if key[2] == day]:
                self._count -= len(self._points.pop(key)[0])
            self._signals.pop(day, None)
            self._given_up.discard(("signal", day))
            self._spoiled = {key for key in self._spoiled if key[2] != day}
        for week in sorted({key[1] for key in self._transitions} | set(self._entities)):
            end = week + WEEK_MS
            if now < end + self._late:
                continue
            if self._states and ("states", week) not in self._given_up and self.coverage.covers(week, end + self._late):
                for entity in sorted(self._entities.get(week, ())):
                    if self._hole_in(entity, week - self._gap, end + self._late):
                        continue
                    rows = sorted(self._transitions.get((entity, week), {}).values(), key=lambda row: row["t"])
                    out.append(("states", entity, None, week, {"transitions": rows}))
            for key in [key for key in self._transitions if key[1] == week]:
                del self._transitions[key]
            self._entities.pop(week, None)
            self._given_up.discard(("states", week))
        for name in list(self._holes):
            self._holes[name] = [hole for hole in self._holes[name] if hole[1] >= now - WEEK_MS - self._late - self._gap]
            if not self._holes[name]:
                del self._holes[name]
        self.coverage.forget(now - 2 * WEEK_MS)
        return out


def rows_of(series):
    times, values, states = series
    return [[t, None if math.isnan(value) else value, state] for t, value, state in zip(times, values, states)]
