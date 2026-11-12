import { describe, expect, it } from "vitest";
import { applyLive, stateCode } from "./timelineLive";
import { EMPTY_TIMELINE, seriesKey, type EntityInfo, type Point, type TimelineResponse } from "./timeline";
import { EMPTY_STORE, mergeAnswer, toTimelineData, type TimeStore } from "./timeStore";

const ENTITY: EntityInfo = { name: "a", displayName: "A", parents: [], state: 1, signals: [{ name: "cpu", displayName: "CPU", kind: null, unit: null, refreshInterval: null, rules: { degraded: null, unhealthy: null, dynamic: false } }] };
const KEY = seriesKey("a", "cpu");
const ALL = { parts: ["structure", "states", "annotations", "reports", "signals"], entities: null, signals: null, level: 0 } as const;

function answer(parts: Partial<TimelineResponse> = {}, from = 0, to = 1000): TimelineResponse {
  return {
    model: "m",
    observedAt: "",
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    retentionDays: 30,
    resolution: 0,
    partial: false,
    entities: [ENTITY],
    states: [{ entity: "a", transitions: [{ t: 100, from: 0, to: 1, reason: null }], complete: true, earliest: null }],
    series: [{ entity: "a", signal: "cpu", points: [[900, 1, 1]], complete: true, earliest: null }],
    annotations: [],
    reports: [],
    failures: [],
    ...parts,
  };
}

const held = (): TimeStore => mergeAnswer(EMPTY_STORE, answer(), ALL);
const NONE = new Map<string, 0 | 1 | 2 | 3 | 4>();

describe("applyLive", () => {
  it("adds a transition once, in time order, and moves the current state of the entity", () => {
    const delta = { transitions: [{ entity: "a", t: 1500, from: 1 as const, to: 3 as const, reason: "SignalTransition" }] };

    const once = applyLive(held(), delta, 2000, new Map([["a", 3 as const]]));
    const twice = applyLive(once, delta, 2100, new Map([["a", 3 as const]]));

    expect(once.states.a?.rows.map((row) => [row.t, row.to])).toEqual([[100, 1], [1500, 3]]);
    expect(twice.states.a?.rows).toHaveLength(2);
    expect(once.entities[0]?.state).toBe(3);
    expect(once.now).toBe(2000);
  });

  it("carries every current history forward to now, because no transition means no change", () => {
    const next = applyLive(held(), {}, 5000, NONE);

    expect(next.states.a?.covered).toEqual([{ from: 0, to: 5000 }]);
    expect(next.annotations.a?.covered).toEqual([{ from: 0, to: 5000 }]);
    expect(next.series[KEY]?.[0]?.covered).toEqual([{ from: 0, to: 5000 }]);
  });

  it("a history that ended long before now keeps its gap: what happened in between was never read", () => {
    const hour = 3600_000;
    const old = mergeAnswer(mergeAnswer(EMPTY_STORE, answer({ series: [] }, 0, 10 * hour), ALL), answer({ entities: [], states: [], series: [{ entity: "a", signal: "cpu", points: [[900, 1, 1]], complete: true, earliest: null }] }, 0, hour), { ...ALL, parts: ["signals"] });

    const next = applyLive(old, { points: [{ entity: "a", signal: "cpu", points: [[10 * hour + 10, 5, 1]] }] }, 10 * hour + 30_000, NONE);

    expect(next.series[KEY]?.[0]).toBe(old.series[KEY]?.[0]);
    expect(next.states.a?.covered).toEqual([{ from: 0, to: 10 * hour + 30_000 }]);
  });

  it("appends a new point, revises one with the same time, and ignores a series that is not held", () => {
    const delta = {
      points: [
        { entity: "a", signal: "cpu", points: [[900, 7, 2], [1100, 3, 1]] as const },
        { entity: "a", signal: "mem", points: [[1100, 1, 1]] as const },
      ],
    };

    const next = applyLive(held(), delta, 1200, NONE);

    expect(next.series[KEY]?.[0]?.rows).toEqual([[900, 7, 2], [1100, 3, 1]]);
    expect(next.series[seriesKey("a", "mem")]).toBeUndefined();
  });

  it("a new point goes onto every level of the series that is held and current", () => {
    const coarse = mergeAnswer(held(), answer({ entities: [], states: [], resolution: 3600, series: [{ entity: "a", signal: "cpu", points: [[500, 2, 1]], complete: true, earliest: null }] }), { ...ALL, parts: ["signals"], level: 2 });

    const next = applyLive(coarse, { points: [{ entity: "a", signal: "cpu", points: [[1100, 3, 1]] }] }, 1200, NONE);

    expect(next.series[KEY]?.[0]?.rows.at(-1)).toEqual([1100, 3, 1]);
    expect(next.series[KEY]?.[2]?.rows).toEqual([[500, 2, 1], [1100, 3, 1]]);
  });

  it("a delta without a point for a series leaves its points the same array, also where two levels are drawn as one", () => {
    const dense: Point[] = Array.from({ length: 30 }, (_unused, index) => [index * 10, index, 1]);
    const both = mergeAnswer(
      mergeAnswer(EMPTY_STORE, answer({ series: [{ entity: "a", signal: "cpu", points: dense, complete: true, earliest: null }] }, 0, 400), ALL),
      answer({ entities: [], states: [], resolution: 3600, series: [{ entity: "a", signal: "cpu", points: [[450, 2, 1]], complete: true, earliest: null }] }, 400, 1000),
      { ...ALL, parts: ["signals"], level: 2 },
    );
    const shown = { level: 2, window: { from: 0, to: 1000 } };
    const before = toTimelineData(both, shown, EMPTY_TIMELINE);

    const after = toTimelineData(applyLive(both, {}, 1500, NONE), shown, before);

    expect(after).not.toBe(before);
    expect(after.series[KEY]?.points).toBe(before.series[KEY]?.points);
    expect(after.series[KEY]?.covered).toEqual([{ from: 0, to: 1500 }]);
    expect(after.states.a?.transitions).toBe(before.states.a?.transitions);
    expect(after.entities[0]?.signals[0]?.rules).toBe(before.entities[0]?.signals[0]?.rules);
  });

  it("a transition of an entity whose history was never read is left for when it is", () => {
    const next = applyLive(held(), { transitions: [{ entity: "z", t: 1500, from: 1, to: 2, reason: null }] }, 2000, NONE);

    expect(next.states.z).toBeUndefined();
  });

  it("adds annotations and reports once", () => {
    const delta = {
      annotations: [{ entity: "a", id: "n1", t: 1200, description: "Deploy", details: {} }],
      reports: [{ entity: "a", t: 1300, state: 2 as const, value: 0.5, reason: "x", reportId: "r1" }],
    };

    const twice = applyLive(applyLive(held(), delta, 2000, NONE), delta, 2100, NONE);

    expect(twice.annotations.a?.rows).toHaveLength(1);
    expect(twice.reports.a?.rows).toHaveLength(1);
  });

  it("does nothing before the structure has been read", () => {
    expect(applyLive(EMPTY_STORE, {}, 5000, NONE)).toBe(EMPTY_STORE);
  });

  it("leaves an entity object alone when its state did not change", () => {
    const before = held();

    const next = applyLive(before, {}, 2000, new Map([["a", 1 as const]]));

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
