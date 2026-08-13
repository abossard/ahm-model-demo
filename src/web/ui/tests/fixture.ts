import type { Page } from "@playwright/test";
import type {
  Entity,
  EntityDetail,
  EntitySignal,
  HealthModel,
  HealthReportResult,
  JourneyResult,
  ModelCatalog,
} from "../src/model/types";

function signal(
  name: string,
  displayName: string,
  value: EntitySignal["value"],
  healthState: EntitySignal["healthState"],
): EntitySignal {
  return {
    name,
    displayName,
    kind: "metric",
    healthState,
    value,
    reportedAt: "2026-07-30T16:00:00Z",
    writable: name === "web-ui-health-report",
  };
}

function entity(base: Partial<Entity> & Pick<Entity, "name" | "displayName" | "healthState">): Entity {
  return {
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: base.healthState !== "Deleted", signalName: "web-ui-health-report" },
    ...base,
  };
}

const svcA = entity({
  name: "svc-a",
  displayName: "Service A",
  healthState: "Healthy",
  impact: "High",
  children: ["svc-b", "svc-d"],
  signals: [
    signal("cpu", "CPU", 0.2, "Healthy"),
    signal("latency", "Latency", 980, "Degraded"),
    signal("errors", "Errors", 0, "Healthy"),
  ],
});

const svcB = entity({
  name: "svc-b",
  displayName: "Service B",
  healthState: "Degraded",
  parents: ["svc-a"],
  children: ["svc-c"],
  signals: [signal("queue", "Queue", 42, "Degraded")],
});

const svcC = entity({
  name: "svc-c",
  displayName: "Service C",
  healthState: "Unhealthy",
  parents: ["svc-b"],
  signals: [],
});

const svcD = entity({
  name: "svc-d",
  displayName: "Service D",
  healthState: "Unknown",
  parents: ["svc-a"],
  signals: [signal("heartbeat", "Heartbeat", null, "Unknown")],
});

const svcE = entity({
  name: "svc-e",
  displayName: "Service E (retired)",
  healthState: "Deleted",
  unlinked: true,
  signals: [],
});

const svcF = entity({
  name: "svc-f",
  displayName: "Very Long Downstream Analytics And Reporting Service Name",
  healthState: "Healthy",
  unlinked: true,
  signals: [signal("ok", "OK", 1, "Healthy")],
});

export const healthModel: HealthModel = {
  model: {
    id: "/subscriptions/x/hm",
    name: "Contoso Platform Health",
    location: "northeurope",
    provisioningState: "Succeeded",
    healthState: "Degraded",
  },
  observedAt: "2026-07-30T16:05:00Z",
  entities: [svcA, svcB, svcC, svcD, svcE, svcF],
  relationships: [
    { name: "r1", displayName: "reads", parentEntityName: "svc-a", childEntityName: "svc-b" },
    { name: "r2", displayName: "writes", parentEntityName: "svc-b", childEntityName: "svc-c" },
    { name: "r3", displayName: "queries", parentEntityName: "svc-a", childEntityName: "svc-d" },
    { name: "r4", displayName: "", parentEntityName: "svc-d", childEntityName: "svc-c" },
  ],
  reportOptions: {
    signalName: "web-ui-health-report",
    healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"],
    values: [null, 0, 0.5, 1],
    expiries: [1, 5, 15, 30, 60, 120],
    reasonPresets: [
      { value: "demo-test", label: "Demo test" },
      { value: "investigating", label: "Investigating" },
      { value: "maintenance", label: "Maintenance window" },
      { value: "recovery", label: "Recovery confirmed" },
      { value: "custom", label: "Custom reason" },
    ],
  },
};

const detailA: EntityDetail = {
  entity: svcA,
  observedAt: "2026-07-30T16:05:00Z",
  transitions: [
    { previousState: "Healthy", healthState: "Degraded", occurredAt: "2026-07-29T10:00:00Z" },
    { previousState: "Degraded", healthState: "Healthy", occurredAt: "2026-07-29T12:30:00Z" },
  ],
  canonicalSignal: {
    name: "web-ui-health-report",
    current: signal("web-ui-health-report", "Web UI health report", 1, "Healthy"),
    history: [
      {
        healthState: "Degraded",
        value: 0.5,
        occurredAt: "2026-07-29T10:00:00Z",
        source: "health-pulse-web",
        reportId: "prev-1",
        reason: "Investigating",
      },
      { healthState: "Healthy", value: 1, occurredAt: "2026-07-29T12:30:00Z" },
    ],
  },
};

const detailE: EntityDetail = {
  entity: svcE,
  observedAt: "2026-07-30T16:05:00Z",
  transitions: [
    { previousState: "Unhealthy", healthState: "Deleted", occurredAt: "2026-07-28T08:00:00Z" },
  ],
  canonicalSignal: { name: "web-ui-health-report", current: null, history: [] },
};

export const entityDetails: Readonly<Record<string, EntityDetail>> = {
  "svc-a": detailA,
  "svc-e": detailE,
};

