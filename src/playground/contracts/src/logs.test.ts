import { describe, expect, it } from "vitest";
import { collapseRuns, countText, filterLines, kindsOf, visibleLog } from "./logs";

const line = (kind: string, text: string) => ({ kind, text });
const none = new Set<string>();

describe("collapseRuns", () => {
  it.each([
    ["empty", [], []],
    ["one line", [line("a", "x")], [1]],
    ["a run of three", [line("a", "x"), line("a", "x"), line("a", "x")], [3]],
    ["the same text apart is two rows", [line("a", "x"), line("a", "y"), line("a", "x")], [1, 1, 1]],
    ["the same text of another kind is another row", [line("a", "x"), line("b", "x")], [1, 1]],
    ["two runs", [line("a", "x"), line("a", "x"), line("a", "y"), line("a", "y")], [2, 2]],
  ])("%s", (_name, lines, counts) => {
    expect(collapseRuns(lines).map((row) => row.count)).toEqual(counts);
  });
});

describe("kindsOf", () => {
  it.each([
    [[], []],
    [[line("b", "1"), line("a", "2"), line("b", "3")], ["b", "a"]],
  ])("%j", (lines, kinds) => {
    expect(kindsOf(lines)).toEqual(kinds);
  });
});

describe("filterLines", () => {
  const lines = [line("size", "asked for 720 px"), line("career", "layer 5 open"), line("message", "Hello Layer")];
  it.each([
    ["nothing off, no query", none, "", 3],
    ["a kind off", new Set(["size"]), "", 2],
    ["every kind off", new Set(["size", "career", "message"]), "", 0],
    ["a query ignores case", none, "LAYER", 2],
    ["a query is trimmed", none, "  720 ", 1],
    ["a kind off and a query", new Set(["career"]), "layer", 1],
    ["no match", none, "zzz", 0],
  ])("%s", (_name, off, query, count) => {
    expect(filterLines(lines, off, query)).toHaveLength(count);
  });
});

describe("visibleLog", () => {
  it("collapses what the filter leaves next to each other", () => {
    const lines = [line("a", "x"), line("b", "noise"), line("a", "x")];
    expect(visibleLog(lines, new Set(["b"]), "").map((row) => row.count)).toEqual([2]);
    expect(visibleLog(lines, none, "").map((row) => row.count)).toEqual([1, 1, 1]);
  });
});

describe("countText", () => {
  it.each([[1, ""], [2, "×2"], [7, "×7"]])("%i", (count, text) => {
    expect(countText(count)).toBe(text);
  });
});
