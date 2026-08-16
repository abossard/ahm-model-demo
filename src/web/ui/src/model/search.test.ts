import { describe, it, expect } from "vitest";
import { searchGraph } from "./search";
import type { Entity, EntitySignal, Relationship } from "./types";

function signal(name: string, displayName: string): EntitySignal {
  return {
    name,
    displayName,
    kind: "metric",
    healthState: "Healthy",
    value: 1,
    reportedAt: null,
    writable: false,
  };
}

function entity(
  name: string,
  displayName: string,
  signals: readonly EntitySignal[] = [],
): Entity {
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
    signals,
    report: { eligible: true, signalName: null },
  };
}

const ENTITIES: readonly Entity[] = [
  entity("svc-a", "Service A", [signal("cpu", "CPU"), signal("latency", "Latency")]),
  entity("svc-b", "Service B", [signal("queue", "Queue")]),
];

const RELATIONSHIPS: readonly Relationship[] = [
  { name: "r1", displayName: "reads", parentEntityName: "svc-a", childEntityName: "svc-b" },
];

function groups(query: string): readonly string[] {
  return [...new Set(searchGraph(query, ENTITIES, RELATIONSHIPS).map((hit) => hit.group))];
}

describe("searchGraph", () => {
  it("matches entities, relationships and signals in one query", () => {
    const hits = searchGraph("e", ENTITIES, RELATIONSHIPS);

    expect(groups("e")).toEqual(["entities", "relationships", "signals"]);
    expect(hits.filter((hit) => hit.group === "entities").map((hit) => hit.focusEntity)).toEqual([
      "svc-a",
      "svc-b",
    ]);
    expect(hits.find((hit) => hit.group === "relationships")?.focusEntities).toEqual([
      "svc-a",
      "svc-b",
    ]);
  });

  it("returns only the signal group for a signal-only term", () => {
    const hits = searchGraph("queue", ENTITIES, RELATIONSHIPS);

    expect(groups("queue")).toEqual(["signals"]);
    expect(hits).toHaveLength(1);
    expect(hits.map((hit) => hit.focusEntity)).toEqual(["svc-b"]);
    expect(hits.map((hit) => hit.detail)).toEqual(["Service B"]);
  });

  it("reports the matched range so the caller can mark it", () => {
    const [hit] = searchGraph("erv", ENTITIES, RELATIONSHIPS);

    expect(hit?.label).toBe("Service A");
    expect(hit?.label.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("erv");
  });

  it("matches case-insensitively and on the technical name too", () => {
    expect(searchGraph("SERVICE a", ENTITIES, RELATIONSHIPS).map((hit) => hit.focusEntity)).toEqual([
      "svc-a",
    ]);
    expect(searchGraph("SVC-B", ENTITIES, RELATIONSHIPS).map((hit) => hit.focusEntity)).toEqual([
      "svc-b",
    ]);
  });

  it("marks the matched substring even when only the technical name matched", () => {
    for (const hit of searchGraph("svc-b", ENTITIES, RELATIONSHIPS)) {
      expect(hit.matchLength).toBeGreaterThan(0);
      expect(hit.label.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe(
        "svc-b",
      );
    }
    expect(searchGraph("svc-b", ENTITIES, RELATIONSHIPS).length).toBeGreaterThan(0);
  });

  it("never marks a slice that does not equal the query, even under locale folding", () => {
    // "İ" lowercases to two UTF-16 units, so an index found in the folded string can address
    // different characters in the original.
    const folding: readonly Entity[] = [entity("svc-x", "İX")];

    for (const hit of searchGraph("x", folding, [])) {
      const marked = hit.label.slice(hit.matchStart, hit.matchStart + hit.matchLength);
      expect(marked === "" || marked.toLocaleLowerCase() === "x").toBe(true);
    }
    expect(searchGraph("x", folding, [])).toHaveLength(1);
  });

  it("returns nothing for a blank or unmatched query", () => {
    expect(searchGraph("   ", ENTITIES, RELATIONSHIPS)).toEqual([]);
    expect(searchGraph("zzzz", ENTITIES, RELATIONSHIPS)).toEqual([]);
  });

  it("gives every hit a unique option id", () => {
    const ids = searchGraph("e", ENTITIES, RELATIONSHIPS).map((hit) => hit.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
