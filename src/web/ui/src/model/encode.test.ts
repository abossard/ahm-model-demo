import { describe, it, expect } from "vitest";
import { renderSwimlane } from "../diagrammo";
import { encodeSnapshot } from "./encode";
import type { Entity, HealthModelSnapshot, Relationship } from "./types";

const LONG_NAME =
  "Front Door Gateway with an intentionally very long descriptive display name that must never be truncated";

const ENTITIES: readonly Entity[] = [
  {
    name: "gateway-fe",
    displayName: LONG_NAME,
    healthState: "Healthy",
    impact: "Critical to customer checkout",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: ["orders-svc"],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [
      {
        name: "latency",
        displayName: "Latency p95",
        kind: "metric",
        healthState: "Healthy",
        value: 230,
        reportedAt: null,
        writable: false,
      },
      {
        name: "errors",
        displayName: "Error rate",
        kind: "metric",
        healthState: "Degraded",
        value: "4.2%",
        reportedAt: null,
        writable: false,
      },
    ],
    report: { eligible: true, signalName: "web-ui-health-report" },
  },
  {
    name: "orders-svc",
    displayName: "Orders Service",
    healthState: "Degraded",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: ["gateway-fe"],
    children: ["payments-db"],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [
      {
        name: "queue",
        displayName: "Queue depth",
        kind: "metric",
        healthState: "Unhealthy",
        value: 12,
        reportedAt: null,
        writable: true,
      },
    ],
    report: { eligible: true, signalName: "web-ui-health-report" },
  },
  {
    name: "payments-db",
    displayName: "Payments Database",
    healthState: "Unhealthy",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: ["orders-svc"],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: "web-ui-health-report" },
  },
  {
    name: "legacy-batch",
    displayName: "Legacy Batch Job",
    healthState: "Unknown",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: true,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: "web-ui-health-report" },
  },
  {
    name: "old-cache",
    displayName: "Retired Cache Tier",
    healthState: "Deleted",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: true,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [
      {
        name: "hits",
        displayName: "Cache hits",
        kind: "metric",
        healthState: "Unknown",
        value: null,
        reportedAt: null,
        writable: false,
      },
    ],
    report: { eligible: false, signalName: null },
  },
];

const RELATIONSHIPS: readonly Relationship[] = [
  {
    name: "r0",
    displayName: "reads",
    parentEntityName: "gateway-fe",
    childEntityName: "orders-svc",
  },
  {
    name: "r1",
    displayName: null,
    parentEntityName: "orders-svc",
    childEntityName: "payments-db",
  },
  {
    name: "r2",
    displayName: "ghost link",
    parentEntityName: "gateway-fe",
    childEntityName: "does-not-exist",
  },
];

const SNAPSHOT: HealthModelSnapshot = {
  entities: ENTITIES,
  relationships: RELATIONSHIPS,
};

const CARD_KEYS = ["h", "headerH", "id", "lane", "qualLines", "w", "x", "y"];

describe("encodeSnapshot", () => {
  const code = encodeSnapshot(SNAPSHOT);

  it("emits a bottom-up flowchart that preserves the full model", () => {
    expect(code).toContain("flowchart BT");

    expect(code).toContain(LONG_NAME);

    expect(code).toContain("Latency p95 = 230 (healthy)");
    expect(code).toContain("Error rate = 4.2% (degraded)");
    expect(code).toContain("Queue depth = 12 (unhealthy)");
    expect(code).toContain("Cache hits (unknown)");

    expect(code).toContain('e1 -- "reads" --> e0');
    expect(code).toContain("e2 --> e1");
    expect(code).not.toContain("does-not-exist");

    expect(code).toContain("class e0 green;");
    expect(code).toContain("class e1 amber;");
    expect(code).toContain("class e2 red;");
    expect(code).toContain("class e4 purple;");
    expect(code).toContain("class e0s,e1s,e4s blue;");
    expect(code).not.toMatch(/class [^\n]*\be3\b/);

    expect(code).not.toContain("e2s");
    expect(code).not.toContain("e3s");
    expect(code).toContain('e3["Legacy Batch Job"]');
  });

  it("renders through the vendored renderer with the expected card key set (re-vendor guard)", () => {
    const result = renderSwimlane(code, { theme: "portal", maxWidth: 900 });
    const firstCard = result.debug.cards[0];
    expect(firstCard).toBeDefined();
    expect(Object.keys(firstCard!).sort()).toEqual(CARD_KEYS);
    expect(result.debug.cards).toHaveLength(ENTITIES.length);
  });
});
