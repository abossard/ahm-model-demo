// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  familyOf,
  kindOf,
  moveTo,
  orderKey,
  persistOrders,
  persistSortKey,
  ranksFromPositions,
  readStoredOrders,
  readStoredSortKey,
  reconcile,
  slotsFor,
  swapTargets,
  swapped,
  type CustomOrders,
} from "./customOrder";
import { LAYOUT_CHOICES } from "./layout";

function links(text: string): { parentEntityName: string; childEntityName: string }[] {
  return text.split(" ").filter(Boolean).map((pair) => {
    const [parentEntityName = "", childEntityName = ""] = pair.split(">");
    return { parentEntityName, childEntityName };
  });
}

function rows(text: string): string[][] {
  return text.split("/").map((row) => row.split(" ").filter(Boolean));
}

function storage(initial: Record<string, string> = {}, fails = false): () => Storage {
  const items = new Map(Object.entries(initial));
  const store = {
    getItem: (key: string) => {
      if (fails) throw new Error("blocked");
      return items.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fails) throw new Error("blocked");
      items.set(key, value);
    },
  };
  return () => store as unknown as Storage;
}

// A root with three children; the shared child s hangs from a and b.
const TREE = rows("r/a b c/a1 a2 s b1 c1 c2");
const TREE_LINKS = links("r>a r>b r>c a>a1 a>a2 a>s b>s b>b1 c>c1 c>c2");
// A main part and, on the shelf, a small tree y and a lone entity x.
const SHELF = rows("m x y/m1 m2 y1 y2");
const SHELF_LINKS = links("m>m1 m>m2 y>y1 y>y2");

describe("families, keys and kinds", () => {
  it.each([
    ["dagre-tb", "hierarchy", "ranks"],
    ["dagre-bt", "hierarchy", "ranks"],
    ["dagre-lr", "hierarchy", "ranks"],
    ["dagre-rl", "hierarchy", "ranks"],
    ["elk-layered", "elk-layered", "ranks"],
    ["elk-radial", "elk-radial", "slots"],
    ["d3-force", "force", "slots"],
    ["d3-force-adaptive", null, null],
  ] as const)("%s keeps its order as %s, a %s order", (layout, family, kind) => {
    expect(familyOf(layout)).toBe(family);
    if (family) expect(kindOf(family)).toBe(kind);
  });

  it("covers every layout the picker offers", () => {
    expect(LAYOUT_CHOICES.map((engine) => familyOf(engine.id)).filter((family) => family === null)).toHaveLength(1);
  });

  it("keys an order by the model the address names and the family", () => {
    expect(orderKey({ subscriptionId: "sub", resourceGroup: "rg", name: "hm" }, "hierarchy")).toBe("sub/rg/hm#hierarchy");
    expect(orderKey({ subscriptionId: "sub", resourceGroup: "rg", name: "hm" }, "force")).not.toBe(orderKey({ subscriptionId: "sub", resourceGroup: "rg", name: "hm" }, "hierarchy"));
    expect(orderKey(null, "hierarchy")).toBeNull();
  });
});

describe("slotsFor: where a card may go", () => {
  it.each([
    ["a child among its siblings", TREE, TREE_LINKS, "a", { rank: 1, from: 0, indices: [0, 1, 2], part: false }],
    ["a middle child", TREE, TREE_LINKS, "b", { rank: 1, from: 1, indices: [0, 1, 2], part: false }],
    ["a grandchild among the children of its parent, a shared child between them included", TREE, TREE_LINKS, "a1", { rank: 2, from: 0, indices: [0, 1, 2], part: false }],
    ["a grandchild with a shared child beside it", TREE, TREE_LINKS, "b1", { rank: 2, from: 3, indices: [2, 3], part: false }],
    ["a card with several parents, among the cards of its part", TREE, TREE_LINKS, "s", { rank: 2, from: 2, indices: [0, 1, 2, 3, 4, 5], part: false }],
    ["the only root of the main part: nowhere else to go", TREE, TREE_LINKS, "r", { rank: 0, from: 0, indices: [0], part: false }],
    ["the root of a part on the shelf moves its part", SHELF, SHELF_LINKS, "y", { rank: 0, from: 1, indices: [0, 1], part: true }],
    ["a lone entity on the shelf", SHELF, SHELF_LINKS, "x", { rank: 0, from: 0, indices: [0, 1], part: true }],
    ["a child on the shelf stays among its siblings", SHELF, SHELF_LINKS, "y2", { rank: 1, from: 3, indices: [2, 3], part: false }],
    ["a child of the main part", SHELF, SHELF_LINKS, "m1", { rank: 1, from: 0, indices: [0, 1], part: false }],
  ] as const)("%s", (_name, ranks, edges, name, expected) => {
    expect(slotsFor(ranks, edges, name)).toEqual(expected);
  });

  it("knows nothing of a card the ranks do not have", () => {
    expect(slotsFor(TREE, TREE_LINKS, "ghost")).toBeNull();
  });

  it("ignores relationships to cards the ranks do not have, and self loops", () => {
    expect(slotsFor(TREE, [...TREE_LINKS, ...links("a>ghost ghost>b a>a")], "a")).toEqual({ rank: 1, from: 0, indices: [0, 1, 2], part: false });
  });

  it("leaves a card with no parent in a deeper rank where it is: its part is only itself", () => {
    expect(slotsFor(rows("r/a b"), links("r>a"), "b")).toEqual({ rank: 1, from: 1, indices: [1], part: false });
  });
});

