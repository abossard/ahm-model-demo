"""Past history never changes, so it is kept: in memory while the app runs and, when a blob container is configured, in
that container under its own prefix, so a restart does not read it from Azure again. Only closed buckets are stored, and
only when they were read in full. This store deletes nothing and never fails a request: a blob that cannot be read is a miss."""

import json
import logging
import threading
from collections import OrderedDict
from urllib.parse import quote

from azure.core.exceptions import AzureError, ResourceNotFoundError

from config import HISTORY_MEMORY_BUCKETS, HISTORY_PREFIX, HISTORY_SAFETY_SECONDS


logger = logging.getLogger("ahm-demo")

DAY_MS = 24 * 3600 * 1000
BUCKET_MS = {"signal": DAY_MS, "states": 7 * DAY_MS, "annotations": 7 * DAY_MS}


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


def blob_name(scope, kind, entity, signal, start):
    parts = [*scope, kind, entity, signal or "_"]
    return f"{HISTORY_PREFIX}/{'/'.join(quote(str(part).casefold(), safe='') for part in parts)}/{start}.json"


class MemoryHistory:
    def __init__(self, size=HISTORY_MEMORY_BUCKETS):
        self._size = size
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def get(self, name):
        with self._lock:
            if name not in self._items:
                return None
            self._items.move_to_end(name)
            return self._items[name]

    def put(self, name, value):
        with self._lock:
            self._items[name] = value
            self._items.move_to_end(name)
            while len(self._items) > self._size:
                self._items.popitem(last=False)


class BlobHistory:
    def __init__(self, container):
        self._container = container

    def get(self, name):
        try:
            return json.loads(self._container.download_blob(name).readall().decode("utf-8"))
        except ResourceNotFoundError:
            return None
        except (AzureError, ValueError) as error:
            logger.warning("history blob unreadable type=%s", type(error).__name__)
            return None

    def put(self, name, value):
        try:
            self._container.upload_blob(name, json.dumps(value, separators=(",", ":")).encode("utf-8"), overwrite=True)
        except AzureError as error:
            logger.warning("history blob not written type=%s", type(error).__name__)


class LayeredHistory:
    """Memory in front of an optional durable layer: reads fill memory, writes go to both."""

    def __init__(self, memory, durable=None):
        self._memory = memory
        self._durable = durable

    def get(self, name):
        found = self._memory.get(name)
        if found is None and self._durable is not None:
            found = self._durable.get(name)
            if found is not None:
                self._memory.put(name, found)
        return found

    def put(self, name, value):
        self._memory.put(name, value)
        if self._durable is not None:
            self._durable.put(name, value)


PARTS = {"states": ("transitions",), "annotations": ("items",), "signal": ("points", "reports")}
KEYS = {"transitions": lambda row: row["t"], "items": lambda row: row["t"], "points": lambda row: row[0], "reports": lambda row: row["t"]}


def merge_parts(kind, parts):
    """Joins the buckets of one history, newest first as read, into one oldest-first load result."""
    out = {name: [] for name in PARTS[kind]}
    for part in parts:
        for name in PARTS[kind]:
            out[name].extend(part.get(name, []))
    for name, rows in out.items():
        rows.sort(key=KEYS[name])
    return out
