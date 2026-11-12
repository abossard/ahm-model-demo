// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EMPTY_ORDER,
  TOP,
  familyOf,
  forLayout,
  hasOrder,
  impose,
  inOrder,
  kindOf,
  orderKey,
  persistOrders,
  persistSortKey,
  ranksFromPositions,
  ranksInOrder,
  readStoredOrders,
  readStoredSortKey,
  sameRanks,
  swapTargets,
  swapped,
  withChain,
  withPlaces,
  type CustomOrders,
  type ModelOrder,
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

/** An order from text: `r:b a;a:a2 a1` is the children of r as b a, then those of a as a2 a1; `:` alone names the top. */
function order(text: string): ModelOrder {
  return { chains: text.split(";").filter(Boolean).map((chain) => ({ of: chain.split(":")[0] ?? "", names: (chain.split(":")[1] ?? "").split(" ").filter(Boolean) })), places: {} };
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
  ] as const)("%s is of the family %s, which is handed %s", (layout, family, kind) => {
    expect(familyOf(layout)).toBe(family);
    if (family) expect(kindOf(family)).toBe(kind);
  });

  it("covers every layout the picker offers", () => {
    expect(LAYOUT_CHOICES.map((engine) => familyOf(engine.id)).filter((family) => family === null)).toHaveLength(1);
  });

  it("keys an order by the model the address names: one order for every view and layout", () => {
    expect(orderKey({ subscriptionId: "sub", resourceGroup: "rg", name: "hm" })).toBe("sub/rg/hm");
    expect(orderKey(null)).toBeNull();
  });

  it.each([
    ["nothing", null, false],
    ["an empty order", EMPTY_ORDER, false],
    ["a chain", order("r:b a"), true],
    ["places", withPlaces(null, "force", { a: { x: 1, y: 2 } }), true],
  ] as const)("%s is an order to show: %s", (_name, given, expected) => {
    expect(hasOrder(given)).toBe(expected);
  });
});

describe("impose: a chain on things drawn side by side", () => {
  it.each([
    ["the chain's names take the places they hold, in its order", "a b c", "c a", "c b a"],
    ["names the row does not draw are passed over", "a b c", "c x a", "c b a"],
    ["a chain with one name of the row changes nothing", "a b c", "b x", "a b c"],
    ["a chain with none changes nothing", "a b c", "x y", "a b c"],
    ["the others keep their places", "a p b q c", "c b a", "c p b q a"],
    ["a name the chain repeats counts once", "a b", "b a b", "b a"],
  ] as const)("%s", (_name, row, chain, expected) => {
    expect(impose(row.split(" "), chain.split(" "))).toEqual(expected.split(" "));
  });
});

describe("inOrder: every chain, the earliest first", () => {
  it.each([
    ["no order leaves the row", "a b c", null, "a b c"],
    ["one chain", "a b c", order("r:c b a"), "c b a"],
    ["a later chain wins where two disagree", "a b c", order("p:c b a;q:a c"), "a b c"],
    ["chains of other parents do nothing", "a b c", order("p:x y;q:z"), "a b c"],
    ["two chains of different cards both hold", "a b c d", order("p:b a;q:d c"), "b a d c"],
  ] as const)("%s", (_name, row, given, expected) => {
    expect(inOrder(row.split(" "), given)).toEqual(expected.split(" "));
  });
});

