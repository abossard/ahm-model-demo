import { lowerBound, upperBound, type Point, type SignalInfo, type Span } from "./timeline";
import { bucketSize, holdOf, parseDuration, valueDomain } from "./timelineBands";
import { laneOf, levelOf, type Level } from "./timelineLine";

/**
 * The signal rows of the graph's cards, which the viewer turns on and off, and the sparkline in each: the signal's values
 * over the window that ends at the selected moment, drawn with the timeline's own rules for the colour of a line.
 */

export const SPARK_WIDTH = 56;
export const SPARK_HEIGHT = 14;
/** Room for the stroke at the top and bottom, and for the marker at the right. */
const INSET = 1.5;
const MARKER_ROOM = 2;
const NO_RULES: SignalInfo["rules"] = { degraded: null, unhealthy: null, dynamic: false };

export interface SparkPath {
  readonly level: Level;
  /** SVG path data in the sparkline's own pixels. A run of one evaluation is a zero-length segment: a round cap draws it as a dot. */
  readonly d: string;
}

export interface Sparkline {
  /** One path for each level the line passes through in the window, Unknown first and Unhealthy last. */
  readonly paths: readonly SparkPath[];
  /** Where the line is at the end of the window, the moment: null when no evaluation holds there. */
  readonly marker: { readonly x: number; readonly y: number; readonly level: Level } | null;
}

const EMPTY: Sparkline = { paths: [], marker: null };

const round = (value: number): number => Math.round(value * 10) / 10;
const timeOf = (point: Point): number => point[0];

/**
 * The sparkline of a series over `span`: the lane the timeline would draw at this width (`laneOf`), green where the value
 * is healthy, amber past the degraded threshold, red past the unhealthy one and grey where the state is Unknown, scaled
 * to the values in the window as the timeline scales a lane (`valueDomain`). Empty when the window holds no value.
 */
export function sparkline(points: readonly Point[], info: SignalInfo | undefined, span: Span, width = SPARK_WIDTH, height = SPARK_HEIGHT): Sparkline {
  const length = span.to - span.from;
  // One point before the window, so the line enters it at its left edge.
  const shown = points.slice(Math.max(0, lowerBound(points, span.from, timeOf) - 1), upperBound(points, span.to, timeOf));
  const values = shown.flatMap((point) => (point[1] === null ? [] : [point[1]]));
  if (length <= 0 || values.length === 0) return EMPTY;
  const rules = info?.rules ?? NO_RULES;
  const hold = holdOf(points, parseDuration(info?.refreshInterval ?? null));
  const reach = width - MARKER_ROOM;
  const lane = laneOf(shown, bucketSize(length / reach), rules, hold);
  const domain = valueDomain(Math.min(...values), Math.max(...values), rules);
  const x = (t: number): number => round(((t - span.from) / length) * reach);
  const y = (v: number): number => round(INSET + (1 - (v - domain.lo) / (domain.hi - domain.lo)) * (height - 2 * INSET));
  const paths: SparkPath[] = [];
  lane.runs.forEach((runs, level) => {
    if (runs.length === 0) return;
    const d = runs.map((run) => run.xs.map((t, i) => `${i === 0 ? "M" : "L"}${x(t)} ${y(run.vs[i] as number)}`).join("") + (run.xs.length === 1 ? "h0" : "")).join("");
    paths.push({ level: level as Level, d });
  });
  const last = shown[shown.length - 1] as Point;
  const marker = last[1] !== null && span.to - last[0] <= hold ? { x: reach, y: y(last[1]), level: levelOf(last[1], last[2], rules) } : null;
  return { paths, marker };
}

export const CARD_SIGNALS_STORAGE_KEY = "ahm.cardSignals.v1";

/** Whether the viewer last turned the cards' signal rows on; off when nothing was kept. */
export function readStoredCardSignals(getStorage: () => Storage): boolean {
  try {
    return getStorage().getItem(CARD_SIGNALS_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function persistCardSignals(on: boolean, getStorage: () => Storage): void {
  try {
    getStorage().setItem(CARD_SIGNALS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The choice then lasts only as long as the page does.
  }
}
