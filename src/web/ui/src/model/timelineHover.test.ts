import { describe, expect, it } from "vitest";
import type { Annotation, EntityInfo, Point, Report, SeriesHistory, Transition } from "./timeline";
import type { Band } from "./timelineBands";
import { describeRule, describeRules, formatValue, markersOf, tooltipLines, type TipInput } from "./timelineHover";
import type { Row } from "./timelineRows";

const RULES = { degraded: { operator: "GreaterThan", threshold: 70 }, unhealthy: { operator: "GreaterThan", threshold: 90 }, dynamic: false };
const entity = (name: string, signals: string[] = []): EntityInfo => ({
  name,
  displayName: name.toUpperCase(),
  parents: [],
  state: 1,
  signals: signals.map((signal) => ({ name: signal, displayName: signal.toUpperCase(), kind: null, unit: "Percent", refreshInterval: null, rules: RULES })),
});

const A = entity("a", ["cpu"]);
const B = entity("b");
const C = entity("c");
const ENTITIES = new Map([A, B, C].map((item) => [item.name, item]));
const place = { depth: 0, position: 1, size: 1 };
const ROWS: Row[] = [
  { kind: "entity", key: "e:a", entity: "a", label: "A", ...place, signalCount: 1, childCount: 0, expandable: true, expanded: true, connected: true, y: 0, h: 30 },
  { kind: "signal", key: "s:e:a\u0000cpu", parent: "e:a", entity: "a", signal: "cpu", label: "CPU", ...place, y: 30, h: 52 },
  { kind: "entity", key: "e:b", entity: "b", label: "B", ...place, signalCount: 0, childCount: 0, expandable: false, expanded: false, connected: true, y: 82, h: 30 },
  { kind: "entity", key: "e:c", entity: "c", label: "C", ...place, signalCount: 0, childCount: 0, expandable: false, expanded: false, connected: true, y: 112, h: 30 },
];
const BANDS: Record<string, Band[]> = { a: [{ a: 0, b: 100, state: 1 }], b: [{ a: 0, b: 100, state: 3 }], c: [{ a: 0, b: 50, state: 2 }] };
const POINTS: Point[] = [[10, 12.3456, 1], [60, 95, 3]];
const SERIES: SeriesHistory = { points: POINTS, covered: [], error: null };

function input(parts: Partial<TipInput> = {}): TipInput {
  return {
    t: 70,
    rows: ROWS,
    entities: ENTITIES,
    bandsOf: (item) => BANDS[item.name] ?? [],
    seriesOf: (name, signal) => (name === "a" && signal === "cpu" ? SERIES : undefined),
    hoveredKey: null,
    maxLines: 10,
    holdOf: () => 30,
    ...parts,
  };
}

describe("tooltipLines", () => {
  it("reads every lane that shows at the instant, trouble first", () => {
    const { lines, hidden } = tooltipLines(input());

    expect(lines.map((line) => [line.label, line.state, line.value])).toEqual([
      ["CPU", 3, "95%"],
      ["B", 3, null],
      ["A", 1, null],
      ["C", null, null],
    ]);
    expect(hidden).toBe(0);
  });

  it("puts the hovered row first", () => {
    expect(tooltipLines(input({ hoveredKey: "e:a" })).lines[0]?.label).toBe("A");
  });

  it("caps the list and says how many were left out", () => {
    const { lines, hidden } = tooltipLines(input({ maxLines: 2 }));

    expect(lines).toHaveLength(2);
    expect(hidden).toBe(2);
  });

  it("a signal with no evaluation within its hold has no state or value", () => {
    const { lines } = tooltipLines(input({ t: 500 }));

    expect(lines.find((line) => line.label === "CPU")).toMatchObject({ state: null, value: null });
  });

  it("a signal that is not loaded has no state", () => {
    const { lines } = tooltipLines(input({ seriesOf: () => undefined }));

    expect(lines.find((line) => line.label === "CPU")?.state).toBeNull();
  });

  it("names the entity a signal belongs to", () => {
    expect(tooltipLines(input()).lines.find((line) => line.kind === "signal")?.context).toBe("A");
  });
});

describe("formatValue and describeRules", () => {
  it.each([
    [12.3456, "Percent", "12.3%"],
    [0.000123456, null, "0.000123"],
    [1234.5, "MilliSeconds", "1230 ms"],
    [100, "Percent", "100%"],
    [3, "Count", "3"],
    [7, "Furlongs", "7 Furlongs"],
  ])("formats %d %s as %s", (value, unit, expected) => {
    expect(formatValue(value, unit)).toBe(expected);
  });

  it.each([
    { rule: { operator: "GreaterThan", threshold: 70 }, unit: "Percent", expected: "above 70%" },
    { rule: { operator: "GreaterThanOrEqual", threshold: 70 }, unit: "Percent", expected: "at or above 70%" },
    { rule: { operator: "LessThan", threshold: 99.5 }, unit: "Percent", expected: "below 99.5%" },
    { rule: { operator: "LessThanOrEqual", threshold: 250 }, unit: "MilliSeconds", expected: "at or below 250 ms" },
    { rule: { operator: "Equals", threshold: 0 }, unit: "Count", expected: "at 0" },
    { rule: { operator: "Surprise", threshold: 3 }, unit: null, expected: "above 3" },
  ])("describes a rule $expected", ({ rule, unit, expected }) => {
    expect(describeRule(rule, unit)).toBe(expected);
  });

  it.each([
    { rules: RULES, expected: "Degraded above 70%, Unhealthy above 90%" },
    { rules: { degraded: { operator: "LessThan", threshold: 99 }, unhealthy: null, dynamic: false }, expected: "Degraded below 99%" },
    { rules: { degraded: null, unhealthy: null, dynamic: true }, expected: "Dynamic threshold" },
    { rules: { degraded: null, unhealthy: null, dynamic: false }, expected: null },
  ])("describes $expected", ({ rules, expected }) => {
    expect(describeRules(rules, "Percent")).toBe(expected);
  });
});

describe("markersOf", () => {
  const annotations: Annotation[] = [
    { entity: "a", id: "1", t: 20, description: "Deploy", details: {} },
    { entity: "a", id: "2", t: 90, description: null, details: {} },
    { entity: "b", id: "3", t: 20, description: "Other", details: {} },
  ];
  const reports: Report[] = [{ entity: "a", t: 30, state: 2, value: 0.5, reason: "Maintenance", reportId: "r" }];
  const changes: Transition[] = [
    { t: 45, from: 1, to: 2, reason: "SignalTransition" },
    { t: 60, from: 2, to: 3, reason: null },
  ];

  it.each([
    { name: "everything of one entity", t0: 0, t1: 100, expected: ["Deploy", "Degraded report: Maintenance", "Healthy to Degraded: SignalTransition", "Degraded to Unhealthy", "Annotation"] },
    { name: "a window", t0: 25, t1: 35, expected: ["Degraded report: Maintenance"] },
    { name: "a state change", t0: 40, t1: 50, expected: ["Healthy to Degraded: SignalTransition"] },
    { name: "an empty window", t0: 65, t1: 70, expected: [] },
  ])("lists $name oldest first", ({ t0, t1, expected }) => {
    expect(markersOf({ annotations, reports, changes, entity: "a", t0, t1 }).map((marker) => marker.text)).toEqual(expected);
  });

  it("marks no state change when none are handed over", () => {
    expect(markersOf({ annotations, reports, changes: [], entity: "a", t0: 40, t1: 50 })).toEqual([]);
  });
});
