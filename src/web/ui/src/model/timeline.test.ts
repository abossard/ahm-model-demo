import { describe, expect, it } from "vitest";
import { addSpan, lowerBound, mergeRange, missingSpans, severity, stateName, upperBound, worse } from "./timeline";

describe("states", () => {
  it.each([
    [0, "Unknown"],
    [1, "Healthy"],
    [2, "Degraded"],
    [3, "Unhealthy"],
    [4, "Deleted"],
    [9, "Unknown"],
  ])("names code %d as %s", (code, name) => {
    expect(stateName(code)).toBe(name);
  });

  it.each([
    [1, 2, 2],
    [2, 3, 3],
    [3, 2, 3],
    [1, 0, 0],
    [0, 2, 2],
    [1, 1, 1],
  ] as const)("the worse of %d and %d is %d (a gap ranks above healthy, below degraded)", (a, b, expected) => {
    expect(worse(a, b)).toBe(expected);
    expect(severity(expected)).toBeGreaterThanOrEqual(severity(a));
  });
});

describe("bounds", () => {
  const items = [10, 20, 20, 30];
  it.each([
    [5, 0, 0],
    [10, 0, 1],
    [20, 1, 3],
    [25, 3, 3],
    [31, 4, 4],
  ])("at %d the lower bound is %d and the upper bound %d", (t, lower, upper) => {
    expect(lowerBound(items, t, (x) => x)).toBe(lower);
    expect(upperBound(items, t, (x) => x)).toBe(upper);
  });
});

describe("mergeRange", () => {
  const time = (x: number) => x;
  it.each([
    { name: "nothing held", existing: [], incoming: [3, 4], span: { from: 3, to: 4 }, expected: [3, 4] },
    { name: "a newer read replaces the overlap", existing: [1, 2, 3, 4], incoming: [3, 40], span: { from: 3, to: 5 }, expected: [1, 2, 3, 40] },
    { name: "an older read keeps the newer items", existing: [5, 6], incoming: [1, 2], span: { from: 1, to: 3 }, expected: [1, 2, 5, 6] },
    { name: "a read of the middle keeps both sides", existing: [1, 9], incoming: [4, 5], span: { from: 3, to: 6 }, expected: [1, 4, 5, 9] },
    { name: "an empty read clears its window", existing: [1, 4, 9], incoming: [], span: { from: 3, to: 6 }, expected: [1, 9] },
  ])("$name", ({ existing, incoming, span, expected }) => {
    expect(mergeRange(existing, incoming, span, time)).toEqual(expected);
  });
});

describe("spans", () => {
  it.each([
    { name: "an empty list", spans: [], add: { from: 1, to: 2 }, expected: [{ from: 1, to: 2 }] },
    { name: "disjoint after", spans: [{ from: 1, to: 2 }], add: { from: 5, to: 6 }, expected: [{ from: 1, to: 2 }, { from: 5, to: 6 }] },
    { name: "disjoint before", spans: [{ from: 5, to: 6 }], add: { from: 1, to: 2 }, expected: [{ from: 1, to: 2 }, { from: 5, to: 6 }] },
    { name: "touching", spans: [{ from: 1, to: 2 }], add: { from: 2, to: 3 }, expected: [{ from: 1, to: 3 }] },
    { name: "bridging two", spans: [{ from: 1, to: 2 }, { from: 4, to: 5 }], add: { from: 2, to: 4 }, expected: [{ from: 1, to: 5 }] },
    { name: "inside one", spans: [{ from: 1, to: 9 }], add: { from: 3, to: 4 }, expected: [{ from: 1, to: 9 }] },
  ])("adds a span to $name", ({ spans, add, expected }) => {
    expect(addSpan(spans, add)).toEqual(expected);
  });

  it.each([
    { name: "nothing covered", covered: [], want: { from: 0, to: 10 }, expected: [{ from: 0, to: 10 }] },
    { name: "all covered", covered: [{ from: 0, to: 10 }], want: { from: 2, to: 8 }, expected: [] },
    { name: "the old end missing", covered: [{ from: 4, to: 10 }], want: { from: 0, to: 10 }, expected: [{ from: 0, to: 4 }] },
    { name: "a hole", covered: [{ from: 0, to: 3 }, { from: 6, to: 10 }], want: { from: 0, to: 10 }, expected: [{ from: 3, to: 6 }] },
    { name: "the new end missing", covered: [{ from: 0, to: 5 }], want: { from: 0, to: 10 }, expected: [{ from: 5, to: 10 }] },
    { name: "a span far away", covered: [{ from: 20, to: 30 }], want: { from: 0, to: 10 }, expected: [{ from: 0, to: 10 }] },
  ])("finds what is missing with $name", ({ covered, want, expected }) => {
    expect(missingSpans(covered, want)).toEqual(expected);
  });
});
