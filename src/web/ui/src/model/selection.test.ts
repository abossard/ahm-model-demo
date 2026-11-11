import { describe, it, expect } from "vitest";
import {
  searchFromLocation,
  searchFromSelection,
  selectionFromSearch,
  workspaceFromSearch,
} from "./selection";
import type { ModelCatalog } from "./types";

const CATALOG: ModelCatalog = {
  models: [
    { id: "/a", name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-1", location: "northeurope", provisioningState: "Succeeded" },
    { id: "/b", name: "hm-b", resourceGroup: "rg-b", subscriptionId: "sub-1", location: "westeurope", provisioningState: "Creating" },
    { id: "/c", name: "hm-b", resourceGroup: "rg-b", subscriptionId: "sub-2", location: "westeurope", provisioningState: "Succeeded" },
  ],
  default: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-1" },
};

const CASES: readonly (readonly [string, string, string])[] = [
  ["", "hm-a", "sub-1"],
  ["?model=hm-b&resourceGroup=rg-b&subscription=sub-1", "hm-b", "sub-1"],
  ["?model=hm-b&resourceGroup=rg-b&subscription=sub-2", "hm-b", "sub-2"],
  ["?model=ghost&resourceGroup=rg-b&subscription=sub-1", "hm-a", "sub-1"],
  ["?model=hm-b&resourceGroup=rg-b&subscription=sub-3", "hm-a", "sub-1"],
  ["?model=hm-b&resourceGroup=rg-b", "hm-a", "sub-1"],
  ["?model=hm-b", "hm-a", "sub-1"],
  ["?model=hm-b&resourceGroup=rg-a&subscription=sub-1", "hm-a", "sub-1"],
];

describe("model selection", () => {
  it.each(CASES)("resolves %s to %s in %s", (search, name, subscriptionId) => {
    const { selected } = selectionFromSearch(search, CATALOG);
    expect([selected?.name, selected?.subscriptionId]).toEqual([name, subscriptionId]);
  });

  it("falls back to the first model when the default is absent from the catalog", () => {
    const orphaned: ModelCatalog = {
      models: CATALOG.models.slice(1),
      default: CATALOG.default,
    };
    expect(selectionFromSearch("", orphaned).selected?.name).toBe("hm-b");
  });

  it("opens the first model of a catalog that names no default, and none when it is empty", () => {
    expect(selectionFromSearch("", { models: CATALOG.models, default: null }).selected).toEqual(CATALOG.models[0]);
    expect(selectionFromSearch("", { models: [], default: null })).toEqual({ selected: null, unavailable: null });
  });

  it("returns null when the catalog is empty", () => {
    expect(
      selectionFromSearch("?model=hm-a&resourceGroup=rg-a&subscription=sub-1", {
        models: [],
        default: CATALOG.default,
      }).selected,
    ).toBeNull();
  });

  it.each(CATALOG.models.map((model) => [model.id, model] as const))(
    "round-trips %s through the search string",
    (_id, selection) => {
      expect(searchFromSelection(selection)).toBe(
        `?model=${selection.name}&resourceGroup=${selection.resourceGroup}&subscription=${selection.subscriptionId}`,
      );
      expect(selectionFromSearch(searchFromSelection(selection), CATALOG).selected).toEqual(
        selection,
      );
    },
  );

  it("encodes selection values that need escaping", () => {
    expect(
      searchFromSelection({ name: "hm a&b", resourceGroup: "rg/x", subscriptionId: "s=1" }),
    ).toBe("?model=hm+a%26b&resourceGroup=rg%2Fx&subscription=s%3D1");
  });

  it("captures an unavailable requested triple while selecting a safe fallback", () => {
    const resolved = selectionFromSearch(
      "?model=ghost&resourceGroup=rg-z&subscription=sub-9",
      CATALOG,
    );
    expect(resolved.selected).toEqual(CATALOG.models[0]);
    expect(resolved.unavailable).toEqual({
      name: "ghost",
      resourceGroup: "rg-z",
      subscriptionId: "sub-9",
    });
  });

  it("reports no unavailable selection when nothing valid was requested", () => {
    expect(selectionFromSearch("?model=hm-b", CATALOG).unavailable).toBeNull();
  });
});

describe("workspace location", () => {
  it.each([
    { search: "", expected: { session: null, task: null } },
    { search: "?session=abc123", expected: { session: "abc123", task: null } },
    { search: "?session=abc123&task=3", expected: { session: "abc123", task: 3 } },
    { search: "?task=3", expected: { session: null, task: null } },
    { search: "?session=abc123&task=0", expected: { session: "abc123", task: null } },
    { search: "?session=abc123&task=x", expected: { session: "abc123", task: null } },
    { search: "?session=../etc&task=1", expected: { session: null, task: null } },
    { search: "?model=hm-a&session=s1&task=12", expected: { session: "s1", task: 12 } },
  ])("reads $search", ({ search, expected }) => {
    expect(workspaceFromSearch(search)).toEqual(expected);
  });

  const MODEL = { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-1" };
  it.each([
    { model: MODEL, workspace: { session: null, task: null }, expected: "?model=hm-a&resourceGroup=rg-a&subscription=sub-1" },
    { model: MODEL, workspace: { session: "s1", task: null }, expected: "?model=hm-a&resourceGroup=rg-a&subscription=sub-1&session=s1" },
    { model: MODEL, workspace: { session: "s1", task: 2 }, expected: "?model=hm-a&resourceGroup=rg-a&subscription=sub-1&session=s1&task=2" },
    { model: MODEL, workspace: { session: null, task: 2 }, expected: "?model=hm-a&resourceGroup=rg-a&subscription=sub-1" },
    { model: null, workspace: { session: "s1", task: 2 }, expected: "?session=s1&task=2" },
    { model: null, workspace: { session: null, task: null }, expected: "" },
  ])("writes $expected", ({ model, workspace, expected }) => {
    expect(searchFromLocation(model, workspace)).toBe(expected);
  });

  it("round-trips a Session and Task through the address bar", () => {
    const search = searchFromLocation(MODEL, { session: "abc123", task: 7 });
    expect(workspaceFromSearch(search)).toEqual({ session: "abc123", task: 7 });
  });
});
