import type { EntityInfo } from "../model/timeline";
import { parseCell } from "../model/timelinePlan";
import { CLOSE_SAFETY, LEVELS, OVERVIEW_TILE, type Level } from "../model/timelineTiles";
import type { KeptTile } from "../model/timeStore";

/**
 * The timeline's tiles and the model's structure in the browser's IndexedDB, so a reload paints at once and a tile that
 * closed is never asked for again. Every entry belongs to one signed-in user in one directory and one model: its key
 * begins with a hash of both, and nothing is ever read by another key. The least recently used entries go when the
 * cache passes its size.
 */

/** Bumped when the shape of what is stored changes, so an old entry is never read as a new one. */
export const CACHE_SCHEMA = 2;
/** What the cache may hold, by the estimate of `tileBytes`. */
export const MAX_BYTES = 48 * 1024 * 1024;
/** After an eviction the cache is this full, so the next write does not evict again. */
const KEEP_RATIO = 0.9;
const WRITE_DELAY_MS = 1500;
/** An entry that is read is marked as used at most this often: a read must not cost a write every time. */
const TOUCH_MS = 3600 * 1000;
const DB_NAME = "ahm-timeline";
const STORE = "tiles";
const SEP = "\u0001";

/** Whose data, of which model. Neither is written down as it is: the key holds a hash of the owner. */
export interface CacheScope {
  /** The signed-in user and directory. */
  readonly owner: string;
  /** Subscription, resource group and name of the model. */
  readonly model: string;
}

export interface Stored {
  readonly id: string;
  readonly schema: number;
  readonly usedAt: number;
  readonly bytes: number;
  readonly tile?: KeptTile;
  readonly entities?: readonly EntityInfo[];
}

export interface Usage {
  readonly id: string;
  readonly usedAt: number;
  readonly bytes: number;
}

/** The storage under the cache: IndexedDB in the browser, a map in tests. */
export interface TileStorage {
  readonly get: (ids: readonly string[]) => Promise<readonly (Stored | undefined)[]>;
  readonly put: (items: readonly Stored[]) => Promise<void>;
  readonly remove: (ids: readonly string[]) => Promise<void>;
  /** Every entry's id, last use and size, without what it holds. */
  readonly usage: () => Promise<readonly Usage[]>;
}

export interface TileCache {
  /** The kept tiles of some cells of the plan. A cell that is not kept is simply missing from the answer. */
  readonly read: (scope: CacheScope, cells: readonly string[]) => Promise<readonly KeptTile[]>;
  /** Keeps the tiles of an answer that was observed at `observedAt`, after a short delay so a burst is one write. */
  readonly write: (scope: CacheScope, tiles: readonly KeptTile[], observedAt: number) => void;
  readonly readStructure: (scope: CacheScope) => Promise<readonly EntityInfo[] | null>;
  readonly writeStructure: (scope: CacheScope, entities: readonly EntityInfo[]) => void;
}

/** A rough size of a tile in storage: its rows, and a little for the rest. */
export function tileBytes(tile: KeptTile): number {
  return 160 + tile.rows.length * (tile.kind === "series" ? 24 : 96);
}

const sizeOf = (tile: Pick<KeptTile, "kind" | "level">): number => (tile.kind === "series" ? (LEVELS[tile.level] as Level).tile : OVERVIEW_TILE);

/** The id of a tile under a scope's prefix. */
export function tileId(prefix: string, tile: Pick<KeptTile, "kind" | "entity" | "signal" | "level"> & { readonly span: { readonly from: number } }): string {
  return [prefix, tile.kind, tile.entity, tile.signal ?? "", tile.level, Math.floor(tile.span.from / sizeOf(tile))].join(SEP);
}

/** The ids a cell of the plan is kept under: the overview of an entity is three histories, a series one. */
export function idsOfCell(prefix: string, cell: string): readonly string[] {
  const { kind, entity, signal, level, tile } = parseCell(cell);
  if (kind === "s") return [[prefix, "series", entity, signal, level, tile].join(SEP)];
  if (kind === "o" && entity !== "*") return ["states", "annotations", "reports"].map((part) => [prefix, part, entity, "", 0, tile].join(SEP));
  return [];
}

/**
 * A tile as it may be kept. What was read less than the safety margin after its end may still change, so it is kept
 * only up to that margin before the read: after a reload the rest counts as not held and is read again.
 */
export function keepable(tile: KeptTile, observedAt: number): KeptTile | null {
  const settled = observedAt - CLOSE_SAFETY;
  if (tile.span.to <= settled) return tile;
  if (settled <= tile.span.from) return null;
  const time = (row: unknown): number => (Array.isArray(row) ? (row[0] as number) : (row as { readonly t: number }).t);
  return { ...tile, span: { from: tile.span.from, to: settled }, rows: tile.rows.filter((row) => time(row) <= settled) };
}

/** The entries to drop, least recently used first, so that what stays is under the bound. Nothing when it already is. */
export function evictions(usage: readonly Usage[], bound: number): readonly string[] {
  let total = usage.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= bound) return [];
  const out: string[] = [];
  for (const entry of [...usage].sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= bound * KEEP_RATIO) break;
    out.push(entry.id);
    total -= entry.bytes;
  }
  return out;
}

