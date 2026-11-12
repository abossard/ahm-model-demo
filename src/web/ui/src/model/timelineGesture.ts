/** What a wheel event asks of the timeline: the rows scroll, the time window pans, or it zooms. */
export type WheelIntent = "scroll" | "pan" | "zoom";

export interface WheelInput {
  /** How far the wheel turned, in pixels. */
  readonly dx: number;
  readonly dy: number;
  /** Control or Command is down. A pinch on a touchpad arrives as a wheel event with Control down. */
  readonly zoom: boolean;
  readonly shift: boolean;
  /** When the event happened, in ms. */
  readonly at: number;
}

/** The axis one swipe is held to, when its last event came and how far it has gone on each axis. */
export interface AxisLock {
  readonly axis: "x" | "y";
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export interface WheelStep {
  readonly intent: WheelIntent;
  /** The pixels to scroll or pan by, or the turn to zoom by. */
  readonly amount: number;
  /** The lock to hand to the next event. */
  readonly lock: AxisLock | null;
}

/** A swipe ends when no wheel event came for this long: the next event picks its axis anew. */
export const GESTURE_GAP_MS = 150;
/** A swipe has picked its axis once it has gone this far: until then a stray first pixel decides nothing. */
const LOCK_PX = 8;

/**
 * Reads one wheel event. Control or Command (a pinch) zooms and Shift pans, whatever the swipe before did. Without a
 * modifier the swipe scrolls rows or pans time, whichever axis it moves more on, and it keeps that axis until it ends:
 * a mostly vertical swipe never pans and a mostly horizontal one never scrolls rows.
 */
export function wheelStep(input: WheelInput, lock: AxisLock | null): WheelStep {
  if (input.zoom) return { intent: "zoom", amount: input.dy, lock: null };
  if (input.shift) return { intent: "pan", amount: input.dx !== 0 ? input.dx : input.dy, lock: null };
  const held = lock !== null && input.at - lock.at <= GESTURE_GAP_MS ? lock : null;
  const x = (held?.x ?? 0) + Math.abs(input.dx);
  const y = (held?.y ?? 0) + Math.abs(input.dy);
  const decided = held !== null && Math.max(held.x, held.y) >= LOCK_PX;
  const axis = decided ? held.axis : x > y ? "x" : "y";
  return { intent: axis === "x" ? "pan" : "scroll", amount: axis === "x" ? input.dx : input.dy, lock: { axis, at: input.at, x, y } };
}

const LINE_PX = 16;

/** A wheel delta in pixels: `mode` is the event's `deltaMode` (0 pixels, 1 lines, 2 pages) and `page` the height of a page. */
export function wheelPixels(delta: number, mode: number, page: number): number {
  return delta * (mode === 1 ? LINE_PX : mode === 2 ? page : 1);
}

/** The most one wheel event zooms by: a notch of a mouse wheel, which reports a hundred pixels, zooms like a firm pinch. */
const ZOOM_TURN = 40;

/** The factor a wheel turn zooms the window by: below 1 (the wheel turned up, the fingers spread) zooms in. */
export function wheelZoom(dy: number): number {
  return Math.exp(Math.max(-ZOOM_TURN, Math.min(ZOOM_TURN, dy)) * 0.01);
}
