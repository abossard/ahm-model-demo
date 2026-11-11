import { describe, expect, it } from "vitest";
import type { EntityInfo, SignalInfo, StateCode } from "./timeline";
import { ROW_HEIGHT, allKeys, buildRows, entityKey, entityOfKey, moveFocus, revealKeys, rootEntity, rootKeys, scrollToShow, signalKey, visibleRows, type RowInput } from "./timelineRows";

const signal = (name: string): SignalInfo => ({ name, displayName: name, kind: null, unit: null, refreshInterval: null, rules: { degraded: null, unhealthy: null, dynamic: false } });
const entity = (name: string, parents: string[] = [], signals: string[] = []): EntityInfo => ({ name, displayName: name.toUpperCase(), parents, state: 1, signals: signals.map(signal) });

const MODEL: EntityInfo[] = [
  entity("root"),
  entity("flow-a", ["root"]),
  entity("flow-b", ["root"], ["errors"]),
  entity("comp-a", ["flow-a"]),
  entity("res-a", ["comp-a"], ["cpu", "mem"]),
  entity("res-b", ["comp-a", "flow-b"], ["cpu"]),
  entity("stray", [], ["cpu"]),
];

const path = (...names: string[]): string => entityKey(names);
const ALL = new Set([...allKeys(MODEL)]);

function input(parts: Partial<RowInput> = {}): RowInput {
  return { entities: MODEL, order: "structure", open: ALL, rank: () => 1, ...parts };
}

