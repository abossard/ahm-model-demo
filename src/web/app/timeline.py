import hashlib
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from azure.core.exceptions import AzureError

from config import (
    CANONICAL_SIGNAL_NAME,
    CLOUDHEALTH_API_VERSION,
    HISTORY_SAFETY_SECONDS,
    PREWARM_CONCURRENCY,
    PREWARM_GLOBAL_CONCURRENCY,
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
from healthmodels import MISSING, TtlCache, cached
import history_store


logger = logging.getLogger("ahm-demo")

STATE_CODES = {"Unknown": 0, "Healthy": 1, "Degraded": 2, "Unhealthy": 3, "Deleted": 4}
PARTS = ("structure", "states", "annotations", "reports", "signals")
DEFAULT_PARTS = ("structure", "states", "annotations", "reports")
QUERY_KEYS = ("from", "to", "include", "entity", "signal", "resolution")
MAX_RESOLUTION_SECONDS = 86400
# How bad a state is when one point stands for several: a gap in the data ranks above Healthy and below Degraded.
SEVERITY = {1: 1, 4: 1, 0: 1.5, 2: 2, 3: 3}
DECIMATE_ABOVE = 5
ETAG_VERSION = "t1"
# A closed window is kept by the browser and checked again on every use, so the access check still runs.
CLOSED_CACHE_CONTROL = "private, no-cache"
RETENTION_MARGIN = timedelta(minutes=5)
RETENTION_MARGIN_MS = int(RETENTION_MARGIN.total_seconds() * 1000)
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
        raise TimelineRequestError("unsupported_query", "The timeline takes from, to, include, entity, signal and resolution.")
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
    asked = (params.get("from") or "", params.get("to") or "")
    return {"parts": parts, "resolution": resolution, "start": start, "end": end, "floor": floor, "asked": asked}


def snap_window(start, end, now, floor):
    quantum = snap_seconds(end - start)
    step = quantum * 1000
    start_ms = max(to_ms(start) // step * step, to_ms(floor))
    end_ms = -(-to_ms(end) // step) * step
    live = end_ms >= to_ms(now)
    return {"from": start_ms, "to": None if live else end_ms, "live": live}


def state_code(value):
    return STATE_CODES.get(scalar(value), 0)


def decimate(points, step_ms):
    """At most five real points per slot of `step_ms`: the last of each half, so the kept points stay evenly spaced and a
    reader that joins a point to the next one sees no hole, then the lowest and the highest value and the worst state."""
    if step_ms <= 0:
        return points
    kept = []
    slot, index = [], None

    def flush():
        if len(slot) <= DECIMATE_ABOVE:
            kept.extend(slot)
            return
        middle = index * step_ms + step_ms // 2
        early = [point for point in slot if point[0] < middle]
        picks = [slot[-1]] + early[-1:]
        valued = [point for point in slot if point[1] is not None]
        if valued:
            picks += [min(valued, key=lambda point: point[1]), max(valued, key=lambda point: point[1])]
        worst = max(slot, key=lambda point: SEVERITY.get(point[2], 0))
        if SEVERITY.get(worst[2], 0) > max(SEVERITY.get(point[2], 0) for point in picks):
            picks.append(worst)
        kept.extend(sorted({id(point): point for point in picks}.values(), key=lambda point: point[0]))

    for point in points:
        if point[0] // step_ms != index:
            flush()
            slot, index = [], point[0] // step_ms
        slot.append(point)
    flush()
    return kept


def matches(header, etag):
    """Whether an If-None-Match header names the validator, strong or weak."""
    if not header or not etag:
        return False
    names = [name.strip().removeprefix("W/") for name in header.split(",")]
    return "*" in names or etag in names


def validator(scope, query, window, jobs, closed_before_ms):
    """The ETag of an answer that can never change: a window that closed a safety margin ago, without the model's structure.
    It names the request, not the bytes, so it is known before anything is read."""
    if window["to"] is None or window["to"] > closed_before_ms or "structure" in query["parts"] or not jobs:
        return None
    identity = [ETAG_VERSION, CLOUDHEALTH_API_VERSION, *scope, *query["asked"], window["from"], window["to"], query["resolution"], sorted(query["parts"]), sorted(query["only"]), jobs]
    return f'"{hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode("utf-8")).hexdigest()[:32]}"'


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


def levels_of(kind, rows):
    """The rows of a piece at every level it is kept at: a signal also thinned to the slots of each coarser level, with the
    same rule as an answer, so a stored level is what thinning every point would give."""
    if kind != "signal":
        return {0: rows}
    return {0: rows, **{level: {"points": decimate(rows["points"], level * 1000)} for level in history_store.LEVELS[1:]}}


def stored_level(query, window):
    """The level a request's series can be read at from storage: its resolution when that is a kept level and the window
    begins and ends on its slots, so no slot is cut. Else every point, thinned in the answer."""
    step = query["resolution"] * 1000
    if query["resolution"] not in history_store.LEVELS[1:] or window["from"] % step or (window["to"] is not None and window["to"] % step):
        return 0
    return query["resolution"]


class Gate:
    """The Azure calls the timeline makes at once across the app. A call made in the background waits while any interactive
    call waits or runs, and only a few run at a time."""

    def __init__(self, total, background):
        self._total = total
        self._background_limit = background
        self._cond = threading.Condition()
        self._busy = 0
        self._wanted = 0
        self._background = 0

    @contextmanager
    def interactive(self):
        with self._cond:
            self._wanted += 1
            self._cond.wait_for(lambda: self._busy < self._total)
            self._busy += 1
        try:
            yield
        finally:
            with self._cond:
                self._busy -= 1
                self._wanted -= 1
                self._cond.notify_all()

    @contextmanager
    def background(self, check):
        """`check` raises to give up waiting, and is asked every second."""
        with self._cond:
            while not self._cond.wait_for(lambda: self._wanted == 0 and self._background < self._background_limit and self._busy < self._total, 1.0):
                check()
            self._busy += 1
            self._background += 1
        try:
            yield
        finally:
            with self._cond:
                self._busy -= 1
                self._background -= 1
                self._cond.notify_all()


class Budget:
    def __init__(self, calls, deadline, clock, tally=None):
        self._left = calls
        self._deadline = deadline
        self._clock = clock
        self._lock = threading.Lock()
        self.tally = tally or history_store.Tally()

    def take(self):
        with self._lock:
            if self._left <= 0:
                return False
            self._left -= 1
            return True

    def expired(self):
        return self._clock() >= self._deadline

    def slot(self, gate):
        return gate.interactive()


class FillBudget:
    """The budget of a background fill: `pace` decides when a call may go, and raises when the fill has to stop."""

    def __init__(self, pace, tally):
        self._pace = pace
        self.tally = tally

    def take(self):
        self._pace.call()
        return True

    def expired(self):
        return False

    def slot(self, gate):
        return gate.background(self._pace.check)


class Prepared:
    def __init__(self, etag, read, tally):
        self.etag = etag
        self.read = read
        self.tally = tally

    def headers(self, body=None):
        """The headers of an answer the browser may keep: none for a window that is still open or an answer with holes."""
        if self.etag is None or (body is not None and (body["partial"] or body["failures"])):
            return {}
        return {"ETag": self.etag, "Cache-Control": CLOSED_CACHE_CONTROL}


class TimelineReader:
    def __init__(self, clock=time.monotonic, now=lambda: datetime.now(timezone.utc), history=None, structure=None):
        self._history = history
        self._hub_structure = structure
        self._clock = clock
        self._now = now
        self._gate = Gate(TIMELINE_GLOBAL_CONCURRENCY, PREWARM_GLOBAL_CONCURRENCY)
        self._structures = TtlCache(64, TIMELINE_STRUCTURE_CACHE_SECONDS, clock)
        self._live = TtlCache(TIMELINE_CACHE_SIZE, TIMELINE_LIVE_CACHE_SECONDS, clock)
        self._past = TtlCache(TIMELINE_CACHE_SIZE, TIMELINE_PAST_CACHE_SECONDS, clock)

    @property
    def keeps_history(self):
        return self._history is not None

    def read(self, caller, user, selection, params, names=(), signals=()):
        return self.prepare(caller, user, selection, params, names, signals).read()

    def prepare(self, caller, user, selection, params, names=(), signals=()):
        """One request, checked and laid out but not read: its validator is known before any history call."""
        now = self._now()
        query = {**parse_query(params, now), "only": frozenset(signals)}
        subscription, group, model = selection
        client = user.client(subscription)
        scope = (caller.owner, subscription.casefold(), group.casefold(), model.casefold())
        structure = (self._hub_structure(selection) if self._hub_structure else None) or cached(
            self._structures, scope, lambda: self._read_structure(client, group, model)
        )
        wanted, missing = self._wanted(structure, names)
        window = snap_window(query["start"], query["end"], now, query["floor"])
        jobs = self._jobs(wanted, query["parts"], query["only"])
        if sum(1 for job in jobs if job[0] == "signal") > TIMELINE_MAX_SERIES:
            raise TimelineRequestError(
                "too_many_series", f"Ask for at most {TIMELINE_MAX_SERIES} signals at a time: pass entity to narrow the request."
            )
        etag = None if missing else validator(scope[1:], query, window, jobs, to_ms(now) - HISTORY_SAFETY_SECONDS * 1000)
        tally = history_store.Tally()
        level = stored_level(query, window)

        def level_of(job):
            reports = job[2] == CANONICAL_SIGNAL_NAME and "reports" in query["parts"]
            return level if job[0] == "signal" and not reports else 0

        def read():
            budget = Budget(TIMELINE_MAX_CALLS, self._clock() + TIMELINE_DEADLINE_SECONDS, self._clock, tally)
            cache = self._live if window["live"] else self._past
            batch = history_store.Batch()
            results = self._run(jobs, lambda job: self._job(cache, scope, client, group, model, window, budget, job, level_of(job), batch))
            if len(batch):
                self._history.write(batch, tally)
            return self._assemble(model, now, window, query, wanted, jobs, results, missing)

        return Prepared(etag, read, tally)

    def read_tail(self, user, selection, since, annotation_names):
        """The newest transitions of some entities, from a time each, and the newest annotations of others: what the live feed adds to a snapshot."""
        subscription, group, model = selection
        client = user.client(subscription)
        budget = Budget(TIMELINE_MAX_CALLS, self._clock() + TIMELINE_DEADLINE_SECONDS, self._clock)
        jobs = [("states", name, from_ms(t)) for name, t in since.items()] + [
            ("annotations", name, from_ms(to_ms(self._now()) - 15 * 60_000)) for name in annotation_names
        ]

        def read(job):
            kind, name, start = job
            first = {"startAt": start}
            if kind == "states":
                rows, complete = self._pages(lambda body: client.entities.get_history(group, model, name, body), first, 1, budget)
                return [{"entity": name, **transition_row(row)} for row in rows], complete
            first["top"] = TIMELINE_ANNOTATION_PAGE_SIZE
            rows, complete = self._pages(
                lambda body: client.entities.get_data_annotations(group, model, name, body),
                first,
                1,
                budget,
                lambda response: list(field(response, "annotations", default=[]) or []),
            )
            return [{"entity": name, **row} for row in filter(None, map(annotation_row, rows))], complete

        def run(job):
            try:
                return read(job)
            except AzureError as error:
                if getattr(error, "status_code", None) == 404:  # an entity that is gone, such as one an Apply deleted, adds nothing and must not fail the others
                    return [], True
                raise

        found = {"transitions": [], "annotations": [], "cut": []}
        for job, (rows, complete) in zip(jobs, self._run(jobs, run)):
            found["transitions" if job[0] == "states" else "annotations"].extend(rows)
            if job[0] == "states" and not complete:
                found["cut"].append(job[1])
        return found

    def _read_structure(self, client, group, model):
        entities = list(client.entities.list_by_health_model(group, model))
        relationships = client.relationships.list_by_health_model(group, model)
        return build_structure(entities, relationships, model)

    def _wanted(self, structure, names):
        """The entities to read and the names that are not in the model. The unknown ones are reported per entity, as long as one is known:
        an Apply may have deleted an entity that a page with an older structure still asks for."""
        if not names:
            return structure, []
        known = {entity["name"]: entity for entity in structure}
        unique = list(dict.fromkeys(names))
        missing = [name for name in unique if name not in known]
        if len(missing) == len(unique) or len(unique) > TIMELINE_MAX_ENTITIES:
            raise TimelineRequestError("unknown_entity", "Every entity must exist in the selected Health Model.")
        return [known[name] for name in unique if name in known], missing

    def _jobs(self, wanted, parts, only=frozenset()):
        """What a request reads, one history each. `only` narrows the series to the signals with those names."""
        jobs = []
        for entity in wanted:
            name = entity["name"]
            if "states" in parts:
                jobs.append(("states", name, None))
            if "annotations" in parts:
                jobs.append(("annotations", name, None))
            signals = [signal["name"] for signal in entity["signals"]]
            for signal in signals:
                series = "signals" in parts and (not only or signal in only)
                if series or (signal == CANONICAL_SIGNAL_NAME and "reports" in parts):
                    jobs.append(("signal", name, signal))
        return jobs

    def _run(self, jobs, run):
        if not jobs:
            return []
        with ThreadPoolExecutor(max_workers=min(TIMELINE_CALL_CONCURRENCY, len(jobs))) as pool:
            return list(pool.map(run, jobs))

    def _job(self, cache, scope, client, group, model, window, budget, job, level=0, batch=None):
        kind, entity, signal = job
        key = (*scope, kind, entity, signal, level, window["from"], window["to"])
        try:
            return cached(cache, key, lambda: self._load(kind, client, group, model, entity, signal, window, budget, scope[1:], level, batch))
        except Skipped as skipped:
            return {"error": {"code": skipped.code, "message": skipped.message, "retryable": skipped.retryable}}
        except AzureError as error:
            logger.warning("timeline history failed kind=%s status=%s", kind, getattr(error, "status_code", None))
            return {"error": series_error(error), "cause": error}

    def _floor_ms(self, now_ms):
        return now_ms - TIMELINE_RETENTION_DAYS * 24 * 3600 * 1000 + int(RETENTION_MARGIN.total_seconds() * 1000)

    def _load(self, kind, client, group, model, entity, signal, window, budget, model_scope, level=0, batch=None):
        """One history over a window. Whole days (or weeks) that are over are read once and kept, at every level; the open
        tail is always read. A signal at a kept level is served as stored, already thinned."""
        if self._history is None:
            return self._load_raw(kind, client, group, model, entity, signal, window, budget)
        size = history_store.PIECE_MS[kind]
        now_ms = to_ms(self._now())
        limit = history_store.closed_before(now_ms, size)
        start, end = window["from"], now_ms if window["to"] is None else window["to"]
        floor_ms = self._floor_ms(now_ms)
        parts, complete, earliest = [], True, None
        tail_start = max(start, limit)
        if tail_start < end:
            tail = self._load_raw(kind, client, group, model, entity, signal, {**window, "from": tail_start}, budget)
            parts.append(tail)
            complete, earliest = tail["complete"], tail.get("earliest")
        if complete:
            for first, last in history_store.buckets(start, end, size, limit):
                found = self._stored(model_scope, kind, level, entity, signal, first, budget.tally, batch)
                if found is not None:
                    budget.tally.add("pieces_stored")
                else:
                    try:
                        # The service refuses a start more than 30 days back: the oldest piece is read from the floor and, being partial, not kept.
                        raw = self._load_raw(kind, client, group, model, entity, signal, {"from": max(first, floor_ms), "to": last, "live": False}, budget)
                    except Skipped:
                        if not parts:
                            raise
                        complete, earliest = False, self._oldest(kind, parts)
                        break
                    rows = history_store.within(kind, raw, first, last)
                    if not raw["complete"]:
                        parts.append(rows)
                        complete, earliest = False, raw.get("earliest")
                        break
                    budget.tally.add("pieces_read")
                    levels = levels_of(kind, rows)
                    if first >= floor_ms and batch is not None:
                        batch.add(model_scope, kind, entity, signal, first, history_store.AZURE, levels)
                    found = levels[level]
                parts.append(found)
        merged = history_store.merge_parts(kind, parts)
        for part, rows in merged.items():
            time_of = history_store.KEYS[part]
            merged[part] = [row for row in rows if start <= time_of(row) <= end]
        return {**merged, "complete": complete, "earliest": earliest if not complete else self._oldest(kind, [merged])}

    def _stored(self, model_scope, kind, level, entity, signal, start, tally, batch):
        """The rows of a closed piece at a level from the store, or None. A coarser level that is missing is thinned from the
        stored points, and a piece only the first layout holds is moved to this one: both are written with the batch."""
        found = self._history.piece(model_scope, kind, level, entity, signal, start, tally)
        if found is not None:
            return found[1]
        if level:
            raw = self._history.piece(model_scope, kind, 0, entity, signal, start, tally)
            if raw is not None:
                levels = levels_of(kind, raw[1])
                if batch is not None:
                    batch.add(model_scope, kind, entity, signal, start, raw[0], {key: rows for key, rows in levels.items() if key})
                return levels[level]
        old = self._history.legacy(model_scope, kind, entity, signal, start, tally)
        if old is None:
            return None
        levels = levels_of(kind, history_store.within(kind, old, start, start + history_store.PIECE_MS[kind]))
        if batch is not None:
            batch.add(model_scope, kind, entity, signal, start, history_store.AZURE, levels)
        return levels[level]

    def keep(self, selection, pieces):
        """What a live hub recorded of closed days and weeks, as (kind, entity, signal, start, rows): kept at every level,
        where Azure's own pieces are not."""
        if self._history is None:
            return
        model_scope = tuple(part.casefold() for part in selection)
        floor_ms = self._floor_ms(to_ms(self._now()))
        batch = history_store.Batch()
        for kind, entity, signal, start, rows in pieces:
            if start >= floor_ms:
                batch.add(model_scope, kind, entity, signal, start, history_store.RECORDED, levels_of(kind, rows))
        tally = history_store.Tally()
        self._history.write(batch, tally)
        logger.info("timeline recorded model=%s pieces=%d written=%d", selection[2], len(pieces), tally.counts()["written"])

    def fill(self, caller, user, selection, pace, tally):
        """Reads every closed piece of the last 30 days that the store lacks, newest first, as `user` and at the pace `pace`
        allows: the states and annotations of every entity by the week, then every signal by the day. `pace` raises to stop."""
        if self._history is None:
            return
        subscription, group, model = selection
        client = user.client(subscription)
        model_scope = tuple(part.casefold() for part in selection)
        budget = FillBudget(pace, tally)
        structure = self._hub_structure(selection) if self._hub_structure else None
        if not structure:
            structure = self._structures.get((caller.owner, *model_scope))
        if structure is MISSING or not structure:
            pace.call()
            pace.call()
            structure = self._read_structure(client, group, model)
        now_ms = to_ms(self._now())
        overview = [(kind, entity["name"], None) for entity in structure for kind in ("states", "annotations")]
        signals = [("signal", entity["name"], signal["name"]) for entity in structure for signal in entity["signals"]]
        for histories, size, level in ((overview, history_store.WEEK_MS, 0), (signals, history_store.DAY_MS, history_store.LEVELS[-1])):
            limit = history_store.closed_before(now_ms, size)
            for first, last in history_store.buckets(self._floor_ms(now_ms), limit, size, limit):
                # A fill takes a while: a piece that aged out of the 30 days on the way is no longer read.
                if first < self._floor_ms(to_ms(self._now())):
                    continue
                batch = history_store.Batch()
                missing = [job for job in histories if self._stored(model_scope, job[0], level, job[1], job[2], first, tally, batch) is None]
                tally.add("pieces_stored", len(histories) - len(missing))

                def one(job, first=first, last=last, batch=batch):
                    raw = self._fill_piece(job, client, group, model, first, last, budget, pace)
                    if raw is not None:
                        tally.add("pieces_read")
                        batch.add(model_scope, job[0], job[1], job[2], first, history_store.AZURE, levels_of(job[0], history_store.within(job[0], raw, first, last)))

                if missing:
                    pool = ThreadPoolExecutor(max_workers=min(PREWARM_CONCURRENCY, len(missing)))
                    try:
                        list(pool.map(one, missing))
                    finally:
                        pool.shutdown(wait=True, cancel_futures=True)
                        if len(batch):
                            self._history.write(batch, tally)
                elif len(batch):
                    self._history.write(batch, tally)

    def _fill_piece(self, job, client, group, model, first, last, budget, pace):
        """One piece read in full for a fill, or None when it is skipped. A busy service is waited out by `pace`, and a piece
        that ages out of the 30 days the service keeps is skipped without counting as a failure."""
        kind, entity, signal = job
        while True:
            if first < self._floor_ms(to_ms(self._now())):
                return None
            try:
                raw = self._load_raw(kind, client, group, model, entity, signal, {"from": first, "to": last, "live": False}, budget)
            except Exception as error:  # pace decides: wait and try again, skip this history, or stop the fill
                if getattr(error, "status_code", None) == 400 and first < self._floor_ms(to_ms(self._now())) + RETENTION_MARGIN_MS:
                    return None
                if pace.failed(error):
                    continue
                return None
            pace.succeeded()
            return raw if raw["complete"] else None

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
            with budget.slot(self._gate):
                response = call(body)
            budget.tally.add("azure_calls")
            pages += 1
            rows.extend(items(response))
            marker = field(response, "next_marker", "nextMarker")
            if not marker:
                return rows, True
            if pages >= max_pages:
                return rows, False
            body = {"nextMarker": marker, **{key: value for key, value in first.items() if key not in WINDOW_KEYS}}

    def _assemble(self, model, now, window, query, wanted, jobs, results, missing=()):
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
            if kind == "signal" and "signals" in query["parts"] and (not query["only"] or signal in query["only"]):
                body = self._body(result, "points")
                if not error:
                    body["points"] = decimate(body["points"], step)
                out["series"].append({"entity": entity, "signal": signal, **body})
            if error:
                failures.append(result)
        if jobs and all("cause" in result for result in results):
            raise results[0]["cause"]
        gone = {"code": "unknown_entity", "message": "This entity is not in the Health Model.", "retryable": False}
        for entity in missing:
            if "states" in query["parts"]:
                out["states"].append({"entity": entity, "transitions": [], "complete": False, "earliest": None, "error": gone})
            for part in ("annotations", "reports"):
                if part in query["parts"]:
                    out["failures"].append({"entity": entity, "part": part, "error": gone})
        partial = bool(failures) or bool(missing) or any(not item.get("complete", True) for item in out["states"] + out["series"])
        return {
            "model": model,
            "observedAt": iso_ms(to_ms(now)),
            "range": {"from": iso_ms(window["from"]), "to": iso_ms(to_ms(now) if window["to"] is None else window["to"])},
            "retentionDays": TIMELINE_RETENTION_DAYS,
            "resolution": query["resolution"],
            "apiVersion": CLOUDHEALTH_API_VERSION,
            "entities": wanted if "structure" in query["parts"] else [],
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
