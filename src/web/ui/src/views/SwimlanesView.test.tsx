import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeBadge } from "../model/changes";
import * as swimlanes from "../model/swimlanes";
import type { Entity } from "../model/types";
import { actions, useStore } from "../store/store";
import { denseIncidentModel, incidentModel } from "../../tests/viewModels";
import { SwimlanesView } from "./SwimlanesView";
import type { ViewProps } from "./types";

vi.mock("../store/api", () => ({
  fetchModelCatalog: vi.fn(() => new Promise(() => {})),
  fetchHealthModel: vi.fn(() => new Promise(() => {})),
  fetchEntityDetail: vi.fn(() => new Promise(() => {})),
  postHealthReport: vi.fn(() => new Promise(() => {})),
}));

const layoutCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../model/swimlanes", async (importOriginal) => {
  const original = await importOriginal<typeof import("../model/swimlanes")>();
  return {
    ...original,
    layoutSwimlanes: (...args: Parameters<typeof original.layoutSwimlanes>) => {
      layoutCalls.count += 1;
      return original.layoutSwimlanes(...args);
    },
  };
});

// React Flow needs a browser; what these tests look at is what the view hands it and what its nodes draw.
const fits: unknown[] = [];
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    Handle: () => null,
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
    getViewportForBounds: () => ({ x: 0, y: 0, zoom: (globalThis as unknown as { __zoom: number }).__zoom }),
    useReactFlow: () => ({
      fitView: (options?: unknown) => {
        fits.push(options);
        return Promise.resolve(true);
      },
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport: () => Promise.resolve(true),
    }),
    ReactFlow: (props: { nodes: { id: string; type: string; data: unknown }[]; nodeTypes: Record<string, React.ComponentType<unknown>> }) =>
      React.createElement(
        "div",
        { "data-testid": "flow" },
        props.nodes.map((node) => React.createElement(props.nodeTypes[node.type] as React.ComponentType<Record<string, unknown>>, { key: node.id, id: node.id, type: node.type, data: node.data })),
      ),
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { __zoom: number }).__zoom = 0.8;

const frame = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
};

