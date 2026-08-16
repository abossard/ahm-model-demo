import { describe, it, expect } from "vitest";
import { elkLayout } from "./layoutElk";
import type { GraphLayout, NodeSize } from "./layout";
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
  return {
    name: `${parent}->${child}`,
    displayName: null,
    parentEntityName: parent,
    childEntityName: child,
  };
}

const SIZE: NodeSize = { width: 260, height: 120 };
const sizeOf = (): NodeSize => SIZE;

/** Two linked components plus a degree-zero node — the shape that stacked on one coordinate. */
const ENTITIES: readonly Entity[] = ["a", "b", "c", "d", "lonely"].map(entity);
const RELATIONSHIPS: readonly Relationship[] = [rel("a", "b"), rel("c", "d")];

function overlaps(layout: GraphLayout): readonly string[] {
  const boxes = [...layout.positions.entries()];
  const clashes: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [leftName, left] = boxes[i] as [string, { x: number; y: number }];
      const [rightName, right] = boxes[j] as [string, { x: number; y: number }];
      const apart =
        left.x + SIZE.width <= right.x ||
        right.x + SIZE.width <= left.x ||
        left.y + SIZE.height <= right.y ||
        right.y + SIZE.height <= left.y;
      if (!apart) clashes.push(`${leftName}/${rightName}`);
    }
  }
  return clashes;
}

describe("elkLayout", () => {
  it.each(["radial", "layered"] as const)(
    "%s places disconnected components without overlapping any card",
    async (algorithm) => {
      const layout = await elkLayout(ENTITIES, RELATIONSHIPS, sizeOf, algorithm);

      expect(layout.positions.size).toBe(ENTITIES.length);
      expect(overlaps(layout)).toEqual([]);
      for (const point of layout.positions.values()) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    },
  );

  it("keeps a single connected component intact under radial", async () => {
    const connected: readonly Relationship[] = [rel("a", "b"), rel("b", "c"), rel("c", "d")];
    const layout = await elkLayout(ENTITIES.slice(0, 4), connected, sizeOf, "radial");

    expect(overlaps(layout)).toEqual([]);
    expect(layout.positions.size).toBe(4);
  });
});
