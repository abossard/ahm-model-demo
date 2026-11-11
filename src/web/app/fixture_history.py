import base64
import json
import math
import zlib
from datetime import datetime, timedelta, timezone

from azure.core.exceptions import HttpResponseError


GRID_MS = 5 * 60 * 1000
HOUR_MS = 3600 * 1000
HISTORY_DAYS = 14
RETENTION_DAYS = 30
PAGE_SIZE = 1000
ANNOTATION_PAGE_SIZE = 100
REPORT_SIGNAL = "web-ui-health-report"
REPORT_EXPIRY_MS = 30 * 60 * 1000
STATES = ("Unknown", "Healthy", "Degraded", "Unhealthy")

# value = base + wobble, plus bumps. Bumps are (start offset from the anchor in hours, rise, hold, fall in hours, peak).
# The anchor is when the fixture backend started, so the last bump of each signal is an incident that is still going.
SPECS = {
    ("web-frontend", "http-5xx"): {"base": 0.25, "wobble": 0.35, "rules": (1, 5), "bumps": [(-30, 0.1, 0.2, 0.1, 6.0), (-1.6, 0.4, 5, 0, 0.6)]},
    ("orders-api", "order-errors"): {
        "base": 0.3,
        "wobble": 0.5,
        "rules": (1, 5),
        "bumps": [(-72, 0.2, 0.6, 0.4, 2.6), (-30, 0.2, 0.5, 0.2, 1.8), (-1.4, 0.5, 6, 0, 2.7)],
        "gaps": [(-26, -25.4)],
    },
    ("orders-db", "cpu"): {
        "base": 42,
        "wobble": 9,
        "rules": (80, 95),
        "bumps": [(-72, 0.6, 0.5, 0.7, 98.0), (-30, 0.3, 0.3, 0.3, 84.0), (-1.7, 0.25, 6, 0, 97.0)],
        "daily": 8,
    },
}
CHILDREN_OF_ROOT = (("orders-api", "order-errors"), ("orders-db", "cpu"))
REPORTS = [
    {"entity": "payments", "at": -1.55, "state": "Degraded", "value": 0.5, "reason": "Maintenance window"},
    {"entity": "payments", "at": -26, "state": "Healthy", "value": 1, "reason": "Recovered"},
]
ANNOTATIONS = [
    {"entity": "orders-db", "at": -1.7, "description": "Failover started", "details": {"phase": "start", "source": "runbook"}},
    {"entity": "orders-db", "at": -72, "description": "Failover started", "details": {"phase": "start", "source": "runbook"}},
    {"entity": "orders-db", "at": -70.8, "description": "Failover finished", "details": {"phase": "end", "source": "runbook"}},
    {"entity": "@root", "at": -30, "description": "Release 2026.11.10", "details": {"source": "deployment"}},
]


def bad_request(message):
    error = HttpResponseError(message=message)
    error.status_code = 400
    return error


def unit(key, index):
    value = zlib.crc32(f"{key}:{index}".encode())
    return (value * 2654435761 % 2**32) / 2**32


def bump(offset, rise, hold, fall, peak, hours):
    if hours < offset or hours > offset + rise + hold + fall:
        return 0.0
    if hours < offset + rise:
        return peak * math.sin((hours - offset) / rise * math.pi / 2)
    if hours <= offset + rise + hold:
        return peak
    return peak * math.cos((hours - offset - rise - hold) / fall * math.pi / 2)


