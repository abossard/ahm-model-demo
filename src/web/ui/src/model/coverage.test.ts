// @vitest-environment node
import { describe, expect, it } from "vitest";
import { coverage, neighbour, type Coverage, type Direction } from "./coverage";
import { calmModel, denseIncidentModel, incidentModel } from "../../tests/viewModels";
import type { Entity, Relationship } from "./types";

const live = incidentModel();

function entity(name: string, displayName = name): Entity {
  return { ...(live.entities[0] as Entity), name, displayName, parents: [], children: [], signals: [] };
}

function tiny(names: string, pairs: string): { entities: Entity[]; relationships: Relationship[] } {
  return {
    entities: names.split(" ").map((name) => entity(name)),
    relationships: pairs.split(" ").filter(Boolean).map((pair, index) => {
      const [parent, child] = pair.split(">") as [string, string];
      return { name: `r${index}`, displayName: null, parentEntityName: parent, childEntityName: child };
    }),
  };
}

function check(model: Coverage, total: number): void {
  expect(model.cells).toHaveLength(total);
  expect(new Set(model.cells.map((cell) => cell.name)).size).toBe(total);
  const byName = new Map(model.cells.map((cell) => [cell.name, cell] as const));
  for (const cell of model.cells) {
    const kids = model.cells.filter((item) => item.parent === cell.name);
    if (kids.length === 0) {
      expect(cell.span).toBe(1);
      expect(cell.leaf).toBe(true);
      continue;
    }
    // Children tile the parent's span without a gap, in order.
    let cursor = cell.start;
    for (const kid of kids) {
      expect(kid.start).toBe(cursor);
      expect(kid.depth).toBe(cell.depth + 1);
      cursor += kid.span;
    }
    expect(cursor).toBe(cell.start + cell.span);
    expect(byName.get(cell.name)?.leaf).toBe(false);
  }
}

describe("coverage of the live model", () => {
  const model = coverage(live.entities, live.relationships);

  it("places every entity once and tiles each part over what is below it", () => {
    check(model, 17);
  });

  it("puts the parts that are not connected to the root in a band of their own", () => {
    expect(model.bands.map((band) => band.band)).toEqual([0, 1]);
    const unconnected = model.cells.filter((cell) => cell.band === 1).map((cell) => cell.name);
    expect(unconnected).toEqual(["discover-app-insights", "81db2f7a-697d-c4ed-5d5f-251344a971fe", "2cfe8745-bb71-b592-3736-7d3343a007dc"]);
    expect(model.cells.find((cell) => cell.name === "hm-contosodemo")).toMatchObject({ band: 0, depth: 0, start: 0, parent: null });
  });

  it("seats an entity with several parents under the first by label and lists the others", () => {
    const hosting = model.cells.find((cell) => cell.name === "system-app-hosting")!;
    expect(hosting.parent).toBe("flow-run-agent-tasks");
    expect(hosting.otherParents).toEqual(["flow-send-health-reports", "flow-view-health-model"]);
  });

  it("orders siblings by label", () => {
    const flows = model.cells.filter((cell) => cell.parent === "hm-contosodemo").map((cell) => cell.name);
    expect(flows).toEqual(["discovered-app-topology", "platform-context", "flow-run-agent-tasks", "flow-send-health-reports", "flow-view-health-model"].sort((a, b) => {
      const label = (name: string): string => (live.entities.find((item) => item.name === name)!.displayName).toLowerCase();
      return label(a) < label(b) ? -1 : 1;
    }));
  });

  it("does not depend on the order of the input", () => {
    const shuffled = coverage([...live.entities].reverse(), [...live.relationships].reverse());
    expect(shuffled.cells.map((cell) => [cell.name, cell.parent, cell.start, cell.span])).toEqual(model.cells.map((cell) => [cell.name, cell.parent, cell.start, cell.span]));
  });
});

describe("coverage of other models", () => {
  it.each([
    ["the calm model", calmModel(), 17],
    ["the dense model", denseIncidentModel(), 81],
  ] as const)("%s: every entity once, tiles exact", (_name, model, total) => {
    check(coverage(model.entities, model.relationships), total);
  });

  it("gives the dense model one column per leaf, so 1360 px leave every leaf room for a state", () => {
    const model = denseIncidentModel();
    const result = coverage(model.entities, model.relationships);
    const main = result.bands.find((band) => band.band === 0)!;
    expect(main.leaves).toBeLessThan(60);
    expect(1360 / main.leaves).toBeGreaterThan(20);
  });

  it("copes with 300 entities in a tree", () => {
    const names = Array.from({ length: 300 }, (_, index) => `n${String(index).padStart(3, "0")}`);
    const pairs = names.slice(1).map((name, index) => `n${String(Math.floor(index / 4)).padStart(3, "0")}>${name}`).join(" ");
    const { entities, relationships } = tiny(names.join(" "), pairs);
    const result = coverage(entities, relationships);
    check(result, 300);
    expect(result.bands).toHaveLength(1);
  });
});

