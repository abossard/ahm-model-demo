import { describe, expect, it } from "vitest";
import type { Point } from "./timeline";
import { bandsFromPoints, holdOf } from "./timelineBands";
import { DAY, HOUR, MINUTE } from "./timelineScale";
import { CLOSE_SAFETY, LEVELS, RAW, WEEK, decimate, isClosed, levelFor, levelOfResolution, tileOf, tileRuns, tileSpan, tilesIn } from "./timelineTiles";

describe("levels", () => {
  it("are days of raw points, days of slots of 15 minutes and weeks of slots of an hour", () => {
    expect(LEVELS).toEqual([
      { slot: 0, tile: DAY },
      { slot: 15 * MINUTE, tile: DAY },
      { slot: HOUR, tile: WEEK },
    ]);
  });

  it.each([
    { name: "an hour", span: HOUR, width: 1000, level: 0 },
    { name: "a day", span: DAY, width: 1000, level: 0 },
    { name: "four days", span: 4 * DAY, width: 1000, level: 0 },
    { name: "a week", span: 7 * DAY, width: 1000, level: 1 },
    { name: "a week on a wide screen", span: 7 * DAY, width: 3000, level: 0 },
    { name: "two weeks", span: 14 * DAY, width: 1000, level: 1 },
    { name: "a month", span: 30 * DAY, width: 1000, level: 2 },
    { name: "a month on a narrow screen", span: 30 * DAY, width: 300, level: 2 },
    { name: "no width", span: DAY, width: 0, level: 2 },
  ])("$name on $width px is drawn at level $level", ({ span, width, level }) => {
    expect(levelFor(span, width)).toBe(level);
  });

  it.each([
    [0, 0],
    [900, 1],
    [3600, 2],
    [60, 1],
    [1800, 2],
    [86400, 2],
  ])("an answer at %d seconds a slot is held at level %d", (seconds, level) => {
    expect(levelOfResolution(seconds)).toBe(level);
  });
});

describe("tiles", () => {
  it.each([
    { name: "inside one tile", span: { from: 10, to: 20 }, size: 100, tiles: [0] },
    { name: "across a boundary", span: { from: 90, to: 110 }, size: 100, tiles: [0, 1] },
    { name: "ending on a boundary", span: { from: 0, to: 100 }, size: 100, tiles: [0] },
    { name: "beginning on a boundary", span: { from: 100, to: 250 }, size: 100, tiles: [1, 2] },
    { name: "an empty span", span: { from: 50, to: 50 }, size: 100, tiles: [] },
    { name: "before the epoch", span: { from: -150, to: -50 }, size: 100, tiles: [-2, -1] },
  ])("a span $name touches $tiles", ({ span, size, tiles }) => {
    expect(tilesIn(span, size)).toEqual(tiles);
  });

  it("a tile begins at a multiple of its size, so the same instant is always in the same tile", () => {
    const t = Date.parse("2026-11-11T12:34:56Z");

    expect(tileSpan(tileOf(t, DAY), DAY)).toEqual({ from: Date.parse("2026-11-11T00:00:00Z"), to: Date.parse("2026-11-12T00:00:00Z") });
    expect(tileSpan(tileOf(t, WEEK), WEEK)).toEqual({ from: Date.parse("2026-11-05T00:00:00Z"), to: Date.parse("2026-11-12T00:00:00Z") });
  });

  it.each([
    { tiles: [], runs: [] },
    { tiles: [4], runs: [[4, 4]] },
    { tiles: [1, 2, 3], runs: [[1, 3]] },
    { tiles: [1, 2, 5, 6, 9], runs: [[1, 2], [5, 6], [9, 9]] },
  ])("$tiles are the runs $runs", ({ tiles, runs }) => {
    expect(tileRuns(tiles)).toEqual(runs);
  });

  it.each([
    { name: "while it is open", readAt: 500, closed: false },
    { name: "at its end", readAt: 1000, closed: false },
    { name: "inside the safety margin", readAt: 1000 + CLOSE_SAFETY - 1, closed: false },
    { name: "after the safety margin", readAt: 1000 + CLOSE_SAFETY, closed: true },
  ])("a tile read $name is closed: $closed", ({ readAt, closed }) => {
    expect(isClosed({ from: 0, to: 1000 }, readAt)).toBe(closed);
  });
});