describe("ranksInOrder: the order laid over the ranks of a layout", () => {
  it.each([
    ["no order returns the ranks", TREE, TREE_LINKS, null, "r/a b c/a1 a2 s b1 c1 c2"],
    ["a chain of other cards returns the ranks", TREE, TREE_LINKS, order("x:p q"), "r/a b c/a1 a2 s b1 c1 c2"],
    ["siblings stand in the chain's order and take what hangs below them along", TREE, TREE_LINKS, order("r:c a b"), "r/c a b/c1 c2 a1 a2 s b1"],
    ["a chain of leaves moves only them", TREE, TREE_LINKS, order("c:c2 c1"), "r/a b c/a1 a2 s b1 c2 c1"],
    ["a parent moved and its children ordered", TREE, TREE_LINKS, order("r:b a c;a:a2 a1"), "r/b a c/s b1 a2 a1 c1 c2"],
    ["the parts on the shelf follow the chain of the top", SHELF, SHELF_LINKS, order(":m y x"), "m y x/m1 m2 y1 y2"],
    ["a part moved takes its cards along", rows("m x y z/m1 y1 z1"), links("m>m1 y>y1 z>z1"), order(":m z y x"), "m z y x/m1 z1 y1"],
  ] as const)("%s", (_name, ranks, edges, given, expected) => {
    expect(ranksInOrder(ranks, edges, given)).toEqual(rows(expected));
  });

  it("keeps every card exactly once, in its rank", () => {
    for (const given of [order("r:c b a"), order("a:s a2 a1;b:b1 s"), order(":r;r:b c a;c:c2 c1")]) {
      expect(ranksInOrder(TREE, TREE_LINKS, given).map((row) => [...row].sort())).toEqual(TREE.map((row) => [...row].sort()));
    }
  });

  it("leaves children that stand between the children of another parent where they are, when no parent moved", () => {
    const mixed = rows("r/a b/a1 b1 a2");

    expect(ranksInOrder(mixed, links("r>a r>b a>a1 a>a2 b>b1"), order("b:b1"))).toEqual(mixed);
  });
});

describe("forLayout: what a layout of the card graph is handed", () => {
  const PLACED = withPlaces(order("r:c a b"), "force", { a: { x: 1, y: 2 } });

  it.each([
    ["the hierarchy gets its ranks in the order", "hierarchy", PLACED, { kind: "ranks", ranks: rows("r/c a b/c1 c2 a1 a2 s b1") }],
    ["ELK layered gets its ranks in the order", "elk-layered", PLACED, { kind: "ranks", ranks: rows("r/c a b/c1 c2 a1 a2 s b1") }],
    ["the force layout gets its places", "force", PLACED, { kind: "slots", slots: { a: { x: 1, y: 2 } } }],
    ["ELK radial has no places kept", "elk-radial", PLACED, null],
    ["an order that changes nothing is none", "hierarchy", order("r:a b c"), null],
    ["no order is none", "hierarchy", null, null],
  ] as const)("%s", (_name, family, given, expected) => {
    expect(forLayout(family, given, TREE, TREE_LINKS)).toEqual(expected);
  });

  it.each([
    ["the same ranks", "r/a b", "r/a b", true],
    ["another order in a rank", "r/a b", "r/b a", false],
    ["another number of ranks", "r/a b", "r", false],
  ] as const)("sameRanks: %s", (_name, left, right, expected) => {
    expect(sameRanks(rows(left), rows(right))).toBe(expected);
  });
});

describe("withChain: the order a drop leaves", () => {
  it.each([
    ["the first chain of a parent", null, "r", "b a", "r:b a"],
    ["a chain replaces the one its parent had and becomes the latest", order("r:a b c;p:x y"), "r", "c b a", "p:x y;r:c b a"],
    ["children the view did not draw keep their places in the chain", order("r:a b c d"), "r", "d a", "r:d b c a"],
    ["a child the chain did not know stands after the one before it", order("r:a b"), "r", "a n b", "r:a n b"],
    ["a new child that comes first stands first", order("r:a b"), "r", "n a b", "r:n a b"],
    ["the top has a chain of its own", order("r:a b"), TOP, "y x", "r:a b;:y x"],
  ] as const)("%s", (_name, before, of, names, expected) => {
    expect(withChain(before, of, names.split(" "))).toEqual(order(expected));
  });

  it("keeps the places beside the chains", () => {
    const placed = withPlaces(order("r:a b"), "elk-radial", { a: { x: 1, y: 2 } });

    expect(withChain(placed, "r", ["b", "a"]).places).toEqual({ "elk-radial": { a: { x: 1, y: 2 } } });
    expect(withPlaces(placed, "force", { b: { x: 3, y: 4 } })).toEqual({ chains: [{ of: "r", names: ["a", "b"] }], places: { "elk-radial": { a: { x: 1, y: 2 } }, force: { b: { x: 3, y: 4 } } } });
  });
});

