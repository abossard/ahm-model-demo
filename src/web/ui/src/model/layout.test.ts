import { describe, it, expect } from "vitest";
import { layoutGraph, type NodeSize } from "./layout";
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
});
