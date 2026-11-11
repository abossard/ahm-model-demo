import { describe, expect, it } from "vitest";
import type { Point } from "./timeline";
import {
  bandAt,
  bandsFromPoints,
  bandsFromTransitions,
  clusterMarkers,
  decimateColumns,
  holdOf,
  lowerIsWorse,
  parseDuration,
  pixelBands,
  pointAt,
  valueDomain,
  visibleRange,
  type Band,
} from "./timelineBands";

const RULES_HIGH = { degraded: { operator: "GreaterThan", threshold: 70 }, unhealthy: { operator: "GreaterThan", threshold: 90 }, dynamic: false };
const RULES_LOW = { degraded: { operator: "LessThan", threshold: 99 }, unhealthy: { operator: "LessThan", threshold: 95 }, dynamic: false };
const NO_RULES = { degraded: null, unhealthy: null, dynamic: false };

describe("bandsFromTransitions", () => {
  it.each([
    {
      name: "no transitions: the current state all through",
      transitions: [],
      current: 2 as const,
      expected: [{ a: 0, b: 100, state: 2 }],
    },
    {
      name: "the state before the first transition is its from",
      transitions: [{ t: 40, from: 1 as const, to: 3 as const, reason: null }],
      current: 3 as const,
      expected: [{ a: 0, b: 40, state: 1 }, { a: 40, b: 100, state: 3 }],
    },
    {
      name: "a transition into the same state merges",
      transitions: [{ t: 40, from: 1 as const, to: 1 as const, reason: null }],
      current: 1 as const,
      expected: [{ a: 0, b: 100, state: 1 }],
    },
    {
      name: "a transition at the very start leaves no empty band",
      transitions: [{ t: 0, from: 0 as const, to: 1 as const, reason: null }],
      current: 1 as const,
      expected: [{ a: 0, b: 100, state: 1 }],
    },
    {
      name: "several transitions run back to back",
      transitions: [
        { t: 10, from: 1 as const, to: 2 as const, reason: null },
        { t: 20, from: 2 as const, to: 3 as const, reason: null },
        { t: 70, from: 3 as const, to: 1 as const, reason: null },
      ],
      current: 1 as const,
      expected: [{ a: 0, b: 10, state: 1 }, { a: 10, b: 20, state: 2 }, { a: 20, b: 70, state: 3 }, { a: 70, b: 100, state: 1 }],
    },
  ])("$name", ({ transitions, current, expected }) => {
    expect(bandsFromTransitions(transitions, { from: 0, to: 100 }, current)).toEqual(expected);
  });
});

describe("bandsFromPoints", () => {
  const p = (t: number, state: 0 | 1 | 2 | 3, value: number | null = 1): Point => [t, value, state];

  it.each([
    { name: "each point holds until the next", points: [p(0, 1), p(10, 2), p(20, 1)], hold: 100, expected: [{ a: 0, b: 10, state: 1 }, { a: 10, b: 20, state: 2 }, { a: 20, b: 30, state: 1 }] },
    { name: "equal neighbours merge", points: [p(0, 1), p(10, 1), p(20, 1)], hold: 100, expected: [{ a: 0, b: 30, state: 1 }] },
    { name: "a point does not hold past the hold: a gap shows", points: [p(0, 1), p(500, 1)], hold: 100, end: 1000, expected: [{ a: 0, b: 100, state: 1 }, { a: 500, b: 600, state: 1 }] },
    { name: "an unknown point is an unknown band", points: [p(0, 1), p(10, 0, null)], hold: 100, expected: [{ a: 0, b: 10, state: 1 }, { a: 10, b: 30, state: 0 }] },
    { name: "no points no bands", points: [], hold: 100, expected: [] },
  ])("$name", ({ points, hold, expected, ...rest }) => {
    expect(bandsFromPoints(points, hold, "end" in rest ? rest.end : 30)).toEqual(expected);
  });

  it.each([
    { name: "a single point", points: [[0, 1, 1]] as Point[], refresh: 0, expected: 120_000 },
    { name: "a steady five minutes", points: Array.from({ length: 20 }, (_, i): Point => [i * 300_000, 1, 1]), refresh: 0, expected: 900_000 },
    { name: "a fast signal is held at least two minutes", points: Array.from({ length: 20 }, (_, i): Point => [i * 10_000, 1, 1]), refresh: 0, expected: 120_000 },
    { name: "the refresh interval counts when it is longer than the points show", points: Array.from({ length: 20 }, (_, i): Point => [i * 60_000, 1, 1]), refresh: 600_000, expected: 1_800_000 },
    { name: "two points a day apart are not one line", points: [[0, 1, 1], [86_400_000, 1, 1]] as Point[], refresh: 0, expected: 7_200_000 },
  ])("the hold of $name is $expected ms", ({ points, refresh, expected }) => {
    expect(holdOf(points, refresh)).toBe(expected);
  });

  it.each([
    ["PT5M", 300_000],
    ["PT1M", 60_000],
    ["PT1H30M", 5_400_000],
    ["PT30S", 30_000],
    ["P1D", 86_400_000],
    ["P1DT2H", 93_600_000],
    ["5 minutes", 0],
    ["", 0],
    [null, 0],
  ])("parses %s as %d ms", (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });
});

