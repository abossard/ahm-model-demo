// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Rect } from "./edgeRouting";
import {
  candidateAt,
  candidatesOf,
  currentCandidate,
  describeMove,
  drawnParents,
  isNoOp,
  orderAfter,
  placesOf,
  previewPositions,
  rowAfter,
  stepCandidate,
  type Candidate,
  type ReorderWorld,
} from "./reorder";
import { LAYOUT_ENGINES, type NodeSize } from "./layout";
import { denseModel } from "../../tests/denseModel";
import type { Entity, Relationship } from "./types";
import { forLayout, withChain, withPlaces, type ModelOrder, type PlaceFamily } from "./customOrder";

const W = 100;
const H = 60;
const STEP = 160;

function links(text: string): { parentEntityName: string; childEntityName: string }[] {
  return text.split(" ").filter(Boolean).map((pair) => {
    const [parentEntityName = "", childEntityName = ""] = pair.split(">");
    return { parentEntityName, childEntityName };
  });
}

function rows(text: string): string[][] {
  return text.split("/").map((row) => row.split(" ").filter(Boolean));
}

function order(text: string): ModelOrder {
  return { chains: text.split(";").filter(Boolean).map((chain) => ({ of: chain.split(":")[0] ?? "", names: (chain.split(":")[1] ?? "").split(" ").filter(Boolean) })), places: {} };
}

/** Rows drawn on a grid: one row a line (or a column, reading down), each thing STEP further on. `fixed` hold their places. */
function world(text: string, edges: string, down = false, fixed: readonly string[] = []): ReorderWorld {
  const drawn = rows(text);
  const rects = new Map<string, Rect>();
  drawn.forEach((row, rank) => row.forEach((name, index) => rects.set(name, down ? { x: rank * 260, y: index * STEP, width: W, height: H } : { x: index * STEP, y: rank * 200, width: W, height: H })));
  const names = drawn.flat();
  return { rows: drawn, rects, parents: drawnParents(names.filter((name) => !fixed.includes(name)), new Set(names), links(edges)) };
}

function swapWorld(rects: ReadonlyMap<string, Rect>, places: PlaceFamily = "elk-radial"): ReorderWorld {
  return { rows: [], rects, parents: new Map([...rects.keys()].map((name) => [name, []] as const)), places };
}

// A root with three children; the shared child s hangs from a and b.
const TREE = "r/a b c/a1 a2 s b1 c1 c2";
const TREE_LINKS = "r>a r>b r>c a>a1 a>a2 a>s b>s b>b1 c>c1 c>c2";
// A main part and, on the shelf, a small tree y and a lone entity x.
const SHELF = "m x y/m1 m2 y1 y2";
const SHELF_LINKS = "m>m1 m>m2 y>y1 y>y2";

describe("drawnParents", () => {
  it("lists for each thing that can be moved its parents among what is drawn, each once", () => {
    const parents = drawnParents(["a", "b", "c"], new Set(["r", "a", "b", "c"]), links("r>a r>a r>b gone>b a>a x>c"));

    expect([...parents]).toEqual([["a", ["r"]], ["b", ["r"]], ["c", []]]);
  });
});

describe("placesOf: where a thing may go", () => {
  it.each([
    ["a child may take the places of its siblings", TREE, TREE_LINKS, "a", [0, 1, 2], 0],
    ["a grandchild stays under its parent: with the shared child", TREE, TREE_LINKS, "a1", [0, 1, 2], 0],
    ["the last child of its parent", TREE, TREE_LINKS, "b1", [2, 3], 3],
    ["a card with two parents may take the places of the children of both", TREE, TREE_LINKS, "s", [0, 1, 2, 3], 2],
    ["a root alone has only its own place", TREE, TREE_LINKS, "r", [0], 0],
    ["the entities with no parent trade among themselves", SHELF, SHELF_LINKS, "y", [0, 1, 2], 2],
    ["siblings that do not stand together keep the places they hold", "r/a p b q c", "r>a r>b r>c o>p o>q", "a", [0, 2, 4], 0],
  ] as const)("%s", (_name, text, edges, id, slots, from) => {
    const places = placesOf(world(text, edges), id);

    expect(places?.slots).toEqual(slots);
    expect(places?.from).toBe(from);
  });

  it("has none for a thing that holds its place, or is not drawn, and does not count it among the others", () => {
    const held = world(TREE, TREE_LINKS, false, ["b"]);

    expect(placesOf(held, "b")).toBeNull();
    expect(placesOf(held, "ghost")).toBeNull();
    expect(placesOf(held, "a")?.slots).toEqual([0, 2]);
  });
});

