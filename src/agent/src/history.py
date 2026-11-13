"""How far back Explain reads: the current state by default, history for the asked entity in a bounded window.

The model has no clock and the Azure MCP server's own default is open-ended, so the window is set here, from the clock of
the agent: at most the last 24 hours, or the period the instruction names, never more than 30 days.

A Task about a past moment (`asOf`) moves that clock: the model is read as it was at the moment, the window ends there, and
metrics, log queries and the activity log are read for that window instead of for now."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

HISTORY_INCLUDES = frozenset({"history", "signalhistory", "annotations"})
DEFAULT_WINDOW = timedelta(hours=24)
MAX_WINDOW = timedelta(days=30)
MIN_WINDOW = timedelta(minutes=1)
TOLERANCE = timedelta(seconds=90)
UNITS = {"minute": timedelta(minutes=1), "min": timedelta(minutes=1), "hour": timedelta(hours=1), "hr": timedelta(hours=1),
         "day": timedelta(days=1), "week": timedelta(weeks=1), "month": timedelta(days=30)}
NAMED_PERIODS = (
    (re.compile(r"\byesterday\b", re.IGNORECASE), timedelta(days=2)),
    (re.compile(r"\blast\s+night\b|\bovernight\b|\bearlier today\b", re.IGNORECASE), timedelta(hours=24)),
    (re.compile(r"\blast\s+week\b|\bthis\s+week\b|\bpast\s+week\b", re.IGNORECASE), timedelta(weeks=1)),
    (re.compile(r"\blast\s+month\b|\bpast\s+month\b", re.IGNORECASE), MAX_WINDOW),
)
COUNTED_PERIOD = re.compile(r"\b(\d+)\s*(minute|min|hour|hr|day|week|month)s?\b", re.IGNORECASE)
PAST = re.compile(
    r"\b(?:yesterday|last|ago|history|earlier|previous(?:ly)?|since|before|overnight|past|recent(?:ly)?|"
    r"what changed|when did|went (?:red|down|unhealthy)|turned|became)\b",
    re.IGNORECASE,
)
REFUSAL = "History is read only for an Explain Task, for the asked entity, with no `walk`"
# The service refuses a start older than what it keeps: a window that would begin there begins a little later.
HOUR_SPAN = timedelta(hours=1)
RETENTION_MARGIN = timedelta(minutes=5)
AGO = re.compile(r"\bago\(\s*([^()]*?)\s*\)", re.IGNORECASE)
NOW_CALL = re.compile(r"\bnow\(\s*([^()]*?)\s*\)", re.IGNORECASE)
SINCE_AGO = re.compile(r"\bTimeGenerated\s*>=?\s*ago\(\s*([^()]+?)\s*\)", re.IGNORECASE)
BOUNDED_ABOVE = re.compile(r"\bTimeGenerated\s*(?:<=?|\s+between\s*\()", re.IGNORECASE)
AGO_SPAN = re.compile(r"\bago\(\s*(\d+(?:\.\d+)?)\s*([dhm])\s*\)", re.IGNORECASE)
SPAN_UNIT = {"d": 24, "h": 1, "m": 1 / 60}


class HistoryRefused(Exception):
    """A read of history that the window rule does not allow. The message tells the model what to ask instead."""


def instant(text: Any) -> datetime | None:
    if not isinstance(text, str):
        return None
    try:
        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def period_named(instruction: str) -> timedelta | None:
    """The period of the past an instruction names ("last week", "3 days ago", "yesterday"), at most 30 days."""
    periods = [period for pattern, period in NAMED_PERIODS if pattern.search(instruction)]
    periods += [int(count) * UNITS[unit.lower()] for count, unit in COUNTED_PERIOD.findall(instruction)]
    return min(max(periods), MAX_WINDOW) if periods else None


def asks_about_past(instruction: str) -> bool:
    return bool(PAST.search(instruction)) or period_named(instruction) is not None


def include_names(value: Any) -> set[str]:
    items = value if isinstance(value, Sequence) and not isinstance(value, str) else str(value or "").split(",")
    return {re.sub(r"[^a-z]", "", str(item).lower()) for item in items} - {""}


def history_window(now: datetime, instruction: str, start_at: datetime | None, end_at: datetime | None) -> tuple[datetime, datetime]:
    """The window that is read: from the start asked for to the end asked for, inside the period the rule allows (the last
    24 hours, or the period the instruction names, up to now). The model has no clock: a start or an end outside the period,
    or a start after the end, is no start or end, and the period's own is used."""
    earliest = now - max(DEFAULT_WINDOW, period_named(instruction) or DEFAULT_WINDOW)
    end = end_at if end_at is not None and earliest + MIN_WINDOW <= end_at <= now else now
    start = start_at if start_at is not None and earliest <= start_at <= end - MIN_WINDOW else earliest
    return start, end


