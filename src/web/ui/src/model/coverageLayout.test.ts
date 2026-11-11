// @vitest-environment node
import { describe, expect, it } from "vitest";
import { coverage } from "./coverage";
import { GAP, MAX_UNIT, ROW, fitText, layoutCoverage } from "./coverageLayout";
import { calmModel, denseIncidentModel, incidentModel } from "../../tests/viewModels";
import type { Entity, Relationship } from "./types";

function labelsOf(entities: readonly Entity[]): (name: string) => string {
  const byName = new Map(entities.map((entity) => [entity.name, entity.displayName || entity.name] as const));
  return (name) => byName.get(name) ?? name;
}

function laid(model: { entities: readonly Entity[]; relationships: readonly Relationship[] }, width: number, focus: string | null = null) {
  return layoutCoverage(coverage(model.entities, model.relationships, { focus }), labelsOf(model.entities), width);
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width - 0.01 && b.x < a.x + a.width - 0.01 && a.y < b.y + b.height - 0.01 && b.y < a.y + a.height - 0.01;
}

describe("fitText", () => {
  it.each([
    ["Run agent tasks", 400, "Run agent tasks"],
    ["Run agent tasks", 66, "Run agen…"],
    ["Run agent tasks", 20, null],
    ["Run", 22, "Run"],
    ["", 100, ""],
  ] as const)("fits %j into %s px as %j", (text, room, expected) => {
    expect(fitText(text, room)).toBe(expected);
  });

  it("never exceeds the room", () => {
    for (const room of [30, 50, 80, 120, 200]) {
      const fitted = fitText("A rather long entity name that goes on", room);
      if (fitted !== null) expect(fitted.length * 7).toBeLessThanOrEqual(room + 7);
    }
  });
});

describe("layoutCoverage", () => {
  it.each([
    ["the incident model at 1360 px", incidentModel(), 1360, "labels"],
    ["the calm model at 1360 px", calmModel(), 1360, "labels"],
    ["the dense model at 1360 px", denseIncidentModel(), 1360, "glyphs"],
    ["the dense model at 390 px", denseIncidentModel(), 390, "strips"],
  ] as const)("%s uses the %s density", (_name, model, width, density) => {
    expect(laid(model, width).density).toBe(density);
  });

  it("gives every cell of the dense model at 1360 px room for its state glyph and most of them a name", () => {
    const layout = laid(denseIncidentModel(), 1360);
    expect(layout.cells).toHaveLength(81);
    expect(layout.cells.every((cell) => cell.glyph)).toBe(true);
    expect(layout.cells.filter((cell) => cell.label !== null).length).toBeGreaterThan(60);
    expect(layout.unit).toBeGreaterThan(20);
  });

  it("puts no cell on another, and keeps the width", () => {
    for (const width of [1360, 700]) {
      const layout = laid(denseIncidentModel(), width);
      expect(layout.width).toBeLessThanOrEqual(width + 1);
      for (const [index, cell] of layout.cells.entries()) {
        for (const other of layout.cells.slice(index + 1)) expect(overlap(cell, other), `${cell.name} on ${other.name}`).toBe(false);
      }
    }
  });

  it("tiles a parent exactly over its children in a row below", () => {
    const layout = laid(incidentModel(), 1360);
    const byName = new Map(layout.cells.map((cell) => [cell.name, cell] as const));
    const root = byName.get("hm-contosodemo")!;
    const flows = layout.cells.filter((cell) => cell.depth === 1 && cell.band === 0);
    expect(Math.min(...flows.map((cell) => cell.x))).toBeCloseTo(root.x, 5);
    expect(Math.max(...flows.map((cell) => cell.x + cell.width + GAP))).toBeCloseTo(root.x + root.width + GAP, 5);
  });

  it("stacks the band of unconnected parts below the main one", () => {
    const layout = laid(incidentModel(), 1360);
    expect(layout.bands.map((band) => band.band)).toEqual([0, 1]);
    expect(layout.bands[1]!.y).toBeGreaterThan(layout.bands[0]!.y + layout.bands[0]!.height);
    expect(layout.cells.filter((cell) => cell.band === 1).every((cell) => cell.y >= layout.bands[1]!.y)).toBe(true);
  });

  it("reduces 300 entities to strips of state without text", () => {
    const names = Array.from({ length: 300 }, (_, index) => `n${String(index).padStart(3, "0")}`);
    const base = incidentModel().entities[0]!;
    const entities = names.map((name) => ({ ...base, name, displayName: name }));
    const relationships = names.slice(1).map((name, index) => ({ name: `r${index}`, displayName: null, parentEntityName: names[Math.floor(index / 5)]!, childEntityName: name }));
    const layout = laid({ entities, relationships }, 1360);
    expect(layout.density).toBe("strips");
    expect(layout.cells.every((cell) => cell.label === null && !cell.glyph)).toBe(true);
    expect(layout.width).toBeLessThanOrEqual(1361);
  });

  it("never makes a cell wider than MAX_UNIT per leaf, so a small model does not stretch", () => {
    const layout = laid(calmModel(), 4000);
    expect(layout.unit).toBe(MAX_UNIT);
  });

  it("zoomed to a part, lays out only that part, from the left edge", () => {
    const model = incidentModel();
    const layout = laid(model, 1360, "system-app-hosting");
    expect(layout.cells.map((cell) => cell.name)).toEqual(["system-app-hosting", "container-app"]);
    expect(layout.cells[0]!.x).toBe(0);
    expect(layout.cells[0]!.height).toBe(ROW - GAP);
  });

  it("draws a badge on a cell with other parents when it is wide enough", () => {
    const layout = laid(incidentModel(), 1360);
    expect(layout.cells.find((cell) => cell.name === "system-app-hosting")!.badge).toBe(true);
    expect(layout.cells.find((cell) => cell.name === "hm-contosodemo")!.badge).toBe(false);
  });
});
