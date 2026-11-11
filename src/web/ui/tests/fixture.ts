import type { Page } from "@playwright/test";
import type {
  AuthConfig,
  Entity,
  EntityDetail,
  EntitySignal,
  HealthModel,
  HealthReportResult,
  ModelCatalog,
} from "../src/model/types";
import liveJson from "./liveModel.json" with { type: "json" };

export function signal(
  name: string,
  displayName: string | null,
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

export function entity(base: Partial<Entity> & Pick<Entity, "name" | "displayName" | "healthState">): Entity {
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
  latestEvaluationAt: "2026-07-30T16:00:00Z",
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
  latestEvaluationAt: "2026-07-28T09:00:00Z",
  name: "svc-e",
  displayName: "Service E (retired)",
  healthState: "Deleted",
  unlinked: true,
  signals: [],
});

const svcF = entity({
  latestEvaluationAt: "2026-07-29T12:00:00Z",
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
    healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown"],
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

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, retryable: true, operationId: "op-1" } };
}

/** What the app says when it runs as the developer's own identity: nobody signs in and no call carries a token. */
export const LOCAL_CONFIG: AuthConfig = { authMode: "local", clientId: null, apiScope: null };

export interface StubState {
  healthModelFails: boolean;
  /** The sign-in settings `GET /api/config` answers; local mode unless a test signs in. */
  authConfig?: AuthConfig;
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

const GUID_APP = "81db2f7a-697d-c4ed-5d5f-251344a971fe";
const GUID_STORAGE = "2cfe8745-bb71-b592-3736-7d3343a007dc";

/** Signal names of a discovered storage account: GUIDs, with no display name. */
export const DISCOVERED_SIGNALS = [
  { name: "b2040e11-7b13-49c5-8693-dc6e8a4b6f2d", value: 100 },
  { name: "8f7f5e6b-6c15-4d14-b886-dd2e3a8f01aa", value: 6.9821428571428575 },
  { name: "61d053e0-63c6-44da-b109-dd511f3b9c27", value: 3.8214285714285716 },
] as const;

/**
 * What the deployed app serves: discovered entities with GUID names and no canvas position, signals that have
 * no display name, and metrics whose values are long fractions.
 */
export const realShapeModel: HealthModel = {
  ...healthModel,
  model: { ...healthModel.model, name: "hm-real", healthState: "Healthy" },
  entities: [
    entity({
      name: "hm-real",
      displayName: "Health Pulse",
      healthState: "Healthy",
      impact: "Standard",
      canvasPosition: { x: 560, y: 40 },
      children: ["container-app"],
    }),
    entity({
      name: "container-app",
      displayName: "Web Container App",
      healthState: "Healthy",
      impact: "Standard",
      canvasPosition: { x: 200, y: 190 },
      parents: ["hm-real"],
      signals: [signal("failed-requests", "Failed application requests", 0, "Healthy"), signal("cpu", "CPU percentage", null, "Unknown")],
    }),
    entity({
      name: "discover-app-insights",
      displayName: "Application Insights topology",
      healthState: "Healthy",
      discoveredBy: "discover-app-insights",
      children: [GUID_APP],
    }),
    entity({
      name: GUID_APP,
      displayName: "contosodemo",
      healthState: "Healthy",
      discoveredBy: "discover-app-insights",
      parents: ["discover-app-insights"],
      children: [GUID_STORAGE],
      signals: [signal("failed-requests-contosodemo", "Failed requests contosodemo", 0, "Healthy")],
    }),
    entity({
      name: GUID_STORAGE,
      displayName: "stcontosodemo00001",
      healthState: "Healthy",
      discoveredBy: "discover-app-insights",
      parents: [GUID_APP],
      signals: DISCOVERED_SIGNALS.map(({ name, value }) => signal(name, null, value, "Healthy")),
    }),
  ],
  relationships: [
    { name: "r-root-app", displayName: "serves", parentEntityName: "hm-real", childEntityName: "container-app" },
    { name: "r-discover-app", displayName: "", parentEntityName: "discover-app-insights", childEntityName: GUID_APP },
    { name: "r-app-storage", displayName: "", parentEntityName: GUID_APP, childEntityName: GUID_STORAGE },
  ],
};

/** The deployed model as it looked on 2026-11-11: 17 entities, 17 relationships, labels on most of them. */
export const liveShapeModel: HealthModel = (() => {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const item of liveJson.relationships) {
    children.set(item.parentEntityName, [...(children.get(item.parentEntityName) ?? []), item.childEntityName]);
    parents.set(item.childEntityName, [...(parents.get(item.childEntityName) ?? []), item.parentEntityName]);
  }
  return {
    ...healthModel,
    model: { ...healthModel.model, name: "hm-live", healthState: "Healthy" },
    entities: liveJson.entities.map((item) =>
      entity({
        name: item.name,
        displayName: item.displayName,
        healthState: "Healthy",
        parents: parents.get(item.name) ?? [],
        children: children.get(item.name) ?? [],
        signals: Array.from({ length: item.signals }, (_unused, row) => signal(`${item.name}-${row}`, `Signal ${row}`, row, "Healthy")),
      }),
    ),
    relationships: liveJson.relationships.map((item, index) => ({ name: `live-${index}`, ...item })),
  };
})();

