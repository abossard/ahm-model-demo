"""Past history never changes, so it is kept: in memory while the app runs and, when a blob container is configured, in
that container under its own prefix, so a restart does not read it from Azure again (ADR 0011).

A blob holds one tile of one model: the transitions and annotations of every entity for a week, or the points of every
signal at one level for the tile of that level. Inside it, a piece is what one Azure read gives: a signal for a day, or the
transitions or the annotations of an entity for a week. A piece is written only whole, with where it came from, and a
blob is written with its ETag, so writers that meet merge their pieces. This store deletes nothing and never fails a
request: a blob that cannot be read is a miss and one that cannot be written is left as it was. Blobs are written after
the answer has gone, by a few writers in the background."""

import json
import logging
import threading
import time
import zlib
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from azure.core import MatchConditions
from azure.core.exceptions import AzureError, ResourceExistsError, ResourceModifiedError, ResourceNotFoundError

from config import (
    HISTORY_LEGACY_MODELS,
    HISTORY_LEGACY_PREFIX,
    HISTORY_LEGACY_RETRY_SECONDS,
    HISTORY_MEMORY_BYTES,
    HISTORY_PREFIX,
    HISTORY_SAFETY_SECONDS,
    HISTORY_WRITE_ATTEMPTS,
    HISTORY_WRITE_QUEUE,
    HISTORY_WRITERS,
)


logger = logging.getLogger("ahm-demo")

DAY_MS = 24 * 3600 * 1000
WEEK_MS = 7 * DAY_MS
# What one Azure read covers: a signal is read a day at a time, the transitions and annotations of an entity a week at a time.
PIECE_MS = {"signal": DAY_MS, "states": WEEK_MS, "annotations": WEEK_MS}
# The levels a series is kept at, as seconds a slot (the `resolution` of the API), and the tile of each: the same as LEVELS
# and OVERVIEW_TILE in src/web/ui/src/model/timelineTiles.ts. Change both.
LEVELS = (0, 900, 3600)
SERIES_TILE_MS = {0: DAY_MS, 900: DAY_MS, 3600: WEEK_MS}
OVERVIEW_TILE_MS = WEEK_MS
AZURE = "azure"
RECORDED = "recorded"
FORMAT = 2
PARTS = {"states": ("transitions",), "annotations": ("items",), "signal": ("points", "reports")}
KEYS = {"transitions": lambda row: row["t"], "items": lambda row: row["t"], "points": lambda row: row[0], "reports": lambda row: row["t"]}
NO_SIGNAL = "_"
LOCK_STRIPES = 64


def bucket_start(t, size):
    return t // size * size


def closed_before(now_ms, size, safety_ms=HISTORY_SAFETY_SECONDS * 1000):
    """The instant before which every bucket is closed: whole buckets that ended at least `safety_ms` ago."""
    return bucket_start(now_ms - safety_ms, size)


def buckets(start, end, size, limit):
    """The closed buckets that cover `[start, end)` up to `limit`, newest first, as (from, to) pairs."""
    stop = min(end, limit)
    out = []
    b = bucket_start(start, size)
    while b < stop:
        out.append((b, b + size))
        b += size
    return out[::-1]


def model_path(scope):
    return "/".join(quote(str(part).casefold(), safe="") for part in scope)


def tile_of(kind, level, start):
    """The family, level and tile of the blob that holds a piece."""
    if kind == "signal":
        return f"series/{level}", bucket_start(start, SERIES_TILE_MS[level])
    return "overview", bucket_start(start, OVERVIEW_TILE_MS)


def bucket_name(scope, kind, level, start):
    family, tile = tile_of(kind, level, start)
    return f"{HISTORY_PREFIX}/{model_path(scope)}/{family}/{tile}.json"


def legacy_name(scope, kind, entity, signal, start):
    """Where the first layout kept a piece: one blob per history and bucket."""
    parts = [*scope, kind, entity, signal or NO_SIGNAL]
    return f"{HISTORY_LEGACY_PREFIX}/{'/'.join(quote(str(part).casefold(), safe='') for part in parts)}/{start}.json"


def within(kind, rows, start, end):
    """The rows of a piece that belong to it: `[start, end)`, so the pieces of a history never overlap."""
    return {part: [row for row in rows.get(part, []) if start <= KEYS[part](row) < end] for part in PARTS[kind]}


def merge_parts(kind, parts):
    """Joins the pieces of one history, newest first as read, into one oldest-first load result."""
    out = {name: [] for name in PARTS[kind]}
    for part in parts:
        for name in PARTS[kind]:
            out[name].extend(part.get(name, []))
    for name, rows in out.items():
        rows.sort(key=KEYS[name])
    return out


