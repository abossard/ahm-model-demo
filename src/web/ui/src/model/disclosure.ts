/**
 * What a viewer has opened or closed to read, remembered in this browser. An explanation starts closed so it never takes
 * the graph's room; until the viewer has opened or closed it once, its toggle invites a first-time viewer to open it.
 * Storage may be unavailable, then the choice lasts as long as the page.
 */
export type DisclosureKey = "graph-key" | "timeline-key";

/** `unseen` is closed, and the viewer has never opened it. */
export type DisclosureState = "unseen" | "open" | "closed";

const PREFIX = "health-pulse-open-";

export function readDisclosure(key: DisclosureKey, getStorage: () => Storage): DisclosureState {
  try {
    const saved = getStorage().getItem(PREFIX + key);
    if (saved === "0") return "closed";
    if (saved === "1") return "open";
  } catch {
    // Storage is unavailable: a first visit.
  }
  return "unseen";
}

export function writeDisclosure(key: DisclosureKey, open: boolean, getStorage: () => Storage): void {
  try {
    getStorage().setItem(PREFIX + key, open ? "1" : "0");
  } catch {
    // Keep the choice in memory only.
  }
}
