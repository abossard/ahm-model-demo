import { describe, expect, it } from "vitest";
import type { SignalInfo, StateCode } from "./timeline";
import { colourRuns, levelOf, thresholdLines, type Vertices } from "./timelineLine";

const HIGH: SignalInfo["rules"] = { degraded: { operator: "GreaterThan", threshold: 70 }, unhealthy: { operator: "GreaterThan", threshold: 90 }, dynamic: false };
const LOW: SignalInfo["rules"] = { degraded: { operator: "LessThan", threshold: 99 }, unhealthy: { operator: "LessThan", threshold: 95 }, dynamic: false };
const DYNAMIC: SignalInfo["rules"] = { degraded: null, unhealthy: null, dynamic: true };
const ONLY_UNHEALTHY: SignalInfo["rules"] = { degraded: null, unhealthy: { operator: "GreaterThanOrEqual", threshold: 5 }, dynamic: false };

describe("levelOf", () => {
  it.each([
    { name: "the healthy side of the degraded threshold", value: 70, state: 1, rules: HIGH, expected: 1 },
    { name: "past the degraded threshold", value: 71, state: 2, rules: HIGH, expected: 2 },
    { name: "at the unhealthy threshold, which is not past it", value: 90, state: 2, rules: HIGH, expected: 2 },
    { name: "past the unhealthy threshold", value: 90.5, state: 3, rules: HIGH, expected: 3 },
    { name: "a low value on the healthy side of a lower than rule", value: 99.5, state: 1, rules: LOW, expected: 1 },
    { name: "a low value past the degraded threshold", value: 98, state: 2, rules: LOW, expected: 2 },
    { name: "a low value past the unhealthy threshold", value: 90, state: 3, rules: LOW, expected: 3 },
    { name: "a rule that includes its threshold", value: 5, state: 1, rules: ONLY_UNHEALTHY, expected: 3 },
    { name: "the value rules, not the reported state", value: 10, state: 3, rules: HIGH, expected: 1 },
    { name: "an Unknown state is grey, whatever the value", value: 95, state: 0, rules: HIGH, expected: 0 },
    { name: "no value is grey", value: null, state: 1, rules: HIGH, expected: 0 },
    { name: "a signal without thresholds takes the state it reported: healthy", value: 3, state: 1, rules: DYNAMIC, expected: 1 },
    { name: "a signal without thresholds takes the state it reported: degraded", value: 3, state: 2, rules: DYNAMIC, expected: 2 },
    { name: "a signal without thresholds takes the state it reported: unhealthy", value: 3, state: 3, rules: DYNAMIC, expected: 3 },
  ] as const)("$name", ({ value, state, rules, expected }) => {
    expect(levelOf(value, state, rules)).toBe(expected);
  });
});

const line = (...points: [number, number | null, StateCode?][]): Vertices => ({ x: points.map((p) => p[0]), v: points.map((p) => p[1]), s: points.map((p) => p[2] ?? 1) });
const shape = (runs: ReturnType<typeof colourRuns>) => runs.map((run) => ({ level: run.level, x: run.xs, v: run.vs }));

/** The runs as plain numbers, so a cut at a third of the way is compared to a digit, not exactly. */
function expectRuns(actual: ReturnType<typeof colourRuns>, expected: readonly { level: number; x: readonly number[]; v: readonly number[] }[]): void {
  expect(actual.map((run) => run.level)).toEqual(expected.map((run) => run.level));
  expected.forEach((want, index) => {
    expect(actual[index]?.xs.length).toBe(want.x.length);
    want.x.forEach((x, at) => expect(actual[index]?.xs[at]).toBeCloseTo(x, 6));
    want.v.forEach((v, at) => expect(actual[index]?.vs[at]).toBeCloseTo(v, 6));
  });
}

