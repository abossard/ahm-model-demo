import type { TimelineResponse } from "../model/timeline";

/** Bumped when the shape of what is stored changes, so an old entry is never read as a new one. */
export const CACHE_SCHEMA = 1;
const DB_NAME = "ahm-timeline";
const STORE = "overview";
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const WRITE_DELAY_MS = 1500;

export interface CacheEntry {
  readonly schema: number;
  readonly savedAt: number;
  readonly response: TimelineResponse;
}

export interface OverviewCache {
  /** The last overview stored for a model, or null when there is none, it is of another schema or too old. */
  readonly read: (key: string) => Promise<TimelineResponse | null>;
  /** Stores the overview after a short delay, so a burst of updates is one write. */
  readonly write: (key: string, response: TimelineResponse) => void;
}

export function wrap(response: TimelineResponse, now: number): CacheEntry {
  return { schema: CACHE_SCHEMA, savedAt: now, response };
}

export function unwrap(entry: unknown, now: number): TimelineResponse | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { schema, savedAt, response } = entry as Partial<CacheEntry>;
  if (schema !== CACHE_SCHEMA || typeof savedAt !== "number" || now - savedAt > MAX_AGE_MS || typeof response !== "object" || response === null) return null;
  return Array.isArray(response.entities) && Array.isArray(response.states) ? response : null;
}

function request<T>(open: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** The overview of each model in the browser's IndexedDB, for a first paint before the network answers. Null where there is no IndexedDB. */
export function createIndexedDbCache(): OverviewCache | null {
  if (typeof indexedDB === "undefined") return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, CACHE_SCHEMA);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    return db;
  };
  const timers = new Map<string, number>();
  return {
    read: async (key) => {
      try {
        const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
        return unwrap(await request(store.get(key)), Date.now());
      } catch {
        return null;
      }
    },
    write: (key, response) => {
      window.clearTimeout(timers.get(key));
      timers.set(
        key,
        window.setTimeout(() => {
          void open()
            .then((database) => request(database.transaction(STORE, "readwrite").objectStore(STORE).put(wrap(response, Date.now()), key)))
            .catch(() => undefined);
        }, WRITE_DELAY_MS),
      );
    },
  };
}