describe("moveTo: taking a card to a place", () => {
  it.each([
    ["a child to the end: its subtree follows", TREE, "a", 2, "r/b c a/s b1 c1 c2 a1 a2"],
    ["a child to the front: the others keep their order", TREE, "c", 0, "r/c a b/c1 c2 a1 a2 s b1"],
    ["a middle child to the front", TREE, "b", 0, "r/b a c/s b1 a1 a2 c1 c2"],
    ["a grandchild among its siblings", TREE, "a1", 2, "r/a b c/a2 s a1 b1 c1 c2"],
    ["a grandchild to where it is", TREE, "a1", 0, "r/a b c/a1 a2 s b1 c1 c2"],
    ["a place past the last is the last", TREE, "a1", 99, "r/a b c/a2 s a1 b1 c1 c2"],
    ["a place before the first is the first", TREE, "a2", -5, "r/a b c/a2 a1 s b1 c1 c2"],
    ["a card with several parents anywhere in its rank", TREE, "s", 5, "r/a b c/a1 a2 b1 c1 c2 s"],
    ["a card with several parents, to the front", TREE, "s", 0, "r/a b c/s a1 a2 b1 c1 c2"],
  ] as const)("%s", (_name, ranks, name, index, expected) => {
    expect(moveTo(ranks, TREE_LINKS, name, index)).toEqual(rows(expected));
  });

  it.each([
    ["a part moves ahead of another", "x", 1, "m y x/m1 m2 y1 y2"],
    ["a part with children moves ahead", "y", 0, "m y x/m1 m2 y1 y2"],
    ["a part to where it is", "x", 0, "m x y/m1 m2 y1 y2"],
  ] as const)("shelf: %s", (_name, name, index, expected) => {
    expect(moveTo(SHELF, SHELF_LINKS, name, index)).toEqual(rows(expected));
  });

  it("moves a part with every rank it has", () => {
    const ranks = rows("m x y/m1 y1/y2");
    const moved = moveTo(ranks, links("m>m1 y>y1 y1>y2"), "y", 0);

    expect(moved).toEqual(rows("m y x/m1 y1/y2"));
  });

  it("changes nothing for a card that is not there, and never changes what it is given", () => {
    const given = rows("r/a b c/a1 a2 s b1 c1 c2");
    const copy = JSON.parse(JSON.stringify(given)) as string[][];

    expect(moveTo(given, TREE_LINKS, "ghost", 0)).toEqual(given);
    moveTo(given, TREE_LINKS, "a", 2);
    expect(given).toEqual(copy);
  });

  it("is the same whatever order the relationships are given in", () => {
    expect(moveTo(TREE, [...TREE_LINKS].reverse(), "a", 2)).toEqual(moveTo(TREE, TREE_LINKS, "a", 2));
  });

  it("keeps every card exactly once", () => {
    for (const name of ["a", "b", "c", "a1", "s", "c2"]) {
      const slots = slotsFor(TREE, TREE_LINKS, name);
      for (const index of slots?.indices ?? []) {
        const moved = moveTo(TREE, TREE_LINKS, name, index);

        expect(moved.map((row) => [...row].sort()), `${name} to ${index}`).toEqual(TREE.map((row) => [...row].sort()));
      }
    }
  });
});

describe("reconcile: an order without what is gone", () => {
  it.each([
    ["ranks", { kind: "ranks", ranks: rows("r/a b c") } as const, { kind: "ranks", ranks: rows("r/a c") }],
    ["slots", { kind: "slots", slots: { r: { x: 0, y: 0 }, b: { x: 1, y: 1 } } } as const, { kind: "slots", slots: { r: { x: 0, y: 0 } } }],
  ] as const)("drops from %s what is not present", (_name, order, expected) => {
    expect(reconcile(order, new Set(["r", "a", "c"]))).toEqual(expected);
  });

  it("keeps the rank a row was in even when it is left empty", () => {
    expect(reconcile({ kind: "ranks", ranks: rows("r/a b/c") }, new Set(["r", "c"]))).toEqual({ kind: "ranks", ranks: [["r"], [], ["c"]] });
  });
});