describe("decimate", () => {
  const slot = 60_000;
  const ramp: Point[] = Array.from({ length: 12 }, (_unused, index) => [index * 5000, index, 1]);
  const flat = (states: readonly (0 | 1 | 3)[], values: readonly (number | null)[] = []): Point[] => [0, 10_000, 20_000, 29_000, 40_000, 59_000].map((t, index) => [t, values[index] === undefined ? 5 : (values[index] as number | null), states[index] ?? 1]);

  // The same table as test_timeline.py: the server thins by the same rule.
  it.each([
    { name: "no slot keeps everything", size: 0, points: [[0, 1, 1], [1000, 2, 1]] as Point[], expected: [[0, 1, 1], [1000, 2, 1]] },
    { name: "a slot of five points is kept whole", size: slot, points: [0, 1, 2, 3, 4].map((t): Point => [t, t, 1]), expected: [0, 1, 2, 3, 4].map((t) => [t, t, 1]) },
    { name: "a ramp keeps its first point, the last of each half and its top", size: slot, points: ramp, expected: [ramp[0], ramp[5], ramp[11]] },
    { name: "the lowest and the highest value are kept where they are", size: slot, points: flat([], [5, 9, 1, 4, 5, 6]), expected: [[10_000, 9, 1], [20_000, 1, 1], [29_000, 4, 1], [59_000, 6, 1]] },
    { name: "a worse state than any kept point is kept too", size: slot, points: flat([1, 3]), expected: [[0, 5, 1], [10_000, 5, 3], [29_000, 5, 1], [59_000, 5, 1]] },
    { name: "a gap in the data outranks healthy points", size: slot, points: flat([1, 0], [5, null]), expected: [[0, 5, 1], [10_000, null, 0], [29_000, 5, 1], [59_000, 5, 1]] },
    { name: "a slot of gaps keeps the last of each half", size: slot, points: [0, 1, 2, 3, 4, 5].map((index): Point => [index * 10_000, null, 0]), expected: [[20_000, null, 0], [50_000, null, 0]] },
    { name: "slots stay separate", size: slot, points: [[0, 1, 1], [slot, 2, 1]] as Point[], expected: [[0, 1, 1], [slot, 2, 1]] },
  ])("$name", ({ size, points, expected }) => {
    expect(decimate(points, size)).toEqual(expected);
  });

  it("returns the same array when nothing was thinned", () => {
    const points: Point[] = [[0, 1, 1], [slot, 2, 1]];

    expect(decimate(points, slot)).toBe(points);
  });

  it.each([
    { name: "a signal evaluated every minute", every: MINUTE, level: 1 },
    { name: "a signal evaluated every minute", every: MINUTE, level: 2 },
    { name: "a signal evaluated every five minutes", every: 5 * MINUTE, level: 2 },
  ])("$name thinned to level $level shows no hole where the plot joins each point to the next", ({ every, level }) => {
    const raw: Point[] = Array.from({ length: (3 * DAY) / every }, (_unused, index) => [index * every, (index * 7919) % 101, 1]);
    const slotMs = (LEVELS[level] as { slot: number }).slot;

    const thin = decimate(raw, slotMs);
    const gaps = thin.slice(1).map((point, index) => point[0] - (thin[index] as Point)[0]);
    const bands = bandsFromPoints(thin, holdOf(thin, every), 3 * DAY);

    expect(Math.max(...gaps)).toBeLessThanOrEqual(slotMs / 2 + every);
    expect(thin.length).toBeLessThanOrEqual((5 * 3 * DAY) / slotMs);
    expect(bands).toHaveLength(1);
    expect([Math.max(...thin.map((point) => point[1] as number)), Math.min(...thin.map((point) => point[1] as number))]).toEqual([100, 0]);
  });

  it("raw is level 0", () => {
    expect(RAW).toBe(0);
  });
});