export const reportResponse: HealthReportResult = {
  status: "accepted",
  reportId: "rpt-9f3c",
  entityName: "svc-a",
  signalName: "web-ui-health-report",
  requestedState: "Degraded",
  submittedAt: "2026-07-30T16:06:00Z",
  expiresAt: "2026-07-30T16:21:00Z",
};

export const journeyResponse: JourneyResult = {
  request_id: "req-abc-123",
  queue_head: { request_id: "req-old-000" },
  row_count: 4217,
};

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, retryable: true, operationId: "op-1" } };
}

export interface StubState {
  healthModelFails: boolean;
  model?: HealthModel;
  catalog?: ModelCatalog;
  modelsByName?: Readonly<Record<string, HealthModel>>;
}

const shardStates: readonly Entity["healthState"][] = [
  "Healthy",
  "Degraded",
  "Unhealthy",
  "Healthy",
  "Unknown",
  "Degraded",
  "Healthy",
  "Unhealthy",
];

const shards: readonly Entity[] = shardStates.map((healthState, index) =>
  entity({
    name: `shard-${index + 1}`,
    displayName: `Payment gateway shard ${index + 1}`,
    healthState,
    parents: ["platform"],
    signals: [signal("lat", "Latency", index * 3, healthState)],
  }),
);

export const wideHealthModel: HealthModel = {
  ...healthModel,
  entities: [
    entity({
      name: "platform",
      displayName: "Contoso Platform",
      healthState: "Degraded",
      children: shards.map((shard) => shard.name),
    }),
    ...shards,
  ],
  relationships: shards.map((shard, index) => ({
    name: `rw${index}`,
    displayName: "",
    parentEntityName: "platform",
    childEntityName: shard.name,
  })),
};

export const modelCatalog: ModelCatalog = {
  models: [
    {
      id: "/subscriptions/x/resourceGroups/rg-demo/providers/Microsoft.CloudHealth/healthmodels/hm-demo",
      name: "hm-demo",
      resourceGroup: "rg-demo",
      location: "northeurope",
      provisioningState: "Succeeded",
    },
    {
      id: "/subscriptions/x/resourceGroups/rg-demo/providers/Microsoft.CloudHealth/healthmodels/hm-payments",
      name: "hm-payments",
      resourceGroup: "rg-demo",
      location: "northeurope",
      provisioningState: "Succeeded",
    },
    {
      id: "/subscriptions/x/resourceGroups/rg-eu/providers/Microsoft.CloudHealth/healthmodels/hm-eu",
      name: "hm-eu",
      resourceGroup: "rg-eu",
      location: "westeurope",
      provisioningState: "Creating",
    },
  ],
  default: { name: "hm-demo", resourceGroup: "rg-demo" },
};

const paymentsShards: readonly Entity[] = ["Healthy", "Unhealthy"].map((healthState, index) =>
  entity({
    name: `pay-${index + 1}`,
    displayName: `Payments shard ${index + 1}`,
    healthState: healthState as Entity["healthState"],
    parents: ["pay-root"],
  }),
);

export const paymentsHealthModel: HealthModel = {
  ...healthModel,
  model: { ...healthModel.model, name: "Contoso Payments Health", healthState: "Unhealthy" },
  observedAt: "2026-07-30T16:09:00Z",
  entities: [
    entity({
      name: "pay-root",
      displayName: "Payments",
      healthState: "Unhealthy",
      children: paymentsShards.map((shard) => shard.name),
    }),
    ...paymentsShards,
  ],
  relationships: paymentsShards.map((shard, index) => ({
    name: `rp${index}`,
    displayName: "",
    parentEntityName: "pay-root",
    childEntityName: shard.name,
  })),
};

export async function installStubs(page: Page, state: StubState): Promise<void> {
  const model = state.model ?? healthModel;
  const catalog = state.catalog ?? modelCatalog;
  const byModel = state.modelsByName ?? {};
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/health-models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalog) });
      return;
    }

    if (pathname === "/api/health-model") {
      if (state.healthModelFails) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify(
            errorEnvelope("sdk_unavailable", "The health model service is unavailable."),
          ),
        });
        return;
      }
      const requested = byModel[searchParams.get("model") ?? ""] ?? model;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(requested) });
      return;
    }

    if (pathname === "/api/demo-request" && method === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(journeyResponse) });
      return;
    }

    const reportMatch = /^\/api\/entities\/([^/]+)\/health-reports$/.exec(pathname);
    if (reportMatch && method === "POST") {
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(reportResponse) });
      return;
    }

    const entityMatch = /^\/api\/entities\/([^/]+)$/.exec(pathname);
    if (entityMatch && method === "GET") {
      const name = decodeURIComponent(entityMatch[1] ?? "");
      const detail = entityDetails[name];
      if (detail) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify(errorEnvelope("entity_not_found", "The entity is no longer present.")),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify(errorEnvelope("not_found", "Unknown route.")),
    });
  });
}