export const SUBSCRIPTION_A = "11111111-1111-1111-1111-111111111111";
export const SUBSCRIPTION_B = "22222222-2222-2222-2222-222222222222";

export const modelCatalog: ModelCatalog = {
  models: [
    {
      id: `/subscriptions/${SUBSCRIPTION_A}/resourceGroups/rg-demo/providers/Microsoft.CloudHealth/healthmodels/hm-demo`,
      name: "hm-demo",
      resourceGroup: "rg-demo",
      subscriptionId: SUBSCRIPTION_A,
      location: "northeurope",
      provisioningState: "Succeeded",
    },
    {
      id: `/subscriptions/${SUBSCRIPTION_A}/resourceGroups/rg-demo/providers/Microsoft.CloudHealth/healthmodels/hm-payments`,
      name: "hm-payments",
      resourceGroup: "rg-demo",
      subscriptionId: SUBSCRIPTION_A,
      location: "northeurope",
      provisioningState: "Succeeded",
    },
    {
      id: `/subscriptions/${SUBSCRIPTION_B}/resourceGroups/rg-eu/providers/Microsoft.CloudHealth/healthmodels/hm-eu`,
      name: "hm-eu",
      resourceGroup: "rg-eu",
      subscriptionId: SUBSCRIPTION_B,
      location: "westeurope",
      provisioningState: "Creating",
    },
  ],
  default: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A },
};

/** The model, group and subscription keys every selector scoped request has to carry. */
function selectorKeys(searchParams: URLSearchParams): readonly (string | null)[] {
  return [
    searchParams.get("model"),
    searchParams.get("resourceGroup"),
    searchParams.get("subscription"),
  ];
}

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
  let streamRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/config") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.authConfig ?? LOCAL_CONFIG) });
      return;
    }

    if (pathname === "/api/health-models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalog) });
      return;
    }

    // The live stream of the model: a snapshot of the stubbed model, then an open connection that stays quiet. A spec that
    // wants events registers its own route for it after this one (tests/liveStub.ts).
    if (pathname === "/api/health-model/stream") {
      streamRequests += 1;
      if (streamRequests > 1) return new Promise<void>(() => undefined);
      const shown = byModel[searchParams.get("model") ?? ""] ?? model;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: `retry: 3600000\n\nid: stub-0\nevent: snapshot\ndata: ${JSON.stringify(shown)}\n\n`,
      });
      return;
    }

    const scoped = selectorKeys(searchParams).every((key) => key !== null && key !== "");
    if (!scoped && (pathname === "/api/health-model" || pathname.startsWith("/api/entities/"))) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify(
          errorEnvelope("invalid_selector", "model, resourceGroup and subscription are required."),
        ),
      });
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
