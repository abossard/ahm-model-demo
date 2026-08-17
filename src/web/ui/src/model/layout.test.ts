import { describe, it, expect } from "vitest";
import { LAYOUT_CHOICES, LAYOUT_ENGINES, layoutGraph, type NodeSize } from "./layout";
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
