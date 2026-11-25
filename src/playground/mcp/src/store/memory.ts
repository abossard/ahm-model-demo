import { TTL_SECONDS } from "../ports";
import type { Doc, Kind, Store } from "../ports";

interface Entry {
  doc: Doc<unknown>;
  seq: number;
}

export function createMemoryStore(now: () => number = Date.now): Store {
  const kinds: Record<Kind, Map<string, Entry>> = { tables: new Map(), runs: new Map(), players: new Map() };
  let seq = 0;
  const keyOf = (pk: string, id: string) => `${pk}\u0000${id}`;

  function live(kind: Kind, pk: string, id: string): Entry | undefined {
    const entry = kinds[kind].get(keyOf(pk, id));
    if (!entry) return undefined;
    if (entry.doc.updatedAt + TTL_SECONDS[kind] * 1000 < now()) {
      kinds[kind].delete(keyOf(pk, id));
      return undefined;
    }
    return entry;
  }

  return {
    async get<T>(kind: Kind, pk: string, id: string) {
      const entry = live(kind, pk, id);
      return entry ? (structuredClone(entry.doc) as Doc<T>) : null;
    },

    async update<T>(kind: Kind, pk: string, id: string, change: (body: T | null) => T | null) {
      const entry = live(kind, pk, id);
      const current = entry ? (structuredClone(entry.doc) as Doc<T>) : null;
      const next = change(current ? current.body : null);
      if (next === null || (current && next === current.body)) return current;
      const doc: Doc<T> = { id, pk, version: (current?.version ?? 0) + 1, updatedAt: now(), body: structuredClone(next) };
      kinds[kind].set(keyOf(pk, id), { doc, seq: ++seq });
      return structuredClone(doc);
    },

    async list<T>(kind: Kind, pk: string, limit: number) {
      const entries: Entry[] = [];
      for (const entry of kinds[kind].values()) {
        if (entry.doc.pk === pk && live(kind, pk, entry.doc.id)) entries.push(entry);
      }
      entries.sort((a, b) => b.doc.updatedAt - a.doc.updatedAt || b.seq - a.seq);
      return entries.slice(0, limit).map((entry) => structuredClone(entry.doc) as Doc<T>);
    },

    async remove(kind, pk, id) {
      kinds[kind].delete(keyOf(pk, id));
    },
  };
}