class Tally:
    """What one request (or fill) cost: Azure calls, pieces found and missed, buckets from memory or blob storage."""

    NAMES = ("azure_calls", "pieces_stored", "pieces_read", "memory", "blob", "absent", "legacy", "written")

    def __init__(self):
        self._counts = dict.fromkeys(self.NAMES, 0)
        self._lock = threading.Lock()

    def add(self, name, count=1):
        with self._lock:
            self._counts[name] += count

    def counts(self):
        with self._lock:
            return dict(self._counts)


class Bucket:
    """One blob's content: pieces by kind, entity, signal and piece start, each `{"src", "rows"}` with the rows as JSON text.
    Never changed in place: a merge returns a new bucket, so a reader holds a consistent one."""

    def __init__(self, pieces=None, etag=None, size=0):
        self.pieces = pieces or {}
        self.etag = etag
        self.size = size

    def piece(self, kind, entity, signal, start):
        found = self.pieces.get(kind, {}).get(entity, {}).get(signal or NO_SIGNAL, {}).get(str(start))
        return None if found is None else (found["src"], found["rows"])

    def merged(self, adds):
        """The bucket with `adds` (kind, entity, signal, start, src, text) in it, and whether anything changed. A piece read
        from Azure replaces a recorded one; otherwise the piece that is there stays."""
        pieces = None
        size = self.size
        for kind, entity, signal, start, src, text in adds:
            current = (pieces or self.pieces).get(kind, {}).get(entity, {}).get(signal or NO_SIGNAL, {}).get(str(start))
            if current is not None and not (current["src"] == RECORDED and src == AZURE):
                continue
            if pieces is None:
                pieces = {k: {e: {s: dict(p) for s, p in by_signal.items()} for e, by_signal in by_entity.items()} for k, by_entity in self.pieces.items()}
            pieces.setdefault(kind, {}).setdefault(entity, {}).setdefault(signal or NO_SIGNAL, {})[str(start)] = {"src": src, "rows": text}
            size += len(text) - (len(current["rows"]) if current else 0)
        if pieces is None:
            return self, False
        return Bucket(pieces, self.etag, size), True

    def adds(self):
        """Every piece, in the form `merged` takes."""
        return [
            (kind, entity, signal, start, piece["src"], piece["rows"])
            for kind, by_entity in self.pieces.items()
            for entity, by_signal in by_entity.items()
            for signal, by_start in by_signal.items()
            for start, piece in by_start.items()
        ]

    def encode(self):
        return json.dumps({"v": FORMAT, "pieces": self.pieces}, separators=(",", ":")).encode("utf-8")

    @classmethod
    def decode(cls, data, etag=None):
        body = json.loads(data.decode("utf-8"))
        if not isinstance(body, dict) or body.get("v") != FORMAT or not isinstance(body.get("pieces"), dict):
            raise ValueError("not a history bucket")
        return cls(body["pieces"], etag, len(data))


EMPTY = Bucket()


class MemoryBuckets:
    """Buckets by name, least recently used out, bounded by the bytes of what they hold."""

    def __init__(self, limit=HISTORY_MEMORY_BYTES):
        self._limit = limit
        self._items = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    @property
    def size(self):
        return self._bytes

    def get(self, name):
        with self._lock:
            found = self._items.get(name)
            if found is not None:
                self._items.move_to_end(name)
            return found

    def add(self, name, bucket):
        """Keeps `bucket` unless one came in meanwhile, and returns the one kept."""
        with self._lock:
            found = self._items.get(name)
            if found is not None:
                self._items.move_to_end(name)
                return found
            self._put(name, bucket)
            return bucket

    def put(self, name, bucket):
        with self._lock:
            self._put(name, bucket)

    def _put(self, name, bucket):
        weight = bucket.size + len(name) + 64
        old = self._items.pop(name, None)
        if old is not None:
            self._bytes -= old.size + len(name) + 64
        if weight > self._limit:
            return
        self._items[name] = bucket
        self._bytes += weight
        while self._bytes > self._limit:
            gone, dropped = self._items.popitem(last=False)
            self._bytes -= dropped.size + len(gone) + 64


