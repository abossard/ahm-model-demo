import { healthVariables } from "../model/palette";
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

/** The bright palette, for a property that is not set: the timeline then still matches the graphs. */
const BRIGHT = healthVariables("light");
const FALLBACK: TimelineColors = {
  ink: "#242424",
  muted: "#616161",
  hair: BRIGHT["pill-stroke"] as string,
  panel: BRIGHT["canvas-bg"] as string,
  lane: BRIGHT["pill-fill"] as string,
  accent: "#0f6cbd",
  cursor: "#424242",
  state: { 0: BRIGHT["unknown-dot"] as string, 1: BRIGHT["healthy-dot"] as string, 2: BRIGHT["degraded-dot"] as string, 3: BRIGHT["unhealthy-dot"] as string, 4: BRIGHT["deleted-border"] as string },
  label: { 0: BRIGHT["unknown-label"] as string, 1: BRIGHT["healthy-label"] as string, 2: BRIGHT["degraded-label"] as string, 3: BRIGHT["unhealthy-label"] as string, 4: BRIGHT["deleted-label"] as string },
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
    hair: read("--pill-stroke", FALLBACK.hair),
    panel: read("--canvas-bg", FALLBACK.panel),
    lane: read("--pill-fill", FALLBACK.lane),
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