describe("coverage zoomed to an entity", () => {
  const model = coverage(live.entities, live.relationships, { focus: "system-app-hosting" });

  it("shows only that part, from depth 0, with the trail back to the root", () => {
    expect(model.cells.map((cell) => [cell.name, cell.depth])).toEqual([["system-app-hosting", 0], ["container-app", 1]]);
    expect(model.trail).toEqual(["hm-contosodemo", "flow-run-agent-tasks", "system-app-hosting"]);
    expect(model.focus).toBe("system-app-hosting");
    expect(model.bands).toEqual([{ band: 0, leaves: 1, rows: 2 }]);
  });

  it("ignores a focus that does not exist", () => {
    expect(coverage(live.entities, live.relationships, { focus: "nothing" }).focus).toBeNull();
  });
});

describe("coverage edge cases", () => {
  it("shows entities caught in a loop of parents in the second band instead of dropping them", () => {
    const { entities, relationships } = tiny("r a b", "r>a a>b b>a");
    const result = coverage(entities, relationships);
    expect(result.cells.map((cell) => cell.name).sort()).toEqual(["a", "b", "r"]);
  });

  it("draws an empty model as nothing", () => {
    expect(coverage([], [])).toEqual({ cells: [], bands: [], focus: null, trail: [] });
  });

  it("orders by display name, then by name", () => {
    const entities = [entity("x1", "Zebra"), entity("x2", "apple"), entity("root", "Root"), entity("x3", "apple")];
    const relationships = ["x1", "x2", "x3"].map((child, index) => ({ name: `r${index}`, displayName: null, parentEntityName: "root", childEntityName: child }));
    expect(coverage(entities, relationships).cells.map((cell) => cell.name)).toEqual(["root", "x2", "x3", "x1"]);
  });
});

describe("coverage in the order the viewer gave", () => {
  const model = tiny("r a b c a1 a2 x y z", "r>a r>b r>c a>a1 a>a2");
  const chain = (...chains: readonly (readonly [string, string])[]) => ({ chains: chains.map(([of, names]) => ({ of, names: names.split(" ") })), places: {} });
  const names = (found: Coverage): string[] => found.cells.map((cell) => cell.name);

  it.each([
    ["no order: by name", null, ["r", "a", "a1", "a2", "b", "c", "x", "y", "z"]],
    ["the children of a parent stand in its chain, with what is below them", chain(["r", "c a b"]), ["r", "c", "a", "a1", "a2", "b", "x", "y", "z"]],
    ["only the children the chain names trade places", chain(["r", "c a"]), ["r", "c", "b", "a", "a1", "a2", "x", "y", "z"]],
    ["a chain a level down", chain(["a", "a2 a1"]), ["r", "a", "a2", "a1", "b", "c", "x", "y", "z"]],
    ["the parts that are not connected stand in the chain of the top; the root stays first", chain(["", "z r y x"]), ["r", "a", "a1", "a2", "b", "c", "z", "y", "x"]],
  ] as const)("%s", (_name, order, expected) => {
    const found = coverage(model.entities, model.relationships, { order });

    expect(names(found)).toEqual(expected);
    check(found, 9);
  });

  it("puts a moved cell where its place in the row starts", () => {
    const found = coverage(model.entities, model.relationships, { order: chain(["r", "c a b"]) });

    expect(found.cells.filter((cell) => cell.parent === "r").map((cell) => [cell.name, cell.start, cell.span])).toEqual([["c", 0, 1], ["a", 1, 2], ["b", 3, 1]]);
  });

  it("keeps the order when zoomed to an entity", () => {
    expect(names(coverage(model.entities, model.relationships, { focus: "a", order: chain(["a", "a2 a1"]) }))).toEqual(["a", "a2", "a1"]);
  });
});

describe("neighbour", () => {
  const model = coverage(live.entities, live.relationships);
  it.each([
    ["system-agent-runtime", "right", "system-ai-inference"],
    ["system-agent-runtime", "left", null],
    ["system-ai-inference", "left", "system-agent-runtime"],
    ["flow-run-agent-tasks", "down", "system-agent-runtime"],
    ["system-app-hosting", "up", "flow-run-agent-tasks"],
    ["hm-contosodemo", "up", null],
    ["container-app", "down", null],
    ["system-ai-inference", "first", "system-agent-runtime"],
    ["system-agent-runtime", "last", "system-session-store"],
    ["hm-contosodemo", "right", "discover-app-insights"],
    ["discover-app-insights", "left", "hm-contosodemo"],
    ["nothing", "right", null],
  ] as readonly (readonly [string, Direction, string | null])[])("%s %s goes to %s", (name, direction, expected) => {
    expect(neighbour(model, name, direction)).toBe(expected);
  });
});
