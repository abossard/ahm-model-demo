import { expect, it } from "vitest";
import { modelNameSuggestions } from "./modelNameSuggestions";

const group = (name: string) => "/subscriptions/sub/resourceGroups/" + name;
const resource = (name: string, rg = "rg-Commerce-Prod") => group(rg) + "/providers/Microsoft.App/containerApps/" + name;

it.each([
  { scope: { groupIds: [], resourceIds: [] }, first: "hm-workload" },
  { scope: { groupIds: [group("rg-Commerce-Prod")], resourceIds: [] }, first: "hm-commerce-prod" },
  { scope: { groupIds: [], resourceIds: [resource("ca-OrdersApi")] }, first: "hm-orders-api" },
  { scope: { groupIds: [], resourceIds: [resource("ca-orders-api"), resource("sql-orders-db")] }, first: "hm-orders" },
  { scope: { groupIds: [], resourceIds: [resource("web"), resource("billing")] }, first: "hm-commerce-prod" },
  { scope: { groupIds: [group("rg-Équipe.83")], resourceIds: [] }, first: "hm-equipe-83" },
  { scope: { groupIds: [group("731")], resourceIds: [] }, first: "hm-731" },
  { scope: { groupIds: [group("rg-" + "a".repeat(35))], resourceIds: [] }, first: "hm-" + "a".repeat(24) },
])("suggests three valid prefixes starting with $first", ({ scope, first }) => {
  const names = modelNameSuggestions(scope);
  expect(names[0]).toBe(first);
  expect(new Set(names).size).toBe(3);
  for (const name of names) expect(name).toMatch(/^[a-z](?:[a-z0-9-]{0,25}[a-z0-9])?$/);
});
