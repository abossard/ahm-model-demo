import { describe, expect, it } from "vitest";
import type { Point, SeriesHistory, SignalInfo } from "./timeline";
import { ruleZones, signalFacts } from "./timelineTree";

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
  it.each([
    { name: "high is bad", rules: HIGH, domain: { lo: 0, hi: 100 }, expected: [{ from: 70, to: 90, state: 2 }, { from: 90, to: 100, state: 3 }] },
    { name: "low is bad", rules: LOW, domain: { lo: 90, hi: 101 }, expected: [{ from: 95, to: 99, state: 2 }, { from: 90, to: 95, state: 3 }] },
    { name: "clipped to the domain", rules: HIGH, domain: { lo: 0, hi: 80 }, expected: [{ from: 70, to: 80, state: 2 }] },
    { name: "thresholds off the chart", rules: HIGH, domain: { lo: 0, hi: 50 }, expected: [] },
    { name: "an unhealthy rule alone", rules: { ...NONE, unhealthy: { operator: "GreaterThan", threshold: 5 } }, domain: { lo: 0, hi: 10 }, expected: [{ from: 5, to: 10, state: 3 }] },
    { name: "no rules", rules: NONE, domain: { lo: 0, hi: 10 }, expected: [] },
  ])("shades $name", ({ rules, domain, expected }) => {
    expect(ruleZones(rules, domain)).toEqual(expected);
  });
});
