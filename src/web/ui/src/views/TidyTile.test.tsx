import { act } from "react";
import type { ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeBadge } from "../model/changes";
import type { Fold } from "../model/tidy";
import type { Entity, EntitySignal, HealthState } from "../model/types";
import { TidyFold, TidyTile, type TidyFoldData, type TidyTileData } from "./TidyTile";

// React Flow gives a node component more props than the tile reads; these are the ones it reads.
const Tile = TidyTile as unknown as ComponentType<{ id: string; data: TidyTileData }>;
const FoldTile = TidyFold as unknown as ComponentType<{ id: string; data: TidyFoldData }>;

vi.mock("@xyflow/react", () => ({ Position: { Top: "top", Bottom: "bottom" }, Handle: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function signal(state: HealthState, index: number): EntitySignal {
  return { name: `s${index}`, displayName: null, kind: null, healthState: state, value: index, reportedAt: null, writable: false };
}

function entity(patch: Partial<Entity> & { readonly states?: readonly HealthState[] } = {}): Entity {
  const { states = [], ...rest } = patch;
  return {
    name: "svc",
    displayName: "Service",
    healthState: "Healthy",
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: states.map(signal),
    report: { eligible: true, signalName: null },
    ...rest,
  };
}

const noop = (): void => undefined;

function data(patch: Partial<TidyTileData> = {}): TidyTileData {
  return { entity: entity(), selected: false, highlighted: false, step: null, badge: null, marked: false, dimmed: false, collapse: null, onActivate: noop, onToggle: noop, onFocusNode: noop, ...patch };
}

describe("the tiles of the tidy view", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function draw(patch: Partial<TidyTileData>): Promise<HTMLElement> {
    await act(async () => root.render(<Tile id="svc" data={data(patch)} />));
    return host.querySelector<HTMLElement>('[data-testid="tidy-tile"]') as HTMLElement;
  }

  it.each([
    ["added", "+ Added"],
    ["changed", "≠ Changed"],
    ["removed", "− Removed"],
  ] as readonly (readonly [ChangeBadge, string])[])("marks a %s entity with its diff badge", async (badge, text) => {
    const button = await draw({ badge });
    expect(button.dataset["badge"]).toBe(badge);
    expect(host.querySelector('[data-testid="tidy-badge"]')?.textContent).toBe(text);
    expect(button.getAttribute("aria-label")).toContain(`${badge} in the proposed changes`);
  });

  it("draws no diff badge, step or impact chip for a plain entity", async () => {
    await draw({});
    expect(host.querySelector('[data-testid="tidy-badge"]')).toBeNull();
    expect(host.querySelector('[data-testid="tidy-step"]')).toBeNull();
    expect(host.querySelector('[data-testid="tidy-impact"]')).toBeNull();
  });

  it.each([
    [1, "1"],
    [4, "4"],
  ])("numbers a chain entity %s", async (step, text) => {
    const button = await draw({ step });
    expect(host.querySelector('[data-testid="tidy-step"]')?.textContent).toBe(text);
    expect(button.dataset["step"]).toBe(String(step));
    expect(button.getAttribute("aria-label")).toContain(`step ${step} of the chain`);
  });

  it.each([
    ["Limited", "Limited"],
    ["Suppressed", "Suppressed"],
  ])("shows a %s impact as a chip", async (impact, word) => {
    await draw({ entity: entity({ impact }) });
    const chip = host.querySelector('[data-testid="tidy-impact"]') as HTMLElement;
    expect(chip.dataset["impact"]).toBe(impact);
    expect(chip.textContent).toContain(word);
  });

  it.each([
    ["no signals", [], 0, "no signals"],
    ["three healthy", ["Healthy", "Healthy", "Healthy"], 3, "3"],
    ["more than fit", Array.from({ length: 9 }, () => "Healthy"), 6, "+3"],
    ["one failing among others", ["Healthy", "Unhealthy"], 2, "2"],
  ] as readonly (readonly [string, readonly HealthState[], number, string])[])("draws a glyph per signal for %s, and the count", async (_name, states, glyphs, text) => {
    await draw({ entity: entity({ states }) });
    const row = host.querySelector('[data-testid="tidy-signals"]');
    expect(row?.querySelectorAll("svg").length ?? 0).toBe(glyphs);
    expect(host.textContent).toContain(text);
  });

  it("names the state in the label and the title, so the glyph is never the only word", async () => {
    const button = await draw({ entity: entity({ healthState: "Unhealthy", displayName: "Session Storage" }) });
    expect(button.getAttribute("aria-label")).toBe("Session Storage, Unhealthy");
    expect(button.title).toBe("Session Storage: Unhealthy");
  });

  it.each([
    ["selected", { selected: true }, "data-selected"],
    ["highlighted", { highlighted: true }, "data-highlighted"],
    ["faint", { dimmed: true }, "data-dimmed"],
  ] as const)("says when a tile is %s", async (_name, patch, attribute) => {
    const button = await draw(patch);
    expect(button.getAttribute(attribute)).toBe("true");
  });

  it("opens the entity on a click and tells the view when it is focused", async () => {
    const onActivate = vi.fn();
    const onFocusNode = vi.fn();
    const button = await draw({ onActivate, onFocusNode });
    await act(async () => button.click());
    await act(async () => button.focus());
    expect(onActivate).toHaveBeenCalledWith("svc");
    expect(onFocusNode).toHaveBeenCalledWith("svc", button);
  });

  it.each([
    [{ collapsed: false, hiddenCount: 3 }, "Collapse Service", true],
    [{ collapsed: true, hiddenCount: 3 }, "Expand Service, 3 hidden", false],
  ] as const)("offers a collapse toggle that reads %j", async (collapse, label, expanded) => {
    const onToggle = vi.fn();
    await draw({ collapse, onToggle });
    const toggle = host.querySelector('[data-testid="tidy-collapse"]') as HTMLElement;
    expect(toggle.getAttribute("aria-label")).toBe(label);
    expect(toggle.getAttribute("aria-expanded")).toBe(String(expanded));
    await act(async () => toggle.click());
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ name: "svc" }), collapse.collapsed, collapse.hiddenCount);
  });

  describe("the count tile that stands for folded healthy leaves", () => {
    const fold = (open: boolean): Fold => ({ id: "fold:p", parent: "p", members: ["a", "b", "c"], open });

    async function drawFold(open: boolean, onToggleFold = vi.fn()): Promise<HTMLElement> {
      await act(async () => root.render(<FoldTile id="fold:p" data={{ fold: fold(open), parentLabel: "Parent", onToggleFold, onFocusNode: noop }} />));
      return host.querySelector<HTMLElement>('[data-testid="tidy-fold"]') as HTMLElement;
    }

    it.each([
      [false, "3 healthy entities under Parent are folded: a, b, c. Show them", "3 healthy"],
      [true, "Fold the 3 healthy entities under Parent", "Fold 3 healthy"],
    ])("says what it holds when open is %s", async (open, label, text) => {
      const button = await drawFold(open);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("aria-expanded")).toBe(String(open));
      expect(button.textContent).toContain(text);
    });

    it.each([[false], [true]])("asks the view to open it, or fold it, from a click (open is %s)", async (open) => {
      const onToggleFold = vi.fn();
      const button = await drawFold(open, onToggleFold);
      await act(async () => button.click());
      expect(onToggleFold).toHaveBeenCalledWith("p", !open);
    });
  });
});
