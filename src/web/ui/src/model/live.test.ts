import { describe, expect, it } from "vitest";
import { announcement, applyDelta, mergeSnapshot, parseLiveFrame, stateChanges, type LiveDelta } from "./live";
import type { Entity, HealthModel } from "./types";

function entity(name: string, state: Entity["healthState"] = "Healthy", extra: Partial<Entity> = {}): Entity {
  return {
    name,
    displayName: name.toUpperCase(),
    healthState: state,
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
    ...extra,
  };
}

const MODEL: HealthModel = {
  model: { id: null, name: "hm", location: null, provisioningState: null, healthState: "Healthy" },
  observedAt: "t0",
  entities: [entity("a"), entity("b"), entity("c")],
  relationships: [{ name: "a-b", displayName: null, parentEntityName: "a", childEntityName: "b" }],
  reportOptions: { signalName: "s", healthStates: [], values: [], expiries: [], reasonPresets: [] },
};

describe("applyDelta", () => {
  it.each([
    { name: "a state change", delta: { entities: { upsert: [entity("b", "Degraded")] } } as LiveDelta, names: ["a", "b", "c"], states: ["Healthy", "Degraded", "Healthy"] },
    { name: "an entity added", delta: { entities: { upsert: [entity("d")] }, order: ["a", "b", "c", "d"] } as LiveDelta, names: ["a", "b", "c", "d"], states: ["Healthy", "Healthy", "Healthy", "Healthy"] },
    { name: "an entity removed", delta: { entities: { remove: ["b"] }, order: ["a", "c"] } as LiveDelta, names: ["a", "c"], states: ["Healthy", "Healthy"] },
    { name: "a new order", delta: { entities: { upsert: [entity("a", "Unhealthy")] }, order: ["c", "a", "b"] } as LiveDelta, names: ["c", "a", "b"], states: ["Healthy", "Unhealthy", "Healthy"] },
  ])("applies $name", ({ delta, names, states }) => {
    const next = applyDelta(MODEL, delta);

    expect(next.entities.map((item) => item.name)).toEqual(names);
    expect(next.entities.map((item) => item.healthState)).toEqual(states);
  });

  it("keeps the identity of everything the delta does not touch, and of the relationships when only entities changed", () => {
    const next = applyDelta(MODEL, { entities: { upsert: [entity("b", "Degraded")] }, observedAt: "t1" });

    expect(next.entities[0]).toBe(MODEL.entities[0]);
    expect(next.entities[2]).toBe(MODEL.entities[2]);
    expect(next.entities[1]).not.toBe(MODEL.entities[1]);
    expect(next.relationships).toBe(MODEL.relationships);
    expect(next.model).toBe(MODEL.model);
    expect(next.observedAt).toBe("t1");
  });

  it("returns the same model for a delta that changes nothing", () => {
    expect(applyDelta(MODEL, {})).toBe(MODEL);
    expect(applyDelta(MODEL, { observedAt: "t0" })).toBe(MODEL);
    expect(applyDelta(MODEL, { observedAt: "t9" })).toBe(MODEL);
    expect(applyDelta(MODEL, { entities: { upsert: [MODEL.entities[0] as Entity] } })).toBe(MODEL);
  });

  it("changes the relationships and the model summary", () => {
    const next = applyDelta(MODEL, {
      relationships: { upsert: [{ name: "b-c", displayName: null, parentEntityName: "b", childEntityName: "c" }], remove: ["a-b"] },
      model: { healthState: "Degraded" },
    });

    expect(next.relationships.map((link) => link.name)).toEqual(["b-c"]);
    expect(next.model.healthState).toBe("Degraded");
    expect(next.entities).toBe(MODEL.entities);
  });
});

describe("mergeSnapshot", () => {
  it("keeps old objects for equal entities and the old arrays when nothing differs", () => {
    const copy: HealthModel = JSON.parse(JSON.stringify(MODEL));

    const merged = mergeSnapshot(MODEL, copy);

    expect(merged.entities).toBe(MODEL.entities);
    expect(merged.relationships).toBe(MODEL.relationships);
    expect(merged.model).toBe(MODEL.model);
  });

  it("replaces only the entities that differ", () => {
    const next: HealthModel = { ...JSON.parse(JSON.stringify(MODEL)), entities: [entity("a"), entity("b", "Unhealthy"), entity("c")] };

    const merged = mergeSnapshot(MODEL, next);

    expect(merged.entities[0]).toBe(MODEL.entities[0]);
    expect(merged.entities[1]?.healthState).toBe("Unhealthy");
    expect(merged.entities[2]).toBe(MODEL.entities[2]);
  });

  it("takes the first snapshot as it is", () => {
    expect(mergeSnapshot(null, MODEL)).toBe(MODEL);
  });
});

describe("state changes", () => {
  it("lists the entities whose state is not what it was, and not the ones that are new", () => {
    const after = applyDelta(MODEL, { entities: { upsert: [entity("b", "Unhealthy"), entity("d", "Degraded")] } });

    expect(stateChanges(MODEL, after)).toEqual([{ name: "b", displayName: "B", from: "Healthy", to: "Unhealthy" }]);
    expect(stateChanges(MODEL, MODEL)).toEqual([]);
  });

  it.each([
    [[], ""],
    [[{ name: "s", displayName: "Session Storage", from: "Healthy", to: "Unhealthy" }], "Session Storage is now Unhealthy"],
    [
      [
        { name: "s", displayName: "Session Storage", from: "Healthy", to: "Unhealthy" },
        { name: "t", displayName: "Hosted agent", from: "Healthy", to: "Degraded" },
      ],
      "Session Storage is now Unhealthy, and 1 other entity changed",
    ],
    [
      [
        { name: "s", displayName: "A", from: "Healthy", to: "Degraded" },
        { name: "t", displayName: "B", from: "Healthy", to: "Degraded" },
        { name: "u", displayName: "C", from: "Healthy", to: "Degraded" },
      ],
      "A is now Degraded, and 2 other entities changed",
    ],
  ])("announces %j as %s", (changes, text) => {
    expect(announcement(changes)).toBe(text);
  });
});

describe("parseLiveFrame", () => {
  it.each([
    { name: "a snapshot", event: "snapshot", data: JSON.stringify(MODEL), id: "e-1", kind: "snapshot" },
    { name: "a delta", event: "delta", data: '{"entities":{"remove":["a"]}}', id: "e-2", kind: "delta" },
    { name: "a resync", event: "resync", data: '{"reason":"slow"}', id: null, kind: "resync" },
    { name: "a reconnect", event: "reconnect", data: '{"reason":"token_expired"}', id: null, kind: "reconnect" },
    { name: "an error", event: "error", data: '{"reason":"forbidden","error":{"code":"forbidden","message":"No."}}', id: null, kind: "error" },
    { name: "an event it does not know", event: "wat", data: "{}", id: null, kind: null },
    { name: "text that is not JSON", event: "delta", data: "{oops", id: null, kind: null },
    { name: "JSON that is not an object", event: "delta", data: "3", id: null, kind: null },
  ])("reads $name", ({ event, data, id, kind }) => {
    expect(parseLiveFrame(event, data, id)?.kind ?? null).toBe(kind);
  });

  it("an error frame carries its envelope when the server sent one", () => {
    expect(parseLiveFrame("error", '{"error":{"code":"forbidden","message":"No."}}', null)).toEqual({ kind: "error", code: "forbidden", message: "No." });
    expect(parseLiveFrame("error", '{"reason":"x"}', null)).toMatchObject({ kind: "error", code: "error" });
  });
});
