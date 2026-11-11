// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  arrange,
  compareScores,
  scoreArrangement,
  type ArrangeDirection,
  type ArrangeEdge,
  type ArrangeNode,
  type ArrangementScore,
} from "./arrange";
import { LAYOUT_ENGINES, type Point } from "./layout";
import { orderEntities, orderWithinRanks } from "./ordering";
import { estimateNodeSize } from "../components/EntityNode";
import type { Entity, Relationship } from "./types";
import { healthModel, paymentsHealthModel, wideHealthModel } from "../../tests/fixture";
import { DENSE_SEED, denseModel, realAnbomovModel } from "../../tests/denseModel";
import live from "../../tests/liveModel.json";

const DIRECTIONS: readonly ArrangeDirection[] = ["tb", "bt", "lr", "rl"];
const CARD = { width: 260, height: 100 };

function nodesOf(names: string, size = CARD): ArrangeNode[] {
  return names.split(" ").map((name) => ({ name, ...size }));
}

function edgesOf(pairs: string): ArrangeEdge[] {
  return pairs
    .split(" ")
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const [parentEntityName = "", childEntityName = ""] = pair.split(">");
      return { parentEntityName, childEntityName };
    });
}

function centre(positions: ReadonlyMap<string, Point>, nodes: readonly ArrangeNode[], name: string): number {
  const point = positions.get(name) as Point;
  const node = nodes.find((item) => item.name === name) as ArrangeNode;
  return point.x + node.width / 2;
}

function overlapping(nodes: readonly ArrangeNode[], positions: ReadonlyMap<string, Point>): string[] {
  const found: string[] = [];
  nodes.forEach((one, index) => {
    for (const other of nodes.slice(index + 1)) {
      const a = positions.get(one.name) as Point;
      const b = positions.get(other.name) as Point;
      if (a.x < b.x + other.width && b.x < a.x + one.width && a.y < b.y + other.height && b.y < a.y + one.height) {
        found.push(`${one.name}/${other.name}`);
      }
    }
  });
  return found;
}

function entityOf(name: string, displayName: string, signals: number): Entity {
  return {
    name,
    displayName,
    healthState: "Healthy",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: Array.from({ length: signals }, (_unused, row) => ({
      name: `${name}-${row}`,
      displayName: `Signal ${row}`,
      kind: "metric" as const,
      healthState: "Healthy" as const,
      value: row,
      reportedAt: null,
      writable: false,
    })),
    report: { eligible: true, signalName: null },
  };
}

