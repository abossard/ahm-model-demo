import type { DiffChange, DiffView, Entity, EntitySignal, HealthModel, HealthState, Relationship } from "../src/model/types";
import liveJson from "./liveModel.json" with { type: "json" };

/**
 * Models for the graph views, shaped like the deployed one (`liveModel.json`: 17 entities, 17
 * relationships) and like a large one. Every state is stated or follows from its children the way
 * a worst-of rollup gives it: Limited caps a child at Degraded, Suppressed leaves it out.
 */

const RANK: Readonly<Record<string, number>> = { Healthy: 0, Unknown: 1, Degraded: 2, Unhealthy: 3 };

function signal(name: string, displayName: string, value: EntitySignal["value"], healthState: HealthState): EntitySignal {
  return { name, displayName, kind: "metric", healthState, value, reportedAt: "2026-07-30T16:00:00Z", writable: false };
}

function entityOf(name: string, displayName: string, signals: readonly EntitySignal[] = [], impact = "Standard"): Entity {
  return {
    name,
    displayName,
    healthState: "Healthy",
    impact,
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals,
    report: { eligible: true, signalName: "web-ui-health-report" },
  };
}

/** Parents take the worst state of the children that count; leaves take the worst of their signals. */
function settle(entities: readonly Entity[], relationships: readonly Relationship[], stated: ReadonlyMap<string, HealthState>): Entity[] {
  const byName = new Map(entities.map((item) => [item.name, item] as const));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const item of relationships) {
    children.set(item.parentEntityName, [...(children.get(item.parentEntityName) ?? []), item.childEntityName]);
    parents.set(item.childEntityName, [...(parents.get(item.childEntityName) ?? []), item.parentEntityName]);
  }
  const state = new Map<string, HealthState>();
  const visit = (name: string): HealthState => {
    const known = state.get(name);
    if (known) return known;
    const entity = byName.get(name) as Entity;
    let worst: HealthState = stated.get(name) ?? "Healthy";
    for (const signalItem of entity.signals) if ((RANK[signalItem.healthState] ?? 0) > (RANK[worst] ?? 0)) worst = signalItem.healthState;
    for (const child of children.get(name) ?? []) {
      const found = byName.get(child) as Entity;
      const childState = visit(child);
      if (found.impact === "Suppressed") continue;
      const seen: HealthState = found.impact === "Limited" && childState === "Unhealthy" ? "Degraded" : childState;
      if ((RANK[seen] ?? 0) > (RANK[worst] ?? 0)) worst = seen;
    }
    state.set(name, worst);
    return worst;
  };
  return entities.map((item) => ({
    ...item,
    healthState: visit(item.name),
    parents: parents.get(item.name) ?? [],
    children: children.get(item.name) ?? [],
  }));
}

function modelOf(name: string, entities: readonly Entity[], relationships: readonly Relationship[]): HealthModel {
  const root = entities[0] as Entity;
  return {
    model: { id: `/subscriptions/x/hm/${name}`, name, location: "northeurope", provisioningState: "Succeeded", healthState: root.healthState },
    observedAt: "2026-07-30T16:05:00Z",
    entities,
    relationships,
    reportOptions: {
      signalName: "web-ui-health-report",
      healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown"],
      values: [null, 0, 0.5, 1],
      expiries: [1, 5, 15, 30, 60, 120],
      reasonPresets: [{ value: "demo-test", label: "Demo test" }],
    },
  };
}

const DISCOVERED = new Set(["discovered-app-topology", "discover-app-insights", "81db2f7a-697d-c4ed-5d5f-251344a971fe", "2cfe8745-bb71-b592-3736-7d3343a007dc"]);

function live(incident: boolean): HealthModel {
  const relationships: Relationship[] = liveJson.relationships.map((item, index) => ({ name: `live-${index}`, ...item }));
  const own: Readonly<Record<string, readonly EntitySignal[]>> = incident
    ? {
        "session-storage": [signal("availability", "Availability", 91.4, "Unhealthy"), signal("e2e-latency", "Success E2E latency", 38, "Healthy")],
        "hosted-agent": [signal("replica-restarts", "Replica restarts", 0, "Healthy"), signal("cold-start-rate", "Cold start rate", 4.1, "Degraded")],
      }
    : {};
  const stated = new Map<string, HealthState>();
  const entities = liveJson.entities.map((item) => {
    const discovered = DISCOVERED.has(item.name);
    if (discovered) stated.set(item.name, "Unknown");
    const signals = own[item.name] ?? Array.from({ length: item.signals }, (_unused, row) => signal(`${item.name}-${row}`, `Signal ${row}`, row, discovered ? "Unknown" : "Healthy"));
    return entityOf(item.name, item.displayName, signals, discovered ? "Suppressed" : item.name === "system-session-store" ? "Limited" : "Standard");
  });
  return modelOf(incident ? "hm-incident" : "hm-calm", settle(entities, relationships, stated), relationships);
}

