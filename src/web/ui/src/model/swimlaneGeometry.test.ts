// @vitest-environment node
import { describe, expect, it } from "vitest";
import { corridorsOf, orderRows, pickCorridorX, projectPositions, relaxCoordinates } from "./swimlaneGeometry";

describe("projectPositions", () => {
  it.each([
    ["nothing", [], [], []],
    ["one item stays where it wants to be", [5], [], [5]],
    ["items that already have room stay", [0, 100, 200], [50, 50], [0, 100, 200]],
    ["two that collide meet in the middle of their wishes", [10, 12], [20], [1, 21]],
    ["three at one spot spread around it", [100, 100, 100], [30, 30], [70, 100, 130]],
    ["order is kept even when the wishes cross", [50, 40], [10], [40, 50]],
    ["a cluster is pushed by a neighbour it collides with", [0, 5, 100], [20, 20], [-7.5, 12.5, 100]],
  ] as readonly (readonly [string, readonly number[], readonly number[], readonly number[]])[])("%s", (_name, desired, sep, expected) => {
    const placed = projectPositions(desired, sep);
    expect(placed).toHaveLength(expected.length);
    placed.forEach((value, index) => expect(value).toBeCloseTo(expected[index] as number, 6));
  });

  it("lets a heavier item move less", () => {
    const [a, b] = projectPositions([0, 0], [10], [9, 1]);
    expect(Math.abs(a as number)).toBeLessThan(Math.abs(b as number));
    expect((b as number) - (a as number)).toBeCloseTo(10, 6);
  });

  it.each([1, 2, 3, 4, 5])("keeps every neighbour at least its separation apart for a seeded random case %d", (seed) => {
    let state = seed * 7919;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const desired = Array.from({ length: 12 }, () => next() * 300);
    const sep = Array.from({ length: 11 }, () => 20 + next() * 40);
    const placed = projectPositions(desired, sep);
    placed.slice(1).forEach((value, index) => expect(value - (placed[index] as number)).toBeGreaterThanOrEqual((sep[index] as number) - 1e-6));
  });
});

describe("relaxCoordinates", () => {
  const widths = new Map([["p", 100], ["a", 80], ["b", 80], ["c", 80]]);
  const neighbours = new Map([["p", ["a", "b", "c"]], ["a", ["p"]], ["b", ["p"]], ["c", ["p"]]]);

  it("centres a parent over its children and keeps cards of a row apart by the gap", () => {
    const x = relaxCoordinates([["p"], ["a", "b", "c"]], widths, neighbours, 30);
    expect(x.get("p")).toBeCloseTo(x.get("b") as number, 6);
    expect((x.get("b") as number) - (x.get("a") as number)).toBeCloseTo(110, 6);
    expect((x.get("c") as number) - (x.get("b") as number)).toBeCloseTo(110, 6);
  });

  it("starts at zero at the left edge of the leftmost card", () => {
    const x = relaxCoordinates([["p"], ["a", "b", "c"]], widths, neighbours, 30);
    expect(Math.min(...[...x].map(([id, centre]) => centre - (widths.get(id) as number) / 2))).toBeCloseTo(0, 6);
  });

  it("leaves extra room to the right of a card that asks for it", () => {
    const x = relaxCoordinates([["p"], ["a", "b", "c"]], widths, neighbours, 30, { extraGap: new Map([["a", 20]]) });
    expect((x.get("b") as number) - (x.get("a") as number)).toBeGreaterThanOrEqual(130 - 1e-6);
  });
});

describe("corridorsOf and pickCorridorX", () => {
  const cards = [{ x: 100, width: 80 }, { x: 220, width: 80 }];

  it("lists the flanks and the gaps between cards, a margin away from each card", () => {
    expect(corridorsOf(cards, 10, 60)).toEqual([[30, 90], [190, 210], [310, 370]]);
  });

  it("leaves out a gap too narrow to use, and gives an empty row two flanks' worth of room", () => {
    expect(corridorsOf([{ x: 0, width: 50 }, { x: 62, width: 50 }], 10, 60)).toEqual([[-70, -10], [122, 182]]);
    expect(corridorsOf([], 10, 60)).toEqual([[-60, 60]]);
  });

  it.each([
    ["the wish when it is free", 200, [], 200],
    ["the wish clamped into the nearest corridor", 150, [], 190],
    ["a slot beside a taken one", 200, [200], 210],
    ["the next corridor when the nearest is full", 230, [190, 200, 210], 310],
  ] as const)("picks %s", (_name, want, taken, expected) => {
    expect(pickCorridorX(corridorsOf(cards, 10, 60), want, taken, 10)).toBe(expected);
  });

  it("returns null when every corridor is full", () => {
    expect(pickCorridorX([[0, 10]], 5, [0, 10], 10)).toBeNull();
  });
});

describe("orderRows", () => {
  it("puts children in the order of their parents, whatever order they started in", () => {
    const parents = new Map([["a1", ["p1"]], ["a2", ["p1"]], ["b1", ["p2"]], ["b2", ["p2"]]]);
    const children = new Map([["p1", ["a1", "a2"]], ["p2", ["b1", "b2"]]]);
    const ordered = orderRows([["p1", "p2"], ["b2", "a2", "b1", "a1"]], parents, children);
    expect(ordered[1]?.slice(0, 2).every((id) => id.startsWith("a"))).toBe(true);
    expect(ordered[1]?.slice(2).every((id) => id.startsWith("b"))).toBe(true);
  });

  it("uncrosses two parents whose children are swapped", () => {
    const parents = new Map([["c1", ["p2"]], ["c2", ["p1"]]]);
    const children = new Map([["p1", ["c2"]], ["p2", ["c1"]]]);
    expect(orderRows([["p1", "p2"], ["c1", "c2"]], parents, children)).toEqual([["p1", "p2"], ["c2", "c1"]]);
  });

  it("lets an edge that skips a row pull as hard as one that does not, and leaves cards without neighbours in place", () => {
    const parents = new Map([["far", ["top"]]]);
    const children = new Map([["top", ["far"]]]);
    const ordered = orderRows([["x", "top", "y"], ["m"], ["u", "far", "v"]], parents, children);
    expect(ordered[2]).toEqual(["u", "far", "v"]);
  });

  it("does not change what it is given", () => {
    const rows = [["b", "a"]] as const;
    orderRows(rows, new Map(), new Map());
    expect(rows).toEqual([["b", "a"]]);
  });
});
