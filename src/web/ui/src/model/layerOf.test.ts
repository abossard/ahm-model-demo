// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layerOf, type LaneKind } from "./layerOf";
import type { Entity, Relationship } from "./types";
import { healthModel, realShapeModel } from "../../tests/fixture";
import { calmModel, denseIncidentModel, diffViewModel, incidentModel } from "../../tests/viewModels";

function entity(name: string, patch: Partial<Entity> = {}): Entity {
  return {
    name,
    displayName: name,
    healthState: "Healthy",
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
    ...patch,
  };
}

const link = (parent: string, child: string): Relationship => ({ name: `${parent}>${child}`, displayName: null, parentEntityName: parent, childEntityName: child });
const graph = (names: readonly string[], pairs: readonly (readonly [string, string])[], patches: Readonly<Record<string, Partial<Entity>>> = {}): { entities: Entity[]; relationships: Relationship[] } => ({
  entities: names.map((name) => entity(name, patches[name])),
  relationships: pairs.map(([parent, child]) => link(parent, child)),
});

function lanesOf(entities: readonly Entity[], relationships: readonly Relationship[]): readonly (readonly [LaneKind, readonly string[]])[] {
  const { lanes } = layerOf(entities, relationships);
  return lanes.map((lane) => [lane.kind, lane.names] as const);
}

