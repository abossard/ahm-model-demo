"""Keeps the data of a health model warm, and pushes what changes, only while someone watches it (ADR 0007).

One hub per watched model. Its poller starts with the first viewer and stops a grace period after the last one leaves.
It reads Azure as one current viewer, with that viewer's on-behalf-of credential, and hands over to another viewer when
that one leaves or can no longer be exchanged. The data is shared among viewers that were each admitted by an access
check made as themselves, and that check is repeated. Every viewer has a bounded queue: one that cannot keep up is dropped
and told to start again from a snapshot.
"""

import asyncio
import logging
import secrets
import time
from types import SimpleNamespace
from dataclasses import dataclass

from azure.core.exceptions import AzureError, ClientAuthenticationError, HttpResponseError

import live_data
import recording
from config import (
    HISTORY_RECORD_MAX_POINTS,
    HISTORY_RECORD_MAX_TRANSITIONS,
    HISTORY_SAFETY_SECONDS,
    HUB_ACCESS_RECHECK_SECONDS,
    HUB_ANNOTATION_SECONDS,
    HUB_GRACE_SECONDS,
    HUB_MAX_BACKOFF_SECONDS,
    HUB_MAX_HUBS,
    HUB_MAX_STREAMS_PER_USER,
    HUB_MAX_SUBSCRIBERS,
    HUB_OVERLAP_MS,
    HUB_POLL_SECONDS,
    HUB_QUEUE_SIZE,
    HUB_READ_CONCURRENCY,
    HUB_RING_SIZE,
    HUB_TAIL_TRIES,
)
from obo import ConsentRequired, InteractionRequired


logger = logging.getLogger("ahm-demo")

BUSY_BACKOFF_SECONDS = 60
FORBIDDEN = {"code": "forbidden", "message": "Your account no longer has access to this Health Model.", "retryable": False}


@dataclass(frozen=True)
class HubSettings:
    poll_seconds: float = HUB_POLL_SECONDS
    grace_seconds: float = HUB_GRACE_SECONDS
    max_backoff_seconds: float = HUB_MAX_BACKOFF_SECONDS
    max_hubs: int = HUB_MAX_HUBS
    max_subscribers: int = HUB_MAX_SUBSCRIBERS
    max_streams_per_user: int = HUB_MAX_STREAMS_PER_USER
    queue_size: int = HUB_QUEUE_SIZE
    ring_size: int = HUB_RING_SIZE
    access_recheck_seconds: float = HUB_ACCESS_RECHECK_SECONDS
    annotation_seconds: float = HUB_ANNOTATION_SECONDS
    read_concurrency: int = HUB_READ_CONCURRENCY
    overlap_ms: int = HUB_OVERLAP_MS
    tail_tries: int = HUB_TAIL_TRIES
    record_late_ms: int = HISTORY_SAFETY_SECONDS * 1000
    record_max_points: int = HISTORY_RECORD_MAX_POINTS
    record_max_transitions: int = HISTORY_RECORD_MAX_TRANSITIONS


class Refusal(Exception):
    def __init__(self, status, code, message, retryable=True):
        super().__init__(message)
        self.status, self.code, self.message, self.retryable = status, code, message, retryable


def status_of(error):
    return getattr(error, "status_code", None) or getattr(getattr(error, "response", None), "status_code", None)


def retry_after(error):
    """The seconds the service asked to wait, when the client shows its Retry-After header as a number."""
    headers = getattr(getattr(error, "response", None), "headers", None) or {}
    value = headers.get("Retry-After")
    return int(value) if isinstance(value, str) and value.isdigit() else None


def credential_problem(error):
    """The exchange or the sign-in of the viewer that was reading failed: another viewer can read instead."""
    return isinstance(error, (InteractionRequired, ConsentRequired, ClientAuthenticationError)) or (
        isinstance(error, HttpResponseError) and status_of(error) == 401
    )


def key_of(selection):
    return tuple(part.casefold() for part in selection)


class Subscription:
    """What a route reads: the events to start with, then whatever the hub publishes, until the stream is closed."""

    def __init__(self, hub, member, initial):
        self._hub = hub
        self._member = member
        self.initial = initial

    async def next(self, timeout):
        """The next event, None after `timeout` seconds with nothing (time for a heartbeat), or a Closed."""
        member = self._member
        expires = member.expires_at
        if expires is not None:
            remaining = expires - self._hub.wall()
            if remaining <= 0:
                return Closed("reconnect", "token_expired")
            timeout = min(timeout, remaining)
        try:
            item = await asyncio.wait_for(member.queue.get(), timeout)
        except TimeoutError:
            return None
        return item

    def close(self):
        self._hub.leave(self._member)


