// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { CAREER_KEY, PLAYER_KEY, getCareerCopy, getPlayer, saveCareerCopy } from "./identity";

beforeEach(() => localStorage.clear());

describe("getPlayer", () => {
  it("makes a player once and keeps it", () => {
    const first = getPlayer();
    expect(first.id).toMatch(/^p-[0-9a-f]{16}$/);
    expect(getPlayer()).toEqual(first);
    expect(JSON.parse(localStorage.getItem(PLAYER_KEY)!)).toEqual(first);
  });

  it.each([
    ["not JSON", "{"],
    ["the wrong shape", JSON.stringify({ id: "x", handle: "" })],
  ])("replaces a stored player that is %s", (_name, stored) => {
    localStorage.setItem(PLAYER_KEY, stored);
    const player = getPlayer();
    expect(player.id).toMatch(/^p-/);
    expect(getPlayer()).toEqual(player);
  });
});

describe("career copy", () => {
  it("round trips", () => {
    const career = { unlocked: 3 as const, lab: ["log" as const], completed: false };
    saveCareerCopy(career);
    expect(getCareerCopy()).toEqual(career);
  });

  it.each([
    ["nothing stored", null],
    ["not JSON", "{"],
    ["the wrong shape", JSON.stringify({ unlocked: 9 })],
  ])("reads null for %s", (_name, stored) => {
    if (stored !== null) localStorage.setItem(CAREER_KEY, stored);
    expect(getCareerCopy()).toBeNull();
  });
});
