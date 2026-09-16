import { describe, it, expect } from "vitest";
import {
  LAYOUT_CHOICES,
  LAYOUT_ENGINES,
  anchorLayout,
  layoutGraph,
  type GraphLayout,
  type NodeSize,
  type Point,
} from "./layout";
import type { Entity, Relationship } from "./types";

function entity(name: string): Entity {
  return {
    name,
    displayName: name,
    healthState: "Healthy",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
  };
}

function rel(parent: string, child: string): Relationship {
  return { name: `${parent}->${child}`, displayName: null, parentEntityName: parent, childEntityName: child };
}

const ENTITIES: readonly Entity[] = [
  entity("a"),
  entity("b"),
  entity("c"),
  entity("d"),
  entity("orphan"),
];

const RELATIONSHIPS: readonly Relationship[] = [
  rel("a", "b"),
  rel("a", "d"),
  rel("b", "c"),
  rel("d", "c"),
  rel("ghost", "a"),
];

const SIZE: NodeSize = { width: 240, height: 120 };

const HEIGHTS: Readonly<Record<string, number>> = { a: 120, b: 220, c: 120, d: 60, orphan: 300 };

function sizeOf(item: Entity): NodeSize {
  return { width: 240, height: HEIGHTS[item.name] ?? 120 };
}

describe("layoutGraph", () => {
  it("places every node with finite coordinates and every parent above its children", () => {
    const { positions } = layoutGraph(ENTITIES, RELATIONSHIPS, () => SIZE);

    for (const item of ENTITIES) {
      const point = positions.get(item.name);
      expect(point, `position for ${item.name}`).toBeDefined();
      expect(Number.isFinite(point?.x)).toBe(true);
      expect(Number.isFinite(point?.y)).toBe(true);
    }

    expect(positions.get("orphan")).toBeDefined();

    const present = new Set(ENTITIES.map((item) => item.name));
    for (const relationship of RELATIONSHIPS) {
      if (!present.has(relationship.parentEntityName)) continue;
      if (!present.has(relationship.childEntityName)) continue;
      const parent = positions.get(relationship.parentEntityName);
      const child = positions.get(relationship.childEntityName);
      expect(
        (parent?.y ?? 0) < (child?.y ?? 0),
        `${relationship.parentEntityName} above ${relationship.childEntityName}`,
      ).toBe(true);
    }
  });

  it("top aligns same-rank nodes whose heights differ", () => {
    const { positions } = layoutGraph(ENTITIES, RELATIONSHIPS, sizeOf);

    expect(positions.get("a")?.y).toBe(positions.get("orphan")?.y);
    expect(positions.get("b")?.y).toBe(positions.get("d")?.y);
    expect(positions.get("c")?.y).toBeGreaterThan(positions.get("b")?.y ?? 0);
  });
});

describe("layout engine registry", () => {
  const linked = RELATIONSHIPS.filter(
    (item) =>
      ENTITIES.some((entity) => entity.name === item.parentEntityName) &&
      ENTITIES.some((entity) => entity.name === item.childEntityName),
  );

  it.each([
    ["dagre-tb", (parent: readonly [number, number], child: readonly [number, number]) => parent[1] < child[1]],
    ["dagre-bt", (parent: readonly [number, number], child: readonly [number, number]) => parent[1] > child[1]],
    ["dagre-lr", (parent: readonly [number, number], child: readonly [number, number]) => parent[0] < child[0]],
    ["dagre-rl", (parent: readonly [number, number], child: readonly [number, number]) => parent[0] > child[0]],
  ] as const)("orients every edge correctly under %s", async (id, holds) => {
    const { positions } = await LAYOUT_ENGINES[id].run(ENTITIES, RELATIONSHIPS, sizeOf);

    for (const item of linked) {
      const parent = positions.get(item.parentEntityName);
      const child = positions.get(item.childEntityName);
      expect(
        holds([parent?.x ?? 0, parent?.y ?? 0], [child?.x ?? 0, child?.y ?? 0]),
        `${item.parentEntityName} vs ${item.childEntityName} under ${id}`,
      ).toBe(true);
    }
  });

  it.each(LAYOUT_CHOICES.map((engine) => engine.id))(
    "%s places every node through the one shared async call shape",
    async (id) => {
      const layout = await LAYOUT_ENGINES[id].run(ENTITIES, RELATIONSHIPS, sizeOf);

      expect(layout.positions.size).toBe(ENTITIES.length);
      for (const item of ENTITIES) {
        const point = layout.positions.get(item.name);
        expect(Number.isFinite(point?.x), `${item.name}.x under ${id}`).toBe(true);
        expect(Number.isFinite(point?.y), `${item.name}.y under ${id}`).toBe(true);
      }
      expect(Number.isFinite(layout.width)).toBe(true);
      expect(Number.isFinite(layout.height)).toBe(true);
    },
  );

  it("offers exactly the seven advertised engines in order", () => {
    expect(LAYOUT_CHOICES.map((engine) => engine.id)).toEqual([
      "dagre-tb",
      "dagre-bt",
      "dagre-lr",
      "dagre-rl",
      "elk-layered",
      "elk-radial",
      "d3-force",
    ]);
  });

  it("returns a finite width for an empty model", async () => {
    const layout = await LAYOUT_ENGINES["dagre-tb"].run([], [], sizeOf);

    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
  });
});

