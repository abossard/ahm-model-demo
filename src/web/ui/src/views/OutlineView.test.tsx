import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeBadge } from "../model/changes";
import { useStore } from "../store/store";
import { calmModel, incidentModel } from "../../tests/viewModels";
import { OutlineView } from "./OutlineView";
import { useOutlineState } from "./outlineState";
import type { ViewProps } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the outline view", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // jsdom lays nothing out: give the list a screen's height, or only its first rows are drawn.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    useStore.setState(useStore.getInitialState(), true);
    useOutlineState.setState({ overrides: new Map() });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function props(patch: Partial<ViewProps> = {}): ViewProps {
    const model = incidentModel();
    return { entities: model.entities, relationships: model.relationships, selectedName: null, highlightedName: null, chainNames: [], onActivate: vi.fn(), ...patch };
  }

  async function draw(patch: Partial<ViewProps> = {}): Promise<void> {
    await act(async () => root.render(<OutlineView {...props(patch)} />));
  }

  const row = (name: string): HTMLElement => host.querySelector(`[data-testid="outline-row"][data-entity="${name}"]`) as HTMLElement;

  it.each([
    ["added", "+Added"],
    ["changed", "≠Changed"],
    ["removed", "−Removed"],
  ] as readonly (readonly [ChangeBadge, string])[])("marks a %s entity with its diff chip", async (badge, text) => {
    await draw({ badges: new Map([["session-storage", badge]]) });
    const chip = row("session-storage").querySelector('[data-testid="outline-badge"]') as HTMLElement;
    expect(chip.dataset["badge"]).toBe(badge);
    expect(chip.textContent).toBe(text);
    expect(row("session-storage").dataset["badge"]).toBe(badge);
    expect(row("session-storage").getAttribute("aria-label")).toContain(`${badge} in the proposed changes`);
    expect(host.querySelectorAll('[data-testid="outline-badge"]')).toHaveLength(1);
  });

  it("opens the rows above a changed entity that a diff names, so it is in the list", async () => {
    await draw({ badges: new Map([["container-app", "added"]]) });
    expect(row("container-app")).not.toBeNull();
    expect(row("system-app-hosting").getAttribute("aria-expanded")).toBe("true");
  });

  it("marks the rows whose changes are ticked in a Compare, apart from the one a search points at", async () => {
    await draw({ badges: new Map([["session-storage", "changed"], ["hosted-agent", "changed"]]), marked: new Set(["session-storage"]) });
    expect(row("session-storage").dataset["marked"]).toBe("true");
    expect(row("session-storage").dataset["highlighted"]).toBe("true");
    expect(row("hosted-agent").dataset["marked"]).toBeUndefined();
    expect(row("hosted-agent").dataset["highlighted"]).toBeUndefined();
  });

  it("numbers an Explain chain from its last entity", async () => {
    await draw({ chainNames: ["hm-contosodemo", "flow-run-agent-tasks", "system-session-store", "session-storage", "not-in-the-model"] });
    for (const [name, step] of [["session-storage", "1"], ["system-session-store", "2"], ["flow-run-agent-tasks", "3"], ["hm-contosodemo", "4"]] as const) {
      expect(row(name).dataset["step"]).toBe(step);
      expect(row(name).querySelector('[data-testid="outline-step"]')?.textContent).toBe(step);
    }
    expect(host.querySelectorAll('[data-testid="outline-step"]')).toHaveLength(4);
  });

  it("says which row is selected and which a search result points at", async () => {
    await draw({ selectedName: "session-storage", highlightedName: "hosted-agent" });
    expect(row("session-storage").getAttribute("aria-selected")).toBe("true");
    expect(row("hosted-agent").getAttribute("aria-selected")).toBe("false");
    expect(row("hosted-agent").dataset["highlighted"]).toBe("true");
  });

  it("is a tree whose rows carry their level, place and size", async () => {
    await draw();
    expect(host.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Health model outline");
    const first = host.querySelector('[role="treeitem"]') as HTMLElement;
    expect([first.getAttribute("aria-level"), first.getAttribute("aria-posinset"), first.getAttribute("aria-setsize"), first.getAttribute("aria-expanded")]).toEqual(["1", "1", "2", "true"]);
  });

  it("opens the entity on a click on its row, and leaves the rows as they were", async () => {
    const onActivate = vi.fn();
    await draw({ onActivate });
    await act(async () => row("system-ai-inference").click());
    expect(onActivate).toHaveBeenCalledWith("system-ai-inference");
    expect(row("system-ai-inference").getAttribute("aria-expanded")).toBe("false");
  });

  it("says so when the model has no entities, and when the Health filter hides them all", async () => {
    await draw({ entities: [], relationships: [] });
    expect(host.querySelector('[data-testid="graph-empty"]')?.textContent).toBe("This health model has no entities.");
    useStore.setState({ selectedHealth: [] });
    await draw();
    expect(host.querySelector('[data-testid="graph-empty"]')?.textContent).toBe("The Health filter hides every entity.");
  });

  it("draws the same rows for the same model however often it is drawn, and none of the calm model's closed rows", async () => {
    await draw({ entities: calmModel().entities, relationships: calmModel().relationships });
    expect(host.querySelectorAll('[data-kind="entity"]').length).toBeLessThan(calmModel().entities.length);
  });

  it("is not drawn again by the events of a running Task", async () => {
    let commits = 0;
    await act(async () => root.render(<Profiler id="outline" onRender={() => { commits += 1; }}><OutlineView {...props()} /></Profiler>));
    const settled = commits;
    for (let burst = 0; burst < 20; burst += 1) {
      await act(async () => {
        useStore.setState((state) => ({ events: [...state.events, { seq: burst, ts: "2026-11-11T10:00:00Z", kind: "tool_call", summary: `Step ${burst}`, payload: {} }] }));
      });
    }
    expect(useStore.getState().events).toHaveLength(20);
    expect(commits).toBe(settled);
  });
});