class BlobBuckets:
    def __init__(self, container):
        self._container = container

    def get(self, name):
        """The bucket with its ETag, None when there is none. Raises AzureError or ValueError when it cannot be read."""
        try:
            download = self._container.download_blob(name)
        except ResourceNotFoundError:
            return None
        return Bucket.decode(download.readall(), download.properties.etag)

    def put(self, name, bucket):
        """Writes the bucket only over the version it was merged onto (`bucket.etag`, None for none yet). Returns the new
        ETag; raises ResourceModifiedError or ResourceExistsError when another writer came first."""
        data = bucket.encode()
        if bucket.etag is None:
            result = self._container.upload_blob(name, data, overwrite=False)
        else:
            result = self._container.upload_blob(name, data, overwrite=True, etag=bucket.etag, match_condition=MatchConditions.IfNotModified)
        return result.get("etag"), len(data)


class LegacyHistory:
    """The first layout, read where the new one has nothing yet: each model's blob names are listed once, so a piece that
    was never kept there costs no read."""

    def __init__(self, container, models=HISTORY_LEGACY_MODELS, retry_seconds=HISTORY_LEGACY_RETRY_SECONDS, clock=time.monotonic):
        self._container = container
        self._names = OrderedDict()
        self._models = models
        self._retry = retry_seconds
        self._clock = clock
        self._lock = threading.Lock()

    def _index(self, scope):
        """The model's blob names: listed once, or again a while after a listing failed (nothing is found meanwhile)."""
        key = model_path(scope)
        with self._lock:
            found = self._names.get(key)
            if found is not None and (found[1] is None or self._clock() < found[1]):
                self._names.move_to_end(key)
                return found[0]
        try:
            entry = (frozenset(item.name for item in self._container.list_blobs(name_starts_with=f"{HISTORY_LEGACY_PREFIX}/{key}/")), None)
        except AzureError as error:
            logger.warning("history legacy listing failed type=%s", type(error).__name__)
            entry = (frozenset(), self._clock() + self._retry)
        with self._lock:
            self._names[key] = entry
            self._names.move_to_end(key)
            while len(self._names) > self._models:
                self._names.popitem(last=False)
        return entry[0]

    def get(self, scope, kind, entity, signal, start):
        name = legacy_name(scope, kind, entity, signal, start)
        if name not in self._index(scope):
            return None
        try:
            return json.loads(self._container.download_blob(name).readall().decode("utf-8"))
        except (AzureError, ValueError) as error:
            logger.warning("history legacy blob unreadable type=%s", type(error).__name__)
            return None


class Batch:
    """Pieces to write, collected while a request reads and written once per blob at its end."""

    def __init__(self):
        self._adds = {}
        self._lock = threading.Lock()

    def add(self, scope, kind, entity, signal, start, src, rows_by_level):
        with self._lock:
            for level, rows in rows_by_level.items():
                name = bucket_name(scope, kind, level, start)
                self._adds.setdefault(name, []).append((kind, entity, signal, start, src, json.dumps(rows, separators=(",", ":"))))

    def items(self):
        with self._lock:
            return list(self._adds.items())

    def __len__(self):
        return len(self._adds)


class Writer:
    """Writes blobs in the background: a few at once, one write at a time for a blob, at most `limit` blobs waiting. Pieces
    for a blob that is already waiting join it, so a blob many requests add to is written once for all of them."""

    def __init__(self, persist, workers=HISTORY_WRITERS, limit=HISTORY_WRITE_QUEUE):
        self._persist = persist
        self._limit = limit
        self._waiting = {}
        self._busy = set()
        self._cond = threading.Condition()
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="history-writer")

    def submit(self, name, adds):
        """False when too many blobs wait: the pieces then stay in memory only."""
        with self._cond:
            if name in self._waiting:
                self._waiting[name].extend(adds)
                return True
            if len(self._waiting) >= self._limit:
                return False
            self._waiting[name] = list(adds)
            if name in self._busy:
                return True
            self._busy.add(name)
        self._pool.submit(self._drain, name)
        return True

    def _drain(self, name):
        while True:
            with self._cond:
                adds = self._waiting.pop(name, None)
                if adds is None:
                    self._busy.discard(name)
                    self._cond.notify_all()
                    return
            try:
                self._persist(name, adds)
            except Exception as error:  # a blob that is not written is read from Azure again later, nothing more
                logger.warning("history blob not written type=%s", type(error).__name__)

    def flush(self, timeout=None):
        """Waits until nothing is waiting or being written. True when that happened within `timeout`."""
        with self._cond:
            return self._cond.wait_for(lambda: not self._waiting and not self._busy, timeout)


