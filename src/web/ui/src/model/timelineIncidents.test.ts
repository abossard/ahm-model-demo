import { describe, expect, it } from "vitest";
import { EMPTY_TIMELINE, mergeResponse, type EntityInfo, type TimelineResponse } from "./timeline";
import type { Band } from "./timelineBands";
import { coveredSpan, detectIncidents, entityBands, incidentText, modelAt, planSignals } from "./timelineIncidents";

const band = (a: number, b: number, state: 0 | 1 | 2 | 3): Band => ({ a, b, state });

describe("detectIncidents", () => {
  it.each([
    { name: "none when healthy", bands: [band(0, 100, 1)], expected: [] },
    { name: "a degraded span", bands: [band(0, 10, 1), band(10, 20, 2), band(20, 100, 1)], expected: [{ from: 10, to: 20, peak: 2 }] },
    { name: "degraded then unhealthy is one incident with the worse peak", bands: [band(10, 20, 2), band(20, 30, 3), band(30, 40, 1)], expected: [{ from: 10, to: 30, peak: 3 }] },
    { name: "two spans apart", bands: [band(0, 10, 2), band(10, 50, 1), band(50, 60, 3)], expected: [{ from: 0, to: 10, peak: 2 }, { from: 50, to: 60, peak: 3 }] },
    { name: "an unknown stretch is not an incident and breaks one", bands: [band(0, 10, 2), band(10, 20, 0), band(20, 30, 2)], expected: [{ from: 0, to: 10, peak: 2 }, { from: 20, to: 30, peak: 2 }] },
    { name: "one still going has no end", bands: [band(0, 10, 1), band(10, 100, 3)], now: 100, expected: [{ from: 10, to: null, peak: 3 }] },
  ])("finds $name", ({ bands, expected, ...rest }) => {
    const found = detectIncidents(bands, "now" in rest ? rest.now : 1000);

    expect(found.map(({ from, to, peak }) => ({ from, to, peak }))).toEqual(expected);
  });

  it("joins incidents a short healthy gap apart", () => {
    const bands = [band(0, 10, 2), band(10, 13, 1), band(13, 30, 2)];

    expect(detectIncidents(bands, 1000, 0)).toHaveLength(2);
    expect(detectIncidents(bands, 1000, 5)).toHaveLength(1);
  });

  it("gives every incident a stable id from its start", () => {
    expect(detectIncidents([band(10, 20, 2)], 1000)[0]?.id).toBe("i:10");
  });
});

const entity = (name: string, state: 0 | 1 | 2 | 3 = 1): EntityInfo => ({
  name,
  displayName: name,
  parents: [],
  state,
  signals: [{ name: "cpu", displayName: "CPU", kind: null, unit: null, refreshInterval: null, rules: { degraded: null, unhealthy: null, dynamic: false } }],
});

function overview(parts: Partial<TimelineResponse>): TimelineResponse {
  return {
    model: "m",
    observedAt: "",
    range: { from: new Date(0).toISOString(), to: new Date(1000).toISOString() },
    retentionDays: 30,
    resolution: 0,
    partial: false,
    entities: [entity("a", 3), entity("b")],
    states: [
      { entity: "a", transitions: [{ t: 400, from: 1, to: 3, reason: null }], complete: true, earliest: null },
      { entity: "b", transitions: [], complete: true, earliest: null },
    ],
    series: [],
    annotations: [],
    reports: [],
    failures: [],
    ...parts,
  };
}

describe("incidentText", () => {
  it.each([
    { name: "one that is over", incident: { id: "i", from: 0, to: 5_400_000, peak: 3 as const }, expected: "1 h 30 min, peak Unhealthy" },
    { name: "one that is still going", incident: { id: "i", from: 0, to: null, peak: 2 as const }, expected: "Ongoing, 2 h 00 min, peak Degraded" },
  ])("words $name", ({ incident, expected }) => {
    expect(incidentText(incident, 7_200_000)).toBe(expected);
  });
});

describe("the model at an instant", () => {
  const data = mergeResponse(EMPTY_TIMELINE, overview({}));
  const bandsOf = (info: EntityInfo) => entityBands(data, info);

  it.each([
    { t: 100, a: "Healthy", b: "Healthy" },
    { t: 399, a: "Healthy", b: "Healthy" },
    { t: 400, a: "Unhealthy", b: "Healthy" },
    { t: 900, a: "Unhealthy", b: "Healthy" },
    { t: -5, a: "Unknown", b: "Unknown" },
  ])("at $t a is $a and b is $b", ({ t, a, b }) => {
    const rows = modelAt(data, t, bandsOf);

    expect(rows.map((row) => row.state)).toEqual([a, b]);
    expect(rows.map((row) => row.entity)).toEqual(["a", "b"]);
  });

  it("an entity with no held history is unknown", () => {
    expect(modelAt({ ...data, entities: [entity("c")] }, 100, bandsOf)[0]?.state).toBe("Unknown");
  });

  it("covers the whole held range", () => {
    expect(coveredSpan(data.states.a?.covered ?? [], { from: 5, to: 6 })).toEqual({ from: 0, to: 1000 });
    expect(coveredSpan([], { from: 5, to: 6 })).toEqual({ from: 5, to: 6 });
  });
});

describe("planSignals", () => {
  const data = mergeResponse(EMPTY_TIMELINE, overview({}));
  const held = mergeResponse(data, overview({
    entities: [],
    states: [],
    series: [{ entity: "a", signal: "cpu", points: [[500, 1, 1]], complete: true, earliest: null }],
    range: { from: new Date(0).toISOString(), to: new Date(1_000_000).toISOString() },
  }));

  it.each([
    { name: "nothing is held", data, names: ["a", "b"], want: { from: 0, to: 1_000_000 }, expected: { entities: ["a", "b"], span: { from: 0, to: 1_000_000 } } },
    { name: "one entity is held", data: held, names: ["a", "b"], want: { from: 0, to: 1_000_000 }, expected: { entities: ["b"], span: { from: 0, to: 1_000_000 } } },
    { name: "everything asked is held", data: held, names: ["a"], want: { from: 0, to: 900_000 }, expected: null },
    { name: "an unknown entity is ignored", data: held, names: ["ghost"], want: { from: 0, to: 10 }, expected: null },
    { name: "only the new edge is missing and it is too small to matter", data: held, names: ["a"], want: { from: 0, to: 1_000_500 }, expected: null },
    { name: "the old part is missing", data: held, names: ["a"], want: { from: -2_000_000, to: 1_000_000 }, expected: { entities: ["a"], span: { from: -2_000_000, to: 0 } } },
  ])("plans $name", ({ data: subject, names, want, expected }) => {
    expect(planSignals(subject, names, want)).toEqual(expected);
  });
});
