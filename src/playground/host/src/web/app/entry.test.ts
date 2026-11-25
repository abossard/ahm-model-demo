import type { LayerId } from "@playground/contracts";
import { describe, expect, it } from "vitest";
import { entryFor, resourceOf } from "./entry";

const player = { id: "p-1234abcd", handle: "Neon Pilot" };

describe("entryFor", () => {
  it.each<[LayerId, string | null, string, Record<string, unknown>]>([
    [1, null, "hello_show", { player }],
    [2, null, "lab_open", { player }],
    [3, null, "checkers_open", { player }],
    [3, "ab12cd", "checkers_open", { player, tableId: "ab12cd" }],
    [4, "ab12cd", "trader_open", { player }],
    [5, "tbl-77x", "blackjack_open", { player, tableId: "tbl-77x" }],
  ])("layer %s table %s", (layer, table, tool, args) => {
    expect(entryFor(layer, player, table)).toEqual({ tool, args });
  });
});

describe("resourceOf", () => {
  it.each([
    ["hello_show", "ui://playground/hello.html"],
    ["checkers_open", "ui://playground/checkers.html"],
    ["blackjack_open", "ui://playground/blackjack.html"],
  ] as const)("%s", (tool, uri) => {
    expect(resourceOf(tool)).toBe(uri);
  });
});
