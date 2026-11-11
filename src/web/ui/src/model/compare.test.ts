import { describe, expect, it } from "vitest";
import { diffViewModel } from "../../tests/viewModels";
import { basisFor, compareDrawings, linkKey, noEntitiesText } from "./compare";

const view = diffViewModel();
const names = (items: readonly { readonly name: string }[]): string[] => items.map((item) => item.name);

describe("basisFor", () => {
  it.each(["base", "proposed"] as const)("lists everything either side has, in one order, for the %s side", (side) => {
    const basis = basisFor(view, side);
    const everything = new Set([...names(view.base.entities), ...names(view.proposed.entities)]);
    expect(new Set(names(basis.entities))).toEqual(everything);
    expect(basis.entities).toHaveLength(everything.size);
  });

  it("puts the entities in the same order for both sides, so two arrangements that sort by input agree", () => {
    expect(names(basisFor(view, "base").entities)).toEqual(names(basisFor(view, "proposed").entities));
    expect(names(basisFor(view, "base").relationships)).toEqual(names(basisFor(view, "proposed").relationships));
  });

  it.each([
    { side: "base" as const, impact: "Standard" },
    { side: "proposed" as const, impact: "Limited" },
  ])("keeps the $side side's own version of an entity both sides have", ({ side, impact }) => {
    expect(basisFor(view, side).entities.find((entity) => entity.name === "system-ai-inference")?.impact).toBe(impact);
  });

  it.each([
    { name: "report-queue", side: "base" as const },
    { name: "discovered-app-topology", side: "proposed" as const },
  ])("fills in $name, which the $side side lacks, from the other side", ({ name, side }) => {
    expect(names(basisFor(view, side).entities)).toContain(name);
  });
});

describe("compareDrawings", () => {
  const split = compareDrawings(view, "split");
  const merged = compareDrawings(view, "merged");

  it("draws a split view twice, Base then Proposed, each with its own entities", () => {
    expect(split.map((drawing) => drawing.side)).toEqual(["base", "proposed"]);
    expect(split.map((drawing) => drawing.compare.side)).toEqual(["base", "proposed"]);
    expect(split[0]?.entities).toBe(view.base.entities);
    expect(split[1]?.entities).toBe(view.proposed.entities);
  });

  it.each([
    { side: 0, has: "removed", lacks: "added" },
    { side: 1, has: "added", lacks: "removed" },
  ])("marks on side $side only what exists there", ({ side, has, lacks }) => {
    const marks = [...(split[side]?.badges.values() ?? [])];
    expect(marks).toContain(has);
    expect(marks).not.toContain(lacks);
    expect(marks).toContain("changed");
  });

  it("gives each side the other side's versions too, in the same order", () => {
    const [base, proposed] = split as [(typeof split)[number], (typeof split)[number]];
    expect(base.compare.other).toEqual(proposed.compare.basis);
    expect(proposed.compare.other).toEqual(base.compare.basis);
    expect(names(base.compare.other.entities)).toEqual(names(base.compare.basis.entities));
  });

  it("gives both sides of a split view the same union, one version of each entity, the Proposed model's where both have it", () => {
    expect(split[0]?.compare.union).toBe(split[1]?.compare.union);
    const union = split[0]?.compare.union;
    expect(union?.entities.find((entity) => entity.name === "system-ai-inference")?.impact).toBe("Limited");
    expect(names(union?.entities ?? [])).toEqual(names(split[0]?.compare.basis.entities ?? []));
  });

  it("gives both sides of a split view every mark, to arrange on", () => {
    for (const drawing of split) expect([...drawing.compare.marks.values()].sort()).toEqual(["added", "added", "changed", "changed", "changed", "removed"].sort());
  });

  it("draws a merged view once over the union, every entity carrying its mark", () => {
    expect(merged).toHaveLength(1);
    const [drawing] = merged;
    expect(drawing?.side).toBe("merged");
    expect(names(drawing?.entities ?? [])).toEqual(expect.arrayContaining(["report-queue", "pager-webhook", "discovered-app-topology"]));
    expect(drawing?.badges.get("report-queue")).toBe("added");
    expect(drawing?.badges.get("discovered-app-topology")).toBe("removed");
    expect(drawing?.badges.get("container-app")).toBe("changed");
    expect(drawing?.compare.basis.entities).toBe(drawing?.entities);
    expect(drawing?.compare.union.entities).toBe(drawing?.entities);
  });

  it("draws a relationship both sides have once, and one only a side has on that side", () => {
    const link = (side: number): string[] => (split[side]?.relationships ?? []).map((item) => item.name);
    expect(link(1)).toContain("live-report-queue");
    expect(link(0)).not.toContain("live-report-queue");
    expect(names(merged[0]?.relationships ?? []).filter((name) => name === "live-report-queue")).toHaveLength(1);
  });
});

describe("noEntitiesText", () => {
  const basis = { entities: [], relationships: [] };
  const marks = new Map();
  it.each([
    { compare: undefined, text: "This health model has no entities." },
    { compare: { side: "merged" as const, basis, other: basis, union: basis, marks }, text: "This health model has no entities." },
    { compare: { side: "base" as const, basis, other: basis, union: basis, marks }, text: "Model now: no entities." },
    { compare: { side: "proposed" as const, basis, other: basis, union: basis, marks }, text: "Model after the changes: no entities." },
  ])("says $text", ({ compare, text }) => {
    expect(noEntitiesText(compare)).toBe(text);
  });
});

describe("linkKey", () => {
  it("tells the direction of a link and does not mix up names that share a prefix", () => {
    expect(linkKey("a", "b")).not.toBe(linkKey("b", "a"));
    expect(linkKey("a", "bc")).not.toBe(linkKey("ab", "c"));
  });
});
