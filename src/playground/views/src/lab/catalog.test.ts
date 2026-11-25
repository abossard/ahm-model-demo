import { describe, expect, it } from "vitest";
import { LAB_EXHIBITS } from "@playground/contracts";
import { clip, EXHIBITS, GROUPS, unlockLine, withDone } from "./catalog";

describe("exhibits", () => {
  it.each(LAB_EXHIBITS.map((id) => [id]))("%s is defined once, in a known group", (id) => {
    const found = EXHIBITS.filter((exhibit) => exhibit.id === id);
    expect(found).toHaveLength(1);
    expect(GROUPS.map((group) => group.id)).toContain(found[0]!.group);
  });

  it.each([
    [[], "0 of 10 tried. 3 more opens Checkers."],
    [["log"], "1 of 10 tried. 2 more opens Checkers."],
    [["log", "theme", "message"], "3 of 10 tried. Checkers is open."],
    [["log", "theme", "message", "progress"], "4 of 10 tried. Checkers is open."],
  ] as const)("unlockLine(%j)", (done, line) => expect(unlockLine(done)).toBe(line));

  it.each([
    [[], "log", ["log"]],
    [["log"], "log", ["log"]],
    [["log"], "theme", ["log", "theme"]],
  ] as const)("withDone(%j, %s)", (done, id, expected) => expect(withDone(done, id)).toEqual(expected));

  it.each([["short", "short"], ["x".repeat(300), `${"x".repeat(239)}…`]])("clip %#", (input, out) => expect(clip(input)).toBe(out));
});