describe("SwimlanesView", () => {
  let host: HTMLDivElement;
  let root: Root;
  const activated: string[] = [];
  const model = incidentModel();

  const props = (patch: Partial<ViewProps> = {}): ViewProps => ({
    entities: model.entities,
    relationships: model.relationships,
    selectedName: null,
    highlightedName: null,
    chainNames: [],
    onActivate: (name) => activated.push(name),
    ...patch,
  });
  const show = async (patch: Partial<ViewProps> = {}): Promise<void> => {
    await act(async () => root.render(<SwimlanesView {...props(patch)} />));
    await frame();
  };
  const card = (name: string): HTMLElement => host.querySelector(`[data-testid="swim-card"][data-entity="${name}"]`) as HTMLElement;
  const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="swim-card"]')];

  beforeEach(() => {
    activated.length = 0;
    fits.length = 0;
    layoutCalls.count = 0;
    useStore.setState({ openChips: [], focusNames: [], focusSeq: 0 });
    actions.setSelectedHealth(["Healthy", "Degraded", "Unhealthy", "Unknown"]);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("draws a lane band per layer and a card per entity, each saying its lane and state", async () => {
    await show();
    expect([...host.querySelectorAll('[data-testid="swim-lane"]')].map((lane) => lane.getAttribute("data-lane"))).toEqual(["root", "flows", "systems", "resources", "context"]);
    expect(cards()).toHaveLength(17);
    expect(card("session-storage").getAttribute("data-lane")).toBe("resources");
    expect(card("session-storage").getAttribute("data-state")).toBe("Unhealthy");
    expect(card("platform-context").getAttribute("data-lane")).toBe("context");
    expect(card("system-session-store").querySelector('[data-testid="impact-chip"]')?.textContent).toContain("Limited impact");
    expect(card("session-storage").textContent).toContain("Availability");
    expect(card("session-storage").textContent).toContain("91.4");
  });

  it.each([
    ["by click", (element: HTMLElement) => element.click(), true],
    ["by Enter", (element: HTMLElement) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), true],
    ["by Space", (element: HTMLElement) => element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })), true],
    ["not by another key", (element: HTMLElement) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })), false],
  ] as const)("opens an entity %s", async (_name, act_, opens) => {
    await show();
    await act(async () => act_(card("hosted-agent")));
    expect(activated).toEqual(opens ? ["hosted-agent"] : []);
  });

  it("makes every card reachable by keyboard, in the order of the lanes", async () => {
    await show();
    expect(cards().every((element) => element.tabIndex === 0)).toBe(true);
    const lanes = cards().map((element) => ["root", "flows", "systems", "resources", "context"].indexOf(element.getAttribute("data-lane") as string));
    expect(lanes).toEqual([...lanes].sort((a, b) => a - b));
  });

  it("rings the selected entity and the highlighted one, differently", async () => {
    await show({ selectedName: "hosted-agent", highlightedName: "container-app" });
    expect(card("hosted-agent").classList.contains("is-selected")).toBe(true);
    expect(card("container-app").classList.contains("is-highlighted")).toBe(true);
    expect(card("container-app").getAttribute("data-highlighted")).toBe("true");
    expect(card("foundry-account").classList.contains("is-selected")).toBe(false);
  });

  it("numbers the chain of an Explain result from its last entity, whatever the case of the names", async () => {
    await show({ chainNames: ["HM-CONTOSODEMO", "flow-run-agent-tasks", "system-session-store", "session-storage", "not-an-entity"] });
    for (const [name, step] of [["session-storage", "1"], ["system-session-store", "2"], ["flow-run-agent-tasks", "3"], ["hm-contosodemo", "4"]] as const) expect(card(name).getAttribute("data-step")).toBe(step);
    expect(card("hosted-agent").getAttribute("data-step")).toBeNull();
    expect(host.querySelectorAll('[data-testid="chain-step"]')).toHaveLength(4);
  });

  it("marks what a diff does to an entity, in words and a glyph and not by colour alone, and rings what is ticked", async () => {
    const badges = new Map<string, ChangeBadge>([["foundry-account", "changed"], ["hosted-agent", "added"], ["container-app", "removed"]]);
    await show({ badges, marked: new Set(["hosted-agent"]) });
    expect(card("foundry-account").getAttribute("data-badge")).toBe("changed");
    expect(card("foundry-account").querySelector('[data-testid="change-badge"]')?.textContent).toBe("≠Changed");
    expect(card("hosted-agent").querySelector('[data-testid="change-badge"]')?.textContent).toBe("+Added");
    expect(card("container-app").querySelector('[data-testid="change-badge"]')?.textContent).toBe("−Removed");
    expect(card("hosted-agent").classList.contains("is-marked")).toBe(true);
    expect(card("foundry-account").classList.contains("is-marked")).toBe(false);
    expect(card("foundry-account").getAttribute("aria-label")).toContain("changed in the proposed changes");
  });

  describe("the Health filter", () => {
    it("hides the entities of an unselected state and leaves the others in their lanes", async () => {
      actions.setSelectedHealth(["Degraded", "Unhealthy"]);
      await show();
      expect(cards().map((element) => element.getAttribute("data-state"))).not.toContain("Healthy");
      expect(cards().length).toBeLessThan(17);
      expect(card("session-storage").getAttribute("data-lane")).toBe("resources");
      expect([...host.querySelectorAll('[data-testid="swim-lane"]')].map((lane) => lane.getAttribute("data-lane"))).toEqual(["root", "flows", "systems", "resources"]);
    });

    it("says so when it hides everything, and says when the model is empty", async () => {
      actions.setSelectedHealth([]);
      await show();
      expect(host.querySelector('[data-testid="graph-empty"]')?.textContent).toContain("Health filter hides every entity");
      actions.setSelectedHealth(["Healthy", "Degraded", "Unhealthy", "Unknown"]);
      await show({ entities: [], relationships: [] });
      expect(host.querySelector('[data-testid="graph-empty"]')?.textContent).toContain("no entities");
    });
  });

  describe("layout work", () => {
    it("is done once for a model, and not again for a selection, a highlight, an announcement or the same model arriving again", async () => {
      await show();
      expect(layoutCalls.count).toBe(1);
      await show({ selectedName: "hosted-agent" });
      await show({ highlightedName: "container-app" });
      await act(async () => actions.announce("The activity stream says something."));
      await show({ entities: model.entities.map((entity) => ({ ...entity })), relationships: model.relationships.map((item) => ({ ...item })) });
      expect(layoutCalls.count).toBe(1);
    });

    it("is done again when a state changes", async () => {
      await show();
      const before = layoutCalls.count;
      const changed: Entity[] = model.entities.map((entity) => (entity.name === "container-app" ? { ...entity, healthState: "Degraded" } : entity));
      await show({ entities: changed });
      expect(layoutCalls.count).toBeGreaterThan(before);
      expect(card("container-app").getAttribute("data-state")).toBe("Degraded");
    });
  });

  describe("the viewport", () => {
    it("fits everything when the view opens, with no animation", async () => {
      await show();
      expect(fits[0]).toMatchObject({ duration: 0, maxZoom: 1 });
      expect((fits[0] as { nodes?: unknown }).nodes).toBeUndefined();
    });

    it("opens a model too big to read whole on its first problem, and says so", async () => {
      (globalThis as unknown as { __zoom: number }).__zoom = 0.2;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1200, height: 700, x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 700, toJSON: () => ({}) });
      const dense = denseIncidentModel();
      await show({ entities: dense.entities, relationships: dense.relationships });
      const first = fits[0] as { nodes?: { id: string }[] };
      expect(first.nodes?.length).toBeGreaterThanOrEqual(2);
      expect(first.nodes?.[0]?.id.startsWith("res-")).toBe(true);
      expect(host.querySelector('[data-testid="swimlanes-summary"]')?.textContent).toContain("Zoomed to");
      expect(host.querySelector('[data-testid="swimlanes-summary"]')?.textContent).toContain("Fit shows all 81 entities");
      (globalThis as unknown as { __zoom: number }).__zoom = 0.8;
    });
  });

  describe("chips for folded entities", () => {
    it("folds the healthy parts of a dense model, opens one by click and closes it by keyboard", async () => {
      const dense = denseIncidentModel();
      await show({ entities: dense.entities, relationships: dense.relationships });
      const chips = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="swim-fold"]')];
      expect(chips().length).toBeGreaterThan(5);
      expect(cards().length).toBeLessThan(81);
      const first = chips()[0] as HTMLElement;
      const owner = first.getAttribute("data-owner") as string;
      const before = cards().length;
      expect(first.getAttribute("aria-expanded")).toBe("false");
      await act(async () => first.click());
      await frame();
      const opened = host.querySelector(`[data-testid="swim-fold"][data-owner="${owner}"]`) as HTMLElement;
      expect(opened.getAttribute("aria-expanded")).toBe("true");
      expect(cards().length).toBeGreaterThan(before);
      await act(async () => opened.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      await frame();
      expect((host.querySelector(`[data-testid="swim-fold"][data-owner="${owner}"]`) as HTMLElement).getAttribute("aria-expanded")).toBe("false");
      expect(cards().length).toBe(before);
    });

    it("opens the chip an entity sits behind when a search brings it into view", async () => {
      const dense = denseIncidentModel();
      await show({ entities: dense.entities, relationships: dense.relationships });
      const hidden = swimlanes
        .layoutSwimlanes({ entities: dense.entities, relationships: dense.relationships, layering: (await import("../model/layerOf")).layerOf(dense.entities, dense.relationships) }, { signals: true, labels: null, open: new Set(), keep: new Set() })
        .folds[0]?.members.find((member) => member.startsWith("res-")) as string;
      expect(card(hidden)).toBeNull();
      fits.length = 0;
      await act(async () => actions.focusEntities({ highlight: hidden, names: [hidden] }));
      await frame();
      await frame();
      expect(card(hidden)).not.toBeNull();
      expect((fits.at(-1) as { nodes?: { id: string }[] }).nodes?.map((item) => item.id)).toEqual([hidden]);
    });
  });
});

