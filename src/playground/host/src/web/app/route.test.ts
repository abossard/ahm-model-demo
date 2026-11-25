import { describe, expect, it } from "vitest";
import { layerPath, parseRoute, resolveRoute, tableIdFromContext, type Route } from "./route";

describe("parseRoute", () => {
  it.each<[string, Route]>([
    ["/", { page: "home", highlight: null }],
    ["/nowhere", { page: "home", highlight: null }],
    ["/briefing", { page: "layer", layer: 1, tableId: null }],
    ["/lab", { page: "layer", layer: 2, tableId: null }],
    ["/checkers", { page: "layer", layer: 3, tableId: null }],
    ["/checkers/ab12cd", { page: "layer", layer: 3, tableId: "ab12cd" }],
    ["/blackjack/table-9z", { page: "layer", layer: 5, tableId: "table-9z" }],
    ["/blackjack/NOPE!", { page: "layer", layer: 5, tableId: null }],
    ["/trader/ab12cd", { page: "layer", layer: 4, tableId: null }],
    ["/checkers/ab12cd/extra", { page: "home", highlight: null }],
  ])("%s", (path, expected) => {
    expect(parseRoute(path)).toEqual(expected);
  });
});

describe("layerPath", () => {
  it.each([
    [1, null, "/briefing"],
    [3, "ab12cd", "/checkers/ab12cd"],
    [4, "ab12cd", "/trader"],
    [5, null, "/blackjack"],
  ] as const)("layer %s table %s is %s", (layer, table, path) => {
    expect(layerPath(layer, table)).toBe(path);
  });
});

describe("resolveRoute", () => {
  it.each<[Route, 1 | 2 | 3 | 4 | 5, Route]>([
    [{ page: "layer", layer: 3, tableId: null }, 2, { page: "home", highlight: 3 }],
    [{ page: "layer", layer: 3, tableId: null }, 3, { page: "layer", layer: 3, tableId: null }],
    [{ page: "layer", layer: 1, tableId: null }, 1, { page: "layer", layer: 1, tableId: null }],
    [{ page: "home", highlight: null }, 1, { page: "home", highlight: null }],
  ])("%j with %s open", (route, unlocked, expected) => {
    expect(resolveRoute(route, unlocked)).toEqual(expected);
  });
});

describe("tableIdFromContext", () => {
  it.each([
    [{ structuredContent: { tableId: "ab12cd" } }, "ab12cd"],
    [{ tableId: "ab12cd" }, "ab12cd"],
    [{ structuredContent: { tableId: "x" } }, null],
    [{ structuredContent: {} }, null],
    [null, null],
    ["text", null],
  ])("%j", (value, expected) => {
    expect(tableIdFromContext(value)).toBe(expected);
  });
});
