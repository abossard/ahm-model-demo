import { describe, expect, it } from "vitest";
import { CHEAT_START, isTypingTarget, nextCheat } from "./cheat";

const typeAll = (text: string) => [...text].reduce((state, key) => nextCheat(state, key), CHEAT_START);

describe("nextCheat", () => {
  it.each([
    ["the code", "opencity", true],
    ["upper case", "OPENCITY", true],
    ["noise before", "xxopencity", true],
    ["a typo", "opencty", false],
    ["half the code", "open", false],
    ["code then more", "opencityx", true],
  ])("%s", (_name, keys, hit) => {
    const hits = [...keys].reduce<boolean[]>((all, key, index) => {
      all.push(nextCheat(typeAll(keys.slice(0, index)), key).hit);
      return all;
    }, []);
    expect(hits.some(Boolean)).toBe(hit);
  });

  it("ignores named keys such as Shift", () => {
    expect(nextCheat({ typed: "open", hit: false }, "Shift").typed).toBe("open");
  });

  it("resets after a hit so the code can fire twice", () => {
    expect(typeAll("opencity").typed).toBe("");
  });
});

describe("isTypingTarget", () => {
  it.each([
    ["INPUT", false, true], ["textarea", false, true], ["SELECT", false, true],
    ["DIV", true, true], ["BODY", false, false], ["BUTTON", false, false],
  ])("%s editable=%s", (tag, editable, expected) => {
    expect(isTypingTarget(tag, editable)).toBe(expected);
  });
});