describe("candidateAt in rows", () => {
  const tree = world(TREE, TREE_LINKS);

  it.each([
    ["over its own place", "a", { x: 50, y: 230 }, 0],
    ["over the next card", "a", { x: STEP + 60, y: 230 }, 1],
    ["over the last card", "a", { x: 2 * STEP + 60, y: 230 }, 2],
    ["nearer to the card before than to its own place", "c", { x: STEP + 100, y: 230 }, 1],
    ["nearer to its own place", "c", { x: 2 * STEP - 20, y: 230 }, 2],
    ["a little before the first card is the first place", "c", { x: -30, y: 230 }, 0],
    ["a little past the last card is the last place", "a", { x: 2 * STEP + 100 + 40, y: 230 }, 2],
    ["a little above the row is still the row", "a", { x: STEP + 60, y: 160 }, 1],
    ["a child among its siblings and the shared child", "a1", { x: 2 * STEP + 60, y: 430 }, 2],
    ["a card with two parents among the children of both", "s", { x: 3 * STEP + 60, y: 430 }, 3],
    ["a part on the shelf over another", "y", { x: STEP + 50, y: 30 }, 1],
  ] as const)("%s", (_name, id, centre, index) => {
    const from = id === "y" ? world(SHELF, SHELF_LINKS) : tree;

    expect(candidateAt(from, id, centre)).toEqual({ kind: "index", index });
  });

  it.each([
    ["far past the end of the row", "a", { x: 2 * STEP + 100 + 400, y: 230 }],
    ["far before the start of the row", "c", { x: -400, y: 230 }],
    ["well above the row", "a", { x: STEP + 50, y: -100 }],
    ["on the next row down", "a", { x: STEP + 50, y: 430 }],
    ["among cards that are not its siblings", "b1", { x: 50, y: 430 }],
    ["past its siblings, beside another parent's children", "a1", { x: 4 * STEP + 50, y: 430 }],
    ["for a card with nowhere to go", "r", { x: 50, y: 30 }],
    ["for a card that is not drawn", "ghost", { x: 50, y: 30 }],
  ] as const)("is nowhere %s", (_name, id, centre) => {
    expect(candidateAt(tree, id, centre)).toBeNull();
  });

  it("reads rows that run down the screen", () => {
    const sideways = world(TREE, TREE_LINKS, true);

    expect(candidateAt(sideways, "a", { x: 50 - 200, y: 2 * STEP + 30 })).toBeNull();
    expect(candidateAt(sideways, "a", { x: 260 + 50, y: 2 * STEP + 40 })).toEqual({ kind: "index", index: 2 });
    expect(candidateAt(sideways, "a", { x: 260 + 50, y: 30 })).toEqual({ kind: "index", index: 0 });
  });

  it("tells the rows of a wrapped lane apart: only the cards of its own row are places", () => {
    // Two rows of one lane, the second under the first: every card is a child of r.
    const lane: ReorderWorld = { ...world("a b c/d e f", ""), parents: new Map(["a", "b", "c", "d", "e", "f"].map((name) => [name, ["r"]] as const)) };

    expect(candidatesOf(lane, "e")).toEqual([3, 4, 5].map((index) => ({ kind: "index", index: index - 3 })));
    expect(candidateAt(lane, "e", { x: 2 * STEP + 50, y: 230 })).toEqual({ kind: "index", index: 2 });
  });
});