const usable = (entry: Stored | undefined): entry is Stored => entry !== undefined && entry.schema === CACHE_SCHEMA;

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createTileCache(storage: TileStorage, options: { readonly now?: () => number; readonly maxBytes?: number; readonly delayMs?: number } = {}): TileCache {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const prefixes = new Map<string, Promise<string>>();
  const prefixOf = (scope: CacheScope): Promise<string> => {
    const key = `${scope.owner}${SEP}${scope.model}`;
    let prefix = prefixes.get(key);
    if (!prefix) {
      prefix = digest(scope.owner.toLowerCase()).then((owner) => `${owner}${SEP}${scope.model.toLowerCase()}`);
      prefixes.set(key, prefix);
    }
    return prefix;
  };
  const pending = new Map<string, Stored>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async (): Promise<void> => {
    timer = null;
    const items = [...pending.values()];
    pending.clear();
    try {
      await storage.put(items);
      const drop = evictions(await storage.usage(), maxBytes);
      if (drop.length > 0) await storage.remove(drop);
    } catch {
      /* The cache never fails the timeline: what could not be kept is read again. */
    }
  };
  const queue = (items: readonly Stored[]): void => {
    for (const item of items) pending.set(item.id, item);
    if (timer === null && pending.size > 0) timer = setTimeout(() => void flush(), options.delayMs ?? WRITE_DELAY_MS);
  };
  const touch = (entries: readonly Stored[]): void => {
    const stale = entries.filter((entry) => now() - entry.usedAt > TOUCH_MS);
    if (stale.length > 0) queue(stale.map((entry) => ({ ...entry, usedAt: now() })));
  };

  return {
    read: async (scope, cells) => {
      try {
        const prefix = await prefixOf(scope);
        const ids = cells.flatMap((cell) => idsOfCell(prefix, cell));
        const waiting = ids.map((id) => pending.get(id));
        const found = (await storage.get(ids)).map((entry, index) => waiting[index] ?? entry).filter(usable);
        touch(found);
        return found.flatMap((entry) => (entry.tile ? [entry.tile] : []));
      } catch {
        return [];
      }
    },
    write: (scope, tiles, observedAt) => {
      void prefixOf(scope)
        .then((prefix) =>
          queue(
            tiles.flatMap((tile) => {
              const kept = keepable(tile, observedAt);
              return kept ? [{ id: tileId(prefix, kept), schema: CACHE_SCHEMA, usedAt: now(), bytes: tileBytes(kept), tile: kept }] : [];
            }),
          ),
        )
        .catch(() => undefined);
    },
    readStructure: async (scope) => {
      try {
        const [entry] = await storage.get([`${await prefixOf(scope)}${SEP}structure`]);
        return usable(entry) && Array.isArray(entry.entities) ? entry.entities : null;
      } catch {
        return null;
      }
    },
    writeStructure: (scope, entities) => {
      void prefixOf(scope)
        .then((prefix) => queue([{ id: `${prefix}${SEP}structure`, schema: CACHE_SCHEMA, usedAt: now(), bytes: 160 + entities.length * 600, entities }]))
        .catch(() => undefined);
    },
  };
}

/** A storage in memory, for tests. */
export function memoryStorage(): TileStorage & { readonly items: Map<string, Stored> } {
  const items = new Map<string, Stored>();
  return {
    items,
    get: async (ids) => ids.map((id) => items.get(id)),
    put: async (entries) => {
      for (const entry of entries) items.set(entry.id, entry);
    },
    remove: async (ids) => {
      for (const id of ids) items.delete(id);
    },
    usage: async () => [...items.values()].map((entry) => ({ id: entry.id, usedAt: entry.usedAt, bytes: entry.bytes })),
  };
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** The browser's IndexedDB as the storage. Null where there is none. */
export function indexedDbStorage(): TileStorage | null {
  if (typeof indexedDB === "undefined") return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, CACHE_SCHEMA);
      opening.onupgradeneeded = () => {
        // Another schema's entries cannot be read: they go with their stores.
        for (const name of [...opening.result.objectStoreNames]) opening.result.deleteObjectStore(name);
        opening.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("lru", ["usedAt", "bytes"]);
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    return db;
  };
  return {
    get: async (ids) => {
      if (ids.length === 0) return [];
      const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
      return Promise.all(ids.map((id) => done(store.get(id) as IDBRequest<Stored | undefined>)));
    },
    put: async (items) => {
      if (items.length === 0) return;
      const transaction = (await open()).transaction(STORE, "readwrite");
      for (const item of items) transaction.objectStore(STORE).put(item);
      await finished(transaction);
    },
    remove: async (ids) => {
      if (ids.length === 0) return;
      const transaction = (await open()).transaction(STORE, "readwrite");
      for (const id of ids) transaction.objectStore(STORE).delete(id);
      await finished(transaction);
    },
    usage: async () => {
      const index = (await open()).transaction(STORE, "readonly").objectStore(STORE).index("lru");
      return new Promise((resolve, reject) => {
        const out: Usage[] = [];
        const walking = index.openKeyCursor();
        walking.onerror = () => reject(walking.error);
        walking.onsuccess = () => {
          const cursor = walking.result;
          if (!cursor) return resolve(out);
          const [usedAt, bytes] = cursor.key as [number, number];
          out.push({ id: cursor.primaryKey as string, usedAt, bytes });
          cursor.continue();
        };
      });
    },
  };
}