const names = (parts: Partial<RowInput> = {}) =>
  buildRows(input(parts)).rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "entity" ? row.entity : `${row.signal}()`}`);

describe("buildRows", () => {
  it("is a folder tree of the relationships: roots first, an open entity shows its signals, then its dependencies", () => {
    expect(names()).toEqual([
      "root",
      "  flow-a",
      "    comp-a",
      "      res-a",
      "        cpu()",
      "        mem()",
      "      res-b",
      "        cpu()",
      "  flow-b",
      "    errors()",
      "    res-b",
      "      cpu()",
      "stray",
      "  cpu()",
    ]);
  });

  it("shows only the roots while nothing is open", () => {
    expect(names({ open: new Set() })).toEqual(["root", "stray"]);
  });

  it("opens one row at a time: a path, not a name, is what is open", () => {
    const open = new Set([path("root"), path("root", "flow-b")]);

    expect(names({ open })).toEqual(["root", "  flow-a", "  flow-b", "    errors()", "    res-b", "stray"]);
  });

  it("an entity with several parents has a row, and a key, under each", () => {
    const rows = buildRows(input()).rows.filter((row) => row.kind === "entity" && row.entity === "res-b");

    expect(rows.map((row) => row.key)).toEqual([path("root", "flow-a", "comp-a", "res-b"), path("root", "flow-b", "res-b")]);
    expect(new Set(buildRows(input()).rows.map((row) => row.key)).size).toBe(buildRows(input()).rows.length);
  });

  it("says what each row is: its place among its siblings, signals first, and whether it relates to anything", () => {
    const rows = buildRows(input()).rows;
    const at = (key: string) => rows.find((row) => row.key === key);

    expect(at(path("root", "flow-b", "res-b"))).toMatchObject({ depth: 2, position: 2, size: 2, expandable: true, expanded: true, signalCount: 1, childCount: 0, connected: true });
    expect(rows.find((row) => row.kind === "signal" && row.signal === "errors")).toMatchObject({ position: 1, size: 2, parent: path("root", "flow-b"), depth: 2 });
    expect(at(path("stray"))).toMatchObject({ connected: false, expandable: true });
    expect(at(path("root"))).toMatchObject({ position: 1, size: 2, childCount: 2, signalCount: 0 });
  });

  it("an entity that relates to nothing comes after the roots that do, whatever the order", () => {
    const model = [entity("lone"), ...MODEL];

    expect(names({ entities: model, open: new Set() })).toEqual(["root", "lone", "stray"]);
    expect(names({ entities: model, open: new Set(), order: "worst", rank: (name) => (name === "lone" ? 3 : 1) })).toEqual(["root", "lone", "stray"]);
  });

  it("orders worst first by rank, then name, among the siblings at every level", () => {
    const rank = (name: string): StateCode => (name === "flow-b" ? 3 : name === "flow-a" ? 2 : name === "res-b" ? 3 : 1);

    const rows = names({ order: "worst", rank });

    expect(rows.slice(0, 4)).toEqual(["root", "  flow-b", "    errors()", "    res-b"]);
    expect(rows.indexOf("  flow-a")).toBeGreaterThan(rows.indexOf("  flow-b"));
    const comp = rows.slice(rows.indexOf("    comp-a"));
    expect(comp.slice(0, 3)).toEqual(["    comp-a", "      res-b", "        cpu()"]);
  });

  it("places rows one under another and reports the total height", () => {
    const model = buildRows(input());

    let y = 0;
    for (const row of model.rows) {
      expect(row.y).toBe(y);
      expect(row.h).toBe(row.kind === "signal" ? ROW_HEIGHT.signal : ROW_HEIGHT.entity);
      y += row.h;
    }
    expect(model.height).toBe(y);
    expect(model.indexByKey.get(path("root", "flow-a"))).toBe(model.rows.findIndex((row) => row.kind === "entity" && row.entity === "flow-a"));
    expect(model.indexByKey.get(signalKey(path("stray"), "cpu"))).toBe(model.rows.length - 1);
  });

  it.each([
    { name: "a cycle ends where it comes back", entities: [entity("r"), entity("a", ["r", "b"]), entity("b", ["a"])], expected: ["r", "  a", "    b"] },
    { name: "a cycle with no root is still reachable, from its first entity", entities: [entity("a", ["b"]), entity("b", ["a"])], expected: ["a", "  b"] },
    { name: "an entity that is its own parent is a root", entities: [entity("a", ["a"])], expected: ["a"] },
    { name: "an unknown parent counts as none", entities: [entity("a", ["ghost"])], expected: ["a"] },
    { name: "a parent named twice is one relationship", entities: [entity("p"), entity("c", ["p", "p"])], expected: ["p", "  c"] },
  ])("$name", ({ entities, expected }) => {
    expect(names({ entities, open: new Set(allKeys(entities)) })).toEqual(expected);
  });
});

describe("keys", () => {
  it("lists the rows an entity has when everything is open, in the order they show", () => {
    expect(allKeys(MODEL).map(entityOfKey)).toEqual(["root", "flow-a", "comp-a", "res-a", "res-b", "flow-b", "res-b", "stray"]);
  });

  it.each([
    { name: "the roots that have dependencies, not what relates to nothing", entities: MODEL, expected: [path("root")] },
    { name: "none when nothing relates", entities: [entity("a"), entity("b")], expected: [] },
  ])("starts at $name", ({ entities, expected }) => {
    expect(rootKeys(entities)).toEqual(expected);
  });

  it("names the entity of a row key", () => {
    expect(entityOfKey(path("root", "flow-a", "comp-a"))).toBe("comp-a");
  });

  it("the root entity is the first root with dependencies", () => {
    expect(rootEntity(MODEL)?.name).toBe("root");
    expect(rootEntity([entity("lone"), ...MODEL])?.name).toBe("root");
    expect(rootEntity([])).toBeUndefined();
  });
});

describe("revealKeys", () => {
  const open = (...keys: string[]) => new Set(keys);

  it.each([
    { name: "an entity under one parent: each ancestor, then its own row", entity: "res-a", open: open(), prefer: null, expected: [path("root"), path("root", "flow-a"), path("root", "flow-a", "comp-a"), path("root", "flow-a", "comp-a", "res-a")] },
    { name: "a root", entity: "root", open: open(), prefer: null, expected: [path("root")] },
    { name: "one with several parents: the first path when none is open", entity: "res-b", open: open(), prefer: null, expected: [path("root"), path("root", "flow-a"), path("root", "flow-a", "comp-a"), path("root", "flow-a", "comp-a", "res-b")] },
    { name: "one with several parents: a path that is open already", entity: "res-b", open: open(path("root"), path("root", "flow-b")), prefer: null, expected: [path("root"), path("root", "flow-b"), path("root", "flow-b", "res-b")] },
    { name: "one with several parents: the row that was clicked", entity: "res-b", open: open(), prefer: path("root", "flow-b", "res-b"), expected: [path("root"), path("root", "flow-b"), path("root", "flow-b", "res-b")] },
    { name: "a row that is not one of its own", entity: "res-b", open: open(), prefer: path("root", "flow-a"), expected: [path("root"), path("root", "flow-a"), path("root", "flow-a", "comp-a"), path("root", "flow-a", "comp-a", "res-b")] },
    { name: "an entity the model does not have", entity: "ghost", open: open(), prefer: null, expected: [] },
  ])("opens the way to $name", ({ entity: name, open: held, prefer, expected }) => {
    expect(revealKeys(MODEL, name, { open: held, prefer })).toEqual(expected);
  });

  it("what it opens shows the entity with its signals", () => {
    const keys = revealKeys(MODEL, "res-a", { open: new Set(), prefer: null });

    const rows = buildRows(input({ open: new Set(keys) })).rows;

    expect(rows.map((row) => (row.kind === "signal" ? `${row.entity}.${row.signal}` : row.entity))).toContain("res-a.cpu");
    expect(rows.some((row) => row.key === keys.at(-1))).toBe(true);
  });
});

describe("virtualization", () => {
  const model = buildRows(input({ entities: Array.from({ length: 200 }, (_, i) => entity(`e${i}`, i === 0 ? [] : ["e0"])), open: new Set([path("e0")]) }));

  it.each([
    { name: "the top", top: 0, height: 100 },
    { name: "the middle", top: 3000, height: 300 },
    { name: "past the end", top: model.height - 50, height: 300 },
  ])("shows only the rows in the viewport at $name", ({ top, height }) => {
    const [from, to] = visibleRows(model, top, height, 0);

    expect(to - from).toBeLessThanOrEqual(Math.ceil(height / ROW_HEIGHT.entity) + 2);
    for (let i = from; i < to; i += 1) {
      const row = model.rows[i];
      expect(row && row.y + row.h > top && row.y < top + height).toBe(true);
    }
    const before = model.rows[from - 1];
    if (before) expect(before.y + before.h).toBeLessThanOrEqual(top);
  });

  it("overscan adds rows either side without leaving the list", () => {
    const [from, to] = visibleRows(model, 0, 100, 3);

    expect(from).toBe(0);
    expect(to).toBeGreaterThan(visibleRows(model, 0, 100, 0)[1]);
  });

  it.each([
    { name: "a visible row needs no scroll", index: 2, top: 0, height: 400, expected: null },
    { name: "a row below the view scrolls up to it", index: 100, top: 0, height: 400, expected: (model.rows[100]?.y ?? 0) - ROW_HEIGHT.entity },
    { name: "a row above the view scrolls back", index: 1, top: 3000, height: 400, expected: Math.max(0, (model.rows[1]?.y ?? 0) - ROW_HEIGHT.entity) },
  ])("$name", ({ index, top, height, expected }) => {
    expect(scrollToShow(model.rows[index]!, top, height)).toBe(expected);
  });

  it.each([
    [0, -1, 0],
    [0, 1, 1],
    [model.rows.length - 1, 1, model.rows.length - 1],
    [5, 10, 15],
  ])("moves focus from %d by %d to %d", (index, step, expected) => {
    expect(moveFocus(model, index, step)).toBe(expected);
  });
});