/** The live model with one failing leaf: Session Storage, whose Limited parent only degrades the flow. */
export function incidentModel(): HealthModel {
  return live(true);
}

/** The live model with nothing wrong: Healthy, with the discovered entities Unknown and Suppressed. */
export function calmModel(): HealthModel {
  return live(false);
}

/**
 * A diff on the incident model, as a Review task returns it: Report Queue added under App Hosting
 * (one new relationship), Pager Webhook added and not connected, Web Container App and AI
 * Inference changed, Discovered Application Topology removed. `base` and `proposed` are the two
 * snapshots; Compare draws their union.
 */
export function diffViewModel(): DiffView {
  const base = incidentModel();
  const queue = entityOf("report-queue", "Report Queue", [signal("queue-depth", "Queue depth", 3, "Healthy"), signal("queue-age", "Oldest message age", 12, "Healthy")]);
  const pager = { ...entityOf("pager-webhook", "Pager Webhook"), unlinked: true };
  const joined: Relationship = { name: "live-report-queue", displayName: "buffers through", parentEntityName: "system-app-hosting", childEntityName: "report-queue" };
  const proposedEntities = base.entities
    .filter((item) => item.name !== "discovered-app-topology")
    .map((item) => (item.name === "system-ai-inference" ? { ...item, impact: "Limited" } : item));
  const change = (id: string, op: DiffChange["op"], kind: DiffChange["kind"], name: string, after: DiffChange["after"], before: DiffChange["before"], details: DiffChange["details"] = []): DiffChange => ({
    id, op, kind, name, after, before, reason: "Proposed by the Review task.", details, dependsOn: [], verification: [],
  });
  const changes: DiffChange[] = [
    change("c1", "add", "entity", "report-queue", { displayName: "Report Queue" }, null),
    change("c2", "add", "relationship", joined.name, { parentEntityName: joined.parentEntityName, childEntityName: joined.childEntityName }, null),
    change("c3", "add", "entity", "pager-webhook", { displayName: "Pager Webhook" }, null),
    change("c4", "change", "entity", "container-app", { displayName: "Web Container App" }, { displayName: "Web Container App" }, [{ path: "CPU rule", before: "> 85 %", after: "> 80 %" }]),
    change("c5", "change", "entity", "system-ai-inference", { impact: "Limited" }, { impact: "Standard" }, [{ path: "Impact", before: "Standard", after: "Limited" }]),
    change("c6", "remove", "entity", "discovered-app-topology", null, { displayName: "Discovered Application Topology" }),
  ];
  return {
    base: { entities: base.entities, relationships: base.relationships },
    proposed: {
      entities: [...proposedEntities, queue, pager],
      relationships: [...base.relationships.filter((item) => item.childEntityName !== "discovered-app-topology"), joined],
    },
    changes,
    verification: [],
    findings: [],
    summary: "Add a report queue, retire the discovered topology.",
    target: { name: "hm-incident", resourceGroup: "rg-demo", subscriptionId: "11111111-1111-1111-1111-111111111111" },
    appliable: true,
    applies: [],
  };
}

