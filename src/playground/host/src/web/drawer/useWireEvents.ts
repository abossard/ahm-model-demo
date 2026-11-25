import type { DebugEvent } from "@playground/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Wire } from "../app/wireApi";

interface Source {
  subscribe(onChange: () => void): () => void;
  snapshot(): readonly DebugEvent[];
}

const NONE: readonly DebugEvent[] = [];
const sources = new WeakMap<Wire, Source>();

// `useSyncExternalStore` needs a snapshot that keeps its identity until something changes. A wire may hand out a
// new array on every call, so the snapshot is replaced only when its length or its ends differ.
function sourceOf(wire: Wire): Source {
  let source = sources.get(wire);
  if (!source) {
    let cache = wire.events();
    const refresh = () => {
      const next = wire.events();
      if (next !== cache && (next.length !== cache.length || next[0] !== cache[0] || next.at(-1) !== cache.at(-1))) cache = next;
    };
    source = {
      subscribe: (onChange) => wire.subscribe(() => {
        refresh();
        onChange();
      }),
      snapshot: () => {
        refresh();
        return cache;
      },
    };
    sources.set(wire, source);
  }
  return source;
}

const emptySource: Source = { subscribe: () => () => {}, snapshot: () => NONE };

export function useWireEvents(wire: Wire | null): readonly DebugEvent[] {
  const source = wire ? sourceOf(wire) : emptySource;
  return useSyncExternalStore(source.subscribe, source.snapshot);
}

// A clock for the timers of requests that are still waiting. It runs only while `active`.
export function useNow(active: boolean, everyMs = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
