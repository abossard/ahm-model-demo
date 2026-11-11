// @vitest-environment node
import { describe, expect, it } from "vitest";
import { causePath } from "./causePath";
import { CARD_WIDTH, MAX_SIGNAL_ROWS, chipId, kindOf, layoutCause } from "./causeLayout";
import { throughCards } from "./stepRouter";
import { calmModel, denseIncidentModel, incidentModel } from "../../tests/viewModels";
import type { Entity } from "./types";

const measure = (text: string): number => text.length * 6;

function laid(model: ReturnType<typeof incidentModel>, open: ReadonlySet<string> = new Set()) {
  const path = causePath(model.entities, model.relationships, { open });
  return { path, layout: layoutCause(model.entities, model.relationships, path, measure) };
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("layoutCause", () => {
  it.each([
    ["the incident model", incidentModel()],
    ["the calm model", calmModel()],
    ["the dense model", denseIncidentModel()],
  ] as const)("%s: a node for everything drawn and every chip, none on another, no line through a card", (_name, model) => {
    const { path, layout } = laid(model);
    expect(layout.nodes).toHaveLength(path.draw.length + path.folded.length);
    for (const [index, node] of layout.nodes.entries()) {
      for (const other of layout.nodes.slice(index + 1)) expect(overlap(node.rect, other.rect), `${node.id} on ${other.id}`).toBe(false);
    }
    const rects = new Map(layout.nodes.map((node) => [node.id, node.rect] as const));
    expect(throughCards({ nodes: rects, edges: layout.edges.map((edge) => ({ ...edge })), bounds: layout.bounds })).toEqual([]);
  });

  it("hangs every chip under its owner and numbers the chain from the failing leaf", () => {
    const { path, layout } = laid(incidentModel());
    for (const group of path.folded) expect(layout.edges.some((edge) => edge.from === group.owner && edge.to === chipId(group))).toBe(true);
    const steps = layout.nodes.filter((node) => node.step !== null).sort((a, b) => a.step! - b.step!).map((node) => node.id);
    expect(steps).toEqual(["session-storage", "system-session-store", "flow-run-agent-tasks", "hm-contosodemo"]);
  });

  it("sizes by severity: the failing leaf is the large card with its failing signal, the degraded sibling a normal one", () => {
    const { layout } = laid(incidentModel());
    const byId = new Map(layout.nodes.map((node) => [node.id, node] as const));
    expect(byId.get("session-storage")).toMatchObject({ kind: "hero", moreRows: 0, healthySignals: 1 });
    expect(byId.get("session-storage")!.rows.map((row) => row.displayName)).toEqual(["Availability"]);
    expect(byId.get("session-storage")!.rect.width).toBe(CARD_WIDTH.hero);
    expect(byId.get("hosted-agent")).toMatchObject({ kind: "card" });
    expect(byId.get("hosted-agent")!.rect.width).toBe(CARD_WIDTH.card);
  });

  it("opens a chip in place: its owner stays, what it held is drawn", () => {
    const model = calmModel();
    const closed = laid(model).layout;
    const opened = laid(model, new Set(["hm-contosodemo|healthy"])).layout;
    expect(opened.nodes.length).toBeGreaterThan(closed.nodes.length);
    expect(opened.nodes.find((node) => node.id === "flow-run-agent-tasks")).toBeDefined();
  });

  it("is deterministic", () => {
    const model = denseIncidentModel();
    expect(laid(model).layout).toEqual(laid(model).layout);
  });

  it("puts a label on every labelled relationship it draws", () => {
    const { layout } = laid(incidentModel());
    const labelled = layout.edges.filter((edge) => edge.text !== "");
    expect(labelled.length).toBeGreaterThan(0);
    for (const edge of labelled) expect(edge.label).not.toBeNull();
  });
});

describe("kindOf", () => {
  const base = { ...incidentModel().entities[0]! } as Entity;
  it.each([
    ["Unhealthy", "Standard", null, "hero"],
    ["Unhealthy", "Suppressed", null, "pill"],
    ["Degraded", "Standard", null, "card"],
    ["Degraded", "Suppressed", null, "pill"],
    ["Degraded", "Standard", 2, "hero"],
    ["Healthy", "Standard", 1, "hero"],
    ["Healthy", "Standard", null, "pill"],
    ["Unknown", "Standard", null, "pill"],
    ["Deleted", "Standard", null, "pill"],
  ] as const)("a %s entity with %s impact and step %s is a %s", (state, impact, step, expected) => {
    expect(kindOf({ ...base, healthState: state, impact }, step)).toBe(expected);
  });

  it.each([
    ["Healthy", "Standard", null, "card"],
    ["Unknown", "Suppressed", null, "card"],
    ["Degraded", "Standard", null, "card"],
    ["Unhealthy", "Standard", null, "hero"],
    ["Healthy", "Standard", 1, "hero"],
  ] as const)("a changed %s entity with %s impact and step %s is at least a card: %s", (state, impact, step, expected) => {
    expect(kindOf({ ...base, healthState: state, impact }, step, true)).toBe(expected);
  });

  it("lists at most MAX_SIGNAL_ROWS failing signals and counts the rest", () => {
    const signals = Array.from({ length: 7 }, (_, index) => ({ ...base.signals[0]!, name: `s${index}`, displayName: `S${index}`, healthState: "Degraded" as const }));
    const model = incidentModel();
    const entity = { ...base, healthState: "Unhealthy" as const, signals };
    const path = causePath([entity], [], {});
    const layout = layoutCause([entity], model.relationships, path, measure);
    expect(layout.nodes[0]).toMatchObject({ moreRows: 7 - MAX_SIGNAL_ROWS });
    expect(layout.nodes[0]!.rows).toHaveLength(MAX_SIGNAL_ROWS);
  });
});