describe("candidateAt where cards swap places", () => {
  const rects = new Map<string, Rect>([
    ["a", { x: 0, y: 0, width: W, height: H }],
    ["b", { x: 300, y: 0, width: W, height: H }],
    ["c", { x: 0, y: 300, width: W, height: H }],
    ["near", { x: 120, y: 0, width: 20, height: 20 }],
  ]);
  const swap = (without: string[] = []): ReorderWorld => swapWorld(new Map([...rects].filter(([name]) => !without.includes(name))));

  it.each([
    ["over a card", "a", { x: 350, y: 30 }, "b"],
    ["over another card", "a", { x: 50, y: 330 }, "c"],
    ["a little off a card", "a", { x: 300 + W + 10, y: 30 }, "b"],
  ] as const)("takes the place of the card %s", (_name, id, centre, target) => {
    expect(candidateAt(swap(["near"]), id, centre)).toEqual({ kind: "swap", target });
  });

  it("is nowhere over empty space, or over its own place", () => {
    expect(candidateAt(swap(["near"]), "a", { x: 200, y: 150 })).toBeNull();
    expect(candidateAt(swap(["near"]), "a", { x: 50, y: 30 })).toBeNull();
  });

  it("is nowhere over a card whose place it could not take", () => {
    expect(candidateAt(swap(), "b", { x: 130, y: 10 })).toBeNull();
  });
});

describe("stepCandidate", () => {
  const tree = world(TREE, TREE_LINKS);

  it.each([
    ["to the next place", "a1", null, "ArrowRight", 1],
    ["to the next place, down", "a1", null, "ArrowDown", 1],
    ["to the previous place", "a2", null, "ArrowLeft", 0],
    ["to the previous place, up", "a2", null, "ArrowUp", 0],
    ["on from where it was", "a1", { kind: "index", index: 1 }, "ArrowRight", 2],
    ["back from where it was", "a1", { kind: "index", index: 2 }, "ArrowLeft", 1],
  ] as const)("moves %s", (_name, id, from, key, index) => {
    expect(stepCandidate(tree, id, from, key)).toEqual({ kind: "index", index });
  });

  it.each([
    ["past the last place", "a1", { kind: "index", index: 2 }, "ArrowRight"],
    ["before the first place", "a1", null, "ArrowLeft"],
    ["a card with nowhere to go", "r", null, "ArrowRight"],
  ] as const)("goes nowhere %s", (_name, id, from, key) => {
    expect(stepCandidate(tree, id, from, key)).toBeNull();
  });

  it("steps over what stands between siblings", () => {
    const mixed = world("r/a p b q c", "r>a r>b r>c o>p o>q");

    expect(stepCandidate(mixed, "a", null, "ArrowRight")).toEqual({ kind: "index", index: 2 });
    expect(stepCandidate(mixed, "a", { kind: "index", index: 2 }, "ArrowRight")).toEqual({ kind: "index", index: 4 });
  });

  it("walks to the nearest card in the direction of the key where cards swap places", () => {
    const swap = swapWorld(
      new Map<string, Rect>([
        ["a", { x: 0, y: 0, width: W, height: H }],
        ["right", { x: 300, y: 0, width: W, height: H }],
        ["farRight", { x: 900, y: 0, width: W, height: H }],
        ["below", { x: 0, y: 300, width: W, height: H }],
      ]),
      "force",
    );

    expect(stepCandidate(swap, "a", null, "ArrowRight")).toEqual({ kind: "swap", target: "right" });
    expect(stepCandidate(swap, "a", { kind: "swap", target: "right" }, "ArrowRight")).toEqual({ kind: "swap", target: "farRight" });
    expect(stepCandidate(swap, "a", null, "ArrowDown")).toEqual({ kind: "swap", target: "below" });
    expect(stepCandidate(swap, "a", null, "ArrowLeft")).toBeNull();
    expect(stepCandidate(swap, "a", null, "ArrowUp")).toBeNull();
  });
});

describe("candidatesOf and currentCandidate", () => {
  it.each([
    ["a child", TREE, TREE_LINKS, "a", [0, 1, 2], 0],
    ["a grandchild", TREE, TREE_LINKS, "b1", [2, 3], 3],
    ["a root alone", TREE, TREE_LINKS, "r", [], 0],
    ["a part on the shelf", SHELF, SHELF_LINKS, "y", [0, 1, 2], 2],
  ] as const)("lists the places of %s", (_name, text, edges, id, indices, current) => {
    const w = world(text, edges);

    expect(candidatesOf(w, id)).toEqual(indices.map((index) => ({ kind: "index", index })));
    expect(currentCandidate(w, id)).toEqual({ kind: "index", index: current });
  });

  it("has no current place where cards swap places", () => {
    expect(currentCandidate({ ...world(TREE, TREE_LINKS), places: "force" }, "a")).toBeNull();
  });
});