def plain_name(key: Any) -> str:
    """The name of an argument without separators and in lower case: `start-at` and `start_at` are `startat`."""
    return re.sub(r"[-_]", "", str(key)).lower()


def without(arguments: Mapping[str, Any], *names: str) -> dict[str, Any]:
    return {key: value for key, value in arguments.items() if plain_name(key) not in names}


def moment_window(now: datetime, as_of: datetime, instruction: str, start_at: datetime | None = None, end_at: datetime | None = None) -> tuple[datetime, datetime]:
    """The window a Task about the moment `as_of` reads: the same rule as `history_window`, counted from the moment instead
    of from now, and never from before what the service keeps."""
    start, end = history_window(min(as_of, now), instruction, start_at, end_at)
    return max(start, min(now - MAX_WINDOW + RETENTION_MARGIN, end - MIN_WINDOW)), end


def bounded_arguments(
    arguments: Mapping[str, Any], *, task_type: str, asked: str, instruction: str, now: datetime, as_of: datetime | None = None
) -> tuple[dict[str, Any], tuple[datetime, datetime] | None]:
    """The arguments of an inspect call with a bounded history window, or the same arguments when no history is read.
    Raises HistoryRefused for a read the rule does not allow. The second item is the window that will be read.

    For a Task about a past moment (`as_of`) every read is of the model as it was then (`timestamp`), and history is read
    for the window that ends there."""
    named = {plain_name(key): key for key in arguments}
    wanted = include_names(arguments.get(named.get("include", ""))) & HISTORY_INCLUDES
    moment = None if as_of is None else {"timestamp": iso(min(as_of, now))}
    if not wanted:
        return ({**without(arguments, "timestamp"), **moment} if moment else dict(arguments)), None
    if task_type != "explain":
        raise HistoryRefused(f"{REFUSAL}: read the current state instead.")
    entity = arguments.get(named.get("entity", ""))
    if not isinstance(entity, str) or entity.lower() != asked:
        raise HistoryRefused(f"{REFUSAL}: pass `entity` '{asked}' and call again.")
    if wanted & {"signalhistory", "annotations"} and as_of is None and not asks_about_past(instruction):
        raise HistoryRefused(
            "SignalHistory and Annotations are read only when the instruction asks about the past. Use `History` of the asked "
            "entity, or answer from the current state."
        )
    asked_window = (instant(arguments.get(named.get("startat", ""))), instant(arguments.get(named.get("endat", ""))))
    start, end = history_window(now, instruction, *asked_window) if as_of is None else moment_window(now, as_of, instruction, *asked_window)
    bounded = without(arguments, "walk", "startat", "endat", "timestamp")
    bounded["start-at"], bounded["end-at"] = iso(start), iso(end)
    return {**bounded, **(moment or {})}, (start, end)


def metric_arguments(arguments: Mapping[str, Any], *, as_of: datetime, instruction: str, now: datetime) -> dict[str, Any]:
    """A metrics query of a Task about a past moment: the window that ends at the moment instead of the last day before
    now. A start or an end the call names inside that window is kept."""
    named = {plain_name(key): key for key in arguments}
    start, end = moment_window(now, as_of, instruction, instant(arguments.get(named.get("starttime", ""))), instant(arguments.get(named.get("endtime", ""))))
    return {**without(arguments, "starttime", "endtime"), "start-time": iso(start), "end-time": iso(end)}


