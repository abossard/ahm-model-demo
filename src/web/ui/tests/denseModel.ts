import type { Entity, HealthModel, Relationship } from "../src/model/types";

/**
 * Deterministic generated models used to prove edge routing on graphs denser than the six-node
 * repository fixture. The independent inspection found its counterexample with a generated
 * 12-node / 18-edge acyclic model rendered through `d3-force`; that model was not published, so
 * this generator reconstructs an equivalent family from a fixed seed. Nothing here is random at
 * run time: `mulberry32` is a pure integer hash, so graph `k` is byte-identical on every machine.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATES: readonly Entity["healthState"][] = ["Healthy", "Degraded", "Unhealthy", "Unknown"];

/**
 * One acyclic model with `nodes` entities and `edges` relationships. Every entity carries a
 * different signal count and name length, so the production card sizes vary the way a real model's
 * do rather than tiling one rectangle.
 */
export function denseModel(seed: number, nodes = 12, edges = 18): HealthModel {
  const random = mulberry32(seed);
  const entities: Entity[] = [];

  for (let index = 0; index < nodes; index += 1) {
    const signals = index % 4;
    entities.push({
      name: `n${index}`,
      displayName: `Node ${index}${index % 3 === 0 ? " with a considerably longer service name" : ""}`,
      healthState: STATES[index % STATES.length] as Entity["healthState"],
      impact: "Unknown",
      canvasPosition: null,
      discoveredBy: null,
      parents: [],
      children: [],
      unlinked: false,
      latestEvaluationAt: null,
      latestTransitionAt: null,
      signals: Array.from({ length: signals }, (_unused, row) => ({
        name: `n${index}s${row}`,
        displayName: `Signal ${row}`,
        kind: "metric" as const,
        healthState: STATES[(index + row) % STATES.length] as Entity["healthState"],
        value: row * 3,
        reportedAt: "2026-07-30T16:00:00Z",
        writable: false,
      })),
      report: { eligible: true, signalName: "web-ui-health-report" },
    });
  }

  // A parent is always a lower index than its child, so the relationship set is acyclic by
  // construction and every generated model is inside the supported contract.
  const seen = new Set<string>();
  const relationships: Relationship[] = [];
  for (let child = 1; child < nodes; child += 1) {
    const parent = Math.floor(random() * child);
    seen.add(`${parent}->${child}`);
    relationships.push({
      name: `g${seed}e${relationships.length}`,
      displayName: relationships.length % 3 === 0 ? "reads" : "",
      parentEntityName: `n${parent}`,
      childEntityName: `n${child}`,
    });
  }
  for (let guard = 0; guard < 400 && relationships.length < edges; guard += 1) {
    const child = 1 + Math.floor(random() * (nodes - 1));
    const parent = Math.floor(random() * child);
    if (seen.has(`${parent}->${child}`)) continue;
    seen.add(`${parent}->${child}`);
    relationships.push({
      name: `g${seed}e${relationships.length}`,
      displayName: relationships.length % 3 === 0 ? "reads" : "",
      parentEntityName: `n${parent}`,
      childEntityName: `n${child}`,
    });
  }

  for (const item of relationships) {
    const parent = entities.find((entry) => entry.name === item.parentEntityName) as Entity;
    const child = entities.find((entry) => entry.name === item.childEntityName) as Entity;
    (parent.children as string[]).push(child.name);
    (child.parents as string[]).push(parent.name);
  }

  return {
    model: {
      id: "/subscriptions/x/hm",
      name: `Generated model ${seed}`,
      location: "northeurope",
      provisioningState: "Succeeded",
      healthState: "Degraded",
    },
    observedAt: "2026-07-30T16:05:00Z",
    entities,
    relationships,
    reportOptions: {
      signalName: "web-ui-health-report",
      healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"],
      values: [null, 0, 0.5, 1],
      expiries: [15],
      reasonPresets: [{ value: "demo-test", label: "Demo test" }],
    },
  };
}

/**
 * The seed whose `d3-force` layout reproduces the independent inspection's counterexample. The
 * inspection published only the shape of its own generated case (12 nodes, 18 edges, one route
 * blocked through third-party card `n0`) and not the model itself, so this is the deterministic
 * equivalent this repository records: relationship `g6e12`, `n5 -> n9`, whose corridor has to pass
 * card `n0`. Before the bounded lane search it returned `clear:false` and painted straight through
 * `n0`; the rendered regression in `graph-ux.spec.ts` and the module sweep in `edgeRouting.test.ts`
 * both pin it.
 */
export const DENSE_SEED = 6;
export const DENSE_BLOCKED_EDGE = "g6e12";
export const DENSE_CROSSED_CARD = "n0";

export const REAL_SHARED_RUN_PAIRS: readonly (readonly [string, string])[] = [
  ["8da6b1cd-61e8-4206-9663-3cf7f6800221", "r-app-hosting-aks"],
  ["r-ask-copilot-ai-inference", "r-ask-copilot-app-hosting"],
];

