import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store/store";
import { denseIncidentModel, incidentModel } from "../../tests/viewModels";
import type { HealthModel } from "../model/types";
import { TidyView } from "./TidyView";
import type { ViewProps } from "./types";

interface Flow {
  nodes: { id: string; type: string; position: { x: number; y: number }; width: number; height: number; data: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string }[];
}
interface Globals {
  __rf?: Flow;
  __draws: number;
  __fits: unknown[];
}
const globals = globalThis as unknown as Globals & { IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xyflow/react", () => ({
  Position: { Top: "top", Bottom: "bottom" },
  BackgroundVariant: { Dots: "dots" },
  Handle: () => null,
  Background: () => null,
  Panel: () => null,
  ViewportPortal: () => null,
  BaseEdge: () => null,
  ReactFlowProvider: ({ children }: { children?: unknown }) => children ?? null,
  useReactFlow: () => ({
    fitView: (options?: unknown) => {
      globals.__fits.push(options);
      return Promise.resolve(true);
    },
    getNode: () => undefined,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setCenter: () => Promise.resolve(true),
  }),
  ReactFlow: (props: Flow) => {
    globals.__rf = props;
    globals.__draws += 1;
    return null;
  },
}));

describe("the tidy view", () => {
  let host: HTMLDivElement;
  let root: Root;
  const frames: (() => void)[] = [];

  beforeEach(() => {
    globals.__draws = 0;
    globals.__fits = [];
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    useStore.setState(useStore.getInitialState(), true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function props(model: HealthModel, patch: Partial<ViewProps> = {}): ViewProps {
    return { entities: model.entities, relationships: model.relationships, selectedName: null, highlightedName: null, chainNames: [], onActivate: vi.fn(), ...patch };
  }

  async function draw(model: HealthModel, patch: Partial<ViewProps> = {}): Promise<void> {
    await act(async () => root.render(<TidyView {...props(model, patch)} />));
    await act(async () => {
      for (const callback of frames.splice(0)) callback();
    });
  }

  const positions = (): string[] => (globals.__rf?.nodes ?? []).map((node) => `${node.id}@${node.position.x},${node.position.y}`);

  it("gives React Flow one node of one size for each entity, and one line for each relationship", async () => {
    const model = incidentModel();
    await draw(model);
    expect(globals.__rf?.nodes).toHaveLength(model.entities.length);
    expect(new Set(globals.__rf?.nodes.map((node) => `${node.width}x${node.height}`))).toEqual(new Set(["216x76"]));
    expect(globals.__rf?.edges).toHaveLength(model.relationships.length);
  });

  it("fits the graph once when it opens", async () => {
    await draw(incidentModel());
    expect(globals.__fits).toHaveLength(1);
    expect(globals.__fits[0]).toMatchObject({ maxZoom: 1, duration: 0 });
  });

  it("opens a large model on its first problem instead of fitting all of it", async () => {
    await draw(denseIncidentModel());
    expect(globals.__fits).toHaveLength(1);
    const options = globals.__fits[0] as { nodes: { id: string }[] };
    expect(options.nodes.length).toBeGreaterThan(0);
    expect(["res-sql-orders", "res-func-nightly"]).toContain(options.nodes[0]?.id);
  });

  it("folds the healthy leaves of a large model into count nodes", async () => {
    await draw(denseIncidentModel());
    expect(globals.__rf?.nodes.filter((node) => node.type === "fold").length).toBeGreaterThan(5);
    expect(globals.__rf?.nodes.length).toBeLessThan(81);
  });

  it.each([
    ["added", "session-storage"],
    ["removed", "hosted-agent"],
  ] as const)("passes a %s diff badge to the entity's tile", async (badge, name) => {
    await draw(incidentModel(), { badges: new Map([[name, badge]]) });
    expect(globals.__rf?.nodes.find((node) => node.id === name)?.data["badge"]).toBe(badge);
    expect(globals.__rf?.nodes.find((node) => node.id === "container-app")?.data["badge"]).toBeNull();
  });

  it("numbers the Explain chain from its last entity", async () => {
    await draw(incidentModel(), { chainNames: ["hm-contosodemo", "system-session-store", "session-storage"] });
    const steps = Object.fromEntries((globals.__rf?.nodes ?? []).filter((node) => node.data["step"] !== null).map((node) => [node.id, node.data["step"]]));
    expect(steps).toEqual({ "hm-contosodemo": 3, "system-session-store": 2, "session-storage": 1 });
  });

  it("does not lay the graph out again when another entity is selected, or fit the viewport again", async () => {
    const model = incidentModel();
    await draw(model);
    const before = positions();
    await draw(model, { selectedName: "hosted-agent", highlightedName: "container-app" });
    expect(positions()).toEqual(before);
    expect(globals.__rf?.nodes.find((node) => node.id === "hosted-agent")?.data["selected"]).toBe(true);
    expect(globals.__fits).toHaveLength(1);
  });

  it("is not drawn again by the events of a running Task", async () => {
    await draw(incidentModel());
    const settled = globals.__draws;
    for (let burst = 0; burst < 20; burst += 1) {
      await act(async () => {
        useStore.setState((state) => ({ events: [...state.events, { seq: burst, ts: "2026-11-11T10:00:00Z", kind: "tool_call", summary: `Step ${burst}`, payload: {} }] }));
      });
    }
    expect(useStore.getState().events).toHaveLength(20);
    expect(globals.__draws).toBe(settled);
  });

  it("follows the Health filter and the collapse state in the store", async () => {
    await draw(incidentModel());
    await act(async () => useStore.setState({ selectedHealth: ["Unhealthy", "Degraded"] }));
    expect(globals.__rf?.nodes).toHaveLength(6);
    await act(async () => useStore.setState({ selectedHealth: ["Healthy", "Degraded", "Unhealthy", "Unknown"], collapsed: ["flow-run-agent-tasks"] }));
    expect(globals.__rf?.nodes.some((node) => node.id === "system-session-store")).toBe(false);
    expect(globals.__rf?.nodes.find((node) => node.id === "flow-run-agent-tasks")?.data["collapse"]).toMatchObject({ collapsed: true });
  });
});