describe("rowAfter", () => {
  it.each([
    ["to the end", TREE, TREE_LINKS, "a", 2, "b c a"],
    ["to the middle", TREE, TREE_LINKS, "c", 1, "a c b"],
    ["where it is", TREE, TREE_LINKS, "b", 1, "a b c"],
    ["what stands between siblings keeps its place", "r/a p b q c", "r>a r>b r>c o>p o>q", "a", 4, "b p c q a"],
    ["a place that is not one of its own leaves the row", TREE, TREE_LINKS, "b1", 0, "a1 a2 s b1 c1 c2"],
  ] as const)("takes a thing %s", (_name, text, edges, id, index, expected) => {
    expect(rowAfter(world(text, edges), id, index)).toEqual(expected.split(" "));
  });
});

describe("orderAfter", () => {
  const tree = world(TREE, TREE_LINKS);

  it.each([
    ["the children of its parent, as the row then has them", tree, null, "a", 2, "r:b c a"],
    ["on top of the order that is drawn", tree, order("c:c2 c1;r:a b c"), "a", 2, "c:c2 c1;r:b c a"],
    ["for a card with two parents, the children of each", tree, null, "s", 0, "a:s a1 a2;b:s b1"],
    ["for an entity with no parent, the top", world(SHELF, SHELF_LINKS), null, "y", 1, ":m y x"],
  ] as const)("keeps %s", (_name, from, base, id, index, expected) => {
    expect(orderAfter(from, base, id, { kind: "index", index })).toEqual(order(expected));
  });

  it("is nothing when the thing stays where it is, or holds its place", () => {
    const here: Candidate = { kind: "index", index: 0 };

    expect(isNoOp(tree, "a", here)).toBe(true);
    expect(orderAfter(tree, null, "a", here)).toBeNull();
    expect(orderAfter(world(TREE, TREE_LINKS, false, ["a"]), null, "a", { kind: "index", index: 2 })).toBeNull();
  });

  it("names the entity a thing stands for, where its id is not the entity's name", () => {
    const outline: ReorderWorld = {
      rows: [["x", "also:p:y", "z"]],
      rects: new Map(["x", "also:p:y", "z"].map((id, index) => [id, { x: 0, y: index * 36, width: 0, height: 36 }] as const)),
      parents: new Map(["x", "also:p:y", "z"].map((id) => [id, ["p"]] as const)),
      entityOf: (id) => id.replace("also:p:", ""),
    };

    expect(orderAfter(outline, null, "also:p:y", { kind: "index", index: 0 })).toEqual(order("p:y x z"));
    expect(candidateAt(outline, "z", { x: 0, y: 18 })).toEqual({ kind: "index", index: 0 });
  });

  it("keeps where every card stands, with two swapped, where cards have places, beside the chains", () => {
    const swap = swapWorld(new Map<string, Rect>([["a", { x: 0, y: 0, width: W, height: H }], ["b", { x: 300, y: 0, width: W, height: H }], ["c", { x: 0, y: 300, width: W, height: H }]]));
    const places = { a: { x: 300, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 300 } };

    expect(orderAfter(swap, null, "a", { kind: "swap", target: "b" })).toEqual(withPlaces(null, "elk-radial", places));
    expect(orderAfter(swap, order("r:b a"), "a", { kind: "swap", target: "b" })).toEqual(withPlaces(order("r:b a"), "elk-radial", places));
    expect(orderAfter(swap, null, "a", { kind: "swap", target: "ghost" })).toBeNull();
    expect(orderAfter(tree, null, "a", { kind: "swap", target: "b" })).toBeNull();
  });

  it("says where a move lands", () => {
    expect(describeMove(tree, "a1", { kind: "index", index: 1 })).toBe("Place 2 of 3.");
    expect(describeMove(tree, "b1", { kind: "index", index: 3 })).toBe("Place 2 of 2.");
    expect(describeMove(world("r/a p b q c", "r>a r>b r>c o>p o>q"), "a", { kind: "index", index: 4 })).toBe("Place 3 of 3.");
    expect(describeMove(tree, "a", { kind: "swap", target: "b" }, (id) => `Card ${id}`)).toBe("Swap places with Card b.");
  });
});

