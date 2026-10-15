import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Provider } from "react-redux";
import type { GraphLayout, LiveLayoutSession } from "../model/layout";
import { LAYOUT_ENGINES } from "../model/layout";
import type { Entity, Relationship } from "../model/types";
import { store } from "../store/store";
import {
  focusEntities,
  setExcludedEntityMode,
  setLayout,
  setSelectedHealth,
  toggleCollapse,
  toggleSelectedHealth,
} from "../store/uiSlice";
import { chooseModel } from "../store/catalogSlice";
import { Topology } from "./Topology";

type AdaptiveEngine = (typeof LAYOUT_ENGINES)["d3-force-adaptive"];
type StartLiveArgs = Parameters<NonNullable<AdaptiveEngine["startLive"]>>[0];
type MutableEngine = { -readonly [K in keyof AdaptiveEngine]: AdaptiveEngine[K] };
const adaptiveEngine = LAYOUT_ENGINES["d3-force-adaptive"] as MutableEngine;

vi.mock("@xyflow/react", () => {
  return {
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    Handle: () => null,
    Background: () => null,
    ReactFlowProvider: ({ children }: { children?: unknown }) => children ?? null,
    useStore: () => undefined,
    useReactFlow: () => ({
      fitView: (opts?: unknown) => {
        ((globalThis as unknown as { __fit: unknown[] }).__fit ??= []).push(opts);
        return Promise.resolve(true);
      },
    }),
    ReactFlow: (props: unknown) => {
      (globalThis as unknown as { __rf: unknown }).__rf = props;
      return null;
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Globals {
  __rf?: { readonly nodes: Array<{ id: string; position: { x: number; y: number } }> };
  __fit?: unknown[];
}

function entity(name: string, healthState: Entity["healthState"]): Entity {
  return {
    name,
    displayName: name,
    healthState,
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
  };
}

function relationship(name: string, parentEntityName: string, childEntityName: string): Relationship {
  return { name, displayName: null, parentEntityName, childEntityName };
}

const baseEntities = (): Entity[] => [
  entity("a", "Healthy"),
  entity("b", "Degraded"),
  entity("c", "Unhealthy"),
];
const baseRelationships = (): Relationship[] => [
  relationship("r1", "a", "b"),
  relationship("r2", "a", "c"),
];

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function setBaselineUi(): void {
  store.dispatch(setLayout("dagre-tb"));
  store.dispatch(setSelectedHealth(["Healthy", "Degraded", "Unhealthy", "Unknown"]));
  store.dispatch(setExcludedEntityMode("hide"));
  store.dispatch(toggleCollapse("b"));
  store.dispatch(toggleCollapse("b"));
}

function layoutFor(names: readonly string[], xBase = 0): GraphLayout {
  const positions = new Map(names.map((name, index) => [name, { x: xBase + index * 100, y: index * 40 }] as const));
  return { positions, width: 600, height: 320 };
}

describe("Topology live session guards", () => {
  const originalStartLive: AdaptiveEngine["startLive"] = adaptiveEngine.startLive;
  const originalMatchMedia = window.matchMedia;
  let host: HTMLDivElement;
  let root: Root;
  let latestFrame: ((layout: GraphLayout) => void) | null;
  let latestError: ((error: Error) => void) | null;
  let updateCalls = 0;
  let disposeCalls = 0;
  let startModes: boolean[] = [];
  let sessionUpdates: number[] = [];
  let reduceMatches = false;
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();

  beforeEach(async () => {
    setBaselineUi();
    (globalThis as unknown as Globals).__fit = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    latestFrame = null;
    latestError = null;
    updateCalls = 0;
    disposeCalls = 0;
    startModes = [];
    reduceMatches = false;
    mediaListeners.clear();
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: reduceMatches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.delete(listener);
      },
      dispatchEvent: () => true,
    }));
    sessionUpdates = [];
    adaptiveEngine.startLive = ({ onFrame, onError, reducedMotion }: StartLiveArgs) => {
      const index = sessionUpdates.length;
      sessionUpdates.push(0);
      latestFrame = onFrame;
      latestError = onError;
      startModes.push(reducedMotion);
      return {
        update: () => {
          updateCalls += 1;
          sessionUpdates[index] = (sessionUpdates[index] ?? 0) + 1;
        },
        setDrag: () => {},
        settle: () => {},
        dispose: () => {
          disposeCalls += 1;
        },
      };
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (originalStartLive) adaptiveEngine.startLive = originalStartLive;
    else delete adaptiveEngine.startLive;
    window.matchMedia = originalMatchMedia;
  });

  it("keeps accepting current-session frames after effect re-runs", async () => {
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();

    latestFrame?.(layoutFor(["a", "b", "c"]));
    await flush();
    const firstX = ((globalThis as unknown as Globals).__rf?.nodes.find((node) => node.id === "a")?.position.x ?? -1);
    expect(firstX).toBe(0);

    store.dispatch(toggleSelectedHealth("Degraded"));
    await flush();
    latestFrame?.(layoutFor(["a", "c"], 200));
    await flush();
    const nextX = ((globalThis as unknown as Globals).__rf?.nodes.find((node) => node.id === "a")?.position.x ?? -1);
    expect(nextX).toBe(200);
  });

  it("does not issue live update on non-material refresh payload", async () => {
    const entities = baseEntities();
    const relationships = baseRelationships();
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={entities} relationships={relationships} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    const before = updateCalls;

    const refreshed = entities.map((item) => ({ ...item, latestEvaluationAt: "2026-10-09T00:00:00Z" }));
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={refreshed} relationships={[...relationships]} /></Provider>);
    });
    await flush();

    expect(updateCalls).toBe(before);
  });

  it("retries pending focus when positions arrive later and consumes it once", async () => {
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    (globalThis as unknown as Globals).__fit = [];
    const fitBefore = 0;

    await act(async () => {
      store.dispatch(focusEntities({ highlight: "a", names: ["a"] }));
    });
    await flush();
    const fitAfterFocus = ((globalThis as unknown as Globals).__fit ?? []).length;
    expect(fitAfterFocus).toBeGreaterThan(fitBefore);

    latestFrame?.(layoutFor(["a", "b", "c"]));
    await flush();
    const fitAfterFrame = ((globalThis as unknown as Globals).__fit ?? []).slice(fitBefore);
    const focused = fitAfterFrame.filter((item) => typeof item === "object" && item !== null && "nodes" in (item as object));
    expect(focused).toHaveLength(1);
    expect((focused[0] as { nodes: Array<{ id: string }> }).nodes.map((item) => item.id)).toEqual(["a"]);

    latestFrame?.(layoutFor(["a", "b", "c"], 80));
    await flush();
    const fitAfterSecond = ((globalThis as unknown as Globals).__fit ?? []).slice(fitBefore);
    const focusedSecond = fitAfterSecond.filter((item) => typeof item === "object" && item !== null && "nodes" in (item as object));
    expect(focusedSecond).toHaveLength(1);
  });

  it("does not re-fit viewport on collapse or health filter changes", async () => {
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    const baseline = ((globalThis as unknown as Globals).__fit ?? []).length;

    store.dispatch(toggleCollapse("a"));
    await flush();
    store.dispatch(toggleSelectedHealth("Degraded"));
    await flush();
    const after = ((globalThis as unknown as Globals).__fit ?? []).length;
    expect(after).toBe(baseline);
  });

  it("disposes the live session when a live error is reported", async () => {
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    expect(disposeCalls).toBe(0);
    await act(async () => {
      latestError?.(new Error("boom"));
    });
    await flush();
    expect(disposeCalls).toBeGreaterThan(0);
  });

  it("ignores stale session callbacks after replacing the live session", async () => {
    const sessions: Array<{ frame: ((layout: GraphLayout) => void) | null; current: LiveLayoutSession }> = [];
    adaptiveEngine.startLive = ({ onFrame, onError }: StartLiveArgs) => {
      const current: LiveLayoutSession = {
        update: () => {},
        setDrag: () => {},
        settle: () => {},
        dispose: () => {
          disposeCalls += 1;
        },
      };
      latestFrame = onFrame;
      latestError = onError;
      sessions.push({ frame: onFrame, current });
      return current;
    };

    await act(async () => {
      root.render(
        <StrictMode><Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider></StrictMode>,
      );
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    store.dispatch(setLayout("dagre-tb"));
    await flush();
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    expect(sessions.length).toBe(2);

    sessions[0]?.frame?.(layoutFor(["a", "b", "c"], 999));
    await flush();
    const staleX = ((globalThis as unknown as Globals).__rf?.nodes.find((node) => node.id === "a")?.position.x ?? -1);
    expect(staleX).not.toBe(999);

    sessions.at(-1)?.frame?.(layoutFor(["a", "b", "c"], 333));
    await flush();
    const currentX = ((globalThis as unknown as Globals).__rf?.nodes.find((node) => node.id === "a")?.position.x ?? -1);
    expect(currentX).toBe(333);
  });

  it("runs the first update when StrictMode mounts with adaptive already selected", async () => {
    const perSessionUpdates: number[] = [];
    adaptiveEngine.startLive = ({ onFrame, onError }: StartLiveArgs) => {
      const index = perSessionUpdates.length;
      perSessionUpdates.push(0);
      const current: LiveLayoutSession = {
        update: () => {
          perSessionUpdates[index] = (perSessionUpdates[index] ?? 0) + 1;
        },
        setDrag: () => {},
        settle: () => {},
        dispose: () => {},
      };
      latestFrame = onFrame;
      latestError = onError;
      return current;
    };
    store.dispatch(setLayout("d3-force-adaptive"));
    await act(async () => {
      root.render(
        <StrictMode><Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider></StrictMode>,
      );
    });
    await flush();

    expect(perSessionUpdates.length).toBeGreaterThan(0);
    expect(perSessionUpdates.at(-1) ?? 0).toBeGreaterThan(0);
  });

  it("recovers from synchronous live update failure and retries on the next material update", async () => {
    let failNext = true;
    adaptiveEngine.startLive = ({ onFrame, onError }: StartLiveArgs) => {
      const current: LiveLayoutSession = {
        update: () => {
          if (failNext) {
            failNext = false;
            throw new Error("boom");
          }
          updateCalls += 1;
        },
        setDrag: () => {},
        settle: () => {},
        dispose: () => {
          disposeCalls += 1;
        },
      };
      latestFrame = onFrame;
      latestError = onError;
      return current;
    };
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    expect(disposeCalls).toBeGreaterThan(0);
    expect(updateCalls).toBe(0);

    store.dispatch(toggleSelectedHealth("Degraded"));
    await flush();
    expect(updateCalls).toBe(1);
  });

  it("does not replay already-consumed focus after remount or model switch", async () => {
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    latestFrame?.(layoutFor(["a", "b", "c"]));
    await flush();

    (globalThis as unknown as Globals).__fit = [];
    await act(async () => {
      store.dispatch(focusEntities({ highlight: "a", names: ["a"] }));
    });
    await flush();
    const focusedCalls = ((globalThis as unknown as Globals).__fit ?? []).filter(
      (item) => typeof item === "object" && item !== null && "nodes" in (item as object),
    ).length;
    expect(focusedCalls).toBe(1);

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    await flush();
    const afterRemountFocusedCalls = ((globalThis as unknown as Globals).__fit ?? []).filter(
      (item) => typeof item === "object" && item !== null && "nodes" in (item as object),
    ).length;
    expect(afterRemountFocusedCalls).toBe(1);

    await act(async () => {
      store.dispatch(
        chooseModel({
          name: "other",
          resourceGroup: "group",
          id: null,
          location: null,
          provisioningState: null,
        }),
      );
    });
    await flush();
    const afterModelSwitchFocusedCalls = ((globalThis as unknown as Globals).__fit ?? []).filter(
      (item) => typeof item === "object" && item !== null && "nodes" in (item as object),
    ).length;
    expect(afterModelSwitchFocusedCalls).toBe(1);
  });

  it("recreates the live session when reduced-motion preference changes and reapplies update", async () => {
    await act(async () => {
      root.render(<Provider store={store}><Topology entities={baseEntities()} relationships={baseRelationships()} /></Provider>);
    });
    store.dispatch(setLayout("d3-force-adaptive"));
    await flush();
    expect(startModes).toEqual([false]);
    const sessionsBefore = sessionUpdates.length;

    reduceMatches = true;
    const event = { matches: true } as MediaQueryListEvent;
    await act(async () => {
      for (const listener of mediaListeners) listener(event);
    });
    await flush();

    expect(startModes).toEqual([false, true]);
    expect(disposeCalls).toBeGreaterThan(0);
    expect(sessionUpdates.length).toBeGreaterThan(sessionsBefore);
    expect(sessionUpdates[1] ?? 0).toBeGreaterThan(0);
  });
});
