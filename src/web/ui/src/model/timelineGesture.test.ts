import { describe, expect, it } from "vitest";
import { GESTURE_GAP_MS, wheelPixels, wheelStep, wheelZoom, type AxisLock, type WheelInput, type WheelIntent } from "./timelineGesture";

const wheel = (dx: number, dy: number, at = 0, keys: { zoom?: boolean; shift?: boolean } = {}): WheelInput => ({ dx, dy, at, zoom: keys.zoom ?? false, shift: keys.shift ?? false });

/** What a run of events does, one after another, each with the lock the one before left. */
function play(events: readonly WheelInput[]): { intents: WheelIntent[]; amounts: number[] } {
  let lock: AxisLock | null = null;
  const intents: WheelIntent[] = [];
  const amounts: number[] = [];
  for (const event of events) {
    const step = wheelStep(event, lock);
    lock = step.lock;
    intents.push(step.intent);
    amounts.push(step.amount);
  }
  return { intents, amounts };
}

describe("wheelStep", () => {
  it.each([
    { name: "a vertical swipe scrolls the rows", input: wheel(0, 12), intent: "scroll", amount: 12 },
    { name: "a mouse wheel notch scrolls the rows", input: wheel(0, -100), intent: "scroll", amount: -100 },
    { name: "a horizontal swipe pans", input: wheel(-9, 0), intent: "pan", amount: -9 },
    { name: "a diagonal swipe that is more vertical scrolls", input: wheel(5, 9), intent: "scroll", amount: 9 },
    { name: "a diagonal swipe that is more horizontal pans", input: wheel(9, -5), intent: "pan", amount: 9 },
    { name: "an even diagonal scrolls", input: wheel(6, 6), intent: "scroll", amount: 6 },
    { name: "a pinch zooms", input: wheel(0, -4, 0, { zoom: true }), intent: "zoom", amount: -4 },
    { name: "a pinch zooms however it leans", input: wheel(30, 2, 0, { zoom: true }), intent: "zoom", amount: 2 },
    { name: "Shift and a wheel that reports a vertical turn pans by it", input: wheel(0, 100, 0, { shift: true }), intent: "pan", amount: 100 },
    { name: "Shift and a wheel that reports a horizontal turn pans by it", input: wheel(100, 0, 0, { shift: true }), intent: "pan", amount: 100 },
    { name: "Control wins over Shift", input: wheel(0, 100, 0, { zoom: true, shift: true }), intent: "zoom", amount: 100 },
  ] as const)("$name", ({ input, intent, amount }) => {
    const step = wheelStep(input, null);

    expect(step.intent).toBe(intent);
    expect(step.amount).toBe(amount);
  });

  it.each([
    {
      name: "a vertical swipe that drifts sideways keeps scrolling and never pans",
      events: [wheel(0, 10, 0), wheel(2, 10, 16), wheel(30, 4, 32), wheel(40, 0, 48)],
      intents: ["scroll", "scroll", "scroll", "scroll"],
      amounts: [10, 10, 4, 0],
    },
    {
      name: "a horizontal swipe that drifts down keeps panning and never scrolls",
      events: [wheel(12, 0, 0), wheel(10, 3, 16), wheel(2, 40, 32)],
      intents: ["pan", "pan", "pan"],
      amounts: [12, 10, 2],
    },
    {
      name: "a diagonal start keeps the axis it moved more on",
      events: [wheel(6, 9, 0), wheel(20, 2, 16), wheel(20, 2, 32)],
      intents: ["scroll", "scroll", "scroll"],
      amounts: [9, 2, 2],
    },
    {
      name: "a stray first pixel decides nothing: the swipe takes the axis it goes on",
      events: [wheel(1, 0, 0), wheel(0, 6, 8), wheel(0, 9, 16), wheel(14, 1, 24)],
      intents: ["pan", "scroll", "scroll", "scroll"],
      amounts: [1, 6, 9, 1],
    },
    {
      name: "the momentum of a swipe stays on its axis as long as its events keep coming",
      events: [wheel(0, 40, 0), wheel(3, 1, 100), wheel(2, 0, 200), wheel(1, 0, 300)],
      intents: ["scroll", "scroll", "scroll", "scroll"],
      amounts: [40, 1, 0, 0],
    },
    {
      name: "a pause ends the swipe: the next one picks its axis anew",
      events: [wheel(0, 40, 0), wheel(0, 40, 16), wheel(25, 3, 16 + GESTURE_GAP_MS + 1)],
      intents: ["scroll", "scroll", "pan"],
      amounts: [40, 40, 25],
    },
    {
      name: "a pinch in the middle of a swipe zooms, and the swipe after it picks its axis anew",
      events: [wheel(0, 40, 0), wheel(0, -3, 16, { zoom: true }), wheel(25, 3, 32)],
      intents: ["scroll", "zoom", "pan"],
      amounts: [40, -3, 25],
    },
  ] as const)("$name", ({ events, intents, amounts }) => {
    expect(play(events)).toEqual({ intents, amounts });
  });
});

describe("wheelPixels", () => {
  it.each([
    { name: "pixels stay pixels", mode: 0, expected: 3 },
    { name: "a line is sixteen pixels", mode: 1, expected: 48 },
    { name: "a page is the height it is given", mode: 2, expected: 1200 },
  ])("$name", ({ mode, expected }) => {
    expect(wheelPixels(3, mode, 400)).toBe(expected);
  });
});

describe("wheelZoom", () => {
  it.each([
    { name: "no turn leaves the window as it is", dy: 0, expected: 1 },
    { name: "a turn up zooms in", dy: -10, expected: Math.exp(-0.1) },
    { name: "a turn down zooms out", dy: 10, expected: Math.exp(0.1) },
    { name: "a notch of a mouse wheel zooms no more than a firm pinch", dy: 100, expected: Math.exp(0.4) },
    { name: "and no less the other way", dy: -120, expected: Math.exp(-0.4) },
  ])("$name", ({ dy, expected }) => {
    expect(wheelZoom(dy)).toBeCloseTo(expected, 10);
  });
});