describe("anchorLayout", () => {
  const SIZES: ReadonlyMap<string, NodeSize> = new Map(
    ENTITIES.map((item) => [item.name, sizeOf(item)] as const),
  );
  const SETTLED: ReadonlyMap<string, Point> = new Map([
    ["a", { x: 0, y: 0 }],
    ["orphan", { x: 400, y: 0 }],
  ]);

  it("leaves every node that was already on screen byte-identical", () => {
    const next: GraphLayout = {
      positions: new Map([
        ["a", { x: 999, y: 999 }],
        ["orphan", { x: 1500, y: 40 }],
      ]),
      width: 0,
      height: 0,
    };

    const anchored = anchorLayout(next, SETTLED, SIZES);

    expect(anchored.positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(anchored.positions.get("orphan")).toEqual({ x: 400, y: 0 });
  });

  it("places arriving nodes without moving the nodes that stayed", () => {
    const next: GraphLayout = {
      positions: new Map([
        ["a", { x: 500, y: 500 }],
        ["orphan", { x: 900, y: 500 }],
        ["b", { x: 500, y: 700 }],
      ]),
      width: 0,
      height: 0,
    };

    const anchored = anchorLayout(next, SETTLED, SIZES);
    const moved = [...anchored.positions].filter(([name, point]) => {
      const before = SETTLED.get(name);
      return before ? before.x !== point.x || before.y !== point.y : false;
    });

    expect(moved).toEqual([]);
    expect(anchored.positions.get("b")).toBeDefined();
    expect(anchored.positions.size).toBe(3);
  });

  it("pushes an arriving node clear of a settled node it would land on", () => {
    // `b` lands exactly on top of `a` once the anchor delta is applied, so it has to be pushed.
    const next: GraphLayout = {
      positions: new Map([
        ["a", { x: 0, y: 0 }],
        ["orphan", { x: 400, y: 0 }],
        ["b", { x: 0, y: 0 }],
      ]),
      width: 0,
      height: 0,
    };

    const anchored = anchorLayout(next, SETTLED, SIZES);
    const b = anchored.positions.get("b") as Point;
    const a = SETTLED.get("a") as Point;
    const aSize = SIZES.get("a") as NodeSize;
    const bSize = SIZES.get("b") as NodeSize;

    const collides =
      b.x < a.x + aSize.width && b.x + bSize.width > a.x &&
      b.y < a.y + aSize.height && b.y + bSize.height > a.y;
    expect(collides).toBe(false);
    expect(anchored.positions.get("a")).toEqual({ x: 0, y: 0 });
  });

  it("leaves an arriving node exactly where the engine put it when nothing is in its way", () => {
    // Two arrivals flanking one settled card, neither touching it. A rigid group push moved both by
    // 148 px even though nothing collided; only a node that actually lands on something may move.
    const sizes: ReadonlyMap<string, NodeSize> = new Map([
      ["a", { width: 100, height: 100 }],
      ["b", { width: 100, height: 100 }],
      ["c", { width: 100, height: 100 }],
    ]);
    const next: GraphLayout = {
      positions: new Map([
        ["a", { x: 450, y: 0 }],
        ["b", { x: 0, y: 0 }],
        ["c", { x: 900, y: 0 }],
      ]),
      width: 1000,
      height: 100,
    };

    const anchored = anchorLayout(next, new Map([["a", { x: 450, y: 0 }]]), sizes);

    expect(anchored.positions.get("a")).toEqual({ x: 450, y: 0 });
    expect(anchored.positions.get("b")).toEqual({ x: 0, y: 0 });
    expect(anchored.positions.get("c")).toEqual({ x: 900, y: 0 });
  });

  it("returns a node the caller still remembers to its exact remembered position", () => {
    // What expand does: `b` was hidden, so the engine re-places it, and the remembered coordinates
    // have to win over whatever the fresh run chose.
    const remembered: ReadonlyMap<string, Point> = new Map([
      ["a", { x: 0, y: 0 }],
      ["orphan", { x: 400, y: 0 }],
      ["b", { x: 40, y: 900 }],
    ]);
    const next: GraphLayout = {
      positions: new Map([
        ["a", { x: 3000, y: 12 }],
        ["orphan", { x: 3400, y: 12 }],
        ["b", { x: 5000, y: 5000 }],
      ]),
      width: 0,
      height: 0,
    };

    const anchored = anchorLayout(next, remembered, SIZES);

    expect([...anchored.positions].sort()).toEqual([...remembered].sort());
  });

  it("falls back to the fresh layout when nothing carries over", () => {
    const next: GraphLayout = {
      positions: new Map([["b", { x: 7, y: 9 }]]),
      width: 3,
      height: 4,
    };

    expect(anchorLayout(next, new Map(), SIZES)).toBe(next);
  });
});
