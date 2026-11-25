import { DebugEvent, FEED_EVENT, FEED_PATH, createPairing, wireLine } from "@playground/contracts";

export const MAX_EVENTS = 2000;

export interface Wire {
  sid: string;
  events(): readonly DebugEvent[];
  subscribe(listener: () => void): () => void;
  record(event: DebugEvent): void;
  setPaused(paused: boolean): void;
  clear(): void;
}

export interface WireOptions {
  sid?: string;
  openFeed?: (url: string) => Pick<EventSource, "addEventListener" | "close">;
  log?: (line: string, event: DebugEvent) => void;
}

export function newSid(random: Uint8Array = crypto.getRandomValues(new Uint8Array(8))): string {
  return `tab-${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// The events of this tab, from both recorders: the tap (hop view-host) calls `record`, the feed (hop host-server) arrives over SSE.
export function createWire({
  sid = newSid(),
  openFeed = (url) => new EventSource(url),
  log = (line, event) => console.debug(line, event),
}: WireOptions = {}): Wire {
  const pair = createPairing();
  const listeners = new Set<() => void>();
  const seenFromServer = new Set<string>();
  let list: readonly DebugEvent[] = [];
  let held: DebugEvent[] = [];
  let paused = false;

  const notify = () => listeners.forEach((listener) => listener());
  const append = (events: readonly DebugEvent[]) => {
    list = [...list, ...events].slice(-MAX_EVENTS);
  };

  const wire: Wire = {
    sid,
    events: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    record(event) {
      // The server pairs the events of its hop already. The browser pairs its own.
      const paired = event.hop === "view-host" ? pair(event) : event;
      log(wireLine(paired), paired);
      if (paused) held.push(paired);
      else append([paired]);
      notify();
    },
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      if (!paused) {
        append(held);
        held = [];
      }
      notify();
    },
    clear() {
      list = [];
      held = [];
      notify();
    },
  };

  const source = openFeed(`${FEED_PATH}?sid=${encodeURIComponent(sid)}`);
  source.addEventListener(FEED_EVENT, (message) => {
    let data: unknown;
    try {
      data = JSON.parse((message as MessageEvent<string>).data);
    } catch {
      return;
    }
    const parsed = DebugEvent.safeParse(data);
    // A reconnect may replay what the tab already has.
    if (!parsed.success || seenFromServer.has(parsed.data.id)) return;
    seenFromServer.add(parsed.data.id);
    if (seenFromServer.size > MAX_EVENTS * 2) seenFromServer.delete(seenFromServer.values().next().value!);
    wire.record(parsed.data);
  });
  return wire;
}
