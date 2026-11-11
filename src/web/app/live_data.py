"""Pure logic of the live model feed: what changed between two observations, and the ids that let a stream resume."""

import re
from collections import deque
from datetime import datetime

from config import CANONICAL_SIGNAL_NAME


EVENT_ID = re.compile(r"([A-Za-z0-9]{4,16})-([0-9]{1,12})")
STATE_CODES = {"Unknown": 0, "Healthy": 1, "Degraded": 2, "Unhealthy": 3, "Deleted": 4}
MODEL_FIELDS = ("model", "reportOptions")


def format_event_id(epoch, seq):
    return f"{epoch}-{seq}"


def parse_event_id(text):
    match = EVENT_ID.fullmatch(text or "")
    return (match.group(1), int(match.group(2))) if match else None


def by_name(items):
    return {item["name"]: item for item in items}


def diff_part(old, new):
    old_by, new_by = by_name(old), by_name(new)
    upsert = [item for name, item in new_by.items() if old_by.get(name) != item]
    remove = [name for name in old_by if name not in new_by]
    return {key: value for key, value in (("upsert", upsert), ("remove", remove)) if value}


def diff_inventory(old, new):
    """What changed from one observation to the next, or None when nothing did. Items are whole entities and relationships."""
    delta = {}
    for part in ("entities", "relationships"):
        changed = diff_part(old[part], new[part])
        if changed:
            delta[part] = changed
    names = [item["name"] for item in new["entities"]]
    if names != [item["name"] for item in old["entities"]] and ("entities" in delta):
        delta["order"] = names
    model = {key: new["model"][key] for key in new["model"] if old["model"].get(key) != new["model"][key]}
    if model:
        delta["model"] = model
    if old.get("reportOptions") != new.get("reportOptions"):
        delta["reportOptions"] = new["reportOptions"]
    return delta or None


def apply_delta(inventory, delta):
    """The observation a delta leads to: the same rule the browser applies, kept here so the two can be tested against each other."""
    result = {**inventory, "model": {**inventory["model"], **delta.get("model", {})}}
    if "reportOptions" in delta:
        result["reportOptions"] = delta["reportOptions"]
    for part in ("entities", "relationships"):
        change = delta.get(part, {})
        removed = set(change.get("remove", []))
        upserts = by_name(change.get("upsert", []))
        items = [upserts.pop(item["name"], item) for item in inventory[part] if item["name"] not in removed]
        result[part] = items + list(upserts.values())
    if "order" in delta:
        position = {name: index for index, name in enumerate(delta["order"])}
        result["entities"] = sorted(result["entities"], key=lambda item: position.get(item["name"], len(position)))
    return result


def changed_states(old, new):
    """The entities whose health state changed, or that are new: where the history tail is worth reading."""
    before = {item["name"]: item["healthState"] for item in old["entities"]}
    return [item["name"] for item in new["entities"] if before.get(item["name"]) != item["healthState"]]


def to_ms(text):
    try:
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def signal_marks(inventory):
    """The latest evaluation of every signal: (entity, signal) to (time ms, value, state code)."""
    marks = {}
    for entity in inventory["entities"]:
        for signal in entity["signals"]:
            t = to_ms(signal.get("reportedAt"))
            if t is not None:
                marks[(entity["name"], signal["name"])] = (t, signal.get("value"), STATE_CODES.get(signal.get("healthState"), 0))
    return marks


def new_points(known, inventory):
    """The evaluations the inventory shows that `known` has not: new or revised ones. Returns the new marks and the points by series."""
    marks = signal_marks(inventory)
    series = {}
    for key, mark in marks.items():
        if known.get(key) != mark:
            series.setdefault(key[0], {}).setdefault(key[1], []).append([mark[0], mark[1], mark[2]])
    points = [
        {"entity": entity, "signal": signal, "points": rows}
        for entity, signals in series.items()
        for signal, rows in signals.items()
    ]
    return marks, points


def new_reports(known, inventory):
    """Health reports (the canonical signal's evaluations that carry a report id) that `known` has not seen."""
    reports = []
    for entity in inventory["entities"]:
        for signal in entity["signals"]:
            t = to_ms(signal.get("reportedAt"))
            if signal["name"] != CANONICAL_SIGNAL_NAME or t is None or not signal.get("reportId"):
                continue
            row = {
                "entity": entity["name"],
                "t": t,
                "state": STATE_CODES.get(signal.get("healthState"), 0),
                "value": signal.get("value"),
                "reason": signal.get("reason"),
                "reportId": signal["reportId"],
            }
            if (entity["name"], t, signal["reportId"]) not in known:
                reports.append(row)
    return reports


def merge_by_key(known, fetched, key):
    """The items of `fetched` that `known` does not have, by natural key; `known` is a set of keys and grows."""
    fresh = []
    for item in fetched:
        k = key(item)
        if k not in known:
            known.add(k)
            fresh.append(item)
    return fresh


def transition_key(row):
    return (row["entity"], row["t"], row["from"], row["to"])


def empty_timeline(timeline):
    return not any(timeline.get(part) for part in ("transitions", "points", "annotations", "reports"))


class Ring:
    """The last events of a hub, so a stream that dropped can resume without losing one."""

    def __init__(self, size):
        self._events = deque(maxlen=size)

    def append(self, seq, event):
        self._events.append((seq, event))

    def since(self, seq):
        """The events after `seq`, or None when the ring no longer reaches back that far."""
        if not self._events:
            return [] if seq == 0 else None
        oldest = self._events[0][0]
        if seq < oldest - 1:
            return None
        return [event for number, event in self._events if number > seq]
