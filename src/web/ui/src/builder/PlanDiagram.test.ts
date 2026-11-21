import { describe, expect, it } from "vitest";
import { designerDiagram, workloadDiagram } from "./PlanDiagram";
import type { Analysis, AnalysisRow, BuilderEvidence, Preview } from "./types";

const id = "/subscriptions/sub/resourceGroups/group/providers/Microsoft.App/containerApps/orders";
const row: AnalysisRow = {resourceId: id, displayName: "orders", purpose: "Accepts orders", impact: "Standard"};
const metric = {resourceId: id, metricName: "CpuPercentage", metricNamespace: "Microsoft.App/containerApps",
  aggregation: "Average", operator: "GreaterThan" as const, threshold: 80, sample: 12};
const analysis: Analysis = {kind: "builderAnalysis", summary: "Orders", rows: [row], metrics: [metric],
  plan: {objective: "Accept orders", gaps: [], flows: [{name: "Order", objective: "Save an order",
    failureScenario: "The request fails", components: [{name: "Processing", signal: "Request errors", resourceIds: [id]}]}]}};

describe("health predictions on native plan cards", () => {
  it.each([
    ["Unavailable", 12, "Unhealthy", "Azure Resource Health"],
    ["Degraded", 12, "Degraded", "Azure Resource Health"],
    ["Available", 12, "Healthy", "CpuPercentage"],
    ["Unknown", 99, undefined, undefined],
  ] as const)("shows the strongest evidenced signal for %s with observed sample %s", (availabilityState, sample, state, signal) => {
    const evidence: BuilderEvidence = {resources: [{id, type: "Microsoft.App/containerApps", name: "orders", location: "westus", availabilityState}],
      observedMetrics: [{...metric, sample, unit: "Percent", observedAt: "2026-11-19T12:00:00Z"}]};
    const draft = workloadDiagram(analysis, [row], evidence);
    expect(draft.entities.map(e => e.kind)).toEqual(["Model root", "User flow", "System component", "Azure resource"]);
    const preview: Preview = {id: "review", title: "Orders", summary: "", tradeoff: "", structure: "planned",
      entities: draft.entities.map(({ name, displayName, resourceId }, index) => ({
        name, displayName, x: 20, y: 40 + index * 170, impact: "Standard", ...(resourceId && {resourceId}),
      })), relationships: draft.relationships, monitoringScopes: [], plan: "", modelspec: "", diff: {
        findings: [], verification: ["Azure Resource Health", "CpuPercentage"].map(name => ({
          entity: id, signal: name, status: "verified", query: name, value: 12, error: null,
        })),
      }};
    const designer = designerDiagram(preview, analysis, evidence);
    expect(designer.entities.map(e => e.kind)).toEqual(draft.entities.map(e => e.kind));
    for (const diagram of [draft, designer]) {
      expect(diagram.entities.find(e => e.resourceId === id)?.prediction).toEqual(state ? {state, signal} : undefined);
      expect(diagram.entities.filter(e => !e.resourceId).every(e => !e.prediction)).toBe(true);
    }
  });
});