def signal_value(entity, signal, spec, time_ms, anchor_ms):
    hours = (time_ms - anchor_ms) / HOUR_MS
    if any(start <= hours <= end for start, end in spec.get("gaps", ())):
        return None
    key = f"{entity}/{signal}"
    value = spec["base"] + (unit(key, time_ms // GRID_MS) - 0.5) * 2 * spec["wobble"]
    value += spec.get("daily", 0) * math.sin(hours / 24 * 2 * math.pi)
    lift = max((bump(*item, hours) for item in spec["bumps"]), default=0.0)
    value = max(value, lift + (unit(key, -time_ms // GRID_MS) - 0.5) * spec["wobble"] * 0.3)
    return round(max(value, 0.0), 2)


def judge(value, rules):
    if value is None:
        return "Unknown"
    degraded, unhealthy = rules
    return "Unhealthy" if value > unhealthy else "Degraded" if value > degraded else "Healthy"


def worst(states):
    known = [state for state in states if state != "Unknown"]
    return max(known, key=STATES.index) if known else "Unknown"


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


class LiveScript:
    """A slow incident that develops and recovers, once per period, so the live feed has something to push: orders-db climbs
    from healthy through degraded to unhealthy and back, and orders-api follows it a little later."""

    def __init__(self, now, period_seconds=240):
        self._now = now
        self.period = period_seconds
        self.start = now().timestamp()

    def phase(self, time_ms):
        return ((time_ms / 1000 - self.start) % self.period) / self.period

    def value(self, entity, signal, time_ms):
        phase = self.phase(time_ms)
        wobble = (unit(f"{entity}/{signal}", time_ms // 60_000) - 0.5) * 2
        if (entity, signal) == ("orders-db", "cpu"):
            level = 44 if phase < 0.15 else 44 + (phase - 0.15) / 0.2 * 44 if phase < 0.35 else 97 if phase < 0.6 else 97 - (phase - 0.6) / 0.2 * 45 if phase < 0.8 else 46
            return round(max(0.0, level + wobble * 1.5), 2)
        if (entity, signal) == ("orders-api", "order-errors"):
            level = 0.3 if phase < 0.3 else 3.2 if phase < 0.75 else 0.4
            return round(max(0.0, level + wobble * 0.2), 2)
        return round(max(0.0, 0.25 + wobble * 0.2), 2)


class FixtureHistory:
    def __init__(self, root, now=lambda: datetime.now(timezone.utc), live=None):
        self._now = now
        self._root = root
        self.live = live
        started = int(now().timestamp() * 1000)
        self.anchor_ms = started // GRID_MS * GRID_MS
        self.created_ms = self.anchor_ms - HISTORY_DAYS * 24 * HOUR_MS

    def now_ms(self):
        return int(self._now().timestamp() * 1000)

    def grid(self, start_ms, end_ms):
        first = -(-max(start_ms, self.created_ms) // GRID_MS) * GRID_MS
        last = min(end_ms, self.now_ms()) // GRID_MS * GRID_MS
        return range(first, last + 1, GRID_MS)

    def value_at(self, entity, signal, time_ms):
        if self.live is not None and time_ms > self.anchor_ms:
            return self.live.value(entity, signal, time_ms)
        return signal_value(entity, signal, SPECS[(entity, signal)], time_ms, self.anchor_ms)

    def signal_state(self, entity, signal, time_ms):
        return judge(self.value_at(entity, signal, time_ms), SPECS[(entity, signal)]["rules"])

    def reported(self, entity, time_ms):
        states = []
        for report in REPORTS:
            at = self.anchor_ms + int(report["at"] * HOUR_MS)
            if report["entity"] == entity and at <= time_ms < at + REPORT_EXPIRY_MS:
                states.append(report["state"])
        return states

    def entity_state(self, entity, time_ms):
        if time_ms < self.created_ms:
            return "Unknown"
        if entity == self._root:
            return "Degraded" if any(self.signal_state(*pair, time_ms) != "Healthy" for pair in CHILDREN_OF_ROOT) else "Healthy"
        own = [self.signal_state(name, signal, time_ms) for (name, signal) in SPECS if name == entity]
        return worst(own + self.reported(entity, time_ms) + (["Healthy"] if not own else []))

    def transitions(self, entity, start_ms, end_ms):
        previous = self.entity_state(entity, max(start_ms, self.created_ms) - GRID_MS)
        found = []
        for time_ms in self.grid(start_ms, end_ms):
            state = self.entity_state(entity, time_ms)
            if state != previous:
                found.append((time_ms, previous, state))
                previous = state
        return found

    def points(self, entity, signal, start_ms, end_ms):
        if (entity, signal) in SPECS:
            spec = SPECS[(entity, signal)]
            for time_ms in self.grid(start_ms, end_ms):
                value = self.value_at(entity, signal, time_ms)
                yield time_ms, value, judge(value, spec["rules"]), None
        if signal == REPORT_SIGNAL:
            for report in REPORTS:
                at = self.anchor_ms + int(report["at"] * HOUR_MS)
                if report["entity"] == entity and start_ms <= at <= end_ms:
                    context = json.dumps({"source": "health-pulse-web", "reportId": f"fixture-{at}", "reason": report["reason"]})
                    yield at, report["value"], report["state"], context

    def window(self, body):
        marker = body.get("nextMarker")
        if marker:
            if body.get("startAt") or body.get("endAt"):
                raise bad_request("nextMarker must not be combined with startAt or endAt.")
            return json.loads(base64.urlsafe_b64decode(marker))
        now = self._now()
        start = body.get("startAt") or now - timedelta(hours=24)
        end = body.get("endAt") or now
        if start < now - timedelta(days=RETENTION_DAYS):
            raise bad_request("The value for startAt cannot be more than 30 days in the past.")
        return {"start": int(start.timestamp() * 1000), "end": int(end.timestamp() * 1000), "skip": 0}

    def page(self, body, rows, limit, render):
        """Newest first, like the service, with an opaque marker for the next page."""
        window = self.window(body)
        ordered = sorted(rows(window["start"], window["end"]), key=lambda row: row[0], reverse=True)
        size = min(body.get("top") or limit, limit)
        chunk = ordered[window["skip"] : window["skip"] + size]
        more = window["skip"] + size < len(ordered)
        marker = base64.urlsafe_b64encode(json.dumps({**window, "skip": window["skip"] + size}).encode()).decode()
        return [render(row) for row in chunk], marker if more else None

    def get_history(self, entity, body):
        rows, marker = self.page(
            body,
            lambda start, end: self.transitions(entity, start, end),
            PAGE_SIZE,
            lambda row: {
                "occurredAt": datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc),
                "previousState": row[1],
                "newState": row[2],
                "reason": "ChildEntityTransition" if entity == self._root else "SignalTransition",
            },
        )
        return {"entityName": entity, "history": rows, "nextMarker": marker}

    def get_signal_history(self, entity, body):
        signal = body.get("signalName")
        rows, marker = self.page(
            body,
            lambda start, end: list(self.points(entity, signal, start, end)),
            PAGE_SIZE,
            lambda row: {
                "occurredAt": datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc),
                "healthState": row[2],
                **({"value": row[1]} if row[1] is not None else {}),
                **({"additionalContext": row[3]} if row[3] else {}),
            },
        )
        return {"entityName": entity, "signalName": signal, "history": rows, "nextMarker": marker}

    def get_data_annotations(self, entity, body):
        def found(start, end):
            for index, item in enumerate(ANNOTATIONS):
                at = self.anchor_ms + int(item["at"] * HOUR_MS)
                if item["entity"] in (entity, "@root" if entity == self._root else None) and start <= at <= end:
                    yield at, index

        rows, marker = self.page(
            body,
            lambda start, end: list(found(start, end)),
            ANNOTATION_PAGE_SIZE,
            lambda row: {
                "annotationId": f"fixture-{row[1]}",
                "createdAt": datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc),
                "description": ANNOTATIONS[row[1]]["description"],
                "annotationDetails": ANNOTATIONS[row[1]]["details"],
            },
        )
        return {"entityName": entity, "annotations": rows, "nextMarker": marker}
