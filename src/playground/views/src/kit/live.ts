import { LONG_POLL_CLIENT_TIMEOUT_MS } from "@playground/contracts";
import type { LiveSnapshot, Notice, Player } from "@playground/contracts";
import { call, type KitApp } from "./call";
import { errorText, log } from "./log";

interface Versioned {
  tableId: string;
  version: number;
}

// A calculation. A snapshot of another table is taken as it is. Of the same table it is taken only if newer.
// `null` is the table gone.
export function takeSnapshot<S extends Versioned>(current: S | null, incoming: S | null): S | null {
  if (!incoming || !current) return incoming;
  if (incoming.tableId !== current.tableId) return incoming;
  return incoming.version > current.version ? incoming : current;
}

const RETRY_MS = [0, 1000, 2000, 5000] as const;
export function retryDelayMs(failures: number): number {
  return RETRY_MS[Math.min(failures, RETRY_MS.length - 1)] ?? 5000;
}

// After an answer: at once, unless the server answered "no change" immediately (too many waiters).
export function pollDelayMs(answer: { changed: boolean; elapsedMs: number }): number {
  return !answer.changed && answer.elapsedMs < 1000 ? 1000 : 0;
}

export interface FollowOptions {
  app: KitApp;
  player: Player;
  tableId: string;
  version(): number;
  signal: AbortSignal;
  onChange(snapshot: LiveSnapshot | null, notice: Notice | null): void;
  onOffline(offline: boolean): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// The long-poll loop of ADR 0014: one wait_for_change at a time, again at once after each answer.
export async function followTable(options: FollowOptions): Promise<void> {
  const { app, player, tableId, signal, sleep = sleepFor, now = () => performance.now() } = options;
  let failures = 0;
  // The caller's version can lag a render behind. What this loop has already delivered is never asked for again.
  let delivered = -1;
  while (!signal.aborted) {
    const started = now();
    let delay = 0;
    try {
      const out = await call(app, "wait_for_change", { player, tableId, sinceVersion: Math.max(delivered, options.version()) }, {
        signal,
        timeout: LONG_POLL_CLIENT_TIMEOUT_MS,
      });
      if (signal.aborted) return;
      failures = 0;
      options.onOffline(false);
      if (out.snapshot) delivered = Math.max(delivered, out.snapshot.version);
      if (out.changed || out.snapshot === null) options.onChange(out.snapshot, out.notice);
      if (out.snapshot === null) return;
      delay = pollDelayMs({ changed: out.changed, elapsedMs: now() - started });
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      options.onOffline(true);
      delay = retryDelayMs(failures);
      log.warn("follow", { tableId, failures, retryMs: delay, error: errorText(error) });
    }
    if (delay > 0) await sleep(delay, signal);
  }
}
