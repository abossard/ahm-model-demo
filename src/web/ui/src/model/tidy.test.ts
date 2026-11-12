// @vitest-environment node
import { describe, expect, it } from "vitest";
import { visibleGraph } from "./collapse";
import type { ModelOrder } from "./customOrder";
import { basisFor, linkKey } from "./compare";
import { throughCards, collinearOverlaps, type Rect, type Routing } from "./stepRouter";
import { CHIP, FOLD_ABOVE, TILE, firstProblem, planFolds, tidyLayout, tileSignals, type Fold, type TidyLayout } from "./tidy";
import type { Entity, EntitySignal, HealthModel, HealthState, Relationship } from "./types";
import { calmModel, denseIncidentModel, diffViewModel, incidentModel } from "../../tests/viewModels";

function signal(state: HealthState): EntitySignal {
  return { name: `s-${state}`, displayName: null, kind: null, healthState: state, value: 1, reportedAt: null, writable: false };
}

function entity(name: string, healthState: HealthState = "Healthy", signals: readonly EntitySignal[] = []): Entity {
  return {
    name,
    displayName: name,
    healthState,
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals,
    report: { eligible: true, signalName: null },
  };
}

function link(parent: string, child: string, displayName: string | null = null): Relationship {
  return { name: `${parent}>${child}`, displayName, parentEntityName: parent, childEntityName: child };
}

/** A root over `count` healthy leaves, each with one parent. */
function fan(count: number, extra: readonly Entity[] = []): { entities: Entity[]; relationships: Relationship[] } {
  const leaves = Array.from({ length: count }, (_unused, index) => entity(`leaf-${String(index).padStart(2, "0")}`));
  return {
    entities: [entity("root", "Healthy"), ...leaves, ...extra],
    relationships: [...leaves.map((leaf) => link("root", leaf.name)), ...extra.map((item) => link("root", item.name))],
  };
}

function layoutOf(model: Pick<HealthModel, "entities" | "relationships">, folds: readonly Fold[] = []): TidyLayout {
  return tidyLayout({ entities: model.entities, relationships: model.relationships, folds, whole: model });
}

