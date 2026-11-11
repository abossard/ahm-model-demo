// @vitest-environment node
import { describe, expect, it } from "vitest";
import { badgesByEntity, unionSnapshots } from "./changes";
import { calmModel, denseIncidentModel, diffViewModel, incidentModel } from "../../tests/viewModels";
import type { HealthModel } from "./types";

const states = (model: HealthModel): Record<string, number> => {
  const count: Record<string, number> = {};
  for (const entity of model.entities) count[entity.healthState] = (count[entity.healthState] ?? 0) + 1;
  return count;
};

describe("view fixtures", () => {
  it.each([
    ["the incident model", incidentModel(), 17, 17, { Healthy: 7, Degraded: 4, Unhealthy: 2, Unknown: 4 }],
    ["the calm model", calmModel(), 17, 17, { Healthy: 13, Unknown: 4 }],
    ["the dense model", denseIncidentModel(), 81, 105, undefined],
  ] as const)("%s has the shape the views are built for", (_name, model, entities, relationships, expected) => {
    expect(model.entities).toHaveLength(entities);
    expect(model.relationships.length).toBeGreaterThanOrEqual(relationships - 8);
    if (expected) expect(states(model)).toEqual(expected);
    const names = new Set(model.entities.map((entity) => entity.name));
    for (const item of model.relationships) {
      expect(names.has(item.parentEntityName)).toBe(true);
      expect(names.has(item.childEntityName)).toBe(true);
    }
  });

  it("gives the dense model several parents and skipped layers, failing leaves and Suppressed parts", () => {
    const model = denseIncidentModel();
    const parents = new Map<string, number>();
    for (const item of model.relationships) parents.set(item.childEntityName, (parents.get(item.childEntityName) ?? 0) + 1);
    expect([...parents.values()].filter((count) => count > 1).length).toBeGreaterThanOrEqual(8);
    expect(model.entities.filter((entity) => entity.healthState === "Unhealthy" && entity.name.startsWith("res-"))).toHaveLength(2);
    expect(model.entities.filter((entity) => entity.impact === "Suppressed").length).toBeGreaterThanOrEqual(5);
  });

  it("keeps Limited impact from turning a flow Unhealthy", () => {
    const flows = incidentModel().entities.filter((entity) => entity.name.startsWith("flow-"));
    expect(flows.some((entity) => entity.healthState === "Unhealthy")).toBe(false);
  });

  describe("the diff", () => {
    const view = diffViewModel();
    it("adds two entities and one relationship, changes two entities and removes one", () => {
      const count = (op: string, kind: string): number => view.changes.filter((change) => change.op === op && change.kind === kind).length;
      expect([count("add", "entity"), count("add", "relationship"), count("change", "entity"), count("remove", "entity")]).toEqual([2, 1, 2, 1]);
    });

    it("marks them on the union of both sides", () => {
      const badges = badgesByEntity(view.changes);
      expect(badges.get("report-queue")).toBe("added");
      expect(badges.get("pager-webhook")).toBe("added");
      expect(badges.get("container-app")).toBe("changed");
      expect(badges.get("discovered-app-topology")).toBe("removed");
      const union = unionSnapshots(view.base, view.proposed);
      expect(union.entities.map((entity) => entity.name)).toEqual(expect.arrayContaining(["report-queue", "pager-webhook", "discovered-app-topology"]));
    });
  });
});