def query_at(query: str, as_of: datetime) -> str:
    """A KQL query as it would have run at `as_of`: `now()` and `ago()` count from that instant, and where the query takes
    everything since an `ago()`, it takes it up to that instant."""
    moment = f"datetime({iso(as_of)})"
    text = SINCE_AGO.sub(lambda found: f"TimeGenerated between (({moment} - {found[1]}) .. {moment})", query)
    text = AGO.sub(lambda found: f"({moment} - {found[1]})", text)
    return NOW_CALL.sub(lambda found: f"({moment} + {found[1]})" if found[1] else moment, text)


def hours_back(now: datetime, as_of: datetime, instruction: str) -> int:
    """How many hours before now the window of a Task about `as_of` begins: the server counts a log read back from now."""
    return max(1, math.ceil((now - moment_window(now, as_of, instruction)[0]) / timedelta(hours=1)))


def lookback_hours(arguments: Mapping[str, Any], query: object) -> float:
    """The lookback a log call asks for: its `hours`, or the longest `ago()` span its query names."""
    named = {plain_name(key): key for key in arguments}
    asked = arguments.get(named.get("hours", ""))
    spans = [float(found[1]) * SPAN_UNIT[found[2].lower()] for found in AGO_SPAN.finditer(query)] if isinstance(query, str) else []
    given = [float(asked)] if isinstance(asked, (int, float)) and not isinstance(asked, bool) else []
    return max(given + spans, default=0.0)


def log_arguments(arguments: Mapping[str, Any], *, as_of: datetime, instruction: str, now: datetime) -> dict[str, Any]:
    """A log query of a Task about a past moment: read far enough back to reach its window, with `now()` and `ago()` counted
    from the moment. The server reads up to now, so a query that does not stop at the moment itself is refused. A look at a
    table's columns (`getschema`) reads no rows and passes."""
    named = {plain_name(key): key for key in arguments}
    query = arguments.get(named.get("query", ""))
    reach = math.ceil((now - min(as_of, now)) / HOUR_SPAN + lookback_hours(arguments, query))
    bounded = {**without(arguments, "hours"), "hours": max(hours_back(now, as_of, instruction), reach)}
    if not isinstance(query, str):
        return bounded
    pinned = query_at(query, min(as_of, now))
    if not BOUNDED_ABOVE.search(pinned) and "getschema" not in pinned.lower():
        start, end = moment_window(now, as_of, instruction)
        raise HistoryRefused(
            f"This Task is about {iso(end)}, and a log query reads up to now unless it says otherwise. Add "
            f"`| where TimeGenerated between (datetime({iso(start)}) .. datetime({iso(end)}))` after the table, or a shorter "
            "range that ends there, and call again."
        )
    return {**bounded, named["query"]: pinned}


def activity_arguments(arguments: Mapping[str, Any], *, as_of: datetime, instruction: str, now: datetime) -> dict[str, Any]:
    """The activity log of a Task about a past moment: far enough back to reach its window. It has no end to set, so what
    happened after the moment comes back too."""
    return {**without(arguments, "hours"), "hours": hours_back(now, as_of, instruction)}


def widened(read: tuple[datetime, datetime] | None, window: tuple[datetime, datetime]) -> tuple[datetime, datetime]:
    """The period read so far: the earliest start and the latest end of every window this Task read."""
    return window if read is None else (min(read[0], window[0]), max(read[1], window[1]))


def window_problems(result: Mapping[str, Any], window: tuple[datetime, datetime] | None) -> list[str]:
    """An explain result names the window it read: `window` is there when history was read, with that window, and only then."""
    if result["kind"] != "explain":
        return []
    given = result.get("window")
    if window is None:
        return ["window: no history was read in this Task: leave `window` out"] if given is not None else []
    wanted = {"from": iso(window[0]), "to": iso(window[1])}
    start, end = instant((given or {}).get("from")), instant((given or {}).get("to"))
    if start and end and abs(start - window[0]) <= TOLERANCE and abs(end - window[1]) <= TOLERANCE:
        return []
    return [f"window: history was read for this period: set `window` to {wanted['from']} and {wanted['to']} as `from` and `to`"]
