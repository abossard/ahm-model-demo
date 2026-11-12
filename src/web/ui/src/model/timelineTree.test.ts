import { describe, expect, it } from "vitest";
import type { Point, SeriesHistory, SignalInfo } from "./timeline";
import { emphasisOf, ruleZones, signalFacts } from "./timelineTree";

const HIGH: SignalInfo["rules"] = { degraded: { operator: "GreaterThan", threshold: 70 }, unhealthy: { operator: "GreaterThan", threshold: 90 }, dynamic: false };
const LOW: SignalInfo["rules"] = { degraded: { operator: "LessThan", threshold: 99 }, unhealthy: { operator: "LessThan", threshold: 95 }, dynamic: false };
const NONE: SignalInfo["rules"] = { degraded: null, unhealthy: null, dynamic: false };

describe("signalFacts", () => {
  const points: Point[] = [[100, 12.3456, 1], [200, 95, 3], [300, null, 0]];
  const history: SeriesHistory = { points, covered: [], error: null };
  const info: SignalInfo = { name: "cpu", displayName: "CPU", kind: null, unit: "Percent", refreshInterval: null, rules: HIGH };

  it.each([
    { name: "the latest", asOf: 250, expected: { state: 3, value: "95%", at: 200 } },
    { name: "an earlier moment", asOf: 150, expected: { state: 1, value: "12.3%", at: 100 } },
    { name: "an evaluation without a value", asOf: 320, expected: { state: 0, value: null, at: 300 } },
    { name: "before the history", asOf: 10, expected: { state: null, value: null, at: null } },
    { name: "long after the last evaluation", asOf: 9999, expected: { state: null, value: null, at: null } },
  ])("reads $name", ({ asOf, expected }) => {
    expect(signalFacts(info, history, asOf, 100)).toMatchObject(expected);
  });

  it("carries the rule text, and has no state for a signal that is not loaded", () => {
    expect(signalFacts(info, undefined, 150, 100)).toEqual({ state: null, value: null, rule: "Degraded above 70%, Unhealthy above 90%", at: null });
    expect(signalFacts(undefined, history, 150, 100).rule).toBeNull();
  });
});

describe("ruleZones", () => {
  const rule = (operator: string, threshold: number) => ({ operator, threshold });
  it.each([
    { name: "high is bad", rules: HIGH, domain: { lo: 0, hi: 100 }, expected: [{ from: 0, to: 70, state: 1 }, { from: 70, to: 90, state: 2 }, { from: 90, to: 100, state: 3 }] },
    { name: "low is bad", rules: LOW, domain: { lo: 90, hi: 101 }, expected: [{ from: 90, to: 95, state: 3 }, { from: 95, to: 99, state: 2 }, { from: 99, to: 101, state: 1 }] },
    { name: "the inclusive forms cut at the same values", rules: { ...HIGH, degraded: rule("GreaterThanOrEqual", 70), unhealthy: rule("GreaterThanOrEqual", 90) }, domain: { lo: 0, hi: 100 }, expected: [{ from: 0, to: 70, state: 1 }, { from: 70, to: 90, state: 2 }, { from: 90, to: 100, state: 3 }] },
    { name: "the inclusive forms, low is bad", rules: { ...LOW, degraded: rule("LessThanOrEqual", 99), unhealthy: rule("LessThanOrEqual", 95) }, domain: { lo: 90, hi: 101 }, expected: [{ from: 90, to: 95, state: 3 }, { from: 95, to: 99, state: 2 }, { from: 99, to: 101, state: 1 }] },
    { name: "clipped to the domain", rules: HIGH, domain: { lo: 0, hi: 80 }, expected: [{ from: 0, to: 70, state: 1 }, { from: 70, to: 80, state: 2 }] },
    { name: "thresholds off the chart on the bad side: all of it is healthy", rules: HIGH, domain: { lo: 0, hi: 50 }, expected: [{ from: 0, to: 50, state: 1 }] },
    { name: "an unhealthy rule alone", rules: { ...NONE, unhealthy: rule("GreaterThan", 5) }, domain: { lo: 0, hi: 10 }, expected: [{ from: 0, to: 5, state: 1 }, { from: 5, to: 10, state: 3 }] },
    { name: "a degraded rule alone, low is bad", rules: { ...NONE, degraded: rule("LessThan", 5) }, domain: { lo: 0, hi: 10 }, expected: [{ from: 0, to: 5, state: 2 }, { from: 5, to: 10, state: 1 }] },
    { name: "a spike that stretches the lane keeps the healthy range as short as its values", rules: { ...NONE, unhealthy: rule("GreaterThan", 1000) }, domain: { lo: 0, hi: 14500 }, expected: [{ from: 0, to: 1000, state: 1 }, { from: 1000, to: 14500, state: 3 }] },
    { name: "no rules", rules: NONE, domain: { lo: 0, hi: 10 }, expected: [] },
  ])("cuts $name", ({ rules, domain, expected }) => {
    expect(ruleZones(rules, domain)).toEqual(expected);
  });
});

describe("emphasisOf", () => {
  const zones = ruleZones(HIGH, { lo: 0, hi: 100 });
  const span = (x0: number, x1: number, state: 0 | 1 | 2 | 3 | 4) => ({ x0, x1, state });
  it.each([
    { name: "the zone of the state the signal had", spans: [span(0, 10, 1), span(10, 20, 3)], zones, expected: [{ x0: 0, x1: 10, state: 1, from: 0, to: 70 }, { x0: 10, x1: 20, state: 3, from: 90, to: 100 }] },
    { name: "Unknown over the whole lane height", spans: [span(0, 10, 0)], zones, expected: [{ x0: 0, x1: 10, state: 0, from: null, to: null }] },
    { name: "Deleted not at all", spans: [span(0, 10, 4)], zones, expected: [] },
    { name: "every state of a signal without zones over the whole lane height", spans: [span(0, 10, 1), span(10, 20, 2)], zones: [], expected: [{ x0: 0, x1: 10, state: 1, from: null, to: null }, { x0: 10, x1: 20, state: 2, from: null, to: null }] },
    { name: "a state the rule has no zone for over the whole lane height", spans: [span(0, 10, 2)], zones: ruleZones({ ...NONE, unhealthy: { operator: "GreaterThan", threshold: 90 } }, { lo: 0, hi: 100 }), expected: [{ x0: 0, x1: 10, state: 2, from: null, to: null }] },
  ])("washes $name", ({ spans, zones: given, expected }) => {
    expect(emphasisOf(spans, given)).toEqual(expected);
  });
});
