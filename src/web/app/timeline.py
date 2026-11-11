import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from azure.core.exceptions import AzureError

from config import (
    CANONICAL_SIGNAL_NAME,
    CLOUDHEALTH_API_VERSION,
    TIMELINE_ANNOTATION_PAGE_SIZE,
    TIMELINE_ANNOTATION_PAGES,
    TIMELINE_CACHE_SIZE,
    TIMELINE_CALL_CONCURRENCY,
    TIMELINE_DEADLINE_SECONDS,
    TIMELINE_DEFAULT_SPAN_HOURS,
    TIMELINE_GLOBAL_CONCURRENCY,
    TIMELINE_LIVE_CACHE_SECONDS,
    TIMELINE_MAX_CALLS,
    TIMELINE_MAX_ENTITIES,
    TIMELINE_MAX_SERIES,
    TIMELINE_MIN_SPAN_SECONDS,
    TIMELINE_PAST_CACHE_SECONDS,
    TIMELINE_RETENTION_DAYS,
    TIMELINE_SIGNAL_PAGES,
    TIMELINE_STATE_PAGES,
    TIMELINE_STRUCTURE_CACHE_SECONDS,
)
from dto import context_fields, field, graph_dto, history_items, scalar, signal_group_values
from healthmodels import TtlCache, cached
import history_store


logger = logging.getLogger("ahm-demo")

STATE_CODES = {"Unknown": 0, "Healthy": 1, "Degraded": 2, "Unhealthy": 3, "Deleted": 4}
PARTS = ("states", "annotations", "reports", "signals")
DEFAULT_PARTS = ("states", "annotations", "reports")
QUERY_KEYS = ("from", "to", "include", "entity", "resolution")
MAX_RESOLUTION_SECONDS = 86400
RETENTION_MARGIN = timedelta(minutes=5)
SNAP_BY_SPAN = ((timedelta(hours=6), 60), (timedelta(days=2), 300), (timedelta(days=365), 900))
WINDOW_KEYS = ("startAt", "endAt", "top")


class TimelineRequestError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Skipped(Exception):
    def __init__(self, code, message, retryable):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def to_ms(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def from_ms(value):
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc)


def iso_ms(value):
    return from_ms(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(text, name):
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        raise TimelineRequestError("invalid_range", f"{name} must be an ISO 8601 time.") from None
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)


def snap_seconds(span):
    return next(seconds for limit, seconds in SNAP_BY_SPAN if span <= limit)


def parse_query(params, now):
    unknown = set(params) - set(QUERY_KEYS) - {"model", "resourceGroup", "subscription"}
    if unknown:
        raise TimelineRequestError("unsupported_query", "The timeline takes from, to, include, entity and resolution.")
    parts = tuple(part for part in (params.get("include") or ",".join(DEFAULT_PARTS)).split(",") if part)
    if not parts or any(part not in PARTS for part in parts):
        raise TimelineRequestError("invalid_include", f"include takes {', '.join(PARTS)}.")
    try:
        resolution = int(params.get("resolution") or 0)
    except ValueError:
        resolution = -1
    if not 0 <= resolution <= MAX_RESOLUTION_SECONDS:
        raise TimelineRequestError("invalid_resolution", "resolution is a number of seconds from 0 to 86400.")
    floor = now - timedelta(days=TIMELINE_RETENTION_DAYS) + RETENTION_MARGIN
    end = min(parse_time(params["to"], "to") if params.get("to") else now, now)
    start = parse_time(params["from"], "from") if params.get("from") else end - timedelta(hours=TIMELINE_DEFAULT_SPAN_HOURS)
    start = max(start, floor)
    if end - start < timedelta(seconds=TIMELINE_MIN_SPAN_SECONDS):
        raise TimelineRequestError("invalid_range", "The range must span at least one minute inside the last 30 days.")
    return {"parts": parts, "resolution": resolution, "start": start, "end": end, "floor": floor}