describe("pixelBands", () => {
  const bands: Band[] = [
    { a: 0, b: 1000, state: 1 },
    { a: 1000, b: 1001, state: 3 },
    { a: 1001, b: 2000, state: 1 },
  ];

  it("keeps wide bands as they are and folds a sub-pixel outage into one worst-state pixel", () => {
    const out = pixelBands(bands, 0, 2000, 200);

    expect(out.map((band) => band.state)).toEqual([1, 3, 1]);
    const outage = out[1];
    expect((outage?.x1 ?? 0) - (outage?.x0 ?? 0)).toBe(1);
    expect(outage?.x0).toBe(100);
  });

  it.each([
    { name: "a zoom to the middle clips", t0: 500, t1: 1500, width: 100, firstX0: 0, lastX1: 100 },
    { name: "a window with nothing in it", t0: 5000, t1: 6000, width: 100, firstX0: undefined, lastX1: undefined },
  ])("$name", ({ t0, t1, width, firstX0, lastX1 }) => {
    const out = pixelBands(bands, t0, t1, width);

    expect(out[0]?.x0).toBe(firstX0);
    expect(out[out.length - 1]?.x1).toBe(lastX1);
  });

  it("a thousand sub-pixel flaps in a pixel stay one pixel", () => {
    const flaps: Band[] = Array.from({ length: 1000 }, (_, i) => ({ a: i, b: i + 1, state: i % 2 === 0 ? 1 : 2 }));

    const out = pixelBands(flaps, 0, 1000, 10);

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ x0: 0, x1: 10, state: 2 });
  });

  it("answers bandAt for a time inside, between and outside", () => {
    expect(bandAt(bands, 500)).toBe(1);
    expect(bandAt(bands, 1000)).toBe(3);
    expect(bandAt(bands, 1001)).toBe(1);
    expect(bandAt(bands, -1)).toBeNull();
    expect(bandAt(bands, 2000)).toBeNull();
  });
});

describe("points", () => {
  const points: Point[] = [[100, 1, 1], [200, 2, 1], [300, null, 0], [400, 4, 3]];

  it.each([
    { t: 50, hold: 1000, expected: null },
    { t: 100, hold: 1000, expected: [100, 1, 1] },
    { t: 250, hold: 1000, expected: [200, 2, 1] },
    { t: 250, hold: 10, expected: null },
    { t: 900, hold: 1000, expected: [400, 4, 3] },
  ])("the point at $t within $hold is $expected", ({ t, hold, expected }) => {
    expect(pointAt(points, t, hold)).toEqual(expected);
  });

  it.each([
    { t0: 0, t1: 50, expected: [0, 1] },
    { t0: 150, t1: 250, expected: [0, 3] },
    { t0: 450, t1: 500, expected: [3, 4] },
  ])("the visible range of $t0 to $t1 is $expected (one point either side)", ({ t0, t1, expected }) => {
    expect(visibleRange(points, t0, t1)).toEqual(expected);
  });

  it("decimation keeps one entry per column with its extremes and skips gaps", () => {
    const dense: Point[] = Array.from({ length: 1000 }, (_, i) => [i, i === 500 ? 99 : i % 10, 1]);
    dense[300] = [300, null, 0];

    const columns = decimateColumns(dense, 0, 1000, 100);

    expect(columns.x.length).toBeLessThanOrEqual(101);
    const column = columns.x.indexOf(50);
    expect(columns.hi[column]).toBe(99);
    expect(columns.lo[column]).toBe(1);
    expect(columns.first[column]).toBe(99);
    expect(columns.last[column]).toBe(9);
  });

  it("a column holds the worst state of its points", () => {
    const points: Point[] = [[0, 1, 1], [1, 2, 3], [2, 3, 2], [50, 4, 1], [51, 5, 0]];

    const columns = decimateColumns(points, 0, 100, 10);

    expect(columns.state).toEqual([3, 0]);
  });
});

describe("valueDomain", () => {
  it.each([
    { name: "a high threshold keeps zero and includes the thresholds near the data", lo: 20, hi: 60, rules: RULES_HIGH, check: (d: { lo: number; hi: number }) => d.lo === 0 && d.hi > 90 },
    { name: "a threshold far above the data is left out", lo: 0.1, hi: 0.5, rules: { ...RULES_HIGH, degraded: { operator: "GreaterThan", threshold: 5000 }, unhealthy: { operator: "GreaterThan", threshold: 9000 } }, check: (d: { lo: number; hi: number }) => d.hi < 1 },
    { name: "a low threshold is not zero based", lo: 99.2, hi: 100, rules: RULES_LOW, check: (d: { lo: number; hi: number }) => d.lo > 90 && d.lo < 95 && d.hi >= 100 },
    { name: "no rules and a flat line still has a height", lo: 5, hi: 5, rules: NO_RULES, check: (d: { lo: number; hi: number }) => d.hi - d.lo > 0 },
    { name: "negative values are kept", lo: -10, hi: 10, rules: NO_RULES, check: (d: { lo: number; hi: number }) => d.lo <= -10 && d.hi >= 10 },
  ])("$name", ({ lo, hi, rules, check }) => {
    expect(check(valueDomain(lo, hi, rules))).toBe(true);
  });

  it.each([
    [RULES_HIGH, false],
    [RULES_LOW, true],
    [NO_RULES, false],
  ])("a low value is the bad one for %j: %s", (rules, low) => {
    expect(lowerIsWorse(rules)).toBe(low);
  });
});

describe("clusterMarkers", () => {
  it.each([
    { name: "far apart stay apart", xs: [0, 20, 40], minPx: 10, sizes: [1, 1, 1] },
    { name: "close ones join the first", xs: [0, 4, 8, 30], minPx: 10, sizes: [3, 1] },
    { name: "a chain does not run on", xs: [0, 6, 12, 18], minPx: 10, sizes: [2, 2] },
    { name: "none", xs: [], minPx: 10, sizes: [] },
  ])("markers $name", ({ xs, minPx, sizes }) => {
    const clusters = clusterMarkers(xs.map((x) => ({ x, item: x })), minPx);

    expect(clusters.map((cluster) => cluster.items.length)).toEqual(sizes);
  });
});