interface Model {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

function liveModel(): Model {
  return {
    entities: live.entities.map((item) => entityOf(item.name, item.displayName, item.signals)),
    relationships: live.relationships.map((item, index) => ({ name: `live-${index}`, ...item })),
  };
}

function nodesFor(model: Model): ArrangeNode[] {
  return model.entities.map((item) => ({ name: item.name, ...estimateNodeSize(item) }));
}

/** What the graph shows today: dagre, then every rank forced into name order. */
async function currentLayout(model: Model): Promise<ReadonlyMap<string, Point>> {
  const sizes = new Map(model.entities.map((item) => [item.name, estimateNodeSize(item)] as const));
  const layout = await LAYOUT_ENGINES["dagre-tb"].run(
    model.entities,
    model.relationships,
    (item) => sizes.get(item.name) ?? { width: 0, height: 0 },
  );
  const order = orderEntities(model.entities, "name", false).map((item) => item.name);
  return orderWithinRanks(layout, order, "x", sizes).positions;
}

const FIXTURES: readonly (readonly [string, () => Model])[] = [
  ["fixture model", () => healthModel],
  ["wide fan", () => wideHealthModel],
  ["payments", () => paymentsHealthModel],
  ["dense, the seed the specs use", () => denseModel(DENSE_SEED)],
  ["real anbomov model", () => realAnbomovModel()],
  ["live model", liveModel],
  ["dense 1, 30 entities", () => denseModel(1, 30, 45)],
  ["dense 2, 30 entities", () => denseModel(2, 30, 45)],
  ["dense 3, 80 entities", () => denseModel(3, 80, 110)],
  ["dense 4, 80 entities", () => denseModel(4, 80, 110)],
  ["dense 8, 300 entities", () => denseModel(8, 300, 400)],
];

describe("arrange: small graphs", () => {
  it.each([
    ["a chain", "a b c", "a>b b>c", [["a"], ["b"], ["c"]]],
    ["a tree", "r a b c d", "r>a r>b a>c a>d", [["r"], ["a", "b"], ["c", "d"]]],
    ["a diamond", "a b c d", "a>b a>c b>d c>d", [["a"], ["b", "c"], ["d"]]],
    ["a card with several parents", "p q c", "p>c q>c", [["p", "q"], ["c"]]],
    ["an edge that skips ranks", "r a b c", "r>a a>b b>c r>c", [["r"], ["a"], ["b"], ["c"]]],
    ["two parts, largest first", "x y a b c", "x>y a>b a>c", [["a", "x"], ["b", "c", "y"]]],
    ["isolated entities", "a b c", "", [["a", "b", "c"]]],
    ["an entity without edges next to a pair", "a b z", "a>b", [["a", "z"], ["b"]]],
  ] as const)("ranks %s by longest path with children below every parent", (_name, names, pairs, expected) => {
    const nodes = nodesOf(names);
    const result = arrange(nodes, edgesOf(pairs), "tb");

    expect(result.ranks).toEqual(expected);
    for (const edge of edgesOf(pairs)) {
      const parent = result.positions.get(edge.parentEntityName) as Point;
      const child = result.positions.get(edge.childEntityName) as Point;
      expect(child.y, `${edge.parentEntityName} above ${edge.childEntityName}`).toBeGreaterThan(parent.y);
    }
    expect(overlapping(nodes, result.positions)).toEqual([]);
  });

  it.each([
    ["a single child sits straight under its parent", "a b", "a>b", "a", ["b"]],
    ["a parent sits over its two children", "r a b", "r>a r>b", "r", ["a", "b"]],
    ["a parent sits over its first and last of three children", "r a b c", "r>a r>b r>c", "r", ["a", "c"]],
    ["a card with two parents sits between them", "p q c", "p>c q>c", "c", ["p", "q"]],
  ] as const)("%s", (_name, names, pairs, subject, anchors) => {
    const nodes = nodesOf(names);
    const { positions } = arrange(nodes, edgesOf(pairs), "tb");
    const middle = (centre(positions, nodes, anchors[0]) + centre(positions, nodes, anchors[anchors.length - 1] ?? anchors[0])) / 2;

    expect(centre(positions, nodes, subject)).toBeCloseTo(middle, 6);
  });

  it("keeps an edge that skips ranks clear of the cards it passes", () => {
    const nodes = nodesOf("r a b c");
    const edges = edgesOf("r>a a>b b>c r>c");
    const { positions } = arrange(nodes, edges, "tb");

    expect(scoreArrangement(nodes, edges, positions, "tb").throughCards).toBe(0);
  });

  it("shelves unconnected entities instead of stretching the first rank", () => {
    const names = Array.from({ length: 12 }, (_unused, index) => `solo${index}`).join(" ");
    const nodes = nodesOf(`r a b c ${names}`);
    const result = arrange(nodes, edgesOf("r>a r>b r>c"), "tb");
    const tree = ["r", "a", "b", "c"].map((name) => result.positions.get(name) as Point);
    const treeRight = Math.max(...tree.map((point) => point.x)) + CARD.width;
    const treeBottom = Math.max(...tree.map((point) => point.y)) + CARD.height;

    expect(overlapping(nodes, result.positions)).toEqual([]);
    for (const name of names.split(" ")) {
      const point = result.positions.get(name) as Point;
      expect(point.x >= treeRight || point.y >= treeBottom, `${name} is on a shelf`).toBe(true);
    }
    expect(result.width / result.height).toBeLessThan(4);
  });

  it.each([
    ["a cycle", "a b c", "a>b b>c c>a"],
    ["a cycle behind a root", "r a b", "r>a a>b b>a"],
    ["a self loop", "a b", "a>a a>b"],
    ["an edge to an unknown entity", "a b", "a>b a>ghost ghost>b"],
    ["a repeated edge", "a b", "a>b a>b"],
    ["the same edge both ways", "a b", "a>b b>a"],
  ] as const)("draws dirty data: %s", (_name, names, pairs) => {
    const nodes = nodesOf(names);
    const result = arrange(nodes, edgesOf(pairs), "tb");

    expect([...result.positions.keys()].sort()).toEqual(names.split(" ").sort());
    for (const point of result.positions.values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
    expect(overlapping(nodes, result.positions)).toEqual([]);
    expect(Number.isFinite(result.width) && Number.isFinite(result.height)).toBe(true);
  });

  it.each([
    ["no entities", [], ""],
    ["a zero size", [{ name: "a", width: 0, height: 0 }, ...nodesOf("b")], "a>b"],
    ["a size that is not a number", [{ name: "a", width: Number.NaN, height: -4 }, ...nodesOf("b")], "a>b"],
    ["the same entity twice", [...nodesOf("a b"), ...nodesOf("a")], "a>b"],
  ] as const)("accepts %s", (_name, nodes, pairs) => {
    const result = arrange(nodes, edgesOf(pairs), "tb");

    expect(result.positions.size).toBe(new Set(nodes.map((item) => item.name)).size);
    expect(Number.isFinite(result.width) && Number.isFinite(result.height)).toBe(true);
  });
});

describe("arrange: directions", () => {
  const names = "root a b c d e f g";
  const pairs = "root>a root>b a>c a>d b>e b>f root>g c>g";
  const nodes = nodesOf(names, { width: 260, height: 100 });
  const edges = edgesOf(pairs);

  it.each(DIRECTIONS)("%s puts every parent before its children along the rank axis, without overlap", (direction) => {
    const { positions } = arrange(nodes, edges, direction);
    const before: Record<ArrangeDirection, (parent: Point, child: Point) => boolean> = {
      tb: (parent, child) => child.y > parent.y,
      bt: (parent, child) => child.y < parent.y,
      lr: (parent, child) => child.x > parent.x,
      rl: (parent, child) => child.x < parent.x,
    };

    for (const edge of edges) {
      expect(
        before[direction](positions.get(edge.parentEntityName) as Point, positions.get(edge.childEntityName) as Point),
        `${edge.parentEntityName} to ${edge.childEntityName}`,
      ).toBe(true);
    }
    expect(overlapping(nodes, positions)).toEqual([]);
  });

  it.each(DIRECTIONS)("%s keeps the order of the ranks that top-down gives", (direction) => {
    const square = nodesOf(names, { width: 200, height: 200 });

    expect(arrange(square, edges, direction).ranks).toEqual(arrange(square, edges, "tb").ranks);
  });

  it.each(DIRECTIONS)("%s mirrors the placement of top-down for same sized cards", (direction) => {
    const square = nodesOf(names, { width: 200, height: 200 });
    const reference = arrange(square, edges, "tb");
    const turned = arrange(square, edges, direction);
    const across = (point: Point): number => (direction === "tb" || direction === "bt" ? point.x : point.y);

    for (const { name } of square) {
      expect(across(turned.positions.get(name) as Point)).toBeCloseTo((reference.positions.get(name) as Point).x, 6);
    }
  });

  it.each(DIRECTIONS)("%s places cards of different sizes without overlap, dots and collapsed cards included", (direction) => {
    const mixed: ArrangeNode[] = [
      { name: "root", width: 260, height: 180 },
      { name: "a", width: 260, height: 54 },
      { name: "b", width: 12, height: 12 },
      { name: "c", width: 260, height: 246 },
      { name: "d", width: 12, height: 12 },
      { name: "e", width: 260, height: 82 },
      { name: "f", width: 260, height: 54 },
      { name: "g", width: 12, height: 12 },
    ];
    const { positions } = arrange(mixed, edges, direction);

    expect(overlapping(mixed, positions)).toEqual([]);
  });
});

describe("arrange: generated graphs", () => {
  const models = [1, 2, 3, 4, 5, 6].flatMap((seed) =>
    ([[12, 18], [30, 45], [80, 110]] as const).map(([count, links]) => [`seed ${seed}, ${count} entities`, denseModel(seed, count, links)] as const),
  );

  it.each(models)("%s: no overlap, children below parents", (_name, model) => {
    const nodes = nodesFor(model);
    const { positions } = arrange(nodes, model.relationships, "tb");

    expect(overlapping(nodes, positions)).toEqual([]);
    for (const edge of model.relationships) {
      const parent = positions.get(edge.parentEntityName) as Point;
      const child = positions.get(edge.childEntityName) as Point;
      expect(child.y).toBeGreaterThan(parent.y);
    }
  });

  it.each(models)("%s: the same picture whatever the order of the input", (_name, model) => {
    const nodes = nodesFor(model);
    const expected = arrange(nodes, model.relationships, "tb");
    const inputs = [
      [[...nodes].reverse(), [...model.relationships].reverse()],
      [nodes.slice(5).concat(nodes.slice(0, 5)), model.relationships.slice(7).concat(model.relationships.slice(0, 7))],
      [nodes.filter((_item, index) => index % 2 === 0).concat(nodes.filter((_item, index) => index % 2 === 1)), model.relationships],
    ] as const;

    for (const [shuffledNodes, shuffledEdges] of inputs) {
      const result = arrange(shuffledNodes, shuffledEdges, "tb");
      expect(result.ranks).toEqual(expected.ranks);
      for (const [name, point] of expected.positions) expect(result.positions.get(name)).toEqual(point);
    }
  });

  it.each([12, 30, 80, 150].map((count) => [`${count} entities`, count] as const))(
    "a tree of %s is tidy: parents over their children, single children straight below",
    (_name, count) => {
      for (const seed of [1, 2, 3, 4]) {
        const model = denseModel(seed, count, count - 1);
        const nodes = nodesFor(model);
        const { positions } = arrange(nodes, model.relationships, "tb");
        const children = new Map<string, string[]>();
        for (const edge of model.relationships) {
          children.set(edge.parentEntityName, [...(children.get(edge.parentEntityName) ?? []), edge.childEntityName]);
        }

        expect(overlapping(nodes, positions)).toEqual([]);
        for (const [parent, kids] of children) {
          const xs = kids.map((kid) => centre(positions, nodes, kid));
          expect(centre(positions, nodes, parent), `${parent} in seed ${seed}`).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 0);
        }
      }
    },
  );

  const treeLike = [1, 2, 3, 4, 5, 6].flatMap((seed) =>
    ([20, 50, 100] as const).map((count) => [`seed ${seed}, ${count} entities`, denseModel(seed, count, Math.round(count * 1.1))] as const),
  );

  it.each(treeLike)("%s: one more leaf leaves the order of everything else as it was", (_name, model) => {
    const nodes = nodesFor(model);
    const leaf = "zz-new-leaf";
    const parent = (model.relationships[model.relationships.length >> 1] as Relationship).childEntityName;
    const before = arrange(nodes, model.relationships, "tb").ranks;
    const after = arrange(
      [...nodes, { name: leaf, ...CARD }],
      [...model.relationships, { name: "new", displayName: null, parentEntityName: parent, childEntityName: leaf }],
      "tb",
    ).ranks;

    // pairs of old entities in one rank whose relative order flipped
    let flipped = 0;
    before.forEach((row, rank) => {
      const later = new Map((after[rank] ?? []).map((name, index) => [name, index] as const));
      row.forEach((one, index) => {
        for (const other of row.slice(index + 1)) {
          if ((later.get(one) ?? 0) > (later.get(other) ?? 0)) flipped += 1;
        }
      });
    });
    const pairs = before.reduce((sum, row) => sum + (row.length * (row.length - 1)) / 2, 0);

    expect(flipped / Math.max(1, pairs)).toBeLessThanOrEqual(0.1);
  });
});

describe("arrange: a fixed order", () => {
  const TREE = "r a b c d e";
  const TREE_EDGES = "r>a r>b r>c a>d a>e";

  it.each([
    ["the order it gave itself", [["r"], ["a", "b", "c"], ["d", "e"]], [["r"], ["a", "b", "c"], ["d", "e"]]],
    ["a rank turned round", [["r"], ["c", "b", "a"], ["d", "e"]], [["r"], ["c", "b", "a"], ["d", "e"]]],
    ["two ranks changed", [["r"], ["b", "c", "a"], ["e", "d"]], [["r"], ["b", "c", "a"], ["e", "d"]]],
    ["a rank the order says nothing about", [["r"], ["b", "a", "c"]], [["r"], ["b", "a", "c"], ["d", "e"]]],
    ["names that are not drawn", [["r"], ["c", "ghost", "a", "b"], ["x", "e", "d"]], [["r"], ["c", "a", "b"], ["e", "d"]]],
    ["an entity listed in a rank it is not in", [["r", "d"], ["c", "a", "b"]], [["r"], ["c", "a", "b"], ["d", "e"]]],
  ] as const)("keeps %s", (_name, order, expected) => {
    const result = arrange(nodesOf(TREE), edgesOf(TREE_EDGES), "tb", { order });

    expect(result.ranks).toEqual(expected);
  });

  it("puts the cards where their rank says, left to right, with parents still over their children", () => {
    const nodes = nodesOf(TREE);
    const { positions } = arrange(nodes, edgesOf(TREE_EDGES), "tb", { order: [["r"], ["c", "b", "a"], ["e", "d"]] });

    expect(centre(positions, nodes, "c")).toBeLessThan(centre(positions, nodes, "b"));
    expect(centre(positions, nodes, "b")).toBeLessThan(centre(positions, nodes, "a"));
    expect(centre(positions, nodes, "e")).toBeLessThan(centre(positions, nodes, "d"));
    expect(centre(positions, nodes, "a")).toBeCloseTo((centre(positions, nodes, "e") + centre(positions, nodes, "d")) / 2, 0);
  });

  it.each([
    ["a new sibling", "r a b c d e n", "r>a r>b r>c a>d a>e r>n"],
    ["a new child of a card", "r a b c d e n", "r>a r>b r>c a>d a>e a>n"],
    ["a new card with two parents", "r a b c d e n", "r>a r>b r>c a>d a>e b>n c>n"],
    ["a new part on its own", "r a b c d e n", "r>a r>b r>c a>d a>e"],
  ] as const)("keeps the order of the cards it knows when there is %s", (_name, names, pairs) => {
    const order = [["r"], ["c", "b", "a"], ["e", "d"]];
    const result = arrange(nodesOf(names), edgesOf(pairs), "tb", { order });
    const rank = (at: number): readonly string[] => result.ranks[at] ?? [];
    const known = (at: number): string[] => rank(at).filter((name) => (order[at] ?? []).includes(name));

    expect(known(1)).toEqual(["c", "b", "a"]);
    expect(known(2)).toEqual(["e", "d"]);
    expect(result.ranks.flat()).toContain("n");
  });

  it("puts a new card among the fixed ones where the automatic order has it", () => {
    const names = "r a b c n";
    const pairs = "r>a r>b r>c r>n";
    const automatic = arrange(nodesOf(names), edgesOf(pairs), "tb").ranks[1] as readonly string[];
    const result = arrange(nodesOf(names), edgesOf(pairs), "tb", { order: [["r"], ["c", "b", "a"]] }).ranks[1] as readonly string[];

    expect(result.indexOf("n")).toBe(automatic.indexOf("n"));
    expect(result.filter((name) => name !== "n")).toEqual(["c", "b", "a"]);
  });

  it.each([
    ["a part moves ahead of another", "m a1 a2 b1 b2 c1", "m>a1 m>a2 b1>b2 c1", [["m", "c1", "b1"], ["a1", "a2", "b2"]], ["m", "c1", "b1"]],
    ["the main part stays first", "m a1 a2 b1 b2 c1", "m>a1 m>a2 b1>b2 c1", [["c1", "b1", "m"]], ["m", "c1", "b1"]],
  ] as const)("shelves the parts of the order in order: %s", (_name, names, pairs, order, expected) => {
    const result = arrange(nodesOf(names), edgesOf(pairs), "tb", { order });

    expect(result.ranks[0]).toEqual(expected);
  });

  it.each(DIRECTIONS)("%s reads the same order, left to right or top to bottom", (direction) => {
    const square = nodesOf(TREE, { width: 200, height: 200 });
    const order = [["r"], ["c", "a", "b"], ["e", "d"]];

    expect(arrange(square, edgesOf(TREE_EDGES), direction, { order }).ranks).toEqual(order);
  });

  it("keeps the ranks it gave itself when it is handed them, and gives the same picture twice", () => {
    for (const seed of [1, 2, 3, 4]) {
      const model = denseModel(seed, 30, 40);
      const nodes = nodesFor(model);
      const first = arrange(nodes, model.relationships, "tb");
      const again = arrange(nodes, model.relationships, "tb", { order: first.ranks });
      const twice = arrange(nodes, model.relationships, "tb", { order: first.ranks });

      expect(again.ranks, `seed ${seed}`).toEqual(first.ranks);
      for (const [name, point] of again.positions) expect(twice.positions.get(name), name).toEqual(point);
    }
  });

  it("is the same picture whatever the order of the input", () => {
    const model = denseModel(2, 30, 40);
    const nodes = nodesFor(model);
    const order = arrange(nodes, model.relationships, "tb").ranks.map((row) => [...row].reverse());
    const expected = arrange(nodes, model.relationships, "tb", { order });
    const shuffled = arrange([...nodes].reverse(), [...model.relationships].reverse(), "tb", { order });

    expect(shuffled.ranks).toEqual(expected.ranks);
    for (const [name, point] of expected.positions) expect(shuffled.positions.get(name)).toEqual(point);
  });

  it.each([1, 2, 3, 4, 5, 6].map((seed) => [`seed ${seed}`, seed] as const))("%s: a turned order is kept, whatever crosses", (_name, seed) => {
    const model = denseModel(seed, 40, 60);
    const nodes = nodesFor(model);
    const order = arrange(nodes, model.relationships, "tb").ranks.map((row) => [...row].reverse());
    const result = arrange(nodes, model.relationships, "tb", { order });

    // every rank of the result has the entities it shares with the order in the order's order
    result.ranks.forEach((row, at) => {
      const given = order[at] ?? [];
      expect(row.filter((name) => given.includes(name)), `rank ${at}`).toEqual(given.filter((name) => row.includes(name)));
    });
    expect(overlapping(nodes, result.positions)).toEqual([]);
  });
});

describe("arrange: the models the graph draws", () => {
  it.each(FIXTURES)("%s: scores better than today's layout", async (_name, build) => {
    const model = build();
    const nodes = nodesFor(model);
    const before = scoreArrangement(nodes, model.relationships, await currentLayout(model), "tb");
    const after = scoreArrangement(nodes, model.relationships, arrange(nodes, model.relationships, "tb").positions, "tb");

    expect(compareScores(after, before)).toBeLessThanOrEqual(0);
    // a longer or more crossed drawing is only accepted for the sake of fewer edges through cards
    if (after.throughCards >= before.throughCards) {
      expect(after.crossings).toBeLessThanOrEqual(before.crossings);
      expect(after.length).toBeLessThanOrEqual(before.length * 1.05);
    }
  });

  it.each(FIXTURES.filter(([name]) => !name.startsWith("dense")))("%s: no more crossings or edges through cards, and no longer routes", async (_name, build) => {
    const model = build();
    const nodes = nodesFor(model);
    const before = scoreArrangement(nodes, model.relationships, await currentLayout(model), "tb");
    const after = scoreArrangement(nodes, model.relationships, arrange(nodes, model.relationships, "tb").positions, "tb");

    expect(after.crossings).toBeLessThanOrEqual(before.crossings);
    expect(after.throughCards).toBeLessThanOrEqual(before.throughCards);
    expect(after.length).toBeLessThanOrEqual(before.length * 1.05);
  });

  it("has fewer crossings, fewer edges through cards and shorter routes over the whole set", async () => {
    const before = { crossings: 0, throughCards: 0, length: 0 };
    const after = { crossings: 0, throughCards: 0, length: 0 };
    for (const [, build] of FIXTURES) {
      const model = build();
      const nodes = nodesFor(model);
      const then = scoreArrangement(nodes, model.relationships, await currentLayout(model), "tb");
      const now = scoreArrangement(nodes, model.relationships, arrange(nodes, model.relationships, "tb").positions, "tb");
      for (const [sum, score] of [[before, then], [after, now]] as const) {
        sum.crossings += score.crossings;
        sum.throughCards += score.throughCards;
        sum.length += score.length;
      }
    }

    expect(after.crossings).toBeLessThan(before.crossings);
    expect(after.throughCards).toBeLessThan(before.throughCards);
    expect(after.length).toBeLessThan(before.length);
  });

  it.each(FIXTURES)("%s: no overlap in any direction", (_name, build) => {
    const model = build();
    const nodes = nodesFor(model);

    for (const direction of DIRECTIONS) {
      expect(overlapping(nodes, arrange(nodes, model.relationships, direction).positions), direction).toEqual([]);
    }
  });

  it("puts the discovered chain of the live model beside the main tree", () => {
    const model = liveModel();
    const nodes = nodesFor(model);
    const { positions } = arrange(nodes, model.relationships, "tb");
    const root = positions.get("hm-contosodemo") as Point;
    const discovered = positions.get("discover-app-insights") as Point;

    expect(discovered.y).toBeLessThanOrEqual(root.y + 1);
    expect(discovered.x).toBeGreaterThan(root.x + CARD.width);
  });

  // About 15 ms on an idle machine; the bound only catches a change in complexity, not a busy machine.
  it("arranges 300 entities and 400 relationships without a complexity blow-up", () => {
    const model = denseModel(8, 300, 400);
    const nodes = nodesFor(model);
    arrange(nodes, model.relationships, "tb");

    const times = Array.from({ length: 7 }, () => {
      const start = performance.now();
      arrange(nodes, model.relationships, "tb");
      return performance.now() - start;
    }).sort((a, b) => a - b);

    expect(times[3] as number).toBeLessThan(2000);
  });
});

describe("scoreArrangement", () => {
  const at = (...points: readonly (readonly [string, number, number])[]): ReadonlyMap<string, Point> =>
    new Map(points.map(([name, x, y]) => [name, { x, y }] as const));
  const SQUARE = { width: 100, height: 100 };

  it.each([
    ["a straight edge", "a b", "a>b", at(["a", 0, 0], ["b", 0, 200]), { throughCards: 0, crossings: 0, length: 100, offCentre: 0 }],
    ["an edge sideways", "a b", "a>b", at(["a", 0, 0], ["b", 300, 200]), { throughCards: 0, crossings: 0, length: 400, offCentre: 300 }],
    ["an edge through a card", "a b c", "a>c", at(["a", 0, 0], ["b", 0, 200], ["c", 0, 400]), { throughCards: 1, crossings: 0, length: 300, offCentre: 0 }],
    ["an edge beside a card", "a b c", "a>c", at(["a", 0, 0], ["b", 300, 200], ["c", 0, 400]), { throughCards: 0, crossings: 0, length: 300, offCentre: 0 }],
    ["a run through a card", "a b c", "a>c", at(["a", 0, 0], ["b", 200, 200], ["c", 400, 400]), { throughCards: 1, crossings: 0, length: 700, offCentre: 400 }],
    ["two edges that swap places", "a b c d", "a>d b>c", at(["a", 0, 0], ["b", 200, 0], ["c", 0, 300], ["d", 200, 300]), { throughCards: 0, crossings: 1, length: 800, offCentre: 400 }],
    ["two edges side by side", "a b c d", "a>c b>d", at(["a", 0, 0], ["b", 200, 0], ["c", 0, 300], ["d", 200, 300]), { throughCards: 0, crossings: 0, length: 400, offCentre: 0 }],
    ["two edges from one parent", "a b c", "a>b a>c", at(["a", 150, 0], ["b", 0, 300], ["c", 300, 300]), { throughCards: 0, crossings: 0, length: 700, offCentre: 0 }],
    ["two edges whose runs overlap", "a b c d", "a>c b>d", at(["a", 0, 0], ["b", 100, 0], ["c", 200, 300], ["d", 300, 300]), { throughCards: 0, crossings: 1, length: 800, offCentre: 400 }],
  ] as const)("counts %s", (_name, names, pairs, positions, expected) => {
    const score = scoreArrangement(nodesOf(names, SQUARE), edgesOf(pairs), positions, "tb");

    expect(score).toMatchObject(expected);
  });

  it.each([
    ["tb", at(["a", 0, 0], ["b", 0, 200]), 100],
    ["bt", at(["a", 0, 200], ["b", 0, 0]), 100],
    ["lr", at(["a", 0, 0], ["b", 200, 0]), 100],
    ["rl", at(["a", 200, 0], ["b", 0, 0]), 100],
  ] as const)("reads %s from parent to child", (direction, positions, length) => {
    const score = scoreArrangement(nodesOf("a b", SQUARE), edgesOf("a>b"), positions, direction);

    expect(score).toMatchObject({ throughCards: 0, crossings: 0, length, offCentre: 0 });
  });

  it.each([
    ["two labels at one point", "tb", at(["a", 0, 0], ["b", 200, 0], ["c", 0, 300], ["d", 200, 300]), "a>d b>c", 1],
    ["labels far apart", "tb", at(["a", 0, 0], ["b", 200, 0], ["c", 0, 300], ["d", 200, 300]), "a>c b>d", 0],
    ["labels on top of each other, left to right", "lr", at(["a", 0, 0], ["b", 0, 200], ["c", 300, 0], ["d", 300, 200]), "a>d b>c", 1],
    ["labels one under the other", "tb", at(["a", 0, 0], ["b", 0, 300], ["c", 0, 600]), "a>b b>c", 0],
  ] as const)("counts labels in %s", (_name, direction, positions, pairs, clashes) => {
    const edges = edgesOf(pairs).map((edge) => ({ ...edge, displayName: "runs on" }));
    const score = scoreArrangement(nodesOf("a b c d", SQUARE), edges, positions, direction);

    expect(score.labelClashes).toBe(clashes);
  });

  it("counts no label clash for relationships without a label", () => {
    const edges = edgesOf("a>d b>c");

    expect(
      scoreArrangement(nodesOf("a b c d", SQUARE), edges, at(["a", 0, 0], ["b", 200, 0], ["c", 0, 300], ["d", 200, 300]), "tb").labelClashes,
    ).toBe(0);
  });

  it("measures the width across the ranks", () => {
    const nodes = nodesOf("a b", SQUARE);
    const edges = edgesOf("a>b");

    expect(scoreArrangement(nodes, edges, at(["a", 0, 0], ["b", 300, 200]), "tb").width).toBe(400);
    expect(scoreArrangement(nodes, edges, at(["a", 0, 0], ["b", 200, 300]), "lr").width).toBe(400);
  });

  it("ignores edges to entities that are not drawn", () => {
    const score = scoreArrangement(nodesOf("a b", SQUARE), edgesOf("a>b a>ghost a>a a>b"), at(["a", 0, 0], ["b", 0, 200]), "tb");

    expect(score).toMatchObject({ crossings: 0, length: 100 });
  });
});

describe("compareScores", () => {
  const base: ArrangementScore = { throughCards: 0, crossings: 0, length: 1000, width: 500, offCentre: 0, labelClashes: 0 };

  it.each([
    ["an edge through a card costs more than a crossing", { ...base, crossings: 1 }, { ...base, throughCards: 1 }],
    ["a crossing costs more than a few hundred px of route", { ...base, length: 1400 }, { ...base, crossings: 1 }],
    ["a crossing costs less than a lot of route", { ...base, crossings: 1 }, { ...base, length: 4000 }],
    ["shorter routes win", { ...base, length: 900 }, base],
    ["narrower wins", { ...base, width: 400 }, base],
    ["a parent over its children wins", base, { ...base, offCentre: 100 }],
    ["labels on top of each other cost more than a crossing", { ...base, crossings: 1 }, { ...base, labelClashes: 1 }],
    ["labels on top of each other cost less than an edge through a card", { ...base, labelClashes: 1 }, { ...base, throughCards: 1 }],
    ["an edge through a card costs more than a thousand px of route", { ...base, length: 2000 }, { ...base, throughCards: 1 }],
  ] as const)("%s", (_name, better, worse) => {
    expect(compareScores(better, worse)).toBeLessThan(0);
    expect(compareScores(worse, better)).toBeGreaterThan(0);
  });

  it("calls scores within a pixel equal, so the first candidate wins", () => {
    expect(compareScores(base, { ...base, length: 1000.4 })).toBe(0);
  });
});