def snap_window(start, end, now, floor):
    quantum = snap_seconds(end - start)
    step = quantum * 1000
    start_ms = max(to_ms(start) // step * step, to_ms(floor))
    end_ms = -(-to_ms(end) // step) * step
    live = end_ms >= to_ms(now)
    return {"from": start_ms, "to": None if live else end_ms, "live": live}


def state_code(value):
    return STATE_CODES.get(scalar(value), 0)


def downsample(points, step_ms):
    if step_ms <= 0:
        return points
    buckets = {}
    for point in points:
        buckets.setdefault(point[0] // step_ms, []).append(point)
    kept = []
    for bucket in buckets.values():
        if len(bucket) <= 3:
            kept.extend(bucket)
            continue
        valued = [point for point in bucket if point[1] is not None]
        picks = [max(bucket, key=lambda point: point[2])]
        if valued:
            picks += [min(valued, key=lambda point: point[1]), max(valued, key=lambda point: point[1])]
        kept.extend({id(point): point for point in picks}.values())
    return sorted(kept, key=lambda point: point[0])


def rule_dto(rule):
    if rule is None:
        return None
    return {"operator": scalar(field(rule, "operator")), "threshold": field(rule, "threshold")}


def signal_catalog(entity):
    groups = field(field(entity, "properties"), "signal_groups", "signalGroups")
    catalog = []
    for group in signal_group_values(groups):
        for signal in field(group, "signals", default=[]) or []:
            rules = field(signal, "evaluation_rules", "evaluationRules")
            catalog.append(
                {
                    "name": field(signal, "name"),
                    "displayName": field(signal, "display_name", "displayName") or field(signal, "name"),
                    "kind": scalar(field(signal, "signal_kind", "signalKind")),
                    "unit": scalar(field(signal, "data_unit", "dataUnit")),
                    "refreshInterval": field(signal, "refresh_interval", "refreshInterval"),
                    "rules": {
                        "degraded": rule_dto(field(rules, "degraded_rule", "degradedRule")),
                        "unhealthy": rule_dto(field(rules, "unhealthy_rule", "unhealthyRule")),
                        "dynamic": field(rules, "dynamic_detection_rule", "dynamicDetectionRule") is not None,
                    },
                }
            )
    return catalog


def build_structure(raw_entities, relationships, model_name):
    graph = graph_dto(raw_entities, relationships, model_name)
    raw_by_name = {field(item, "name"): item for item in raw_entities}
    return [
        {
            "name": entity["name"],
            "displayName": entity["displayName"],
            "parents": entity["parents"],
            "state": state_code(entity["healthState"]),
            "signals": signal_catalog(raw_by_name[entity["name"]]),
        }
        for entity in graph["entities"]
    ]


def transition_row(item):
    return {
        "t": to_ms(field(item, "occurred_at", "occurredAt")),
        "from": state_code(field(item, "previous_state", "previousState")),
        "to": state_code(field(item, "new_state", "newState")),
        "reason": field(item, "reason"),
    }


def point_row(item):
    return [
        to_ms(field(item, "occurred_at", "occurredAt")),
        field(item, "value"),
        state_code(field(item, "health_state", "healthState")),
    ]


def report_row(item):
    context = context_fields(field(item, "additional_context", "additionalContext"))
    if not context:
        return None
    row = point_row(item)
    return {"t": row[0], "state": row[2], "value": row[1], "reason": context["reason"], "reportId": context["reportId"]}


def annotation_row(item):
    created = field(item, "created_at", "createdAt")
    if created is None:
        return None
    return {
        "id": field(item, "annotation_id", "annotationId"),
        "t": to_ms(created),
        "description": field(item, "description"),
        "details": dict(field(item, "annotation_details", "annotationDetails") or {}),
    }


def series_error(error):
    status = getattr(error, "status_code", None) or getattr(getattr(error, "response", None), "status_code", None)
    table = {
        401: ("forbidden", "Azure refused the sign-in for this history.", False),
        403: ("forbidden", "Your account cannot read this history.", False),
        404: ("not_found", "This history does not exist.", False),
        429: ("busy", "Azure is temporarily busy.", True),
    }
    code, message, retryable = table.get(status, ("unavailable", "This history is temporarily unavailable.", True))
    return {"code": code, "message": message, "retryable": retryable}


class Budget:
    def __init__(self, calls, deadline, clock):
        self._left = calls
        self._deadline = deadline
        self._clock = clock
        self._lock = threading.Lock()

    def take(self):
        with self._lock:
            if self._left <= 0:
                return False
            self._left -= 1
            return True

    def expired(self):
        return self._clock() >= self._deadline


class TimelineReader:
    def __init__(self, clock=time.monotonic, now=lambda: datetime.now(timezone.utc), history=None, structure=None):
        self._history = history
        self._hub_structure = structure
        self._clock = clock
        self._now = now
        self._gate = threading.BoundedSemaphore(TIMELINE_GLOBAL_CONCURRENCY)
        self._structures = TtlCache(64, TIMELINE_STRUCTURE_CACHE_SECONDS, clock)
        self._live = TtlCache(TIMELINE_CACHE_SIZE, TIMELINE_LIVE_CACHE_SECONDS, clock)
        self._past = TtlCache(TIMELINE_CACHE_SIZE, TIMELINE_PAST_CACHE_SECONDS, clock)

    def read(self, caller, user, selection, params, names=()):
        now = self._now()
        query = parse_query(params, now)
        subscription, group, model = selection
        client = user.client(subscription)
        scope = (caller.owner, subscription.casefold(), group.casefold(), model.casefold())
        structure = (self._hub_structure(selection) if self._hub_structure else None) or cached(
            self._structures, scope, lambda: self._read_structure(client, group, model)
        )
        wanted = self._wanted(structure, names)
        window = snap_window(query["start"], query["end"], now, query["floor"])
        jobs = self._jobs(wanted, query["parts"])
        if sum(1 for job in jobs if job[0] == "signal") > TIMELINE_MAX_SERIES:
            raise TimelineRequestError(
                "too_many_series", f"Ask for at most {TIMELINE_MAX_SERIES} signals at a time: pass entity to narrow the request."
            )
        budget = Budget(TIMELINE_MAX_CALLS, self._clock() + TIMELINE_DEADLINE_SECONDS, self._clock)
        cache = self._live if window["live"] else self._past
        results = self._run(jobs, lambda job: self._job(cache, scope, client, group, model, window, budget, job))
        return self._assemble(model, now, window, query, wanted, jobs, results)

    def read_tail(self, user, selection, since, annotation_names):
        """The newest transitions of some entities, from a time each, and the newest annotations of others: what the live feed adds to a snapshot."""
        subscription, group, model = selection
        client = user.client(subscription)
        budget = Budget(TIMELINE_MAX_CALLS, self._clock() + TIMELINE_DEADLINE_SECONDS, self._clock)
        jobs = [("states", name, from_ms(t)) for name, t in since.items()] + [
            ("annotations", name, from_ms(to_ms(self._now()) - 15 * 60_000)) for name in annotation_names
        ]

        def run(job):
            kind, name, start = job
            first = {"startAt": start}
            if kind == "states":
                rows, _ = self._pages(lambda body: client.entities.get_history(group, model, name, body), first, 1, budget)
                return [{"entity": name, **transition_row(row)} for row in rows]
            first["top"] = TIMELINE_ANNOTATION_PAGE_SIZE
            rows, _ = self._pages(
                lambda body: client.entities.get_data_annotations(group, model, name, body),
                first,
                1,
                budget,
                lambda response: list(field(response, "annotations", default=[]) or []),
            )
            return [{"entity": name, **row} for row in filter(None, map(annotation_row, rows))]

        found = {"transitions": [], "annotations": []}
        for job, rows in zip(jobs, self._run(jobs, run)):
            found["transitions" if job[0] == "states" else "annotations"].extend(rows)
        return found

    def _read_structure(self, client, group, model):
        entities = list(client.entities.list_by_health_model(group, model))
        relationships = client.relationships.list_by_health_model(group, model)
        return build_structure(entities, relationships, model)

    def _wanted(self, structure, names):
        if not names:
            return structure
        known = {entity["name"]: entity for entity in structure}
        unique = list(dict.fromkeys(names))
        missing = [name for name in unique if name not in known]
        if missing or len(unique) > TIMELINE_MAX_ENTITIES:
            raise TimelineRequestError("unknown_entity", "Every entity must exist in the selected Health Model.")
        return [known[name] for name in unique]

    def _jobs(self, wanted, parts):
        jobs = []
        for entity in wanted:
            name = entity["name"]
            if "states" in parts:
                jobs.append(("states", name, None))
            if "annotations" in parts:
                jobs.append(("annotations", name, None))
            signals = [signal["name"] for signal in entity["signals"]]
            for signal in signals:
                if "signals" in parts or (signal == CANONICAL_SIGNAL_NAME and "reports" in parts):
                    jobs.append(("signal", name, signal))
        return jobs

    def _run(self, jobs, run):
        if not jobs:
            return []
        with ThreadPoolExecutor(max_workers=min(TIMELINE_CALL_CONCURRENCY, len(jobs))) as pool:
            return list(pool.map(run, jobs))

    def _job(self, cache, scope, client, group, model, window, budget, job):
        kind, entity, signal = job
        key = (*scope, kind, entity, signal, window["from"], window["to"])
        try:
            return cached(cache, key, lambda: self._load(kind, client, group, model, entity, signal, window, budget, scope[1:]))
        except Skipped as skipped:
            return {"error": {"code": skipped.code, "message": skipped.message, "retryable": skipped.retryable}}
        except AzureError as error:
            logger.warning("timeline history failed kind=%s status=%s", kind, getattr(error, "status_code", None))
            return {"error": series_error(error), "cause": error}

    def _load(self, kind, client, group, model, entity, signal, window, budget, model_scope):
        """One history over a window. Whole days (or weeks) that are over are read once and kept; the open tail is always read."""
        if self._history is None:
            return self._load_raw(kind, client, group, model, entity, signal, window, budget)
        size = history_store.BUCKET_MS[kind]
        now_ms = to_ms(self._now())
        limit = history_store.closed_before(now_ms, size)
        start, end = window["from"], now_ms if window["to"] is None else window["to"]
        floor_ms = now_ms - TIMELINE_RETENTION_DAYS * 24 * 3600 * 1000 + int(RETENTION_MARGIN.total_seconds() * 1000)
        parts, complete, earliest = [], True, None
        tail_start = max(start, limit)
        if tail_start < end:
            tail = self._load_raw(kind, client, group, model, entity, signal, {**window, "from": tail_start}, budget)
            parts.append(tail)
            complete, earliest = tail["complete"], tail.get("earliest")
        if complete:
            for first, last in history_store.buckets(start, end, size, limit):
                name = history_store.blob_name(model_scope, kind, entity, signal, first)
                found = self._history.get(name)
                if found is None:
                    try:
                        # The service refuses a start more than 30 days back: the oldest bucket is read from the floor and, being partial, not kept.
                        raw = self._load_raw(kind, client, group, model, entity, signal, {"from": max(first, floor_ms), "to": last, "live": False}, budget)
                    except Skipped:
                        if not parts:
                            raise
                        complete, earliest = False, self._oldest(kind, parts)
                        break
                    if raw["complete"]:
                        if first >= floor_ms:
                            self._history.put(name, {part: raw[part] for part in history_store.PARTS[kind]})
                    else:
                        parts.append(raw)
                        complete, earliest = False, raw.get("earliest")
                        break
                    found = raw
                parts.append(found)
        merged = history_store.merge_parts(kind, parts)
        for part, rows in merged.items():
            time_of = history_store.KEYS[part]
            merged[part] = [row for row in rows if start <= time_of(row) <= end]
        return {**merged, "complete": complete, "earliest": earliest if not complete else self._oldest(kind, [merged])}

    def _oldest(self, kind, parts):
        rows = parts[-1].get(history_store.PARTS[kind][0], []) if parts else []
        for part in parts:
            for row in part.get(history_store.PARTS[kind][0], []):
                t = history_store.KEYS[history_store.PARTS[kind][0]](row)
                if not rows or t < history_store.KEYS[history_store.PARTS[kind][0]](rows[0]):
                    rows = [row]
        return history_store.KEYS[history_store.PARTS[kind][0]](rows[0]) if rows else None

    def _load_raw(self, kind, client, group, model, entity, signal, window, budget):
        first = {"startAt": from_ms(window["from"])}
        if window["to"] is not None:
            first["endAt"] = from_ms(window["to"])
        entities = client.entities
        if kind == "states":
            rows, complete = self._pages(lambda body: entities.get_history(group, model, entity, body), first, TIMELINE_STATE_PAGES, budget)
            items = sorted((transition_row(row) for row in rows), key=lambda row: row["t"])
            return {"transitions": items, "complete": complete, "earliest": items[0]["t"] if items else None}
        if kind == "annotations":
            first["top"] = TIMELINE_ANNOTATION_PAGE_SIZE
            rows, complete = self._pages(
                lambda body: entities.get_data_annotations(group, model, entity, body),
                first,
                TIMELINE_ANNOTATION_PAGES,
                budget,
                lambda response: list(field(response, "annotations", default=[]) or []),
            )
            items = sorted(filter(None, map(annotation_row, rows)), key=lambda row: row["t"])
            return {"items": items, "complete": complete}
        first["signalName"] = signal
        rows, complete = self._pages(
            lambda body: entities.get_signal_history(group, model, entity, body), first, TIMELINE_SIGNAL_PAGES, budget
        )
        points = sorted((point_row(row) for row in rows), key=lambda point: point[0])
        reports = sorted(filter(None, map(report_row, rows)), key=lambda row: row["t"]) if signal == CANONICAL_SIGNAL_NAME else []
        return {"points": points, "reports": reports, "complete": complete, "earliest": points[0][0] if points else None}

    def _pages(self, call, first, max_pages, budget, items=history_items):
        rows = []
        body = first
        pages = 0
        while True:
            if budget.expired():
                raise Skipped("deadline", "The history was not read in time.", True)
            if not budget.take():
                if pages:
                    return rows, False
                raise Skipped("call_budget", "Too many Azure calls for one request: ask for fewer entities.", True)
            with self._gate:
                response = call(body)
            pages += 1
            rows.extend(items(response))
            marker = field(response, "next_marker", "nextMarker")
            if not marker:
                return rows, True
            if pages >= max_pages:
                return rows, False
            body = {"nextMarker": marker, **{key: value for key, value in first.items() if key not in WINDOW_KEYS}}

    def _assemble(self, model, now, window, query, wanted, jobs, results):
        step = query["resolution"] * 1000
        out = {"states": [], "series": [], "annotations": [], "reports": [], "failures": []}
        failures = []
        for (kind, entity, signal), result in zip(jobs, results):
            error = result.get("error")
            if kind == "states":
                out["states"].append({"entity": entity, **self._body(result, "transitions")})
            elif kind == "annotations":
                self._fold(out, "annotations", entity, result)
            elif signal == CANONICAL_SIGNAL_NAME and "reports" in query["parts"]:
                self._fold(out, "reports", entity, {**result, "items": result.get("reports", [])})
            if kind == "signal" and "signals" in query["parts"]:
                body = self._body(result, "points")
                if not error:
                    body["points"] = downsample(body["points"], step)
                out["series"].append({"entity": entity, "signal": signal, **body})
            if error:
                failures.append(result)
        if jobs and all("cause" in result for result in results):
            raise results[0]["cause"]
        partial = bool(failures) or any(not item.get("complete", True) for item in out["states"] + out["series"])
        return {
            "model": model,
            "observedAt": iso_ms(to_ms(now)),
            "range": {"from": iso_ms(window["from"]), "to": iso_ms(to_ms(now) if window["to"] is None else window["to"])},
            "retentionDays": TIMELINE_RETENTION_DAYS,
            "resolution": query["resolution"],
            "apiVersion": CLOUDHEALTH_API_VERSION,
            "entities": wanted,
            "states": out["states"],
            "annotations": out["annotations"],
            "reports": out["reports"],
            "series": out["series"],
            "failures": out["failures"],
            "partial": partial,
        }

    def _body(self, result, key):
        if "error" in result:
            return {key: [], "complete": False, "earliest": None, "error": result["error"]}
        return {key: result[key], "complete": result["complete"], "earliest": result["earliest"]}

    def _fold(self, out, part, entity, result):
        if "error" in result:
            out["failures"].append({"entity": entity, "part": part, "error": result["error"]})
            return
        out[part].extend({"entity": entity, **item} for item in result["items"])
        if not result["complete"]:
            out["failures"].append(
                {"entity": entity, "part": part, "error": {"code": "truncated", "message": "Older entries were not read.", "retryable": False}}
            )