describe("previewPositions", () => {
  const size = (_entity: Entity): NodeSize => ({ width: 260, height: 100 });
  const entity = (name: string): Entity => ({ ...denseModel(1, 1, 0).entities[0], name, displayName: name, signals: [], parents: [], children: [] }) as Entity;
  const rel = (parent: string, child: string): Relationship => ({ name: `${parent}>${child}`, displayName: null, parentEntityName: parent, childEntityName: child });
  const ENTITIES = ["r", "a", "b", "c", "a1", "a2"].map(entity);
  const RELATIONSHIPS = [rel("r", "a"), rel("r", "b"), rel("r", "c"), rel("a", "a1"), rel("a", "a2")];
  const SIZES = new Map(ENTITIES.map((item) => [item.name, size(item)] as const));

  it.each(["dagre-tb", "dagre-bt", "dagre-lr", "dagre-rl"] as const)("shows what %s gives when the order is kept, so a drop does not move anything", async (id) => {
    const given = withChain(order("r:c a b"), "a", ["a2", "a1"]);
    const current = await LAYOUT_ENGINES[id].run(ENTITIES, RELATIONSHIPS, size, { shortest: true });
    const kept = await LAYOUT_ENGINES[id].run(ENTITIES, RELATIONSHIPS, size, { shortest: true, custom: forLayout("hierarchy", given, current.ranks ?? [], RELATIONSHIPS) });

    expect(kept.ranks).toEqual(rows("r/c a b/a2 a1"));
    expect([...previewPositions(id, "hierarchy", given, current.ranks ?? [], current, ENTITIES, RELATIONSHIPS, SIZES)]).toEqual([...kept.positions]);
  });

  it("puts every card where the places of its layout say, and leaves the others", async () => {
    const current = await LAYOUT_ENGINES["elk-radial"].run(ENTITIES, RELATIONSHIPS, size);
    const shown = previewPositions("elk-radial", "elk-radial", withPlaces(null, "elk-radial", { a: { x: 1, y: 2 } }), [], current, ENTITIES, RELATIONSHIPS, SIZES);

    expect(shown.get("a")).toEqual({ x: 1, y: 2 });
    expect(shown.get("b")).toEqual(current.positions.get("b"));
  });

  it("leaves a layout as it is for an order that has nothing for it", async () => {
    const current = await LAYOUT_ENGINES["d3-force"].run(ENTITIES, RELATIONSHIPS, size);

    expect(previewPositions("d3-force", "force", order("r:c a b"), [], current, ENTITIES, RELATIONSHIPS, SIZES)).toBe(current.positions);
  });

  it("opens the place in the rank of ELK layered, whatever order the engine drew", async () => {
    const current = await LAYOUT_ENGINES["elk-layered"].run(ENTITIES, RELATIONSHIPS, size, {});
    const first = (current.ranks?.[1] ?? []) as readonly string[];
    const turned = [...first].reverse();
    const shown = previewPositions("elk-layered", "elk-layered", withChain(null, "r", turned), current.ranks ?? [], current, ENTITIES, RELATIONSHIPS, SIZES);
    const across = (name: string): number => shown.get(name)?.x ?? 0;

    expect(first).toHaveLength(3);
    expect(across(turned[0] as string)).toBeLessThan(across(turned[1] as string));
    expect(across(turned[1] as string)).toBeLessThan(across(turned[2] as string));
  });

  it("is quick enough to follow a pointer: 81 entities well under a frame budget", () => {
    const model = denseModel(7, 81, 100);
    const sizes = new Map(model.entities.map((item) => [item.name, { width: 260, height: 100 }] as const));
    const current = { positions: new Map(model.entities.map((item) => [item.name, { x: 0, y: 0 }] as const)), width: 0, height: 0 };
    const siblings = model.relationships.filter((item) => item.parentEntityName === "n0").map((item) => item.childEntityName);
    const given = withChain(null, "n0", [...siblings].reverse());
    const ranks = [["n0"], siblings];
    previewPositions("dagre-tb", "hierarchy", given, ranks, current, model.entities, model.relationships, sizes);
    const times = Array.from({ length: 7 }, () => {
      const start = performance.now();
      previewPositions("dagre-tb", "hierarchy", given, ranks, current, model.entities, model.relationships, sizes);
      return performance.now() - start;
    }).sort((a, b) => a - b);

    expect(times[3] as number).toBeLessThan(50);
  });
});
