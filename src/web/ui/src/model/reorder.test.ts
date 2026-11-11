// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Rect } from "./edgeRouting";
import { candidateAt, candidatesOf, currentCandidate, describeMove, isNoOp, orderAfter, previewPositions, stepCandidate, type Axis, type Candidate, type DragWorld } from "./reorder";
import { LAYOUT_ENGINES, type NodeSize } from "./layout";
import { denseModel } from "../../tests/denseModel";
import type { Entity, Relationship } from "./types";
import type { OrderFamily } from "./customOrder";

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

/** Ranks drawn on a grid: one rank a row (or column, reading down), each card STEP further on. */
function world(text: string, edges: string, axis: Axis = "x", family: OrderFamily = "hierarchy"): DragWorld {
  const ranks = rows(text);
  const rects = new Map<string, Rect>();
  ranks.forEach((row, rank) => row.forEach((name, index) => rects.set(name, axis === "x" ? { x: index * STEP, y: rank * 200, width: W, height: H } : { x: rank * 260, y: index * STEP, width: W, height: H })));
  return { family, rects, links: links(edges), ranks, axis };
}

const TREE = "r/a b c/a1 a2 s b1 c1 c2";
const TREE_LINKS = "r>a r>b r>c a>a1 a>a2 a>s b>s b>b1 c>c1 c>c2";
const SHELF = "m x y/m1 m2 y1 y2";
const SHELF_LINKS = "m>m1 m>m2 y>y1 y>y2";

describe("candidateAt in ranks", () => {
  const tree = world(TREE, TREE_LINKS);

  it.each([
    ["over its own place", "a", { x: 50, y: 230 }, 0],
    ["past the middle of the next card", "a", { x: STEP + 60, y: 230 }, 1],
    ["past the middle of the last card", "a", { x: 2 * STEP + 60, y: 230 }, 2],
    ["just left of a card's middle takes the place before it", "c", { x: STEP + 40, y: 230 }, 1],
    ["just right of a card's middle takes the place after it", "c", { x: STEP + 60, y: 230 }, 2],
    ["a little before the first card is the first place", "c", { x: -30, y: 230 }, 0],
    ["a little past the last card is the last place", "a", { x: 2 * STEP + 100 + 40, y: 230 }, 2],
    ["a little above the rank is still the rank", "a", { x: STEP + 60, y: 160 }, 1],
  ] as const)("%s", (_name, name, centre, index) => {
    expect(candidateAt(tree, name, centre)).toEqual({ kind: "index", index });
  });

  it.each([
    ["far past the end of the rank", "a", { x: 2 * STEP + 100 + 400, y: 230 }],
    ["far before the start of the rank", "c", { x: -400, y: 230 }],
    ["well above the rank", "a", { x: STEP + 50, y: -100 }],
    ["on the next rank down", "a", { x: STEP + 50, y: 430 }],
    ["among cards that are not its siblings", "b1", { x: 50, y: 430 }],
  ] as const)("is nowhere %s", (_name, name, centre) => {
    expect(candidateAt(tree, name, centre)).toBeNull();
  });

  it("keeps a child among its siblings: a place beside another parent's children is not one", () => {
    // a1 may go among a1, a2 and s; the places right of s are b1's and c's
    expect(candidateAt(tree, "a1", { x: 2 * STEP + 60, y: 430 })).toEqual({ kind: "index", index: 2 });
    expect(candidateAt(tree, "a1", { x: 4 * STEP + 50, y: 430 })).toBeNull();
  });

  it("lets a card with several parents go anywhere in its rank", () => {
    expect(candidateAt(tree, "s", { x: 5 * STEP + 60, y: 430 })).toEqual({ kind: "index", index: 5 });
    expect(candidateAt(tree, "s", { x: 50, y: 430 })).toEqual({ kind: "index", index: 0 });
  });

  it("offers nothing for a card with nowhere to go", () => {
    expect(candidateAt(tree, "r", { x: 50, y: 30 })).toBeNull();
    expect(candidateAt(tree, "ghost", { x: 50, y: 30 })).toBeNull();
  });

  it("reads ranks that run sideways down the screen", () => {
    const sideways = world(TREE, TREE_LINKS, "y");

    expect(candidateAt(sideways, "a", { x: 50, y: 2 * STEP + 30 })).toBeNull(); // over the first rank's column
    expect(candidateAt(sideways, "a", { x: 260 + 50, y: 2 * STEP + 40 })).toEqual({ kind: "index", index: 2 });
    expect(candidateAt(sideways, "a", { x: 260 + 50, y: 30 })).toEqual({ kind: "index", index: 0 });
  });
});

