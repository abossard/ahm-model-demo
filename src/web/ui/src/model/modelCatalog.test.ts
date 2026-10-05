import { describe, expect, it } from "vitest";
import type { ModelRef } from "./types";
import { filterModels, sortModelsByNameThenGroup } from "./modelCatalog";

const MODELS: readonly ModelRef[] = [
  {
    id: "/a",
    name: "hm-zeta",
    resourceGroup: "rg-z",
    location: "northeurope",
    provisioningState: "Succeeded",
  },
  {
    id: "/b",
    name: "hm-alpha",
    resourceGroup: "rg-c",
    location: "northeurope",
    provisioningState: "Succeeded",
  },
  {
    id: "/c",
    name: "Hm-Alpha",
    resourceGroup: "rg-a",
    location: "northeurope",
    provisioningState: "Succeeded",
  },
  {
    id: "/d",
    name: "hm-beta",
    resourceGroup: "rg-b",
    location: "northeurope",
    provisioningState: "Succeeded",
  },
];

describe("sortModelsByNameThenGroup", () => {
  it("sorts case-insensitively by name then resource group", () => {
    const actual = sortModelsByNameThenGroup(MODELS).map(
      (item) => `${item.name}|${item.resourceGroup}`,
    );

    expect(actual).toEqual([
      "Hm-Alpha|rg-a",
      "hm-alpha|rg-c",
      "hm-beta|rg-b",
      "hm-zeta|rg-z",
    ]);
  });
});

describe("filterModels", () => {
  it.each([
    { query: "alpha", expected: ["hm-alpha|rg-c", "Hm-Alpha|rg-a"] },
    { query: "RG-A", expected: ["Hm-Alpha|rg-a"] },
    { query: "  beta  ", expected: ["hm-beta|rg-b"] },
    { query: "", expected: ["hm-zeta|rg-z", "hm-alpha|rg-c", "Hm-Alpha|rg-a", "hm-beta|rg-b"] },
  ])("filters by name or group ($query)", ({ query, expected }) => {
    const actual = filterModels(MODELS, query).map(
      (item) => `${item.name}|${item.resourceGroup}`,
    );
    expect(actual).toEqual(expected);
  });
});