describe("layerOf, small graphs", () => {
  it.each([
    ["nothing", [], [], []],
    ["a root alone", ["r"], [], [["root", ["r"]]]],
    ["a root and a leaf", ["r", "a"], [["r", "a"]], [["root", ["r"]], ["resources", ["a"]]]],
    ["a chain: part, part, leaf", ["r", "a", "b", "c"], [["r", "a"], ["a", "b"], ["b", "c"]], [["root", ["r"]], ["flows", ["a"]], ["systems", ["b"]], ["resources", ["c"]]]],
    ["one inner layer named like systems", ["r", "system-a", "system-b", "x"], [["r", "system-a"], ["r", "system-b"], ["system-a", "x"], ["system-b", "x"]], [["root", ["r"]], ["systems", ["system-a", "system-b"]], ["resources", ["x"]]]],
    ["one inner layer of any other name", ["r", "a", "b", "x"], [["r", "a"], ["r", "b"], ["a", "x"], ["b", "x"]], [["root", ["r"]], ["flows", ["a", "b"]], ["resources", ["x"]]]],
    ["a leaf with parents in two lanes goes below both", ["r", "f", "s", "x"], [["r", "f"], ["f", "s"], ["s", "x"], ["f", "x"]], [["root", ["r"]], ["flows", ["f"]], ["systems", ["s"]], ["resources", ["x"]]]],
    ["a leaf directly under a flow skips the system lane", ["r", "f", "g", "s", "x", "y"], [["r", "f"], ["r", "g"], ["f", "s"], ["s", "x"], ["g", "y"]], [["root", ["r"]], ["flows", ["f", "g"]], ["systems", ["s"]], ["resources", ["x", "y"]]]],
    ["a fourth part layer repeats the system lane", ["r", "f", "s", "t", "x"], [["r", "f"], ["f", "s"], ["s", "t"], ["t", "x"]], [["root", ["r"]], ["flows", ["f"]], ["systems", ["s"]], ["systems", ["t"]], ["resources", ["x"]]]],
    ["the deepest parent decides for a part with two parents", ["r", "f", "s", "t", "x"], [["r", "f"], ["r", "t"], ["f", "s"], ["s", "t"], ["t", "x"]], [["root", ["r"]], ["flows", ["f"]], ["systems", ["s"]], ["systems", ["t"]], ["resources", ["x"]]]],
  ] as readonly (readonly [string, readonly string[], readonly (readonly [string, string])[], readonly (readonly [LaneKind, readonly string[]])[]])[])("%s", (_name, names, pairs, expected) => {
    const { entities, relationships } = graph(names, pairs);
    expect(lanesOf(entities, relationships)).toEqual(expected);
  });

  it.each([
    ["Suppressed impact", { impact: "Suppressed" }],
    ["a discovering entity", { discoveredBy: "discover-x" }],
    ["unlinked", { unlinked: true }],
  ] as const)("puts a part with %s in the context lane, and what only hangs below it", (_name, patch) => {
    const { entities, relationships } = graph(["r", "f", "x", "c", "d"], [["r", "f"], ["f", "x"], ["r", "c"], ["c", "d"]], { c: patch });
    expect(lanesOf(entities, relationships)).toEqual([["root", ["r"]], ["flows", ["f"]], ["resources", ["x"]], ["context", ["c", "d"]]]);
  });

  it("keeps a part below context in its lane when another parent that counts reaches it", () => {
    const { entities, relationships } = graph(["r", "f", "c", "x"], [["r", "f"], ["r", "c"], ["c", "x"], ["f", "x"]], { c: { impact: "Suppressed" } });
    expect(lanesOf(entities, relationships)).toEqual([["root", ["r"]], ["flows", ["f"]], ["resources", ["x"]], ["context", ["c"]]]);
  });

  it("puts what the root does not reach in the context lane, however many such parts there are", () => {
    const { entities, relationships } = graph(["r", "f", "x", "lone", "island", "leaf"], [["r", "f"], ["f", "x"], ["island", "leaf"]]);
    expect(lanesOf(entities, relationships)).toEqual([["root", ["r"]], ["flows", ["f"]], ["resources", ["x"]], ["context", ["island", "leaf", "lone"]]]);
  });

  it("puts a leaf straight under a root that has structure in the context lane, but not under one that has none", () => {
    const structured = graph(["r", "f", "x", "ctx"], [["r", "f"], ["f", "x"], ["r", "ctx"]]);
    expect(lanesOf(structured.entities, structured.relationships)).toEqual([["root", ["r"]], ["flows", ["f"]], ["resources", ["x"]], ["context", ["ctx"]]]);
    const flat = graph(["r", "a", "b"], [["r", "a"], ["r", "b"]]);
    expect(lanesOf(flat.entities, flat.relationships)).toEqual([["root", ["r"]], ["resources", ["a", "b"]]]);
  });

  it("chooses the root with the most descendants over a discovered one with more", () => {
    const { entities, relationships } = graph(["d", "d1", "d2", "d3", "r", "a"], [["d", "d1"], ["d1", "d2"], ["d2", "d3"], ["r", "a"]], { d: { impact: "Suppressed" } });
    expect(lanesOf(entities, relationships)[0]).toEqual(["root", ["r"]]);
  });

  it("survives a cycle and a relationship to an entity that is not there", () => {
    const { entities, relationships } = graph(["r", "a", "b"], [["r", "a"], ["a", "b"], ["b", "a"], ["a", "missing"], ["a", "a"]]);
    const { laneOf } = layerOf(entities, relationships);
    expect([...laneOf.keys()].sort()).toEqual(["a", "b", "r"]);
    expect(laneOf.get("r")).toBe(0);
  });
});

const FIXTURES = [
  ["the classic model", healthModel],
  ["the real-shape model with GUID names", realShapeModel],
  ["the incident model", incidentModel()],
  ["the calm model", calmModel()],
  ["the dense model", denseIncidentModel()],
  ["the diff's proposed model", { entities: diffViewModel().proposed.entities, relationships: diffViewModel().proposed.relationships }],
] as const;