/** The layout as the router's own checks read it. */
function asRouting(layout: TidyLayout): Routing {
  return { nodes: new Map(layout.nodes.map((node) => [node.id, node.rect])), edges: layout.edges, bounds: layout.bounds };
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Everything joined to `root` by relationships, in either direction. */
function reachableFrom(root: string, relationships: readonly Relationship[]): ReadonlySet<string> {
  const seen = new Set<string>([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { parentEntityName: parent, childEntityName: child } of relationships) {
      if (seen.has(parent) !== seen.has(child)) {
        seen.add(parent).add(child);
        grew = true;
      }
    }
  }
  return seen;
}

/** The tiles that lie inside a frame. */
function framedBy(layout: TidyLayout): string[] {
  return layout.nodes
    .filter((node) => layout.shelves.some((shelf) => node.rect.x >= shelf.x && node.rect.y >= shelf.y && node.rect.x + node.rect.width <= shelf.x + shelf.width && node.rect.y + node.rect.height <= shelf.y + shelf.height))
    .map((node) => node.id);
}

const MODELS: readonly (readonly [string, Pick<HealthModel, "entities" | "relationships">])[] = [
  ["incident", incidentModel()],
  ["calm", calmModel()],
  ["dense", denseIncidentModel()],
  ["diff, both sides drawn", { entities: diffViewModel().proposed.entities, relationships: diffViewModel().proposed.relationships }],
];

describe("tileSignals", () => {
  it.each([
    ["no signals", [], { glyphs: [], more: 0, total: 0 }],
    ["worst first", ["Healthy", "Degraded", "Unhealthy", "Healthy", "Unknown"], { glyphs: ["Unhealthy", "Degraded", "Unknown", "Healthy", "Healthy"], more: 0, total: 5 }],
    ["more than fit", Array.from({ length: 9 }, () => "Healthy"), { glyphs: Array.from({ length: 6 }, () => "Healthy"), more: 3, total: 9 }],
    ["the worst survive when some do not fit", [...Array.from({ length: 8 }, () => "Healthy"), "Unhealthy"], { glyphs: ["Unhealthy", ...Array.from({ length: 5 }, () => "Healthy")], more: 3, total: 9 }],
  ] as readonly (readonly [string, readonly HealthState[], ReturnType<typeof tileSignals>])[])("%s", (_name, states, expected) => {
    expect(tileSignals(entity("a", "Degraded", states.map(signal)))).toEqual(expected);
  });
});

describe("planFolds", () => {
  it("folds nothing while the model is small enough to show every name", () => {
    const { entities, relationships } = fan(FOLD_ABOVE - 1);
    expect(planFolds(entities, relationships, new Set(), new Set())).toEqual([]);
  });

  it("folds the healthy leaves under one parent into one fold", () => {
    const { entities, relationships } = fan(FOLD_ABOVE + 5);
    const folds = planFolds(entities, relationships, new Set(), new Set());
    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({ id: "fold:root", parent: "root", open: false });
    expect(folds[0]?.members).toHaveLength(FOLD_ABOVE + 5);
  });

  it.each([
    ["a leaf that needs attention", entity("bad", "Degraded")],
    ["an Unknown leaf", entity("maybe", "Unknown")],
  ])("keeps %s as a tile", (_name, extra) => {
    const { entities, relationships } = fan(FOLD_ABOVE + 2, [extra]);
    const folds = planFolds(entities, relationships, new Set(), new Set());
    expect(folds[0]?.members).not.toContain(extra.name);
  });

  it("keeps the entities it was told to keep, and a leaf that has two parents", () => {
    const { entities, relationships } = fan(FOLD_ABOVE + 2);
    const second = entity("second");
    const shared = [...entities, second];
    const rels = [...relationships, link("root", "second"), link("second", "leaf-00")];
    const folds = planFolds(shared, rels, new Set(["leaf-01"]), new Set());
    expect(folds[0]?.members).not.toContain("leaf-00");
    expect(folds[0]?.members).not.toContain("leaf-01");
  });

  it("does not fold a lone leaf under a parent", () => {
    const { entities, relationships } = fan(FOLD_ABOVE + 1);
    const only = [...entities, entity("branch"), entity("twig")];
    const rels = [...relationships, link("root", "branch"), link("branch", "twig")];
    expect(planFolds(only, rels, new Set(), new Set()).map((fold) => fold.parent)).toEqual(["root"]);
  });

  it("marks the folds the viewer opened", () => {
    const { entities, relationships } = fan(FOLD_ABOVE + 2);
    expect(planFolds(entities, relationships, new Set(), new Set(["root"]))[0]?.open).toBe(true);
  });

  it("folds the dense model's quiet leaves and none of its failing ones", () => {
    const model = denseIncidentModel();
    const folds = planFolds(model.entities, model.relationships, new Set(), new Set());
    const folded = new Set(folds.flatMap((fold) => fold.members));
    expect(folds.length).toBeGreaterThan(5);
    expect(folded.size).toBeGreaterThan(15);
    for (const item of model.entities.filter((candidate) => candidate.healthState !== "Healthy")) expect(folded.has(item.name)).toBe(false);
  });
});

describe("tidyLayout", () => {
  it.each(MODELS)("draws every entity of the %s model as one tile of one size, none on another", (_name, model) => {
    const layout = layoutOf(model);
    expect(layout.nodes).toHaveLength(model.entities.length);
    for (const node of layout.nodes) expect([node.rect.width, node.rect.height]).toEqual([TILE.width, TILE.height]);
    layout.nodes.forEach((node, index) => {
      for (const other of layout.nodes.slice(index + 1)) expect(overlap(node.rect, other.rect), `${node.id} and ${other.id}`).toBe(false);
    });
  });

  it.each(MODELS)("routes no line through a tile in the %s model, and none along another's bus", (_name, model) => {
    const layout = layoutOf(model);
    expect(layout.edges).toHaveLength(model.relationships.length);
    expect(throughCards(asRouting(layout))).toEqual([]);
    expect(collinearOverlaps(asRouting(layout))).toBe(0);
  });

  it.each(MODELS)("keeps the %s model's frames off every tile they do not hold, and off each other", (_name, model) => {
    const layout = layoutOf(model);
    layout.shelves.forEach((shelf, index) => {
      for (const other of layout.shelves.slice(index + 1)) expect(overlap(shelf, other)).toBe(false);
    });
    for (const node of layout.nodes) {
      const holding = layout.shelves.filter((shelf) => overlap(shelf, node.rect));
      for (const shelf of holding) expect(node.rect.x >= shelf.x && node.rect.y >= shelf.y && node.rect.x + node.rect.width <= shelf.x + shelf.width && node.rect.y + node.rect.height <= shelf.y + shelf.height, node.id).toBe(true);
    }
    expect(layout.bounds.width).toBeGreaterThan(0);
  });

  it("frames the parts that are not connected to the root, and only those", () => {
    const model = incidentModel();
    const root = model.entities[0]?.name as string;
    const connected = reachableFrom(root, model.relationships);
    const framed = framedBy(layoutOf(model));
    expect(framed.length).toBeGreaterThan(0);
    expect(new Set(framed)).toEqual(new Set(model.entities.map((item) => item.name).filter((name) => !connected.has(name))));
  });

  it("frames nothing when everything is connected, or when no entity is connected to another", () => {
    expect(layoutOf(fan(5)).shelves).toEqual([]);
    expect(layoutOf({ entities: [entity("a"), entity("b"), entity("c")], relationships: [] }).shelves).toEqual([]);
  });

  it("frames the same unconnected part when the Health filter splits the connected one into pieces, and does not frame the pieces", () => {
    const model = incidentModel();
    const connected = reachableFrom(model.entities[0]?.name as string, model.relationships);
    const filtered = visibleGraph(model.entities, model.relationships, new Set(), { selectedHealth: new Set(["Unhealthy", "Degraded", "Unknown"]), excludedEntityMode: "hide" });
    const layout = tidyLayout({ entities: filtered.entities, relationships: filtered.relationships, folds: [], whole: model });
    const framed = framedBy(layout);
    expect(framed.length).toBeGreaterThan(0);
    for (const name of framed) expect(connected.has(name), name).toBe(false);
  });

  it("lists the tiles in reading order: row by row, so the focus order follows the ranks", () => {
    const layout = layoutOf(incidentModel());
    const rows = new Map<number, number[]>();
    layout.nodes.forEach((node, index) => rows.set(node.rect.y, [...(rows.get(node.rect.y) ?? []), index]));
    const firstOfRow = [...rows.entries()].sort(([a], [b]) => a - b).map(([, indices]) => Math.min(...indices));
    expect(firstOfRow).toEqual([...firstOfRow].sort((a, b) => a - b));
  });

  it("is the same for the same model, whatever order the entities come in", () => {
    const model = incidentModel();
    const reversed = { entities: [...model.entities].reverse(), relationships: [...model.relationships].reverse() };
    const key = (layout: TidyLayout): string[] => layout.nodes.map((node) => `${node.id}@${node.rect.x},${node.rect.y}`).sort();
    expect(key(layoutOf(reversed))).toEqual(key(layoutOf(model)));
  });

  it("puts a label pill on each labelled relationship's line, clear of the tiles", () => {
    const model = incidentModel();
    const layout = layoutOf(model);
    const labelled = layout.edges.filter((edge) => edge.text !== "");
    expect(labelled.length).toBeGreaterThan(5);
    for (const edge of labelled) expect(edge.label, edge.id).not.toBeNull();
    for (const edge of labelled) {
      const pill = { x: (edge.label?.x ?? 0) - 20, y: (edge.label?.y ?? 0) - 9, width: 40, height: 18 };
      for (const node of layout.nodes) expect(overlap(pill, node.rect), `${edge.id} over ${node.id}`).toBe(false);
    }
  });

  it("is empty for an empty model", () => {
    expect(layoutOf({ entities: [], relationships: [] }).nodes).toEqual([]);
  });
});

describe("tidyLayout with folds", () => {
  const model = denseIncidentModel();
  const folds = planFolds(model.entities, model.relationships, new Set(), new Set());

  it("replaces the folded leaves with one tile each, so the dense model is far narrower", () => {
    const plain = layoutOf(model);
    const folded = layoutOf(model, folds);
    const hiddenCount = folds.reduce((sum, fold) => sum + fold.members.length, 0);
    expect(folded.nodes).toHaveLength(model.entities.length - hiddenCount + folds.length);
    expect(folded.nodes.filter((node) => node.kind === "fold")).toHaveLength(folds.length);
    expect(folded.bounds.width).toBeLessThan(plain.bounds.width * 0.6);
    expect(throughCards(asRouting(folded))).toEqual([]);
  });

  it("keeps the members and a small chip for an opened fold", () => {
    const opened = folds.map((fold, index) => (index === 0 ? { ...fold, open: true } : fold));
    const layout = layoutOf(model, opened);
    const first = opened[0] as Fold;
    const ids = new Set(layout.nodes.map((node) => node.id));
    for (const member of first.members) expect(ids.has(member)).toBe(true);
    const chip = layout.nodes.find((node) => node.id === first.id);
    expect([chip?.rect.width, chip?.rect.height]).toEqual([CHIP.width, CHIP.height]);
    expect(layout.edges.some((edge) => edge.to === first.id && edge.from === first.parent)).toBe(true);
    expect(throughCards(asRouting(layout))).toEqual([]);
  });
});

describe("firstProblem", () => {
  const order = ["root", "a", "b", "c", "d"];
  const relationships = [link("root", "a"), link("root", "b"), link("a", "c"), link("b", "d")];

  it.each([
    ["the worst state among the sources of trouble", [["a", "Degraded"], ["c", "Degraded"], ["b", "Unhealthy"], ["d", "Unhealthy"], ["root", "Unhealthy"]], ["d", "b"]],
    ["the earlier in reading order when the states tie", [["a", "Degraded"], ["c", "Degraded"], ["b", "Degraded"], ["d", "Degraded"], ["root", "Degraded"]], ["c", "a"]],
    ["an entity with nothing worse below it, not the root it makes Unhealthy", [["root", "Unhealthy"], ["a", "Unhealthy"], ["c", "Unhealthy"]], ["c", "a"]],
    ["the first Unknown when nothing is Degraded or Unhealthy", [["d", "Unknown"], ["b", "Unknown"]], ["b", "root"]],
    ["nothing on a calm model", [], []],
  ] as readonly (readonly [string, readonly (readonly [string, HealthState])[], readonly string[]])[])("picks %s", (_name, states, expected) => {
    const entities = order.map((name) => entity(name, (states.find(([key]) => key === name)?.[1] ?? "Healthy") as HealthState));
    expect(firstProblem(entities, relationships, order)).toEqual(expected);
  });

  it("finds the failing leaf of the incident and of the dense model", () => {
    const incident = incidentModel();
    const dense = denseIncidentModel();
    const names = (model: HealthModel): string[] => layoutOf(model).nodes.map((node) => node.id);
    expect(firstProblem(incident.entities, incident.relationships, names(incident))[0]).toBe("session-storage");
    expect(["res-sql-orders", "res-func-nightly"]).toContain(firstProblem(dense.entities, dense.relationships, names(dense))[0]);
    // With nothing Degraded or Unhealthy, the first Unknown entity is the one to look at.
    const calm = calmModel();
    expect(calm.entities.find((item) => item.name === firstProblem(calm.entities, calm.relationships, [])[0])?.healthState).toBe("Unknown");
  });
});

describe("tidyLayout in Compare, one side of an arrangement made for both", () => {
  const view = diffViewModel();
  const sides = [
    { side: "base" as const, snapshot: view.base, shelves: 1 },
    { side: "proposed" as const, snapshot: view.proposed, shelves: 2 },
  ];
  const only = (snapshot: { readonly entities: readonly Entity[]; readonly relationships: readonly Relationship[] }): { entities: Set<string>; links: Set<string> } => ({
    entities: new Set(snapshot.entities.map((item) => item.name)),
    links: new Set(snapshot.relationships.map((item) => linkKey(item.parentEntityName, item.childEntityName))),
  });

  describe.each(sides)("the $side side", ({ side, snapshot, shelves }) => {
    const basis = basisFor(view, side);
    const whole = tidyLayout({ entities: basis.entities, relationships: basis.relationships, folds: [], whole: basis });
    const mine = tidyLayout({ entities: basis.entities, relationships: basis.relationships, folds: [], whole: basis, only: only(snapshot) });

    it("draws exactly the entities it has", () => {
      expect(mine.nodes.map((node) => node.id).sort()).toEqual(snapshot.entities.map((item) => item.name).sort());
    });

    it("puts each where the layout of both sides puts it", () => {
      const places = new Map(whole.nodes.map((node) => [node.id, node.rect] as const));
      for (const node of mine.nodes) expect(node.rect, node.id).toEqual(places.get(node.id));
      expect(mine.bounds.width).toBeGreaterThanOrEqual(whole.bounds.width);
    });

    it("draws exactly the lines it has, on the routes of both sides", () => {
      const links = only(snapshot).links;
      const wanted = whole.edges.filter((edge) => links.has(linkKey(edge.from, edge.to)));
      expect(mine.edges.map((edge) => edge.id).sort()).toEqual(wanted.map((edge) => edge.id).sort());
      for (const edge of mine.edges) expect(edge.points).toEqual(whole.edges.find((item) => item.id === edge.id)?.points);
    });

    it(`frames ${shelves} unconnected part${shelves === 1 ? "" : "s"}: the Pager Webhook only where it is`, () => {
      expect(mine.shelves).toHaveLength(shelves);
    });

    it("keeps clear of cards, as the layout of both sides does", () => {
      expect(throughCards(asRouting(mine))).toEqual([]);
    });
  });

  describe("a fold", () => {
    const { entities, relationships } = fan(50);
    const folds = planFolds(entities, relationships, new Set(), new Set());
    const run = (names: readonly string[]): TidyLayout =>
      tidyLayout({ entities, relationships, folds, whole: { entities, relationships }, only: { entities: new Set(names), links: new Set(names.filter((name) => name !== "root").map((name) => linkKey("root", name))) } });

    it.each([
      { name: "keeps the members this side has", names: ["root", ...entities.slice(1, 21).map((item) => item.name)], members: 20 },
      { name: "is gone when the side has none of its members", names: ["root"], members: 0 },
    ])("$name", ({ names, members }) => {
      const fold = run(names).nodes.find((node) => node.kind === "fold");
      expect(fold?.kind === "fold" ? fold.fold.members.length : 0).toBe(members);
      expect(run(names).edges.some((edge) => edge.to.startsWith("fold:"))).toBe(members > 0);
    });
  });
});

describe("tidyLayout keeps the order a viewer gave", () => {
  const model = fan(3);
  const across = (layout: TidyLayout, prefix = "leaf-"): string[] =>
    layout.nodes
      .filter((node) => node.id.startsWith(prefix))
      .sort((left, right) => left.rect.x - right.rect.x)
      .map((node) => node.id);
  const chain = (of: string, names: readonly string[]): ModelOrder => ({ chains: [{ of, names }], places: {} });
  const run = (order: ModelOrder | null): TidyLayout => tidyLayout({ entities: model.entities, relationships: model.relationships, folds: [], whole: model, order });

  it.each([
    ["turned round", ["leaf-02", "leaf-01", "leaf-00"], ["leaf-02", "leaf-01", "leaf-00"]],
    ["a leaf to the front", ["leaf-01", "leaf-00", "leaf-02"], ["leaf-01", "leaf-00", "leaf-02"]],
    ["only the leaves the order names trade places", ["leaf-02", "leaf-00"], ["leaf-02", "leaf-01", "leaf-00"]],
    ["names that are not there are passed over", ["ghost", "leaf-01", "leaf-00"], ["leaf-01", "leaf-00", "leaf-02"]],
  ] as const)("%s", (_name, names, expected) => {
    expect(across(run(chain("root", names)))).toEqual(expected);
  });

  it.each([
    ["no order", null],
    ["an order of other entities", chain("elsewhere", ["x", "y"])],
    ["the order the arrangement has by itself", chain("root", ["leaf-00", "leaf-01", "leaf-02"])],
  ] as const)("is the arrangement's own with %s", (_name, order) => {
    expect(run(order)).toEqual(run(null));
  });

  it("says what stands side by side, row by row: what a drag reorders", () => {
    expect(run(null).ranks).toEqual([["root"], ["leaf-00", "leaf-01", "leaf-02"]]);
    expect(run(chain("root", ["leaf-02", "leaf-01", "leaf-00"])).ranks).toEqual([["root"], ["leaf-02", "leaf-01", "leaf-00"]]);
  });

  it("takes what hangs below a moved parent along, and draws no line through a tile", () => {
    const tree = { entities: ["r", "a", "b", "a1", "a2", "b1", "b2"].map((name) => entity(name)), relationships: [link("r", "a"), link("r", "b"), link("a", "a1"), link("a", "a2"), link("b", "b1"), link("b", "b2")] };
    const own = tidyLayout({ entities: tree.entities, relationships: tree.relationships, folds: [], whole: tree });
    const [first, second] = own.ranks[1] as [string, string];
    const turned = tidyLayout({ entities: tree.entities, relationships: tree.relationships, folds: [], whole: tree, order: chain("r", [second, first]) });

    expect(turned.ranks[1]).toEqual([second, first]);
    expect((turned.ranks[2] ?? []).map((name) => name.slice(0, 1))).toEqual([second, second, first, first]);
    expect(throughCards(asRouting(turned))).toEqual([]);
  });
});
