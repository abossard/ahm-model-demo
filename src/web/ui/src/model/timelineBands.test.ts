import { describe, expect, it } from "vitest";
import type { Point } from "./timeline";
import {
  bandAt,
  bandsFromPoints,
  bandsFromTransitions,
  bucketRange,
  bucketSeries,
  bucketSize,
  changeFrom,
  clusterMarkers,
  decimateColumns,
  firstAt,
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

describe("changeFrom", () => {
  // Healthy, then Degraded, then nothing for a while, then Unhealthy.
  const bands: Band[] = [
    { a: 0, b: 100, state: 1 },
    { a: 100, b: 200, state: 2 },
    { a: 300, b: 400, state: 3 },
  ];

  it.each([
    { name: "the next change after the start", t: 0, step: 1, expected: 100 },
    { name: "the next change from inside a band", t: 150, step: 1, expected: 200 },
    { name: "where the data stops is a change", t: 100, step: 1, expected: 200 },
    { name: "where it comes back is one too", t: 200, step: 1, expected: 300 },
    { name: "after the last change there is none", t: 300, step: 1, expected: null },
    { name: "the change before", t: 350, step: -1, expected: 300 },
    { name: "the change before one it stands on", t: 300, step: -1, expected: 200 },
    { name: "the start of the history is no change", t: 100, step: -1, expected: null },
    { name: "from beyond the end back to the last change", t: 900, step: -1, expected: 300 },
  ] as const)("$name", ({ t, step, expected }) => {
    expect(changeFrom(bands, t, step)).toBe(expected);
  });

  it("a history without bands has no change", () => {
    expect(changeFrom([], 5, 1)).toBeNull();
  });
});

describe("buckets", () => {
  it.each([
    { msPerPx: 0.2, expected: 1 },
    { msPerPx: 1, expected: 1 },
    { msPerPx: 3, expected: 2 },
    { msPerPx: 4, expected: 4 },
    { msPerPx: 600_000, expected: 524_288 },
  ])("a pixel of $msPerPx ms takes buckets of $expected ms: between half a pixel and a pixel", ({ msPerPx, expected }) => {
    expect(bucketSize(msPerPx)).toBe(expected);
  });

  it("folds the values of a bucket into its extremes, its first and last value and its worst state", () => {
    const points: Point[] = [[0, 5, 1], [3, 9, 3], [7, 1, 2], [8, 4, 1], [20, 7, 1]];

    const buckets = bucketSeries(points, 8);

    expect(buckets.length).toBe(3);
    expect([...buckets.from]).toEqual([0, 8, 20]);
    expect([...buckets.to]).toEqual([7, 8, 20]);
    expect([...buckets.lo]).toEqual([1, 4, 7]);
    expect([...buckets.hi]).toEqual([9, 4, 7]);
    expect([...buckets.first]).toEqual([5, 4, 7]);
    expect([...buckets.last]).toEqual([1, 4, 7]);
    expect([...buckets.state]).toEqual([3, 1, 1]);
    expect([...buckets.values]).toEqual([3, 1, 1]);
  });

  it.each([
    { name: "between two buckets", points: [[0, 1, 1], [10, null, 0], [20, 2, 1]] as Point[], cut: [0, 1] },
    { name: "inside a bucket, which it splits", points: [[0, 1, 1], [1, null, 0], [2, 2, 1]] as Point[], cut: [0, 1] },
    { name: "before the first value", points: [[0, null, 0], [1, 2, 1]] as Point[], cut: [1] },
    { name: "nowhere", points: [[0, 1, 1], [9, 2, 1]] as Point[], cut: [0, 0] },
  ])("an evaluation without a value $name marks the bucket after it", ({ points, cut }) => {
    expect([...bucketSeries(points, 8).cut]).toEqual(cut);
  });

  it("the buckets are the same whatever window shows: they start at multiples of their size", () => {
    const points: Point[] = Array.from({ length: 100 }, (_, i) => [1000 + i * 3, i, 1]);

    const buckets = bucketSeries(points, 16);

    for (let i = 1; i < buckets.length; i += 1) {
      expect(Math.floor((buckets.from[i] as number) / 16)).toBe(Math.floor((buckets.to[i] as number) / 16));
      expect(Math.floor((buckets.from[i] as number) / 16)).toBeGreaterThan(Math.floor((buckets.from[i - 1] as number) / 16));
    }
  });

  it.each([
    { times: [10, 20, 30], t: 20, above: false, expected: 1 },
    { times: [10, 20, 30], t: 20, above: true, expected: 2 },
    { times: [10, 20, 30], t: 5, above: false, expected: 0 },
    { times: [10, 20, 30], t: 31, above: false, expected: 3 },
    { times: [], t: 1, above: false, expected: 0 },
  ])("the first of $times at $t (above: $above) is index $expected", ({ times, t, above, expected }) => {
    expect(firstAt(times, t, above)).toBe(expected);
  });

  it.each([
    { name: "a window in the middle takes one bucket either side", t0: 35, t1: 45, expected: [3, 6] },
    { name: "a window before the series takes the first bucket", t0: -50, t1: -10, expected: [0, 1] },
    { name: "a window after it takes the last", t0: 500, t1: 600, expected: [9, 10] },
    { name: "a window over everything takes everything", t0: -5, t1: 500, expected: [0, 10] },
  ])("$name", ({ t0, t1, expected }) => {
    const buckets = bucketSeries(Array.from({ length: 10 }, (_, i): Point => [i * 10, i, 1]), 1);

    expect(bucketRange(buckets, t0, t1)).toEqual(expected);
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