describe("colourRuns", () => {
  it.each([
    {
      name: "a line that stays healthy is one green run",
      rules: HIGH,
      vertices: line([0, 10], [10, 40], [20, 60]),
      expected: [{ level: 1, x: [0, 10, 20], v: [10, 40, 60] }],
    },
    {
      name: "a line that crosses both thresholds is cut where it crosses each",
      rules: HIGH,
      vertices: line([0, 50], [10, 100]),
      expected: [
        { level: 1, x: [0, 4], v: [50, 70] },
        { level: 2, x: [4, 8], v: [70, 90] },
        { level: 3, x: [8, 10], v: [90, 100] },
      ],
    },
    {
      name: "coming back down crosses them in the other order",
      rules: HIGH,
      vertices: line([0, 100], [10, 50]),
      expected: [
        { level: 3, x: [0, 2], v: [100, 90] },
        { level: 2, x: [2, 6], v: [90, 70] },
        { level: 1, x: [6, 10], v: [70, 50] },
      ],
    },
    {
      name: "a lower than rule is bad downwards",
      rules: LOW,
      vertices: line([0, 100], [8, 90]),
      expected: [
        { level: 1, x: [0, 0.8], v: [100, 99] },
        { level: 2, x: [0.8, 4], v: [99, 95] },
        { level: 3, x: [4, 8], v: [95, 90] },
      ],
    },
    {
      name: "a run keeps its level over several points",
      rules: HIGH,
      vertices: line([0, 10], [10, 80], [20, 85], [30, 20]),
      expected: [
        { level: 1, x: [0, 60 / 7], v: [10, 70] },
        { level: 2, x: [60 / 7, 10, 20, 20 + 150 / 65], v: [70, 80, 85, 70] },
        { level: 1, x: [20 + 150 / 65, 30], v: [70, 20] },
      ],
    },
  ])("$name", ({ vertices, rules, expected }) => {
    expectRuns(colourRuns(vertices, rules, 1000), expected);
  });

  it("the pieces of a line meet: each starts where the one before stops", () => {
    const runs = colourRuns(line([0, 10], [10, 80], [20, 95], [30, 20]), HIGH, 1000);

    expect(runs.map((run) => run.level)).toEqual([1, 2, 3, 2, 1]);
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]?.xs[0]).toBeCloseTo(runs[i - 1]?.xs.at(-1) ?? NaN, 9);
      expect(runs[i]?.vs[0]).toBeCloseTo(runs[i - 1]?.vs.at(-1) ?? NaN, 9);
    }
  });

  it.each([
    { name: "a missing value breaks the line", vertices: line([0, 10], [10, null, 0], [20, 10], [30, 12]), gap: 1000, expected: [[0], [20, 30]] },
    { name: "a gap wider than the longest an evaluation holds breaks it", vertices: line([0, 10], [10, 12], [500, 11], [510, 12]), gap: 100, expected: [[0, 10], [500, 510]] },
    { name: "a point that stands alone is a run of one", vertices: line([0, 10], [500, 11]), gap: 100, expected: [[0], [500]] },
  ])("$name", ({ vertices, gap, expected }) => {
    expect(colourRuns(vertices, HIGH, gap).map((run) => [...run.xs])).toEqual(expected);
  });

  it.each([
    { name: "an Unknown state is a grey run, not green", vertices: line([0, 10], [10, 12, 0], [20, 12, 0], [30, 10]), expected: [0] },
    { name: "a line from known to unknown is grey", vertices: line([0, 10, 1], [10, 12, 0]), expected: [0] },
  ])("$name", ({ vertices, expected }) => {
    expect(colourRuns(vertices, HIGH, 1000).map((run) => run.level)).toEqual(expected);
  });

  it("without thresholds a segment takes the worse state of its ends, and is not cut", () => {
    const runs = colourRuns(line([0, 1, 1], [10, 2, 2], [20, 3, 3], [30, 3, 1]), DYNAMIC, 1000);

    expect(shape(runs)).toEqual([
      { level: 2, x: [0, 10], v: [1, 2] },
      { level: 3, x: [10, 20, 30], v: [2, 3, 3] },
    ]);
  });

  it("an empty line has no runs", () => {
    expect(colourRuns(line(), HIGH, 100)).toEqual([]);
  });
});

describe("thresholdLines", () => {
  it.each([
    {
      name: "a higher than rule names both, the degraded label below its line and the unhealthy one above its own",
      rules: HIGH,
      unit: "Percent",
      expected: [
        { state: 2, value: 70, text: "Degraded above 70%", side: "below" },
        { state: 3, value: 90, text: "Unhealthy above 90%", side: "above" },
      ],
    },
    {
      name: "a lower than rule turns that round",
      rules: LOW,
      unit: "Percent",
      expected: [
        { state: 2, value: 99, text: "Degraded below 99%", side: "above" },
        { state: 3, value: 95, text: "Unhealthy below 95%", side: "below" },
      ],
    },
    { name: "one threshold alone is labelled on its bad side", rules: ONLY_UNHEALTHY, unit: "Count", expected: [{ state: 3, value: 5, text: "Unhealthy at or above 5", side: "above" }] },
    { name: "a dynamic signal has none to draw", rules: DYNAMIC, unit: null, expected: [] },
  ])("$name", ({ rules, unit, expected }) => {
    expect(thresholdLines(rules, unit)).toEqual(expected);
  });
});
