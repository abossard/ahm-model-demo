import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../model/live";
import type { Entity, HealthModel, ModelCatalog } from "../model/types";
import * as api from "../store/api";
import { actions, useStore } from "../store/store";
import { App } from "./App";

vi.mock("../store/api");

// The graph is drawn by React Flow; counting how often it is asked to draw says whether the graph re-rendered.
vi.mock("@xyflow/react", () => ({
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  Handle: () => null,
  Background: () => null,
  MiniMap: () => null,
  ReactFlowProvider: ({ children }: { children?: unknown }) => children ?? null,
  useStore: () => undefined,
  useReactFlow: () => ({ fitView: () => Promise.resolve(true) }),
  ReactFlow: (props: { nodes?: unknown[] }) => {
    (globalThis as unknown as { __draws: number }).__draws += 1;
    (globalThis as unknown as { __nodes: unknown[] }).__nodes = props.nodes ?? [];
    return null;
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draws = (): number => (globalThis as unknown as { __draws: number }).__draws;
const frames: (() => void)[] = [];

const MODEL_REF = { id: null, name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a", location: null, provisioningState: null };
const CATALOG: ModelCatalog = { models: [MODEL_REF], default: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" } };

function entity(index: number): Entity {
  return {
    name: `e${index}`,
    displayName: `Entity ${index}`,
    healthState: index % 3 === 0 ? "Degraded" : "Healthy",
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: index === 0 ? [] : ["e0"],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
  };
}

const MODEL: HealthModel = {
  model: { id: null, name: "hm-a", location: null, provisioningState: null, healthState: "Healthy" },
  observedAt: "2026-11-10T10:00:00Z",
  entities: Array.from({ length: 24 }, (_, index) => entity(index)),
  relationships: Array.from({ length: 23 }, (_, index) => ({
    name: `r${index + 1}`,
    displayName: null,
    parentEntityName: "e0",
    childEntityName: `e${index + 1}`,
  })),
  reportOptions: { signalName: "s", healthStates: ["Healthy"], values: [null], expiries: [1], reasonPresets: [] },
};


interface Node {
  readonly id: string;
  readonly data: unknown;
}
const nodes = (): Node[] => (globalThis as unknown as { __nodes: Node[] }).__nodes as Node[];
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("a model that changes while it is on screen", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handlers: api.ModelStreamHandlers;

  const emit = (event: LiveEvent): Promise<void> => act(async () => handlers.onEvent(event));
  const changed = (name: string, state: Entity["healthState"]): Entity => ({ ...(MODEL.entities.find((item) => item.name === name) as Entity), healthState: state });

  beforeEach(async () => {
    (globalThis as unknown as { __draws: number }).__draws = 0;
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    vi.mocked(api.fetchModelCatalog).mockResolvedValue(CATALOG);
    vi.mocked(api.fetchHealthModel).mockResolvedValue(MODEL);
    vi.mocked(api.fetchSessions).mockResolvedValue([]);
    vi.mocked(api.openModelStream).mockImplementation((_selection, given) => {
      handlers = given;
      return { close: () => undefined };
    });
    useStore.setState(useStore.getInitialState(), true);
    window.history.replaceState(null, "", "/");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await act(async () => {
      await actions.loadModelCatalog("");
      await flush();
    });
    await act(async () => handlers.onStatus("open"));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("opens one stream for the model on screen", () => {
    expect(vi.mocked(api.openModelStream)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().liveStatus).toBe("live");
  });

  it("draws the graph again for nothing that the graph shows: a delta with only a time, or a new point", async () => {
    const settled = draws();
    expect(settled).toBeGreaterThan(0);

    for (let tick = 1; tick <= 20; tick += 1) await emit({ kind: "delta", id: `e-${tick}`, delta: { observedAt: `2026-11-10T10:00:${String(tick).padStart(2, "0")}Z`, timeline: { points: [{ entity: "e1", signal: "cpu", points: [[tick, 1, 1]] }] } } });

    expect(draws()).toBe(settled);
  });

  it("a state change reaches the graph at once; no node that was healthy and stayed healthy is rebuilt", async () => {
    const before = new Map(nodes().map((node) => [node.id, node.data]));
    const settled = draws();

    await emit({ kind: "delta", id: "e-1", delta: { observedAt: "2026-11-10T10:00:30Z", entities: { upsert: [changed("e4", "Unhealthy")] } } });

    const after = nodes();
    const touched = after.filter((node) => before.get(node.id) !== node.data).map((node) => node.id);
    const unhealthyBefore = new Set(MODEL.entities.filter((item) => item.healthState !== "Healthy").map((item) => item.name));
    expect(draws() - settled).toBe(1);
    expect(touched).toContain("e4");
    // The graph rebuilds the data of the nodes that are not healthy (their marks depend on the whole set); a folded group that lost or gained a member is rebuilt; a healthy one that stays healthy is left alone.
    expect(touched.filter((id) => id !== "e4" && !id.startsWith("fold:") && !unhealthyBefore.has(id))).toEqual([]);
    expect(JSON.stringify(after.find((node) => node.id === "e4")?.data)).toContain("Unhealthy");
  });

  it("an entity that is added or removed lays the graph out for its new structure", async () => {
    const settled = draws();
    const added: Entity = { ...(MODEL.entities[1] as Entity), name: "new-one", displayName: "New one", parents: ["e0"] };

    await emit({ kind: "delta", id: "e-1", delta: { entities: { upsert: [added] }, relationships: { upsert: [{ name: "r-new", displayName: null, parentEntityName: "e0", childEntityName: "new-one" }] }, order: [...MODEL.entities.map((item) => item.name), "new-one"] } });

    expect(draws()).toBeGreaterThan(settled);
  });

  it("announces a change to the entity for a screen reader", async () => {
    await emit({ kind: "delta", id: "e-1", delta: { entities: { upsert: [changed("e4", "Unhealthy")] } } });

    expect(document.querySelector('[data-testid="live-announcement"]')?.textContent).toBe("Entity 4 is now Unhealthy");
  });
});