describe("layerOf, the fixtures", () => {
  it.each(FIXTURES)("%s: every entity is in exactly one lane, and the lanes list what they hold", (_name, model) => {
    const { lanes, laneOf } = layerOf(model.entities, model.relationships);
    expect([...laneOf.keys()].sort()).toEqual(model.entities.map((item) => item.name).sort());
    const listed = lanes.flatMap((lane) => lane.names);
    expect(listed.sort()).toEqual(model.entities.map((item) => item.name).sort());
    lanes.forEach((lane, index) => {
      expect(lane.names.length).toBeGreaterThan(0);
      for (const name of lane.names) expect(laneOf.get(name)).toBe(index);
    });
  });

  it.each(FIXTURES)("%s: a parent that counts always sits above its child", (_name, model) => {
    const { lanes, laneOf } = layerOf(model.entities, model.relationships);
    const context = lanes.findIndex((lane) => lane.kind === "context");
    for (const item of model.relationships) {
      const parent = laneOf.get(item.parentEntityName) as number;
      const child = laneOf.get(item.childEntityName) as number;
      if (parent === context) continue;
      expect(parent, `${item.parentEntityName} above ${item.childEntityName}`).toBeLessThan(child);
    }
  });

  it.each(FIXTURES)("%s: the same lanes whatever order the entities and relationships come in", (_name, model) => {
    const expected = layerOf(model.entities, model.relationships);
    const shuffled = layerOf([...model.entities].reverse(), [...model.relationships].reverse());
    expect(shuffled.lanes).toEqual(expected.lanes);
  });

  it.each([
    ["the classic model", healthModel, [["root", ["svc-a"]], ["flows", ["svc-b", "svc-d"]], ["resources", ["svc-c"]], ["context", ["svc-e", "svc-f"]]]],
    ["the real-shape model", realShapeModel, [["root", ["hm-real"]], ["resources", ["container-app"]], ["context", ["2cfe8745-bb71-b592-3736-7d3343a007dc", "81db2f7a-697d-c4ed-5d5f-251344a971fe", "discover-app-insights"]]]],
    [
      "the incident model",
      incidentModel(),
      [
        ["root", ["hm-contosodemo"]],
        ["flows", ["flow-run-agent-tasks", "flow-send-health-reports", "flow-view-health-model"]],
        ["systems", ["system-agent-runtime", "system-ai-inference", "system-app-hosting", "system-session-store"]],
        ["resources", ["container-app", "foundry-account", "hosted-agent", "session-storage"]],
        ["context", ["2cfe8745-bb71-b592-3736-7d3343a007dc", "81db2f7a-697d-c4ed-5d5f-251344a971fe", "discover-app-insights", "discovered-app-topology", "platform-context"]],
      ],
    ],
  ] as readonly (readonly [string, { entities: readonly Entity[]; relationships: readonly Relationship[] }, readonly (readonly [LaneKind, readonly string[]])[]])[])("%s: lanes as the design draws them", (_name, model, expected) => {
    expect(lanesOf(model.entities, model.relationships)).toEqual(expected);
  });

  it("puts the dense model's flows, systems, resources and context where their names say, though only the structure decided", () => {
    const { lanes, laneOf } = layerOf(denseIncidentModel().entities, denseIncidentModel().relationships);
    expect(lanes.map((lane) => lane.kind)).toEqual(["root", "flows", "systems", "resources", "context"]);
    for (const [prefix, kind] of [["flow-", "flows"], ["sys-", "systems"], ["res-", "resources"]] as const) {
      for (const item of denseIncidentModel().entities.filter((candidate) => candidate.name.startsWith(prefix) && candidate.name !== "res-grafana-ws")) {
        expect(lanes[laneOf.get(item.name) as number]?.kind, item.name).toBe(kind);
      }
    }
    expect(lanes[laneOf.get("res-grafana-ws") as number]?.kind).toBe("context");
    expect(lanes[laneOf.get("platform-context") as number]?.kind).toBe("context");
    expect(lanes[laneOf.get("pe-sql") as number]?.kind).toBe("context");
  });

  it("puts the diff's added entities where they belong: the queue under App Hosting is a resource, the webhook with no parent is context", () => {
    const { lanes, laneOf } = layerOf(diffViewModel().proposed.entities, diffViewModel().proposed.relationships);
    expect(lanes[laneOf.get("report-queue") as number]?.kind).toBe("resources");
    expect(lanes[laneOf.get("pager-webhook") as number]?.kind).toBe("context");
  });
});
