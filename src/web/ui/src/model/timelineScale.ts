/** The time axis: a view window, how it zooms and pans inside its bounds, and where its ticks fall. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** The narrowest window: a minute, the finest step the service evaluates at. */
export const MIN_SPAN = MINUTE;

export interface View {
  readonly t0: number;
  readonly t1: number;
}

export interface Bounds {
  readonly lo: number;
  readonly hi: number;
}

export type PresetId = "1h" | "6h" | "24h" | "7d" | "all";

export const PRESETS: readonly { readonly id: PresetId; readonly label: string; readonly span: number | null }[] = [
  { id: "1h", label: "1 h", span: HOUR },
  { id: "6h", label: "6 h", span: 6 * HOUR },
  { id: "24h", label: "24 h", span: DAY },
  { id: "7d", label: "7 d", span: 7 * DAY },
  { id: "all", label: "All", span: null },
];

/** The window a preset names, ending at the newest instant; "all" is the whole history. */
export function presetView(id: PresetId, bounds: Bounds): View {
  const span = PRESETS.find((preset) => preset.id === id)?.span ?? null;
  return clampView({ t0: span === null ? bounds.lo : bounds.hi - span, t1: bounds.hi }, bounds);
}

/** The preset a view is, within a tenth of a percent of its span, or null. */
export function presetOf(view: View, bounds: Bounds): PresetId | null {
  const tolerance = Math.max(1000, (view.t1 - view.t0) * 0.001);
  if (Math.abs(view.t1 - bounds.hi) > Math.max(tolerance, 2 * MINUTE)) return null;
  for (const preset of PRESETS) {
    const expected = presetView(preset.id, bounds);
    if (Math.abs(expected.t0 - view.t0) <= Math.max(tolerance, 2 * MINUTE) && Math.abs(expected.t1 - view.t1) <= Math.max(tolerance, 2 * MINUTE)) {
      return preset.id;
    }
  }
  return null;
}

/** Keeps a view inside the bounds, at least a minute wide and no wider than the bounds. */
export function clampView(view: View, bounds: Bounds): View {
  const whole = Math.max(MIN_SPAN, bounds.hi - bounds.lo);
  const span = Math.min(whole, Math.max(MIN_SPAN, view.t1 - view.t0));
  const t0 = Math.min(Math.max(view.t0, bounds.lo), Math.max(bounds.lo, bounds.hi - span));
  return { t0, t1: t0 + span };
}

/** Zooms by `factor` (below 1 zooms in) and keeps the instant under `anchor` where it is. */
export function zoomAt(view: View, anchor: number, factor: number, bounds: Bounds): View {
  const span = view.t1 - view.t0;
  const next = Math.min(bounds.hi - bounds.lo, Math.max(MIN_SPAN, span * factor));
  const fraction = (anchor - view.t0) / span;
  const t0 = anchor - fraction * next;
  return clampView({ t0, t1: t0 + next }, bounds);
}

export function panBy(view: View, dt: number, bounds: Bounds): View {
  return clampView({ t0: view.t0 + dt, t1: view.t1 + dt }, bounds);
}

/** The window a brush between two instants selects, widened to the minimum. */
export function brushView(a: number, b: number, bounds: Bounds): View {
  const mid = (a + b) / 2;
  const span = Math.max(MIN_SPAN, Math.abs(b - a));
  return clampView({ t0: mid - span / 2, t1: mid + span / 2 }, bounds);
}

/** A view that shows `span` around `[from, to]` with a quarter of padding either side. */
export function padView(from: number, to: number, bounds: Bounds): View {
  const pad = Math.max(MINUTE, (to - from) * 0.25);
  return clampView({ t0: from - pad, t1: to + pad }, bounds);
}

export interface Scale {
  readonly x: (t: number) => number;
  readonly t: (x: number) => number;
  readonly pxPerMs: number;
}

export function makeScale(view: View, width: number): Scale {
  const pxPerMs = width / Math.max(1, view.t1 - view.t0);
  return { x: (t) => (t - view.t0) * pxPerMs, t: (x) => view.t0 + x / pxPerMs, pxPerMs };
}

export function sameView(a: View, b: View, toleranceMs = 1): boolean {
  return Math.abs(a.t0 - b.t0) <= toleranceMs && Math.abs(a.t1 - b.t1) <= toleranceMs;
}

const SECOND = 1000;
const STEPS: readonly number[] = [
  SECOND,
  5 * SECOND,
  10 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
];

export interface Tick {
  readonly t: number;
  readonly label: string;
  /** A day boundary, drawn heavier. */
  readonly major: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Minutes behind UTC at an instant, as `Date.getTimezoneOffset` gives it: each instant has its own, so summer time shows. */
export type OffsetOf = (t: number) => number;

/** The offset of the browser's zone at the instant `t`. */
export const offsetAt: OffsetOf = (t) => new Date(t).getTimezoneOffset();

/** A local clock reading for an instant, in the zone `offsetOf` names for it. */
function local(t: number, offsetOf: OffsetOf): Date {
  return new Date(t - offsetOf(t) * MINUTE);
}

export function formatClock(t: number, offsetOf: OffsetOf, withSeconds = false): string {
  const d = local(t, offsetOf);
  const base = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getUTCSeconds())}` : base;
}

export function formatDay(t: number, offsetOf: OffsetOf): string {
  const d = local(t, offsetOf);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}

/** A full label for a cursor: the day, then the clock to the second. */
export function formatInstant(t: number, offsetOf: OffsetOf): string {
  return `${formatDay(t, offsetOf)} ${formatClock(t, offsetOf, true)}`;
}

/** The selected moment in full: the day with its year, then the clock to the second. */
export function formatMoment(t: number, offsetOf: OffsetOf): string {
  return `${formatDay(t, offsetOf)} ${local(t, offsetOf).getUTCFullYear()}, ${formatClock(t, offsetOf, true)}`;
}

/** The step between ticks: the smallest whose ticks are at least `minPx` apart. */
export function tickStep(span: number, width: number, minPx: number): number {
  return STEPS.find((step) => (width * step) / Math.max(1, span) >= minPx) ?? DAY * 7;
}

/** Ticks on the local clock's boundaries; each is placed with the offset of its own instant, so a change of the clock moves none of them off the hour. */
export function timeTicks(view: View, width: number, minPx: number, offsetOf: OffsetOf): readonly Tick[] {
  const step = tickStep(view.t1 - view.t0, width, minPx);
  const out: Tick[] = [];
  // `wall` is the clock reading as if it were UTC; the instant is found with the offset near it, then with the offset at that instant.
  for (let wall = Math.ceil((view.t0 - offsetOf(view.t0) * MINUTE) / step) * step; ; wall += step) {
    const guess = wall + offsetOf(wall) * MINUTE;
    const t = wall + offsetOf(guess) * MINUTE;
    if (t > view.t1) break;
    if (t < view.t0 || t <= (out[out.length - 1]?.t ?? -Infinity)) continue;
    const d = local(t, offsetOf);
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
    const label = step >= DAY || midnight ? formatDay(t, offsetOf) : formatClock(t, offsetOf, step < MINUTE);
    out.push({ t, label, major: midnight });
  }
  return out;
}

/** How far a key press moves the cursor: about one pixel of a 600 px lane, ten times that with shift. */
export function cursorStep(span: number, fast: boolean): number {
  return Math.max(SECOND, Math.round(span / 600)) * (fast ? 10 : 1);
}
