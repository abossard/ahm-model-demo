import { FEED_EVENT, createPairing } from "@playground/contracts";
import type { DebugEvent } from "@playground/contracts";

export const SID_PATTERN = /^[a-z0-9-]{8,40}$/;

export interface FeedClient {
  write(chunk: string): void;
  end(): void;
}

interface Tab {
  seq: number;
  pair: (event: DebugEvent) => DebugEvent;
  ring: DebugEvent[];
  clients: Set<FeedClient>;
  lastActive: number;
}

export interface FeedOptions {
  now?: () => number;
  ringSize?: number;
  maxTabs?: number;
  idleMs?: number;
}

// A calculation: one SSE frame of one event. `id` is the sequence number, so a reconnect replays what it missed.
export function frame(event: DebugEvent): string {
  return `id: ${event.seq}\nevent: ${FEED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

// Per tab (`sid`): the last events and the open streams. Events are kept whether or not a stream is open.
export function createFeed({ now = Date.now, ringSize = 500, maxTabs = 300, idleMs = 600_000 }: FeedOptions = {}) {
  const tabs = new Map<string, Tab>();

  function close(sid: string): void {
    for (const client of tabs.get(sid)?.clients ?? []) client.end();
    tabs.delete(sid);
  }

  function tab(sid: string): Tab {
    let found = tabs.get(sid);
    if (!found) {
      if (tabs.size >= maxTabs) {
        const oldest = [...tabs].reduce((a, b) => (b[1].lastActive < a[1].lastActive ? b : a));
        close(oldest[0]);
      }
      found = { seq: 0, pair: createPairing(), ring: [], clients: new Set(), lastActive: now() };
      tabs.set(sid, found);
    }
    found.lastActive = now();
    return found;
  }

  return {
    // `build` receives the next sequence number of the tab. The event is paired, stored and sent to the open streams.
    record(sid: string, build: (seq: number) => DebugEvent): DebugEvent {
      const current = tab(sid);
      const event = current.pair(build(++current.seq));
      current.ring.push(event);
      if (current.ring.length > ringSize) current.ring.shift();
      const text = frame(event);
      for (const client of current.clients) client.write(text);
      return event;
    },

    // Replays the events after `lastEventId`, then follows. Returns the function that detaches the client.
    open(sid: string, client: FeedClient, lastEventId = 0): () => void {
      const current = tab(sid);
      for (const event of current.ring) if (event.seq > lastEventId) client.write(frame(event));
      current.clients.add(client);
      return () => {
        current.clients.delete(client);
      };
    },

    // Keeps ingress from idling the streams out, and drops tabs that are quiet and unwatched.
    heartbeat(): void {
      const t = now();
      for (const [sid, current] of tabs) {
        if (current.clients.size === 0 && t - current.lastActive > idleMs) tabs.delete(sid);
        for (const client of current.clients) client.write(": ping\n\n");
      }
    },

    stats: () => ({ tabs: tabs.size, streams: [...tabs.values()].reduce((sum, t) => sum + t.clients.size, 0) }),
  };
}
export type Feed = ReturnType<typeof createFeed>;
