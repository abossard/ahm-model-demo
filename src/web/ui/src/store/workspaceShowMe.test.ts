import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthModel, ModelRef } from "../model/types";
import * as api from "./api";
import { useStore } from "./store";
import { workspaceShowMe } from "./workspaceShowMe";

const model: ModelRef = { name: "orders", subscriptionId: "s", resourceGroup: "rg", id: null, location: null, provisioningState: null };
const task = { target: model };
const loaded: HealthModel = {
  model: { id: null, name: "orders", location: null, provisioningState: null, healthState: "Healthy" },
  observedAt: "2026-11-09T08:00:00Z", entities: [], relationships: [],
  reportOptions: { signalName: "", healthStates: [], values: [], expiries: [], reasonPresets: [] },
};

describe("workspace Show me handles", () => {
  beforeEach(() => {
    useStore.setState({ selected: model, model: { kind: "success", value: loaded } });
    document.body.innerHTML = '<main data-graph-area></main>';
  });

  afterEach(() => {
    document.body.replaceChildren();
    useStore.setState(useStore.getInitialState(), true);
  });

  it("advertises only available destinations and publishes the allowed layout ids", () => {
    const registry = workspaceShowMe(useStore, task);
    expect(registry.describe()).toEqual([
      expect.objectContaining({ name: "graph", idDescription: expect.stringContaining("coverage") }),
      expect.objectContaining({ name: "timeline", idDescription: "overview" }),
    ]);
  });

  it.each([
    { kind: "idle" } as const,
    { kind: "failure", error: { code: "forbidden", message: "Access denied", retryable: false, operationId: null } } as const,
  ])("omits a selected model with no available read ($kind) from a new turn", (state) => {
    useStore.setState({ model: state });
    expect(workspaceShowMe(useStore, task).describe()).toEqual([]);
  });

  it.each([
    { handle: "model-view", id: "removed-view" },
    { handle: "node-detail", id: "deleted-entity" },
    { handle: "graph", id: "node/retired" },
    { handle: "graph", id: "connection/retired" },
    { handle: "graph", id: "view/missing" },
    { handle: "timeline", id: "signal/deleted/cpu" },
    { handle: "panel", id: "change/gone" },
    { handle: "retired-handle", id: "something" },
  ])("leaves the answer open when $handle / $id is unavailable", async (action) => {
    useStore.setState({ workspaceOpen: true });
    const registry = workspaceShowMe(useStore, task, new Set(["model-view", "node-detail", "graph", "timeline", "panel"]));
    expect(await registry.execute(action)).toBe("unavailable");
    expect(useStore.getState()).toMatchObject({ workspaceOpen: true, workspaceTarget: null, selectedName: null });
  });

  it("waits for a reopened model and retires its annotation when the reader leaves the layout", async () => {
    useStore.setState({ model: { kind: "loading" } });
    const registry = workspaceShowMe(useStore, task, new Set(["model-view"]));
    const pending = registry.execute({ handle: "model-view", id: "coverage", highlight: { label: "Coverage" } });
    useStore.setState({ model: { kind: "success", value: loaded } });
    expect(await pending).toBe("shown");
    expect(document.querySelector("[data-graph-area]")?.getAttribute("data-show-me-highlight")).toBe("blue");
    useStore.getState().setView("tidy");
    expect(document.querySelector("[data-show-me-highlight], [data-show-me-annotation]")).toBeNull();
  });

  it("reveals only the latest click when the catalog and an offscreen historical model arrive late", async () => {
    const other = { ...model, name: "other" };
    useStore.setState({ selected: other, catalog: { kind: "loading" }, workspaceOpen: true });
    useStore.getState().resetTimeline(true);
    const asOf = "2026-11-09T08:00:00Z";
    const registry = workspaceShowMe(useStore, { ...task, asOf }, new Set(["model-view"]));
    let deliver!: (data: HealthModel) => void;
    const read = vi.spyOn(api, "fetchHealthModel").mockReturnValue(new Promise((resolve) => { deliver = resolve; }));

    // The timeline initializes the new model's history in a mount effect, as useTimelineLoading does.
    function History() {
      useEffect(() => useStore.getState().resetTimeline(true), []);
      return null;
    }
    function Panel() {
      return useStore((state) => state.timelineOpen) ? createElement(History) : null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Panel)));
      const first = registry.execute({ handle: "model-view", id: "coverage" });
      useStore.setState({ catalog: { kind: "success", value: { default: other, models: [other, model] } } });
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith(model));
      const latest = registry.execute({ handle: "model-view", id: "tidy" });
      await act(async () => {
        deliver(loaded);
        expect(await Promise.all([first, latest])).toEqual(["superseded", "shown"]);
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(useStore.getState()).toMatchObject({
        selected: model, view: "tidy", workspaceOpen: true, timelineOpen: true, timelinePinned: Date.parse(asOf),
      });
    } finally {
      registry.clear();
      read.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("cancels navigation when the user leaves before the saved model loads", async () => {
    const navigate = vi.fn();
    useStore.setState({ model: { kind: "loading" }, setView: navigate });
    const registry = workspaceShowMe(useStore, task, new Set(["model-view"]));
    const pending = registry.execute({ handle: "model-view", id: "coverage" });
    registry.clear();
    useStore.setState({ model: { kind: "success", value: loaded } });
    expect(await pending).toBe("superseded");
    expect(navigate).not.toHaveBeenCalled();
  });
});
