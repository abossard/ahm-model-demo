import type { StateCode } from "../model/timeline";

export interface TimelineColors {
  readonly ink: string;
  readonly muted: string;
  readonly hair: string;
  readonly panel: string;
  readonly lane: string;
  readonly accent: string;
  readonly cursor: string;
  readonly state: Readonly<Record<StateCode, string>>;
  /** The state colours as text: the ones with the contrast to read on the panel. */
  readonly label: Readonly<Record<StateCode, string>>;
}

const FALLBACK: TimelineColors = {
  ink: "#242424",
  muted: "#616161",
  hair: "#e0e0e0",
  panel: "#ffffff",
  lane: "#f5f5f5",
  accent: "#0f6cbd",
  cursor: "#424242",
  state: { 0: "#8a8886", 1: "#4c9a2a", 2: "#c26a00", 3: "#c50f18", 4: "#8661c5" },
  label: { 0: "#5f5d5b", 1: "#2f7a1f", 2: "#8a4b00", 3: "#9b111e", 4: "#5b3a8f" },
};

/**
 * The colours a canvas draws with, read from the custom properties the theme sets on the app's root, so a canvas
 * follows light and dark like the rest of the page. A property that is not set falls back to a light-theme colour.
 */
export function readColors(element: Element): TimelineColors {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    ink: read("--colorNeutralForeground1", FALLBACK.ink),
    muted: read("--colorNeutralForeground2", FALLBACK.muted),
    hair: read("--colorNeutralStroke2", FALLBACK.hair),
    panel: read("--colorNeutralBackground1", FALLBACK.panel),
    lane: read("--colorNeutralBackground3", FALLBACK.lane),
    accent: read("--colorBrandForeground1", FALLBACK.accent),
    cursor: read("--colorNeutralForeground2", FALLBACK.cursor),
    state: {
      0: read("--unknown-dot", FALLBACK.state[0]),
      1: read("--healthy-dot", FALLBACK.state[1]),
      2: read("--degraded-dot", FALLBACK.state[2]),
      3: read("--unhealthy-dot", FALLBACK.state[3]),
      4: read("--deleted-border", FALLBACK.state[4]),
    },
    label: {
      0: read("--unknown-label", FALLBACK.label[0]),
      1: read("--healthy-label", FALLBACK.label[1]),
      2: read("--degraded-label", FALLBACK.label[2]),
      3: read("--unhealthy-label", FALLBACK.label[3]),
      4: read("--deleted-label", FALLBACK.label[4]),
    },
  };
}
