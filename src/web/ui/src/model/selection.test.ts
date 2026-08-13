import { describe, it, expect } from "vitest";
import { searchFromSelection, selectionFromSearch } from "./selection";
import type { ModelCatalog } from "./types";

const CATALOG: ModelCatalog = {
  models: [
    { id: "/a", name: "hm-a", resourceGroup: "rg-a", location: "northeurope", provisioningState: "Succeeded" },
    { id: "/b", name: "hm-b", resourceGroup: "rg-b", location: "westeurope", provisioningState: "Creating" },
  ],
  default: { name: "hm-a", resourceGroup: "rg-a" },
};

const CASES: readonly (readonly [string, string])[] = [
  ["", "hm-a"],
  ["?model=hm-b&resourceGroup=rg-b", "hm-b"],
  ["?model=ghost&resourceGroup=rg-b", "hm-a"],
  ["?model=hm-b", "hm-a"],
  ["?model=hm-b&resourceGroup=rg-a", "hm-a"],
];

describe("model selection", () => {
  it.each(CASES)("resolves %s to %s", (search, expected) => {
    expect(selectionFromSearch(search, CATALOG)?.name).toBe(expected);
  });

  it("falls back to the first model when the default is absent from the catalog", () => {
    const orphaned: ModelCatalog = {
      models: CATALOG.models.slice(1),
      default: CATALOG.default,
    };
    expect(selectionFromSearch("", orphaned)?.name).toBe("hm-b");
  });

  it("returns null when the catalog is empty", () => {
    expect(selectionFromSearch("?model=hm-a&resourceGroup=rg-a", { models: [], default: CATALOG.default })).toBeNull();
  });

  it("round-trips a selection through the search string", () => {
    const selection = CATALOG.models[1]!;
    expect(searchFromSelection(selection)).toBe("?model=hm-b&resourceGroup=rg-b");
    expect(selectionFromSearch(searchFromSelection(selection), CATALOG)).toEqual(selection);
  });
});
