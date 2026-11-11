import { describe, expect, it } from "vitest";
import type { ModelRef } from "./types";
import {
  filterModels,
  listModels,
  modelKey,
  sortModelsByNameThenGroup,
  subscriptionHint,
} from "./modelCatalog";

function model(name: string, resourceGroup: string, subscriptionId: string): ModelRef {
  return {
    id: `/${subscriptionId}/${resourceGroup}/${name}`,
    name,
    resourceGroup,
    subscriptionId,
    location: "northeurope",
    provisioningState: "Succeeded",
  };
}

const SUB_A = "aaaaaaaa-0000-0000-0000-000000000000";
const SUB_B = "bbbbbbbb-0000-0000-0000-000000000000";

const MODELS: readonly ModelRef[] = [
  model("hm-zeta", "rg-z", SUB_A),
  model("hm-alpha", "rg-c", SUB_A),
  model("Hm-Alpha", "rg-a", SUB_B),
  model("hm-beta", "rg-b", SUB_B),
];

const labels = (items: readonly ModelRef[]): string[] =>
  items.map((item) => `${item.name}|${item.resourceGroup}|${item.subscriptionId.slice(0, 2)}`);

describe("modelKey and subscriptionHint", () => {
  it("keys a model by subscription, group and name", () => {
    expect(modelKey(MODELS[0]!)).toBe(`${SUB_A}/rg-z/hm-zeta`);
  });

  it.each([
    { id: SUB_A, hint: "aaaaaaaa" },
    { id: "short", hint: "short" },
    { id: "", hint: "" },
  ])("shortens '$id' to '$hint'", ({ id, hint }) => {
    expect(subscriptionHint(id)).toBe(hint);
  });
});

describe("sortModelsByNameThenGroup", () => {
  it("sorts case-insensitively by name, resource group, then subscription", () => {
    expect(
      labels(sortModelsByNameThenGroup([...MODELS, model("hm-alpha", "rg-c", SUB_B)])),
    ).toEqual([
      "Hm-Alpha|rg-a|bb",
      "hm-alpha|rg-c|aa",
      "hm-alpha|rg-c|bb",
      "hm-beta|rg-b|bb",
      "hm-zeta|rg-z|aa",
    ]);
  });
});

describe("filterModels", () => {
  it.each([
    { query: "alpha", expected: ["hm-alpha|rg-c|aa", "Hm-Alpha|rg-a|bb"] },
    { query: "RG-A", expected: ["Hm-Alpha|rg-a|bb"] },
    { query: "  beta  ", expected: ["hm-beta|rg-b|bb"] },
    { query: "BBBBBBBB", expected: ["Hm-Alpha|rg-a|bb", "hm-beta|rg-b|bb"] },
    { query: "nothing", expected: [] },
    {
      query: "",
      expected: ["hm-zeta|rg-z|aa", "hm-alpha|rg-c|aa", "Hm-Alpha|rg-a|bb", "hm-beta|rg-b|bb"],
    },
  ])("filters by name, group or subscription ($query)", ({ query, expected }) => {
    expect(labels(filterModels(MODELS, query))).toEqual(expected);
  });
});

describe("listModels", () => {
  it("groups by subscription with the default subscription first", () => {
    const listing = listModels(MODELS, "", SUB_B);
    expect(listing.groups.map((group) => group.subscriptionId)).toEqual([SUB_B, SUB_A]);
    expect(listing.groups.map((group) => labels(group.models))).toEqual([
      ["Hm-Alpha|rg-a|bb", "hm-beta|rg-b|bb"],
      ["hm-alpha|rg-c|aa", "hm-zeta|rg-z|aa"],
    ]);
  });

  it("orders groups by subscription when the default is not among them", () => {
    const listing = listModels(MODELS, "", "cccccccc");
    expect(listing.groups.map((group) => group.subscriptionId)).toEqual([SUB_A, SUB_B]);
  });

  it.each([
    { limit: 3, shown: 3, total: 4 },
    { limit: 4, shown: 4, total: 4 },
    { limit: 50, shown: 4, total: 4 },
    { limit: 0, shown: 0, total: 4 },
  ])("caps $total matches at $limit", ({ limit, shown, total }) => {
    const listing = listModels(MODELS, "", SUB_A, limit);
    expect([listing.shown, listing.total]).toEqual([shown, total]);
    expect(listing.groups.reduce((sum, group) => sum + group.models.length, 0)).toBe(shown);
  });

  it("filters before it counts and caps", () => {
    const listing = listModels(MODELS, "alpha", SUB_A, 1);
    expect([listing.shown, listing.total]).toEqual([1, 2]);
  });

  it("stays within the cap for a few hundred models", () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      model(`hm-${String(index).padStart(3, "0")}`, `rg-${index % 7}`, index % 3 === 0 ? SUB_A : SUB_B),
    );
    const listing = listModels(many, "", SUB_A);
    expect([listing.shown, listing.total]).toEqual([50, 400]);
    expect(listModels(many, "hm-399", SUB_A).total).toBe(1);
  });
});
