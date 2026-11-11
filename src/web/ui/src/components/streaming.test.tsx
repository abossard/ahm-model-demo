import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity, HealthModel, ModelCatalog, SessionDetail, Task } from "../model/types";
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
  ReactFlow: () => {
    (globalThis as unknown as { __draws: number }).__draws += 1;
    return null;
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeStream {
  static instances: FakeStream[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private readonly handlers: api.TaskStreamHandlers,
  ) {
    FakeStream.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "activity" | "done", data: unknown): void {
    if (type === "activity") this.handlers.onActivity(JSON.stringify(data));
    else this.handlers.onDone(JSON.stringify(data));
  }
}

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

const RUNNING: Task = {
  id: "1",
  sessionId: "s1",
  seq: 1,
  type: "review",
  target: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" },
  instruction: "",
  status: "running",
  createdAt: "2026-11-10T10:00:00Z",
};
const DETAIL: SessionDetail = {
  session: { id: "s1", title: "Demo", createdAt: "2026-11-10T10:00:00Z", taskCount: 1, lastTaskAt: null },
  tasks: [RUNNING],
};

const event = (seq: number) => ({ seq, ts: "2026-11-10T10:00:00Z", kind: "tool_call", summary: `Step ${seq}`, payload: { arguments: "{}" } });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("a running Task", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as unknown as { __draws: number }).__draws = 0;
    FakeStream.instances = [];
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    vi.mocked(api.fetchModelCatalog).mockResolvedValue(CATALOG);
    vi.mocked(api.fetchHealthModel).mockResolvedValue(MODEL);
    vi.mocked(api.fetchSession).mockResolvedValue(DETAIL);
    vi.mocked(api.fetchSessions).mockResolvedValue([DETAIL.session]);
    vi.mocked(api.fetchTask).mockResolvedValue(RUNNING);
    vi.mocked(api.openTaskEvents).mockImplementation((sid, seq, handlers) => new FakeStream(`/api/sessions/${sid}/tasks/${seq}/events`, handlers));
    useStore.setState(useStore.getInitialState(), true);
    // The address names the Session and Task on screen, so the previous test's links would open them again.
    window.history.replaceState(null, "", "/");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await act(async () => {
      await actions.loadModelCatalog("");
      await flush();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("streams its events without drawing the graph again", async () => {
    await act(async () => {
      actions.setWorkspaceOpen(true);
      await actions.openSession("s1");
      await actions.openTask(1);
    });
    expect(FakeStream.instances).toHaveLength(1);
    const settled = draws();
    expect(settled).toBeGreaterThan(0);

    let updates = 0;
    const stop = useStore.subscribe((state, previous) => {
      if (state.events !== previous.events) updates += 1;
    });
    const source = FakeStream.instances[0]!;
    for (let burst = 0; burst < 30; burst += 1) {
      await act(async () => {
        for (let index = 1; index <= 10; index += 1) source.emit("activity", event(burst * 10 + index));
        for (const callback of frames.splice(0)) callback();
      });
    }

    stop();
    // Ten events that arrive together are appended once.
    expect(updates).toBe(30);
    expect(useStore.getState().events).toHaveLength(300);
    expect(document.querySelector('[data-testid="timeline"]')).not.toBeNull();
    expect(draws()).toBe(settled);
  });

  it("closes the stream of the Task it leaves", async () => {
    vi.mocked(api.fetchTask).mockImplementation((_sid, seq) => Promise.resolve({ ...RUNNING, seq, id: String(seq) }));
    await act(async () => {
      await actions.openSession("s1");
      await actions.openTask(1);
      await actions.openTask(2);
      await actions.openTask(1);
    });

    expect(FakeStream.instances.map((source) => [source.url, source.closed])).toEqual([
      ["/api/sessions/s1/tasks/1/events", true],
      ["/api/sessions/s1/tasks/2/events", true],
      ["/api/sessions/s1/tasks/1/events", false],
    ]);
  });
});