class HistoryStore:
    """Memory in front of an optional blob container, and the first layout behind it."""

    def __init__(self, memory, durable=None, legacy=None, workers=HISTORY_WRITERS, queue=HISTORY_WRITE_QUEUE):
        self._memory = memory
        self._durable = durable
        self._legacy = legacy
        self._loading = {}
        self._loading_lock = threading.Lock()
        self._stripes = [threading.Lock() for _ in range(LOCK_STRIPES)]
        self._writer = Writer(self._persist, workers, queue) if durable is not None else None

    def bucket(self, name, tally):
        """The bucket of that name: from memory, else read once from blob storage while others wait for it. Empty when there
        is none: that is kept in memory too, so a missing blob is asked for once."""
        found = self._memory.get(name)
        if found is not None:
            tally.add("memory")
            return found
        if self._durable is None:
            return EMPTY
        with self._loading_lock:
            waiting = self._loading.get(name)
            if waiting is None:
                self._loading[name] = threading.Event()
        if waiting is not None:
            waiting.wait()
            tally.add("memory")
            return self._memory.get(name) or EMPTY
        try:
            try:
                found = self._durable.get(name)
            except (AzureError, ValueError) as error:
                logger.warning("history blob unreadable type=%s", type(error).__name__)
                tally.add("absent")
                return EMPTY
            tally.add("blob" if found is not None else "absent")
            # A write may have put a newer version in memory while this one was read: that one stays.
            return self._memory.add(name, found or Bucket())
        finally:
            with self._loading_lock:
                self._loading.pop(name).set()

    def piece(self, scope, kind, level, entity, signal, start, tally):
        """The rows of a piece at a level and where they came from, or None."""
        found = self.bucket(bucket_name(scope, kind, level, start), tally).piece(kind, entity, signal, start)
        return None if found is None else (found[0], json.loads(found[1]))

    def legacy(self, scope, kind, entity, signal, start, tally):
        """The rows the first layout kept for a piece, or None."""
        if self._legacy is None:
            return None
        found = self._legacy.get(scope, kind, entity, signal, start)
        if found is not None:
            tally.add("legacy")
        return found

    def _stripe(self, name):
        return self._stripes[zlib.crc32(name.encode("utf-8")) % LOCK_STRIPES]

    def write(self, batch, tally=None):
        """Merges every piece of the batch into its blob: at once in memory, where the blob is held, and in blob storage in
        the background. `written` counts the blobs that changed or were handed to the writers."""
        for name, adds in batch.items():
            with self._stripe(name):
                current = self._memory.get(name)
                changed = True
                if current is not None or self._durable is None:
                    merged, changed = (current or EMPTY).merged(adds)
                    if changed:
                        self._memory.put(name, merged)
            if not changed:
                continue
            if self._writer is not None and not self._writer.submit(name, adds):
                logger.warning("history blob not written: too many waiting")
                continue
            if tally is not None:
                tally.add("written")

    def flush(self, timeout=None):
        """Waits for the blobs that wait to be written."""
        return True if self._writer is None else self._writer.flush(timeout)

    def _persist(self, name, adds):
        """Writes a blob over the version it was merged onto, and again on top of a newer one when another writer came
        first. Memory then holds what was written and whatever arrived meanwhile."""
        base = self._memory.get(name) or self._read_for_write(name)
        if base is None:
            return
        merged, _ = base.merged(adds)
        kept = merged
        for _attempt in range(HISTORY_WRITE_ATTEMPTS):
            try:
                etag, size = self._durable.put(name, merged)
                kept = Bucket(merged.pieces, etag, size)
                break
            except (ResourceModifiedError, ResourceExistsError):
                fresh = self._read_for_write(name)
                if fresh is None:
                    break
                merged, _ = fresh.merged((self._memory.get(name) or merged).adds() + list(adds))
                kept = merged
            except AzureError as error:
                logger.warning("history blob not written type=%s", type(error).__name__)
                break
        else:
            logger.warning("history blob not written: changed by others %d times", HISTORY_WRITE_ATTEMPTS)
        # Written or not, memory holds the pieces, over the version of the blob they were merged onto.
        with self._stripe(name):
            held = self._memory.get(name)
            self._memory.put(name, kept if held is None else kept.merged(held.adds())[0])

    def _read_for_write(self, name):
        """The blob as it is now, or an empty bucket when there is none; None when it cannot be read (nothing is written then)."""
        try:
            return self._durable.get(name) or Bucket()
        except (AzureError, ValueError) as error:
            logger.warning("history blob unreadable type=%s", type(error).__name__)
            return None
