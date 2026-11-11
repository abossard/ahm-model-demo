// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LaneKind } from "./layerOf";
import { foldGroups } from "./swimlaneFold";
import type { Entity, HealthState } from "./types";

function entity(name: string, healthState: HealthState = "Healthy", impact = "Standard"): Entity {
  return { name, displayName: name, healthState, impact, canvasPosition: null, discoveredBy: null, parents: [], children: [], unlinked: false, latestEvaluationAt: null, latestTransitionAt: null, signals: [], report: { eligible: true, signalName: null } };
}

interface Case {
  readonly states?: Readonly<Record<string, HealthState>>;
  readonly kinds?: Readonly<Record<string, LaneKind>>;
  readonly open?: readonly string[];
  readonly keep?: readonly string[];
}

function fold(names: readonly string[], pairs: readonly (readonly [string, string])[], { states = {}, kinds = {}, open = [], keep = [] }: Case = {}): { groups: Record<string, readonly string[]>; hidden: readonly string[] } {
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const [parent, child] of pairs) {
    (parentsOf.get(child) ?? parentsOf.set(child, []).get(child)!).push(parent);
    (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(child);
  }
  const result = foldGroups({
    names,
    byName: new Map(names.map((name) => [name, entity(name, states[name] ?? "Healthy", name.startsWith("s") ? "Suppressed" : "Standard")] as const)),
    parentsOf,
    childrenOf,
    kindOf: (name) => kinds[name] ?? (name === "r" ? "root" : "resources"),
    open: new Set(open),
    keep: new Set(keep),
  });
  return { groups: Object.fromEntries([...result.groups].map(([owner, group]) => [owner, group.all])), hidden: [...result.hidden].sort() };
}

describe("foldGroups", () => {
  it.each([
    ["healthy leaves under one parent become one chip", ["r", "p", "a", "b", "c"], [["r", "p"], ["p", "a"], ["p", "b"], ["p", "c"]], { states: { p: "Degraded" } }, { p: ["a", "b", "c"] }, ["a", "b", "c"]],
    ["a healthy subtree folds as a whole, under the nearest parent that is drawn", ["r", "p", "a", "b"], [["r", "p"], ["p", "a"], ["p", "b"]], {}, { r: ["p", "a", "b"] }, ["a", "b", "p"]],
    ["a leaf that is not healthy stays, and keeps its parent drawn", ["r", "p", "a", "b", "c"], [["r", "p"], ["p", "a"], ["p", "b"], ["p", "c"]], { states: { a: "Unhealthy", p: "Degraded" } }, { p: ["b", "c"] }, ["b", "c"]],
    ["one healthy leaf is not worth a chip", ["r", "p", "a", "b"], [["r", "p"], ["p", "a"], ["p", "b"]], { states: { a: "Degraded", p: "Degraded" } }, {}, []],
    ["an unknown leaf stays: missing data is information", ["r", "p", "a", "b", "c"], [["r", "p"], ["p", "a"], ["p", "b"], ["p", "c"]], { states: { a: "Unknown", p: "Healthy" } }, { p: ["b", "c"] }, ["b", "c"]],
    ["a leaf with two parents stays, and so do they", ["r", "p", "q", "a", "b"], [["r", "p"], ["r", "q"], ["p", "a"], ["q", "a"], ["p", "b"]], {}, {}, []],
    ["an entity that is kept never folds", ["r", "p", "a", "b", "c"], [["r", "p"], ["p", "a"], ["p", "b"], ["p", "c"]], { states: { p: "Degraded" }, keep: ["a"] }, { p: ["b", "c"] }, ["b", "c"]],
    ["context never folds", ["r", "p", "a", "b"], [["r", "p"], ["p", "a"], ["p", "b"]], { states: { p: "Degraded" }, kinds: { a: "context", b: "context" } }, {}, []],
    ["a Suppressed entity never folds", ["r", "p", "sx", "sy"], [["r", "p"], ["p", "sx"], ["p", "sy"]], { states: { p: "Degraded" } }, {}, []],
  ] as readonly (readonly [string, readonly string[], readonly (readonly [string, string])[], Case, Record<string, readonly string[]> | undefined, readonly string[]])[])("%s", (_name, names, pairs, options, groups, hidden) => {
    const result = fold(names, pairs, options);
    if (groups) expect(result.groups).toEqual(groups);
    expect(result.hidden).toEqual(hidden);
  });

  describe("opening a chip", () => {
    const names = ["r", "p", "q1", "q2", "a", "b", "c", "d"];
    const pairs = [["r", "p"], ["p", "q1"], ["p", "q2"], ["q1", "a"], ["q1", "b"], ["q2", "c"], ["q2", "d"]] as const;

    it.each([
      ["nothing open: one chip under the root stands for all seven", [], { r: ["a", "b", "c", "d", "p", "q1", "q2"] }, ["a", "b", "c", "d", "p", "q1", "q2"]],
      ["the root's chip open: the part shows, what is below folds again under it", ["r"], { p: ["a", "b", "c", "d", "q1", "q2"], r: ["a", "b", "c", "d", "p", "q1", "q2"] }, ["a", "b", "c", "d", "q1", "q2"]],
      ["two chips open: the next level shows, with a chip under each", ["r", "p"], { p: ["a", "b", "c", "d", "q1", "q2"], q1: ["a", "b"], q2: ["c", "d"], r: ["a", "b", "c", "d", "p", "q1", "q2"] }, ["a", "b", "c", "d"]],
      ["every chip open: everything shows", ["r", "p", "q1", "q2"], { p: ["a", "b", "c", "d", "q1", "q2"], q1: ["a", "b"], q2: ["c", "d"], r: ["a", "b", "c", "d", "p", "q1", "q2"] }, []],
    ] as const)("%s", (_name, open, groups, hidden) => {
      const result = fold(names, pairs, { open });
      expect(Object.fromEntries(Object.entries(result.groups).map(([owner, all]) => [owner, [...all].sort()]))).toEqual(groups);
      expect(result.hidden).toEqual(hidden);
    });
  });

  it("does not hang on a cycle", () => {
    expect(() => fold(["r", "a", "b"], [["r", "a"], ["a", "b"], ["b", "a"]])).not.toThrow();
  });
});