describe("keeping orders in storage", () => {
  const ORDERS: CustomOrders = {
    "s/g/hm#hierarchy": { kind: "ranks", ranks: rows("r/a b") },
    "s/g/hm#force": { kind: "slots", slots: { a: { x: 1, y: 2 } } },
  };

  it("reads back what it kept", () => {
    const get = storage();
    persistOrders(ORDERS, get);

    expect(readStoredOrders(get)).toEqual(ORDERS);
  });

  it.each([
    ["nothing kept", {}],
    ["text that is not json", { "ahm.customOrders.v1": "{not json" }],
    ["json that is not an object", { "ahm.customOrders.v1": "[1,2]" }],
    ["json null", { "ahm.customOrders.v1": "null" }],
  ] as const)("finds no orders when there is %s", (_name, initial) => {
    expect(readStoredOrders(storage(initial))).toEqual({});
  });

  it("leaves out what is not an order and keeps what is", () => {
    const get = storage({
      "ahm.customOrders.v1": JSON.stringify({
        good: { kind: "ranks", ranks: [["a"], ["b"]] },
        wrongKind: { kind: "grid", ranks: [] },
        badRow: { kind: "ranks", ranks: [["a"], "b"] },
        badSlot: { kind: "slots", slots: { a: { x: "no", y: 1 }, b: { x: 3, y: 4 } } },
        notAnObject: 7,
      }),
    });

    expect(readStoredOrders(get)).toEqual({
      good: { kind: "ranks", ranks: [["a"], ["b"]] },
      badSlot: { kind: "slots", slots: { b: { x: 3, y: 4 } } },
    });
  });

  it("copes with storage that refuses", () => {
    const blocked = storage({}, true);

    expect(readStoredOrders(blocked)).toEqual({});
    expect(() => persistOrders(ORDERS, blocked)).not.toThrow();
    expect(() => persistSortKey("custom", blocked)).not.toThrow();
    expect(readStoredSortKey(blocked)).toBeNull();
  });

  it("keeps the order key the viewer chose", () => {
    const get = storage();
    persistSortKey("custom", get);

    expect(readStoredSortKey(get)).toBe("custom");
  });
});

describe("ranksFromPositions", () => {
  it.each([
    ["x", "tops level", new Map([["b", { x: 300, y: 0 }], ["a", { x: 0, y: 0 }], ["c", { x: 50, y: 200 }]]), [["a", "b"], ["c"]]],
    ["y", "lefts level", new Map([["b", { x: 0, y: 300 }], ["a", { x: 0, y: 0 }], ["c", { x: 200, y: 50 }]]), [["a", "b"], ["c"]]],
  ] as const)("reads ranks across %s where %s", (axis, _name, positions, expected) => {
    expect(ranksFromPositions(positions, axis)).toEqual(expected);
  });
});

describe("swapping places", () => {
  const SIZES = new Map([["a", { width: 100, height: 100 }], ["b", { width: 100, height: 100 }], ["c", { width: 100, height: 100 }], ["big", { width: 300, height: 300 }]]);
  const ROW = new Map([["a", { x: 0, y: 0 }], ["b", { x: 300, y: 0 }], ["c", { x: 600, y: 0 }]]);

  it("puts each card where the other was", () => {
    expect(swapped(ROW, SIZES, "a", "c")).toEqual(new Map([["a", { x: 600, y: 0 }], ["b", { x: 300, y: 0 }], ["c", { x: 0, y: 0 }]]));
  });

  it("swaps by the middle, so a bigger card stays centred on the place it takes", () => {
    const sizes = new Map([["a", { width: 100, height: 100 }], ["b", { width: 200, height: 100 }]]);
    const next = swapped(new Map([["a", { x: 0, y: 0 }], ["b", { x: 500, y: 0 }]]), sizes, "a", "b");

    expect(next?.get("a")).toEqual({ x: 550, y: 0 });
    expect(next?.get("b")).toEqual({ x: -50, y: 0 });
  });

  it.each([
    ["a card on itself", "a", "a"],
    ["a card that is not there", "a", "ghost"],
  ] as const)("does not swap %s", (_name, first, second) => {
    expect(swapped(ROW, SIZES, first, second)).toBeNull();
  });

  it("does not swap when a card would land on a third", () => {
    const crowded = new Map([["a", { x: 0, y: 0 }], ["big", { x: 200, y: 0 }], ["b", { x: 380, y: 0 }]]);

    expect(swapped(crowded, SIZES, "a", "big")).toBeNull();
  });

  it("lists the cards it can swap with, nearest first", () => {
    expect(swapTargets(ROW, SIZES, "a")).toEqual(["b", "c"]);
    expect(swapTargets(ROW, SIZES, "c")).toEqual(["b", "a"]);
    expect(swapTargets(ROW, SIZES, "ghost")).toEqual([]);
  });
});
