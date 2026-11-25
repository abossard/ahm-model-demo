import { describe, expect, it } from "vitest";
import { kindOf, toggle, treeRows } from "./jsonRows";

const sample = { jsonrpc: "2.0", id: 4, params: { name: "hello_ping", arguments: { player: { id: "p-1" } } }, tags: [], list: [1, null] };

describe("kindOf", () => {
  it.each([[null, "null"], [undefined, "null"], [[], "array"], [{}, "object"], ["a", "string"], [1, "number"], [false, "boolean"]])(
    "%j", (value, kind) => expect(kindOf(value)).toBe(kind),
  );
});

describe("treeRows", () => {
  it("opens three levels and no deeper by default", () => {
    const rows = treeRows(sample, new Set());
    expect(rows.map((row) => row.path)).toEqual([
      "$", "$.jsonrpc", "$.id", "$.params", "$.params.name", "$.params.arguments", "$.params.arguments.player",
      "$.tags", "$.list", "$.list[0]", "$.list[1]",
    ]);
    expect(rows.find((row) => row.path === "$.params.arguments.player")).toMatchObject({ expandable: true, expanded: false });
  });

  it.each([
    ["scalar string", "x", '"x"'],
    ["scalar number", 3, "3"],
    ["null", null, "null"],
    ["empty object", {}, "{}"],
    ["empty array", [], "[]"],
  ])("%s", (_name, value, text) => {
    const [row] = treeRows(value, new Set());
    expect(row?.text).toBe(text);
    expect(row?.expandable).toBe(false);
  });

  it.each([
    ["an open container counts its keys", { a: 1, b: 2 }, new Set<string>(), "{  2 keys"],
    ["one key is singular", { a: 1 }, new Set<string>(), "{  1 key"],
    ["a closed container is summarised", { a: 1, b: 2 }, new Set(["$"]), "{ … }  2 keys"],
    ["an array counts items", [1, 2, 3], new Set<string>(), "[  3 items"],
  ])("%s", (_name, value, toggled, text) => {
    expect(treeRows(value, toggled)[0]?.text).toBe(text);
  });

  it("a toggled path flips: closes an open one, opens a deep one", () => {
    const closed = treeRows(sample, new Set(["$.params"]));
    expect(closed.some((row) => row.path === "$.params.name")).toBe(false);
    const opened = treeRows(sample, new Set(["$.params.arguments.player"]));
    expect(opened.some((row) => row.path === "$.params.arguments.player.id")).toBe(true);
  });

  it("depth and key are set for the component to indent", () => {
    const row = treeRows(sample, new Set()).find((item) => item.path === "$.params.name");
    expect(row).toMatchObject({ depth: 2, key: "name", kind: "string", text: '"hello_ping"' });
  });

  it("a long string is cut and says how long it was", () => {
    const [row] = treeRows("x".repeat(1000), new Set());
    expect(row?.text).toContain("(1000 chars)");
    expect(row!.text.length).toBeLessThan(500);
  });
});

describe("toggle", () => {
  it("adds, then removes, and never mutates", () => {
    const empty = new Set<string>();
    const once = toggle(empty, "$.a");
    expect([...empty]).toEqual([]);
    expect([...once]).toEqual(["$.a"]);
    expect([...toggle(once, "$.a")]).toEqual([]);
  });
});
