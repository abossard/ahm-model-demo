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
from config import (
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
        self.pending_tail = set()
        self.tail_not_before = 0.0
        self.annotations_at = 0.0
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
        delay = self.settings.poll_seconds
        while True:
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
                await asyncio.wait_for(self.wake.wait(), delay)
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
            inventory, structure = await asyncio.to_thread(read, reader.user, self.selection)
        self.observed = self.wall()
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
        timeline.update(await self.tail(reader, old, inventory))
        if not live_data.empty_timeline(timeline):
            payload["timeline"] = {part: rows for part, rows in timeline.items() if rows}
        self.inventory, self.structure = inventory, structure
        if started == self.generation:
            self.dirty = False
        if payload:
            payload["observedAt"] = inventory["observedAt"]
            self.publish(payload)

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

    async def tail(self, reader, old, inventory):
        """New transitions of the entities whose state changed, and now and then the annotations: the history Azure holds that a snapshot does not."""
        tail = self.manager.read_tail
        if tail is None:
            return {}
        names = set(live_data.changed_states(old, inventory)) | self.pending_tail
        now = self.manager.clock()
        if now < self.tail_not_before:
            self.pending_tail = names
            return {}
        want_annotations = now - self.annotations_at >= self.settings.annotation_seconds
        if not names and not want_annotations:
            return {}
        since = {name: self.last_transition.get(name, int(self.wall() * 1000) - 3600_000) - self.settings.overlap_ms for name in names}
        try:
            async with self.manager.semaphore:
                found = await asyncio.to_thread(
                    tail, reader.user, self.selection, since, [item["name"] for item in inventory["entities"]] if want_annotations else []
                )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if credential_problem(error):
                raise
            self.pending_tail = names
            if status_of(error) in (429, 503):
                self.tail_not_before = now + min(self.settings.max_backoff_seconds, max(retry_after(error) or 0, BUSY_BACKOFF_SECONDS))
            return {}
        self.pending_tail = set()
        if want_annotations:
            self.annotations_at = now
        transitions = live_data.merge_by_key(self.known_transitions, found.get("transitions", []), live_data.transition_key)
        for row in transitions:
            self.last_transition[row["entity"]] = max(self.last_transition.get(row["entity"], 0), row["t"])
        annotations = live_data.merge_by_key(self.known_annotations, found.get("annotations", []), lambda row: (row["entity"], row["id"], row["t"]))
        return {"transitions": transitions, "annotations": annotations}


class ModelHub:
    """All the hubs of the app: bounded in number, each bounded in viewers."""

    def __init__(self, read_state, read_tail=None, settings=None, clock=time.monotonic, wall=time.time):
        self.settings = settings or HubSettings()
        self.read_state = read_state
        self.read_tail = read_tail
        self.clock = clock
        self.wall = wall
        self.semaphore = asyncio.Semaphore(self.settings.read_concurrency)
        self._hubs = {}

    @property
    def hub_count(self):
        return len(self._hubs)

    def warm(self, selection):
        """The hub of a model that has a snapshot, or None."""
        hub = self._hubs.get(key_of(selection))
        return hub if hub is not None and hub.inventory is not None and not hub.dirty else None

    async def refresh(self, selection, user):
        """After a write the app made: reads the model of a warm hub at once. Nothing to do for a model nobody watches."""
        hub = self._hubs.get(key_of(selection))
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
