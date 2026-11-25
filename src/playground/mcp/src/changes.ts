import type { Changes } from "./ports";

export function createChanges(now: () => number = Date.now): Changes {
  const waiting = new Map<string, Set<(version: number | null) => void>>();

  return {
    publish(tableId, version) {
      const resolvers = waiting.get(tableId);
      if (!resolvers) return;
      waiting.delete(tableId);
      for (const resolve of resolvers) resolve(version);
    },

    next(tableId, deadline, signal) {
      return new Promise<number | null>((resolve) => {
        if (signal.aborted) return resolve(null);
        const done = (version: number | null) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          const set = waiting.get(tableId);
          set?.delete(done);
          if (set?.size === 0) waiting.delete(tableId);
          resolve(version);
        };
        const onAbort = () => done(null);
        const timer = setTimeout(() => done(null), Math.max(0, deadline - now()));
        signal.addEventListener("abort", onAbort, { once: true });
        const set = waiting.get(tableId) ?? new Set();
        set.add(done);
        waiting.set(tableId, set);
      });
    },
  };
}