@dataclass(frozen=True)
class Closed:
    """The stream ends: `reconnect` (token expired, take up again), `resync` (too slow, start from a snapshot) or `error`."""

    kind: str
    reason: str
    error: dict | None = None


class Member:
    def __init__(self, caller, user, expires_at, queue_size):
        self.caller = caller
        self.user = user
        self.expires_at = expires_at
        self.queue = asyncio.Queue(maxsize=queue_size + 1)
        self.live = False
        self.closed = False
        self.unreadable_until = 0.0
        self.checked_at = 0.0

    def finish(self, closed):
        """Ends the stream: whatever was queued is dropped, because the client starts over."""
        if self.closed:
            return
        self.closed = True
        self.live = False
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(closed)


class Hub:
    def __init__(self, manager, selection):
        self.manager = manager
        self.selection = selection
        self.settings = manager.settings
        self.epoch = secrets.token_hex(4)
        self.seq = 0
        self.ring = live_data.Ring(self.settings.ring_size)
        self.members = []
        self.inventory = None
        self.structure = None
        self.observed = 0.0
        self.marks = {}
        self.known_reports = set()
        self.known_transitions = set()
        self.known_annotations = set()
        self.last_transition = {}
        # Entities whose seen state change the history has not shown yet: when the earliest of them may have happened
        # (`after`), when the latest may have (`last`), and how often the history was read for it.
        self.pending = {}
        self.read_began = None
        self.tail_not_before = 0.0
        self.annotations_at = 0.0
        self.annotations_not_before = 0.0
        self.writing = set()
        self.checked_at = manager.clock()
        self.ready = asyncio.Event()
        self.failure = None
        self.task = None
        self.stop_handle = None
        self.wake = asyncio.Event()
        self.polling = asyncio.Lock()
        # A write by this app changed the model and no read since has shown it: do not serve the snapshot.
        self.dirty = False
        # Counts those writes. A read that began before the latest one may predate it and cannot clear `dirty`.
        self.generation = 0
        self.recorder = manager.recorder()

    # ----- viewers -----

    def wall(self):
        return self.manager.wall()

    def leave(self, member):
        member.finish(Closed("reconnect", "left"))
        if member in self.members:
            self.members.remove(member)
        if not self.members and self.stop_handle is None:
            loop = asyncio.get_running_loop()
            self.stop_handle = loop.call_later(self.settings.grace_seconds, self.stop_if_idle)

    def stop_if_idle(self):
        self.stop_handle = None
        if self.members:
            return
        self.stop()

    def stop(self):
        if self.task is not None:
            self.task.cancel()
            self.task = None
        if self.stop_handle is not None:
            self.stop_handle.cancel()
            self.stop_handle = None
        self.manager.forget(self)

    def catch_up(self, last_id):
        """What a viewer starts with: the events it missed, when the id it brings is of this hub and still in the ring, else a snapshot."""
        parsed = live_data.parse_event_id(last_id)
        if parsed is not None and parsed[0] == self.epoch:
            missed = self.ring.since(parsed[1])
            if missed is not None:
                return list(missed)
        return [{"id": live_data.format_event_id(self.epoch, self.seq), "event": "snapshot", "data": self.inventory}]

    # ----- publishing -----

    def publish(self, payload):
        self.seq += 1
        event = {"id": live_data.format_event_id(self.epoch, self.seq), "event": "delta", "data": payload}
        self.ring.append(self.seq, event)
        for member in list(self.members):
            if member.live:
                self.offer(member, event)

    def offer(self, member, event):
        if member.queue.qsize() >= self.settings.queue_size:
            logger.info("hub viewer dropped: queue full")
            member.finish(Closed("resync", "slow"))
            return
        member.queue.put_nowait(event)

    # ----- reading -----

    def readers(self):
        now = self.manager.clock()
        wall = self.wall()
        return [
            m
            for m in self.members
            if not m.closed and m.unreadable_until <= now and (m.expires_at is None or m.expires_at > wall + 5)
        ]

    async def run(self):
        """Polls at a fixed rate: the next read begins `delay` after the previous one began, whatever the work in between took."""
        delay = self.settings.poll_seconds
        while True:
            began = self.manager.clock()
            try:
                await self.cycle()
                delay = self.settings.poll_seconds
            except asyncio.CancelledError:
                raise
            except Exception as error:  # a poller that dies leaves viewers with stale data and no word
                delay = self.after_failure(error, delay)
            if self.failure is not None:
                return
            self.wake.clear()
            try:
                await asyncio.wait_for(self.wake.wait(), max(0.0, began + delay - self.manager.clock()))
            except TimeoutError:
                pass

    def after_failure(self, error, delay):
        """How long to wait before reading again. A first read that cannot be made by any viewer fails the viewers waiting for it."""
        status = status_of(error)
        logger.warning("hub read failed model=%s status=%s type=%s", self.selection[2], status, type(error).__name__)
        if self.inventory is None:
            if credential_problem(error) and self.readers():
                return 0.0
            self.fail(error)
            return delay
        if status in (429, 503):
            return min(self.settings.max_backoff_seconds, max(delay * 2, BUSY_BACKOFF_SECONDS))
        if credential_problem(error) and self.readers():
            return 0.0
        return min(self.settings.max_backoff_seconds, max(delay * 2, self.settings.poll_seconds))

    def fail(self, error):
        self.failure = error
        self.manager.forget(self)
        self.ready.set()

    async def cycle(self):
        await self.recheck_access()
        self.expire()
        readers = self.readers()
        if not readers:
            if not self.members:
                return
            raise ClientAuthenticationError(message="No viewer can be exchanged for Azure access.")
        reader = readers[0]
        try:
            async with self.polling:
                await self.poll(reader)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if credential_problem(error):
                reader.unreadable_until = self.manager.clock() + self.settings.max_backoff_seconds
            elif status_of(error) == 403 and self.inventory is not None:
                reader.finish(Closed("error", "forbidden", FORBIDDEN))
                self.members.remove(reader)
            raise

    def expire(self):
        wall = self.wall()
        for member in list(self.members):
            if member.expires_at is not None and member.expires_at <= wall:
                member.finish(Closed("reconnect", "token_expired"))
                self.members.remove(member)

    async def recheck_access(self):
        now = self.manager.clock()
        if now - self.checked_at < self.settings.access_recheck_seconds:
            return
        self.checked_at = now
        for member in list(self.members):
            try:
                allowed = await asyncio.to_thread(member.user.has_model, *self.selection)
            except Exception:  # a failed check is not a refusal: the viewer stays until a check says no
                continue
            if not allowed:
                member.finish(Closed("error", "forbidden", FORBIDDEN))
                self.members.remove(member)

    async def poll(self, reader):
        read = self.manager.read_state
        started = self.generation
        async with self.manager.semaphore:
            began = self.wall()
            inventory, structure = await asyncio.to_thread(read, reader.user, self.selection)
        self.observed = self.wall()
        if self.recorder is not None:
            self.recorder.observed(int(began * 1000), int(self.observed * 1000), inventory, structure)
        # A change this read shows happened after the previous read began.
        changed_after, self.read_began = self.read_began or int(began * 1000), int(began * 1000)
        old = self.inventory
        if old is None:
            self.inventory, self.structure = inventory, structure
            self.marks, _ = live_data.new_points({}, inventory)
            live_data.new_reports(self.known_reports, inventory)
            self.annotations_at = self.manager.clock()
            self.ready.set()
            return
        payload = live_data.diff_inventory(old, inventory) or {}
        self.marks, points = live_data.new_points(self.marks, inventory)
        reports = live_data.new_reports(self.known_reports, inventory)
        for row in reports:
            self.known_reports.add((row["entity"], row["t"], row["reportId"]))
        timeline = {"points": points, "reports": reports}
        # A health report can change a state and change it back between two polls: its entity's history is read too.
        timeline.update(await self.tail(reader, old, inventory, {row["entity"] for row in reports}, changed_after))
        if not live_data.empty_timeline(timeline):
            payload["timeline"] = {part: rows for part, rows in timeline.items() if rows}
        self.inventory, self.structure = inventory, structure
        if started == self.generation:
            self.dirty = False
        if payload:
            payload["observedAt"] = inventory["observedAt"]
            self.publish(payload)
        self.keep()

    def keep(self):
        """Hands the days and weeks that closed, watched whole, to the history store (ADR 0011), in a task of its own so the
        next poll does not wait for it."""
        if self.recorder is None:
            return
        pieces = self.recorder.closed(int(self.wall() * 1000))
        if not pieces:
            return
        task = asyncio.get_running_loop().create_task(self.write_kept(pieces))
        self.writing.add(task)
        task.add_done_callback(self.writing.discard)

    async def write_kept(self, pieces):
        try:
            await asyncio.to_thread(self.manager.record, self.selection, pieces)
        except Exception as error:  # what was recorded is also in Azure: losing it costs a read, never a viewer
            logger.warning("hub recording not kept model=%s type=%s", self.selection[2], type(error).__name__)

    async def refresh(self, user):
        """Reads the model now, as the viewer who just wrote to it, and pushes what changed. False when the read failed: the snapshot is then not served until a read succeeds."""
        self.dirty = True
        self.generation += 1
        try:
            async with self.polling:
                await self.poll(SimpleNamespace(user=user))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("hub refresh failed model=%s type=%s", self.selection[2], type(error).__name__)
            return False
        return True

    async def settle(self, member):
        """Reads the model as a joining viewer when a write of this app is not read back yet. Raises what the read raised."""
        async with self.polling:
            if self.dirty:
                await self.poll(member)

    async def tail(self, reader, old, inventory, also=(), changed_after=0):
        """New transitions of the entities whose state changed (and of `also`), and now and then the annotations: the history
        Azure holds that a snapshot does not. An entity whose change the history has not shown yet is read again, from
        before that change, on the next polls."""
        tail = self.manager.read_tail
        if tail is None:
            return {}
        seen = int(self.observed * 1000)
        for name in live_data.changed_states(old, inventory):
            entry = self.pending.setdefault(name, {"after": changed_after, "last": changed_after, "tries": 0})
            entry["last"] = max(entry["last"], changed_after)
            self.unsure(name, changed_after, seen)
        now = self.manager.clock()
        found = {"transitions": [], "annotations": []}
        names = set(self.pending) | set(also)
        if names and now >= self.tail_not_before:
            since = {name: self.since(name, also, changed_after) for name in names}
            try:
                async with self.manager.semaphore:
                    states = await asyncio.to_thread(tail, reader.user, self.selection, since, [])
            except asyncio.CancelledError:
                raise
            except Exception as error:
                for name in set(also) - set(self.pending):  # a report's history that was not read may hide a change
                    self.unsure(name, changed_after, seen)
                if credential_problem(error):
                    raise
                if status_of(error) in (429, 503):
                    self.tail_not_before = now + self.wait_after(error)
            else:
                self.settle_tail(since, states)
                found["transitions"] = states.get("transitions", [])
        if now - self.annotations_at >= self.settings.annotation_seconds and now >= self.annotations_not_before:
            try:
                async with self.manager.semaphore:
                    notes = await asyncio.to_thread(tail, reader.user, self.selection, {}, [item["name"] for item in inventory["entities"]])
            except asyncio.CancelledError:
                raise
            except Exception as error:  # the annotations are read again on a later poll and never hold up the transitions
                if credential_problem(error):
                    raise
                if status_of(error) in (429, 503):
                    self.annotations_not_before = now + self.wait_after(error)
            else:
                self.annotations_at = now
                found["annotations"] = notes.get("annotations", [])
        transitions = live_data.merge_by_key(self.known_transitions, found["transitions"], live_data.transition_key)
        for row in transitions:
            self.last_transition[row["entity"]] = max(self.last_transition.get(row["entity"], 0), row["t"])
        annotations = live_data.merge_by_key(self.known_annotations, found["annotations"], lambda row: (row["entity"], row["id"], row["t"]))
        return {"transitions": transitions, "annotations": annotations}

    def wait_after(self, error):
        return min(self.settings.max_backoff_seconds, max(retry_after(error) or 0, BUSY_BACKOFF_SECONDS))

    def since(self, name, also, changed_after):
        """Where to read an entity's history from: its last known transition, or an hour back, but never after the earliest
        change of it the history has not shown yet, nor after the previous read began for an entity that got a report."""
        start = self.last_transition.get(name, int(self.wall() * 1000) - 3600_000)
        if name in self.pending:
            start = min(start, self.pending[name]["after"])
        if name in also:
            start = min(start, changed_after)
        return start - self.settings.overlap_ms

    def settle_tail(self, since, found):
        """A read of the history ended: an entity whose latest seen change it shows is no longer pending, and the recording
        knows its changes since the read began. One the history still does not show after a few reads stops being read
        for it; the recording then leaves its week to Azure."""
        cut = set(found.get("cut", []))
        rows = found.get("transitions", [])
        if self.recorder is not None:
            self.recorder.transitions(rows)
        for name, entry in list(self.pending.items()):
            if name not in since:
                continue
            if name not in cut and any(row["entity"] == name and row["t"] >= entry["last"] for row in rows):
                del self.pending[name]
                if self.recorder is not None:
                    self.recorder.confirmed(name, since[name])
                continue
            entry["tries"] += 1
            if entry["tries"] >= self.settings.tail_tries:
                del self.pending[name]

    def unsure(self, name, after, seen):
        if self.recorder is not None:
            self.recorder.unsure(name, after, seen)