describe("candidateAt for the shelf", () => {
  const shelf = world(SHELF, SHELF_LINKS);

  it.each([
    ["the part to its left", "y", { x: STEP + 50, y: 30 }, 0],
    ["its own part", "y", { x: 2 * STEP + 50, y: 30 }, 1],
    ["a part by its children", "x", { x: 2 * STEP + 50, y: 230 }, 1],
  ] as const)("takes the place of %s", (_name, name, centre, index) => {
    expect(candidateAt(shelf, name, centre)).toEqual({ kind: "index", index });
  });

  it("is nowhere over the main part", () => {
    expect(candidateAt(shelf, "x", { x: 50, y: 30 })).toBeNull();
    expect(candidateAt(shelf, "x", { x: 50, y: 230 })).toBeNull();
  });
});

describe("candidateAt where cards swap places", () => {
  const rects = new Map<string, Rect>([
    ["a", { x: 0, y: 0, width: W, height: H }],
    ["b", { x: 300, y: 0, width: W, height: H }],
    ["c", { x: 0, y: 300, width: W, height: H }],
    ["near", { x: 120, y: 0, width: 20, height: 20 }],
  ]);
  const swap = (without: string[] = []): DragWorld => ({ family: "elk-radial", rects: new Map([...rects].filter(([name]) => !without.includes(name))), links: [], ranks: [], axis: "x" });

  it.each([
    ["over a card", "a", { x: 350, y: 30 }, "b"],
    ["over another card", "a", { x: 50, y: 330 }, "c"],
    ["a little off a card", "a", { x: 300 + W + 10, y: 30 }, "b"],
  ] as const)("takes the place of the card %s", (_name, name, centre, target) => {
    expect(candidateAt(swap(["near"]), name, centre)).toEqual({ kind: "swap", target });
  });

  it("is nowhere over empty space, or over its own place", () => {
    expect(candidateAt(swap(["near"]), "a", { x: 200, y: 150 })).toBeNull();
    expect(candidateAt(swap(["near"]), "a", { x: 50, y: 30 })).toBeNull();
  });

  it("is nowhere over a card whose place it could not take", () => {
    const crowded = swap();

    expect(candidateAt(crowded, "b", { x: 130, y: 10 })).toBeNull();
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
  ] as const)("moves %s", (_name, name, from, key, index) => {
    expect(stepCandidate(tree, name, from, key)).toEqual({ kind: "index", index });
  });

  it.each([
    ["past the last place", "a1", { kind: "index", index: 2 }, "ArrowRight"],
    ["before the first place", "a1", null, "ArrowLeft"],
    ["a card with nowhere to go", "r", null, "ArrowRight"],
  ] as const)("goes nowhere %s", (_name, name, from, key) => {
    expect(stepCandidate(tree, name, from, key)).toBeNull();
  });

  it("walks to the nearest card in the direction of the key where cards swap places", () => {
    const rects = new Map<string, Rect>([
      ["a", { x: 0, y: 0, width: W, height: H }],
      ["right", { x: 300, y: 0, width: W, height: H }],
      ["farRight", { x: 900, y: 0, width: W, height: H }],
      ["below", { x: 0, y: 300, width: W, height: H }],
    ]);
    const swap: DragWorld = { family: "force", rects, links: [], ranks: [], axis: "x" };

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
    ["the root of the main part", TREE, TREE_LINKS, "r", [], 0],
    ["a shelved part", SHELF, SHELF_LINKS, "y", [0, 1], 1],
  ] as const)("lists the places of %s", (_name, ranks, edges, name, indices, current) => {
    const w = world(ranks, edges);

    expect(candidatesOf(w, name)).toEqual(indices.map((index) => ({ kind: "index", index })));
    expect(currentCandidate(w, name)?.kind === "index" ? (currentCandidate(w, name) as { index: number }).index : null).toBe(current);
  });

  it("has no current place where there are no ranks", () => {
    expect(currentCandidate({ ...world(TREE, TREE_LINKS), family: "force" }, "a")).toBeNull();
  });
});

