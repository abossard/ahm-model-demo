import type { DebugEvent } from "@playground/contracts";

// When the browser first saw each event. The two recorders keep their own clocks, so a request that is still
// waiting is timed here, on one clock.
const arrivedAt = new Map<string, number>();
const LIMIT = 4000;

export function stampArrivals(events: readonly DebugEvent[], now = Date.now()): void {
  for (const event of events) if (!arrivedAt.has(event.id)) arrivedAt.set(event.id, now);
  while (arrivedAt.size > LIMIT) arrivedAt.delete(arrivedAt.keys().next().value!);
}

export function arrivalOf(id: string): number | null {
  return arrivedAt.get(id) ?? null;
}
