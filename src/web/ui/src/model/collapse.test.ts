import { describe, it, expect } from "vitest";
import { ancestorsToExpand, descendantCounts, visibleGraph } from "./collapse";
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

const ENTITIES: readonly Entity[] = ["a", "b", "c", "d", "orphan"].map(entity);

// Diamond: a fans out to b and d, both of which lead back into c.
const RELATIONSHIPS: readonly Relationship[] = [rel("a", "b"), rel("a", "d"), rel("b", "c"), rel("d", "c")];

function visibleNames(collapsed: readonly string[]): readonly string[] {
  return visibleGraph(ENTITIES, RELATIONSHIPS, new Set(collapsed)).entities.map((item) => item.name);
}

describe("visibleGraph", () => {
  it("hides the whole descendant subtree and counts it on the collapsed node", () => {
    const graph = visibleGraph(ENTITIES, RELATIONSHIPS, new Set(["a"]));

    expect(graph.entities.map((item) => item.name)).toEqual(["a", "orphan"]);
    expect(graph.hiddenCounts.get("a")).toBe(3);
    expect(graph.relationships).toEqual([]);
  });

  it("hides a descendant that still has a visible parent", () => {
    expect(visibleNames(["b"])).toEqual(["a", "b", "d", "orphan"]);
  });

  it("keeps everything visible and counts nothing when nothing is collapsed", () => {
    const graph = visibleGraph(ENTITIES, RELATIONSHIPS, new Set());

    expect(graph.entities).toHaveLength(ENTITIES.length);
    expect(graph.relationships).toHaveLength(RELATIONSHIPS.length);
    expect(graph.hiddenCounts.size).toBe(0);
  });

  it("ignores a collapsed name that is not in the model", () => {
    expect(visibleNames(["ghost"])).toEqual(["a", "b", "c", "d", "orphan"]);
  });

  it("drops only the edges that touch a hidden node", () => {
    const graph = visibleGraph(ENTITIES, RELATIONSHIPS, new Set(["b"]));

    expect(graph.relationships.map((item) => item.name)).toEqual(["a->b", "a->d"]);
  });
});

describe("descendantCounts", () => {
  it("counts transitive descendants for every branching node, collapsed or not", () => {
    const counts = descendantCounts(ENTITIES, RELATIONSHIPS);

    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("d")).toBe(1);
    expect(counts.has("c")).toBe(false);
    expect(counts.has("orphan")).toBe(false);
  });
});

describe("descendantCounts with malformed relationships", () => {
  const MESSY: readonly Relationship[] = [
    rel("a", "b"),
    rel("a", "ghost"),
    rel("orphan", "orphan"),
  ];

  it("ignores relationships pointing at entities that are not in the model", () => {
    expect(descendantCounts(ENTITIES, MESSY).get("a")).toBe(1);
    expect(visibleGraph(ENTITIES, MESSY, new Set(["a"])).hiddenCounts.get("a")).toBe(1);
    expect(visibleGraph(ENTITIES, MESSY, new Set(["a"])).entities.map((item) => item.name)).toEqual([
      "a",
      "c",
      "d",
      "orphan",
    ]);
  });

  it("does not report an ancestor that only reaches the target through an absent node", () => {
    const throughGhost: readonly Relationship[] = [rel("a", "ghost"), rel("ghost", "c")];

    expect(visibleGraph(ENTITIES, throughGhost, new Set(["a"])).entities.map((i) => i.name)).toContain(
      "c",
    );
    expect(ancestorsToExpand("c", ENTITIES, throughGhost, new Set(["a"]))).toEqual([]);
  });

  it("ignores a self-loop instead of offering a toggle that hides nothing", () => {
    expect(descendantCounts(ENTITIES, MESSY).has("orphan")).toBe(false);
    expect(visibleGraph(ENTITIES, MESSY, new Set(["orphan"])).entities).toHaveLength(ENTITIES.length);
  });
});

describe("ancestorsToExpand", () => {
  it("returns every collapsed ancestor blocking the target", () => {
    expect([...ancestorsToExpand("c", ENTITIES, RELATIONSHIPS, new Set(["a", "b"]))].sort()).toEqual([
      "a",
      "b",
    ]);
    expect(ancestorsToExpand("c", ENTITIES, RELATIONSHIPS, new Set(["b"]))).toEqual(["b"]);
  });

  it("returns nothing when the target is already visible", () => {
    expect(ancestorsToExpand("c", ENTITIES, RELATIONSHIPS, new Set())).toEqual([]);
    expect(ancestorsToExpand("a", ENTITIES, RELATIONSHIPS, new Set(["a"]))).toEqual([]);
  });
});
