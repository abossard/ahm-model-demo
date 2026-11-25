import { NEW_CAREER, type Career } from "@playground/contracts";
import { describe, expect, it } from "vitest";
import { higherCareer, sameCareer, jobToOpen, offerFor, parseStoredCareer, progressLine, rungState } from "./career";

const at = (unlocked: Career["unlocked"], lab: Career["lab"] = [], completed = false): Career => ({ unlocked, lab, completed });

describe("rungState", () => {
  it.each([
    [1, 1, "open"], [1, 2, "locked"], [3, 3, "open"], [3, 4, "locked"], [5, 5, "open"], [2, 5, "locked"],
  ] as const)("unlocked %s, layer %s is %s", (unlocked, layer, state) => {
    expect(rungState(at(unlocked), layer)).toBe(state);
  });
});

describe("jobToOpen", () => {
  it.each([
    [2, "Press the button inside the View."],
    [3, "Try any three exhibits."],
    [4, "Take a piece."],
    [5, "Sell cargo for more than you paid."],
  ] as const)("layer %s", (layer, job) => {
    expect(jobToOpen(layer)).toBe(job);
  });
});

describe("parseStoredCareer", () => {
  it.each([
    ["nothing stored", null, NEW_CAREER],
    ["not json", "{", NEW_CAREER],
    ["wrong shape", '{"unlocked":9,"lab":[],"completed":false}', NEW_CAREER],
    ["valid", '{"unlocked":3,"lab":["log"],"completed":false}', at(3, ["log"])],
  ])("%s", (_name, raw, expected) => {
    expect(parseStoredCareer(raw)).toEqual(expected);
  });
});

describe("higherCareer", () => {
  it.each([
    ["more layers", at(2), at(4), at(4)],
    ["same layer, more exhibits", at(2, ["log"]), at(2, ["log", "theme"]), at(2, ["log", "theme"])],
    ["completed beats layer", at(5), at(5, [], true), at(5, [], true)],
    ["tie keeps the first", at(3), at(3), at(3)],
    ["local higher than server", at(5), at(1), at(5)],
  ])("%s", (_name, a, b, expected) => {
    expect(higherCareer(a, b)).toEqual(expected);
  });
});

describe("offerFor", () => {
  it.each([
    ["nothing changed", at(2), at(2), null],
    ["exhibit tried, no layer", at(2), at(2, ["log"]), null],
    ["layer 2 opens", at(1), at(2), { headline: "Layer 2 open", name: "The Lab", go: 2 }],
    ["layer 3 opens", at(2), at(3), { headline: "Layer 3 open", name: "Checkers", go: 3 }],
    ["layer 5 opens", at(4), at(5), { headline: "Layer 5 open", name: "Blackjack", go: 5 }],
    ["cheat jumps", at(1), at(5), { headline: "All layers open", name: "Code accepted", go: 2 }],
    ["career completes", at(5), at(5, [], true), { headline: "Career complete", name: "Every layer", go: null }],
    ["server went down", at(4), at(2), null],
  ])("%s", (_name, prev, next, expected) => {
    const offer = offerFor(prev, next);
    if (expected === null) expect(offer).toBeNull();
    else expect(offer).toMatchObject(expected);
  });

  it("every offer names what was done and what is next", () => {
    for (const layer of [2, 3, 4, 5] as const) {
      const offer = offerFor(at((layer - 1) as Career["unlocked"]), at(layer));
      expect(offer?.did).not.toBe("");
      expect(offer?.next).toMatch(/^Next: /);
    }
  });
});

describe("progressLine", () => {
  it.each([
    [at(1), "1 of 5 layers open"],
    [at(4), "4 of 5 layers open"],
    [at(5, [], true), "Career complete"],
  ])("%j", (career, line) => {
    expect(progressLine(career)).toBe(line);
  });
});

describe("sameCareer", () => {
  it.each([
    ["equal", at(2, ["log"]), at(2, ["log"]), true],
    ["lab order does not matter", at(3, ["log", "theme"]), at(3, ["theme", "log"]), true],
    ["another layer", at(2), at(3), false],
    ["another exhibit", at(2, ["log"]), at(2, ["theme"]), false],
    ["more exhibits", at(2, ["log"]), at(2, ["log", "theme"]), false],
    ["completed", at(5), at(5, [], true), false],
  ])("%s", (_name, a, b, same) => {
    expect(sameCareer(a, b)).toBe(same);
  });
});