describe("keeping orders in storage", () => {
  const ORDERS: CustomOrders = {
    "s/g/hm": { chains: [{ of: "r", names: ["b", "a"] }], places: { force: { a: { x: 1, y: 2 } } } },
    "s/g/other": { chains: [{ of: "", names: ["y", "x"] }], places: {} },
  };

  it("reads back what it kept", () => {
    const get = storage();
    persistOrders(ORDERS, get);

    expect(readStoredOrders(get)).toEqual(ORDERS);
  });

  it.each([
    ["nothing kept", {}],
    ["text that is not json", { "ahm.customOrders.v2": "{not json" }],
    ["json that is not an object", { "ahm.customOrders.v2": "[1,2]" }],
    ["json null", { "ahm.customOrders.v2": "null" }],
    ["text kept per family that is not json", { "ahm.customOrders.v1": "{not json" }],
  ] as const)("finds no orders when there is %s", (_name, initial) => {
    expect(Object.keys(readStoredOrders(storage(initial)))).toEqual([]);
  });

  it("leaves out what is not an order and keeps what is", () => {
    const get = storage({
      "ahm.customOrders.v2": JSON.stringify({
        good: { chains: [{ of: "r", names: ["a", "b"] }], places: {} },
        noChains: { places: {} },
        badChain: { chains: [{ of: 3, names: ["a"] }, { of: "r", names: ["a", 7, "b"] }, "x"], places: { force: { a: { x: "no", y: 1 }, b: { x: 3, y: 4 } }, grid: { a: { x: 1, y: 1 } } } },
        notAnObject: 7,
      }),
    });

    expect(readStoredOrders(get)).toEqual({
      good: { chains: [{ of: "r", names: ["a", "b"] }], places: {} },
      badChain: { chains: [{ of: "r", names: ["a", "b"] }], places: { force: { b: { x: 3, y: 4 } } } },
    });
  });

  it.each([
    [
      "the ranks of a hierarchy are chains: their cards stood side by side",
      { "s/g/hm#hierarchy": { kind: "ranks", ranks: rows("r/b a/a2 a1") } },
      { "s/g/hm": { chains: [{ of: "#hierarchy:1", names: ["b", "a"] }, { of: "#hierarchy:2", names: ["a2", "a1"] }], places: {} } },
    ],
    [
      "the hierarchy's come after ELK layered's, so they win",
      { "s/g/hm#hierarchy": { kind: "ranks", ranks: rows("r/b a") }, "s/g/hm#elk-layered": { kind: "ranks", ranks: rows("r/a b") } },
      { "s/g/hm": { chains: [{ of: "#elk-layered:1", names: ["a", "b"] }, { of: "#hierarchy:1", names: ["b", "a"] }], places: {} } },
    ],
    [
      "places stay places, per layout, beside the chains of the same model",
      { "s/g/hm#force": { kind: "slots", slots: { a: { x: 1, y: 2 } } }, "s/g/hm#elk-radial": { kind: "slots", slots: { b: { x: 3, y: 4 } } }, "s/g/hm#hierarchy": { kind: "ranks", ranks: rows("b a") } },
      { "s/g/hm": { chains: [{ of: "#hierarchy:0", names: ["b", "a"] }], places: { "elk-radial": { b: { x: 3, y: 4 } }, force: { a: { x: 1, y: 2 } } } } },
    ],
    ["what is not an order per family is left out", { "s/g/hm#hierarchy": { kind: "grid" }, "s/g/hm#tree": { kind: "ranks", ranks: [] }, plain: 7 }, {}],
  ] as const)("reads orders kept per family of layouts as one per model: %s", (_name, kept, expected) => {
    expect(readStoredOrders(storage({ "ahm.customOrders.v1": JSON.stringify(kept) }))).toEqual(expected);
  });

  it("an order per model, once kept, is what counts: the ones per family are not read again", () => {
    const get = storage({ "ahm.customOrders.v1": JSON.stringify({ "s/g/hm#hierarchy": { kind: "ranks", ranks: rows("r/b a") } }) });
    persistOrders({}, get);

    expect(readStoredOrders(get)).toEqual({});
  });

  it("an order read from the ones per family draws as it did: the migrated chains order the ranks", () => {
    const read = readStoredOrders(storage({ "ahm.customOrders.v1": JSON.stringify({ "s/g/hm#hierarchy": { kind: "ranks", ranks: rows("r/c a b/c1 c2 a1 a2 s b1") } }) }));

    expect(ranksInOrder(TREE, TREE_LINKS, read["s/g/hm"])).toEqual(rows("r/c a b/c1 c2 a1 a2 s b1"));
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