// ---- a large model: 8 flows, 16 systems, about 50 resources, shared and skipping relationships ----
const FLOWS: readonly (readonly [string, readonly string[]])[] = [
  ["Sign in", ["Identity", "API gateway", "Edge and CDN", "Caching"]],
  ["Browse catalog", ["API gateway", "Catalog service", "Edge and CDN", "Caching"]],
  ["Search products", ["Search", "API gateway", "Catalog service"]],
  ["Manage cart", ["Cart service", "Caching", "API gateway", "Inventory"]],
  ["Checkout", ["Order service", "Payments", "Inventory", "Notifications", "Cart service"]],
  ["Track orders", ["Order service", "Notifications", "Messaging"]],
  ["Get recommendations", ["Recommendations", "Data platform", "Catalog service"]],
  ["Admin reporting", ["Data platform", "Batch jobs", "Observability", "Identity"]],
];
const SYSTEMS: readonly (readonly [string, readonly string[]])[] = [
  ["Identity", ["entra-tenant", "kv-identity", "app-auth-api"]],
  ["API gateway", ["apim-shop", "afd-edge", "waf-policy"]],
  ["Catalog service", ["app-catalog", "cosmos-catalog", "redis-catalog", "st-images"]],
  ["Search", ["search-catalog", "func-indexer", "st-index"]],
  ["Cart service", ["app-cart", "redis-cart", "sql-cart"]],
  ["Order service", ["app-orders", "sql-orders", "sb-orders", "func-order-events"]],
  ["Payments", ["app-payments", "kv-payments", "psp-gateway-conn"]],
  ["Notifications", ["func-notify", "sb-notify", "acs-email"]],
  ["Inventory", ["app-inventory", "sql-inventory", "func-stock-sync"]],
  ["Recommendations", ["aks-reco-pool", "cosmos-reco", "ml-endpoint"]],
  ["Data platform", ["adls-lake", "adf-pipelines", "synapse-wh", "st-exports"]],
  ["Messaging", ["sb-core", "eh-telemetry", "st-checkpoints"]],
  ["Caching", ["redis-shared", "redis-session"]],
  ["Edge and CDN", ["cdn-assets", "dns-zone", "st-static"]],
  ["Observability", ["law-core", "appi-shop", "grafana-ws"]],
  ["Batch jobs", ["func-nightly", "st-batch", "sql-reporting"]],
];
const SHARED: readonly (readonly [string, string])[] = [
  ["Order service", "sb-core"], ["Notifications", "sb-core"], ["Cart service", "redis-shared"], ["Catalog service", "redis-shared"],
  ["Identity", "kv-payments"], ["Data platform", "sql-reporting"], ["Recommendations", "st-index"],
];
const FAILING: Readonly<Record<string, readonly [HealthState, string, number]>> = {
  "sql-orders": ["Unhealthy", "Connection failures", 11.8],
  "func-nightly": ["Unhealthy", "Failures", 9.4],
  "redis-session": ["Degraded", "Server load", 83],
  "cdn-assets": ["Degraded", "Availability", 99.3],
  "aks-reco-pool": ["Degraded", "CPU", 91],
  "adf-pipelines": ["Degraded", "Execution delay", 52],
  "kv-payments": ["Degraded", "Availability", 99.2],
  "sb-notify": ["Degraded", "Dead-letter count", 18],
};
const UNKNOWN_LEAVES = new Set(["ml-endpoint", "grafana-ws", "st-exports"]);
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** 81 entities and about 100 relationships: two failing leaves, six degraded, three unknown, a few with several parents. */
export function denseIncidentModel(): HealthModel {
  const entities: Entity[] = [entityOf("root", "Contoso Shop")];
  const relationships: Relationship[] = [];
  const stated = new Map<string, HealthState>();
  const link = (parent: string, child: string, displayName = ""): void => {
    relationships.push({ name: `d-${relationships.length}`, displayName, parentEntityName: parent, childEntityName: child });
  };
  for (const [name] of FLOWS) {
    entities.push(entityOf(`flow-${slug(name)}`, name));
    link("root", `flow-${slug(name)}`, "serves");
  }
  for (const [name] of SYSTEMS) entities.push(entityOf(`sys-${slug(name)}`, name, [], name === "Order service" ? "Limited" : "Standard"));
  for (const [flow, systems] of FLOWS) systems.forEach((system, index) => link(`flow-${slug(flow)}`, `sys-${slug(system)}`, ["runs on", "uses", "", "depends on"][index % 4]));
  const placed = new Set<string>();
  for (const [system, resources] of SYSTEMS) {
    for (const resource of resources) {
      if (!placed.has(resource)) {
        placed.add(resource);
        const failing = FAILING[resource];
        const signals = failing
          ? [signal(`${resource}-main`, failing[1], failing[2], failing[0]), signal(`${resource}-ok`, "Latency p95", 120, "Healthy")]
          : UNKNOWN_LEAVES.has(resource)
            ? [signal(`${resource}-main`, "Availability", null, "Unknown")]
            : [signal(`${resource}-main`, "Availability", 99.98, "Healthy"), signal(`${resource}-ok`, "Latency p95", 120, "Healthy")];
        entities.push(entityOf(`res-${resource}`, resource, signals, resource === "grafana-ws" ? "Suppressed" : "Standard"));
      }
      link(`sys-${slug(system)}`, `res-${resource}`, ["backed by", "hosted by", "", ""][(placed.size + resource.length) % 4]);
    }
  }
  for (const [system, resource] of SHARED) link(`sys-${slug(system)}`, `res-${resource}`, "shared");
  for (const [flow, resource] of [["Checkout", "kv-payments"], ["Search products", "st-index"], ["Track orders", "sb-orders"]] as const) link(`flow-${slug(flow)}`, `res-${resource}`, "direct");
  link("root", "res-law-core", "observes");
  link("root", "res-dns-zone", "resolves through");
  entities.push(entityOf("platform-context", "Azure Platform Context", [signal("platform-health", "Azure service health events", 0, "Healthy")]));
  link("root", "platform-context", "observes platform context");
  for (const [name, title] of [["discovered-topology", "Discovered Application Topology"], ["discover-net", "Network topology discovery"], ["vnet-core", "vnet-core"], ["pe-sql", "pe-sql-orders"], ["pe-kv", "pe-kv-payments"]] as const) {
    entities.push(entityOf(name, title, [], "Suppressed"));
    stated.set(name, "Unknown");
  }
  link("root", "discovered-topology", "supplements with discovery");
  link("discover-net", "vnet-core");
  link("vnet-core", "pe-sql");
  link("vnet-core", "pe-kv");
  return modelOf("hm-dense", settle(entities, relationships, stated), relationships);
}
