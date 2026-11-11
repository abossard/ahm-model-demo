"""How far back Explain reads: the current state by default, history for the asked entity in a bounded window.

The model has no clock and the Azure MCP server's own default is open-ended, so the window is set here, from the clock of
the agent: at most the last 24 hours, or the period the instruction names, never more than 30 days."""

from __future__ import annotations

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


def bounded_arguments(
    arguments: Mapping[str, Any], *, task_type: str, asked: str, instruction: str, now: datetime
) -> tuple[dict[str, Any], tuple[datetime, datetime] | None]:
    """The arguments of an inspect call with a bounded history window, or the same arguments when no history is read.
    Raises HistoryRefused for a read the rule does not allow. The second item is the window that will be read."""
    named = {re.sub(r"[-_]", "", str(key)).lower(): key for key in arguments}
    wanted = include_names(arguments.get(named.get("include", ""))) & HISTORY_INCLUDES
    if not wanted:
        return dict(arguments), None
    if task_type != "explain":
        raise HistoryRefused(f"{REFUSAL}: read the current state instead.")
    entity = arguments.get(named.get("entity", ""))
    if not isinstance(entity, str) or entity.lower() != asked:
        raise HistoryRefused(f"{REFUSAL}: pass `entity` '{asked}' and call again.")
    if wanted & {"signalhistory", "annotations"} and not asks_about_past(instruction):
        raise HistoryRefused(
            "SignalHistory and Annotations are read only when the instruction asks about the past. Use `History` of the asked "
            "entity, or answer from the current state."
        )
    start, end = history_window(now, instruction, instant(arguments.get(named.get("startat", ""))), instant(arguments.get(named.get("endat", ""))))
    bounded = {key: value for key, value in arguments.items() if re.sub(r"[-_]", "", str(key)).lower() not in ("walk", "startat", "endat", "timestamp")}
    bounded["start-at"], bounded["end-at"] = iso(start), iso(end)
    return bounded, (start, end)


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