class ModelHub:
    """All the hubs of the app: bounded in number, each bounded in viewers."""

    def __init__(self, read_state, read_tail=None, settings=None, clock=time.monotonic, wall=time.time, record=None):
        self.settings = settings or HubSettings()
        self.read_state = read_state
        self.read_tail = read_tail
        self.record = record
        self.clock = clock
        self.wall = wall
        self.semaphore = asyncio.Semaphore(self.settings.read_concurrency)
        self._hubs = {}

    @property
    def hub_count(self):
        return len(self._hubs)

    def recorder(self):
        """What a new hub records for the history store, or None when nothing keeps it. A poll may end 1.5 poll intervals
        after the previous one began, and a signal is recorded only when it is evaluated at most once every two intervals,
        so every evaluation is seen by at least one poll."""
        if self.record is None:
            return None
        poll_ms = int(self.settings.poll_seconds * 1000)
        return recording.Recorder(
            gap_ms=poll_ms * 3 // 2,
            min_refresh_ms=poll_ms * 2,
            late_ms=self.settings.record_late_ms,
            max_points=self.settings.record_max_points,
            max_transitions=self.settings.record_max_transitions,
            states=self.read_tail is not None,
        )

    def warm(self, selection):
        """The hub of a model that has a snapshot, or None."""
        hub = self._hubs.get(key_of(selection))
        return hub if hub is not None and hub.inventory is not None and not hub.dirty else None

    async def refresh(self, selection, user, changed_model=False):
        """After a write the app made: reads the model of a warm hub at once. Nothing to do for a model nobody watches. A
        change to the model itself (an Apply) may have its signals evaluated out of turn: the days around it are not recorded."""
        hub = self._hubs.get(key_of(selection))
        if hub is not None and changed_model and hub.recorder is not None:
            hub.recorder.spoil(int(self.wall() * 1000))
        if hub is None or hub.inventory is None:
            return False
        return await hub.refresh(user)

    def forget(self, hub):
        if self._hubs.get(key_of(hub.selection)) is hub:
            del self._hubs[key_of(hub.selection)]

    def streams_of(self, owner):
        return sum(1 for hub in self._hubs.values() for m in hub.members if m.caller.owner == owner and not m.closed)

    async def subscribe(self, caller, user, selection, last_id=None, expires_at=None):
        """Admits a viewer the caller's route has already checked as that user. Raises Refusal, or the Azure error of a first read that failed."""
        if self.streams_of(caller.owner) >= self.settings.max_streams_per_user:
            raise Refusal(429, "too_many_streams", "This account has too many live connections open.")
        key = key_of(selection)
        hub = self._hubs.get(key)
        if hub is None:
            if len(self._hubs) >= self.settings.max_hubs:
                raise Refusal(503, "live_unavailable", "Live updates are busy. Reload to refresh this model by hand.")
            hub = self._hubs[key] = Hub(self, selection)
        elif len([m for m in hub.members if not m.closed]) >= self.settings.max_subscribers:
            raise Refusal(503, "too_many_subscribers", "This model has too many viewers for live updates.")
        member = Member(caller, user, expires_at, self.settings.queue_size)
        hub.members.append(member)
        if hub.stop_handle is not None:
            hub.stop_handle.cancel()
            hub.stop_handle = None
        if hub.task is None:
            hub.task = asyncio.get_running_loop().create_task(hub.run())
        try:
            await hub.ready.wait()
        except asyncio.CancelledError:
            hub.leave(member)
            raise
        if hub.failure is not None or member.closed:
            error = hub.failure
            hub.leave(member)
            if hub.inventory is None and not hub.members:
                hub.stop()
            raise error if error is not None else Refusal(503, "live_unavailable", "Live updates are unavailable.")
        if hub.dirty:  # the snapshot is the model before a write of this app that no read has shown yet: read it as this viewer, then serve it
            try:
                await hub.settle(member)
            except asyncio.CancelledError:
                hub.leave(member)
                raise
            except Exception as error:
                logger.warning("hub settle failed model=%s type=%s", selection[2], type(error).__name__)
            if hub.dirty:
                hub.leave(member)
                raise Refusal(503, "live_unavailable", "The model was just changed and is being read again. Try again in a moment.")
        initial = hub.catch_up(last_id)
        member.live = True
        return Subscription(hub, member, initial)