const REAL_ENTITIES: readonly (readonly [string, string, number])[] = [
  ["hm-anbomov", "Movie Request Experience", 0],
  ["flow-ask-copilot", "Ask the Health Copilot", 0],
  ["platform-context", "Azure Platform Context", 3],
  ["request-journey", "Do A Queue Thingy", 0],
  ["flow-send-health-reports", "Send Health Reports", 0],
  ["flow-view-health-model", "View Health Model", 0],
  ["system-agent-runtime", "Agent Runtime", 0],
  ["system-ai-inference", "AI Inference", 0],
  ["system-app-hosting", "App Hosting", 0],
  ["system-database", "Database", 0],
  ["system-queueing", "Queueing", 0],
  ["agent-app", "Agent Backend Container App", 2],
  ["agent-web-app", "Agent Web Container App", 2],
  ["aks-cluster", "AKS Cluster", 4],
  ["openai-account", "Azure OpenAI Account", 2],
  ["6b69a031-0ec3-4492-a6ec-cb0245a7ae1f", "Cognitive-Accounts", 0],
  ["6e2c5ed8-1ecc-4222-8859-e3d9aa4c1a37", "kv-byoqtzrvfweq2", 3],
  ["postgres", "PostgreSQL Flexible Server", 6],
  ["container-app", "Python Container App", 8],
  ["queue-storage", "Queue Storage", 4],
  ["f99cd58d-c752-a02d-56d1-fa510780cf2f", "oai-anbomov-4dobgr3v2x2hq", 0],
  ["095831ae-6130-64a9-1db1-61c0e126fdc7", "oai-byoqtzrvfweq2", 0],
];

const REAL_RELATIONSHIPS: readonly (readonly [string, string, string, string | null])[] = [
  ["r-root-ask-copilot", "hm-anbomov", "flow-ask-copilot", "serves"],
  ["r-root-platform", "hm-anbomov", "platform-context", "observes platform context"],
  ["r-root-request-journey", "hm-anbomov", "request-journey", "serves"],
  ["r-root-send-health-reports", "hm-anbomov", "flow-send-health-reports", "serves"],
  ["r-root-view-health-model", "hm-anbomov", "flow-view-health-model", "serves"],
  ["r-ask-copilot-agent-runtime", "flow-ask-copilot", "system-agent-runtime", "reasons through"],
  ["r-ask-copilot-ai-inference", "flow-ask-copilot", "system-ai-inference", "infers through"],
  ["r-ask-copilot-app-hosting", "flow-ask-copilot", "system-app-hosting", "runs on"],
  ["r-request-journey-app-hosting", "request-journey", "system-app-hosting", "runs on"],
  ["r-request-journey-database", "request-journey", "system-database", "persists through"],
  ["r-request-journey-queueing", "request-journey", "system-queueing", "enqueues through"],
  ["r-send-health-reports-app-hosting", "flow-send-health-reports", "system-app-hosting", "runs on"],
  ["r-view-health-model-app-hosting", "flow-view-health-model", "system-app-hosting", "runs on"],
  ["r-agent-runtime-agent-app", "system-agent-runtime", "agent-app", "hosted by"],
  ["r-agent-runtime-agent-web", "system-agent-runtime", "agent-web-app", "hosted by"],
  ["r-ai-inference-openai", "system-ai-inference", "openai-account", "backed by"],
  ["8da6b1cd-61e8-4206-9663-3cf7f6800221", "system-ai-inference", "6b69a031-0ec3-4492-a6ec-cb0245a7ae1f", null],
  ["r-app-hosting-aks", "system-app-hosting", "aks-cluster", "hosted by"],
  [
    "system-app-hosting-6e2c5ed8-1ecc-4222-8859-e3d9aa4c1a37",
    "system-app-hosting",
    "6e2c5ed8-1ecc-4222-8859-e3d9aa4c1a37",
    null,
  ],
  ["r-app-hosting-container-app", "system-app-hosting", "container-app", "hosted by"],
  ["r-database-postgres", "system-database", "postgres", "backed by"],
  ["r-queueing-queue-storage", "system-queueing", "queue-storage", "backed by"],
  ["c2eabb98-5c7c-3dba-792a-0447f28f455e", "6b69a031-0ec3-4492-a6ec-cb0245a7ae1f", "f99cd58d-c752-a02d-56d1-fa510780cf2f", null],
  ["d944a551-93f1-48e7-afcf-dacddf2a1c70", "6b69a031-0ec3-4492-a6ec-cb0245a7ae1f", "095831ae-6130-64a9-1db1-61c0e126fdc7", null],
];

export function realAnbomovModel(): HealthModel {
  const entities: Entity[] = REAL_ENTITIES.map(([name, displayName, signalCount]) => ({
    name,
    displayName,
    healthState: "Healthy",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: Array.from({ length: signalCount }, (_unused, row) => ({
      name: `${name}-signal-${row}`,
      displayName: `Signal ${row}`,
      kind: "metric" as const,
      healthState: "Healthy",
      value: row,
      reportedAt: "2026-07-30T16:00:00Z",
      writable: false,
    })),
    report: { eligible: true, signalName: "web-ui-health-report" },
  }));
  const byName = new Map(entities.map((entry) => [entry.name, entry] as const));
  const relationships: Relationship[] = REAL_RELATIONSHIPS.map(
    ([name, parentEntityName, childEntityName, displayName]) => ({
      name,
      displayName,
      parentEntityName,
      childEntityName,
    }),
  );

  for (const relationship of relationships) {
    (byName.get(relationship.parentEntityName)?.children as string[] | undefined)?.push(
      relationship.childEntityName,
    );
    (byName.get(relationship.childEntityName)?.parents as string[] | undefined)?.push(
      relationship.parentEntityName,
    );
  }

  return {
    model: {
      id: "/subscriptions/x/resourceGroups/rg-anbomov/providers/Microsoft.CloudHealth/healthmodels/hm-anbomov",
      name: "hm-anbomov",
      location: "swedencentral",
      provisioningState: "Succeeded",
      healthState: "Healthy",
    },
    observedAt: "2026-09-09T07:56:00Z",
    entities,
    relationships,
    reportOptions: {
      signalName: "web-ui-health-report",
      healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"],
      values: [null, 0, 0.5, 1],
      expiries: [15],
      reasonPresets: [{ value: "demo-test", label: "Demo test" }],
    },
  };
}