describe("orderAfter", () => {
  const tree = world(TREE, TREE_LINKS);
  const SIZES = new Map([...tree.rects].map(([name, rect]) => [name, { width: rect.width, height: rect.height }] as const));

  it("keeps the ranks with the card moved, and its subtree with it", () => {
    expect(orderAfter(tree, "a", { kind: "index", index: 2 }, SIZES)).toEqual({ kind: "ranks", ranks: rows("r/b c a/s b1 c1 c2 a1 a2") });
  });

  it("is nothing when the card stays where it is", () => {
    const here: Candidate = { kind: "index", index: 0 };

    expect(isNoOp(tree, "a", here)).toBe(true);
    expect(orderAfter(tree, "a", here, SIZES)).toBeNull();
  });

  it("keeps where every card stands, with two swapped, where cards have places", () => {
    const rects = new Map<string, Rect>([["a", { x: 0, y: 0, width: W, height: H }], ["b", { x: 300, y: 0, width: W, height: H }], ["c", { x: 0, y: 300, width: W, height: H }]]);
    const swap: DragWorld = { family: "elk-radial", rects, links: [], ranks: [], axis: "x" };
    const sizes = new Map([...rects].map(([name, rect]) => [name, { width: rect.width, height: rect.height }] as const));

    expect(orderAfter(swap, "a", { kind: "swap", target: "b" }, sizes)).toEqual({ kind: "slots", slots: { a: { x: 300, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 300 } } });
    expect(orderAfter(swap, "a", { kind: "swap", target: "ghost" }, sizes)).toBeNull();
  });

  it("says where a move lands", () => {
    expect(describeMove(tree, "a1", { kind: "index", index: 1 })).toBe("Place 2 of 3.");
    expect(describeMove(tree, "b1", { kind: "index", index: 3 })).toBe("Place 2 of 2.");
    expect(describeMove(world(SHELF, SHELF_LINKS), "y", { kind: "index", index: 0 })).toBe("Place 1 of 2 among the parts on the shelf.");
    expect(describeMove(tree, "a", { kind: "swap", target: "b" })).toBe("Swap places with b.");
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
    const order = { kind: "ranks", ranks: [["r"], ["c", "a", "b"], ["a2", "a1"]] } as const;
    const current = await LAYOUT_ENGINES[id].run(ENTITIES, RELATIONSHIPS, size, { shortest: true });
    const kept = await LAYOUT_ENGINES[id].run(ENTITIES, RELATIONSHIPS, size, { custom: order });

    expect([...previewPositions(id, order, current, ENTITIES, RELATIONSHIPS, SIZES)]).toEqual([...kept.positions]);
  });

  it("puts every card of a slot order where it says, and leaves the others", async () => {
    const current = await LAYOUT_ENGINES["elk-radial"].run(ENTITIES, RELATIONSHIPS, size);
    const shown = previewPositions("elk-radial", { kind: "slots", slots: { a: { x: 1, y: 2 } } }, current, ENTITIES, RELATIONSHIPS, SIZES);

    expect(shown.get("a")).toEqual({ x: 1, y: 2 });
    expect(shown.get("b")).toEqual(current.positions.get("b"));
  });

  it("opens the place in the rank of ELK layered, whatever order the engine drew", async () => {
    const current = await LAYOUT_ENGINES["elk-layered"].run(ENTITIES, RELATIONSHIPS, size, {});
    const shown = previewPositions("elk-layered", { kind: "ranks", ranks: [["r"], ["c", "b", "a"], ["a1", "a2"]] }, current, ENTITIES, RELATIONSHIPS, SIZES);
    const across = (name: string): number => shown.get(name)?.x ?? 0;

    expect(across("c")).toBeLessThan(across("b"));
    expect(across("b")).toBeLessThan(across("a"));
  });

  it("is quick enough to follow a pointer: 81 entities well under a frame budget", () => {
    const model = denseModel(7, 81, 100);
    const sizes = new Map(model.entities.map((item) => [item.name, { width: 260, height: 100 }] as const));
    const current = { positions: new Map(model.entities.map((item) => [item.name, { x: 0, y: 0 }] as const)), width: 0, height: 0 };
    const order = { kind: "ranks", ranks: [[model.entities[0]?.name ?? ""]] } as const;
    previewPositions("dagre-tb", order, current, model.entities, model.relationships, sizes);
    const times = Array.from({ length: 7 }, () => {
      const start = performance.now();
      previewPositions("dagre-tb", order, current, model.entities, model.relationships, sizes);
      return performance.now() - start;
    }).sort((a, b) => a - b);

    expect(times[3] as number).toBeLessThan(50);
  });
});
