import { describe, expect, it } from "vitest";
import { applyTimelineDelta, stateCode } from "./timelineLive";
import { EMPTY_TIMELINE, mergeResponse, seriesKey, type EntityInfo, type TimelineData, type TimelineResponse } from "./timeline";

const ENTITY: EntityInfo = { name: "a", displayName: "A", parents: [], state: 1, signals: [{ name: "cpu", displayName: "CPU", kind: null, unit: null, refreshInterval: null, rules: { degraded: null, unhealthy: null, dynamic: false } }] };

function held(): TimelineData {
  const response: TimelineResponse = {
    model: "m",
    observedAt: "",
    range: { from: new Date(0).toISOString(), to: new Date(1000).toISOString() },
    retentionDays: 30,
    resolution: 0,
    partial: false,
    entities: [ENTITY],
    states: [{ entity: "a", transitions: [{ t: 100, from: 0, to: 1, reason: null }], complete: true, earliest: null }],
    series: [{ entity: "a", signal: "cpu", points: [[900, 1, 1]], complete: true, earliest: null }],
    annotations: [],
    reports: [],
    failures: [],
  };
  return mergeResponse(EMPTY_TIMELINE, response);
}

const NONE = new Map<string, 0 | 1 | 2 | 3 | 4>();

describe("applyTimelineDelta", () => {
  it("adds a transition once, in time order, and moves the current state of the entity", () => {
    const delta = { transitions: [{ entity: "a", t: 1500, from: 1 as const, to: 3 as const, reason: "SignalTransition" }] };

    const once = applyTimelineDelta(held(), delta, 2000, new Map([["a", 3 as const]]));
    const twice = applyTimelineDelta(once, delta, 2100, new Map([["a", 3 as const]]));

    expect(once.states.a?.transitions.map((row) => [row.t, row.to])).toEqual([[100, 1], [1500, 3]]);
    expect(twice.states.a?.transitions).toHaveLength(2);
    expect(once.entities[0]?.state).toBe(3);
    expect(once.now).toBe(2000);
  });

  it("carries every held history forward to now, because no transition means no change", () => {
    const next = applyTimelineDelta(held(), {}, 5000, NONE);

    expect(next.states.a?.covered).toEqual([{ from: 0, to: 5000 }]);
    expect(next.series[seriesKey("a", "cpu")]?.covered).toEqual([{ from: 0, to: 5000 }]);
  });

  it("appends a new point, revises one with the same time, and ignores a series that is not held", () => {
    const delta = {
      points: [
        { entity: "a", signal: "cpu", points: [[900, 7, 2], [1100, 3, 1]] as const },
        { entity: "a", signal: "mem", points: [[1100, 1, 1]] as const },
      ],
    };

    const next = applyTimelineDelta(held(), delta, 1200, NONE);

    expect(next.series[seriesKey("a", "cpu")]?.points).toEqual([[900, 7, 2], [1100, 3, 1]]);
    expect(next.series[seriesKey("a", "mem")]).toBeUndefined();
  });

  it("a transition of an entity whose history was never read is left for when it is", () => {
    const next = applyTimelineDelta(held(), { transitions: [{ entity: "z", t: 1500, from: 1, to: 2, reason: null }] }, 2000, NONE);

    expect(next.states.z).toBeUndefined();
  });

  it("adds annotations and reports once", () => {
    const delta = {
      annotations: [{ entity: "a", id: "n1", t: 1200, description: "Deploy", details: {} }],
      reports: [{ entity: "a", t: 1300, state: 2 as const, value: 0.5, reason: "x", reportId: "r1" }],
    };

    const twice = applyTimelineDelta(applyTimelineDelta(held(), delta, 2000, NONE), delta, 2100, NONE);

    expect(twice.annotations).toHaveLength(1);
    expect(twice.reports).toHaveLength(1);
  });

  it("does nothing before the overview has been read", () => {
    expect(applyTimelineDelta(EMPTY_TIMELINE, {}, 5000, NONE)).toBe(EMPTY_TIMELINE);
  });

  it("leaves an entity object alone when its state did not change", () => {
    const before = held();

    const next = applyTimelineDelta(before, {}, 2000, new Map([["a", 1 as const]]));

    expect(next.entities).toBe(before.entities);
  });

  it.each([
    ["Healthy", 1],
    ["Degraded", 2],
    ["Unhealthy", 3],
    ["Unknown", 0],
    ["Deleted", 4],
    ["Other", 0],
  ])("codes %s as %d", (state, code) => {
    expect(stateCode(state)).toBe(code);
  });
});
