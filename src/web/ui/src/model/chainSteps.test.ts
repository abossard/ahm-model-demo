// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chainSteps } from "./chainSteps";

const ENTITIES = ["root", "flow", "Store", "leaf", "other"];

describe("chainSteps", () => {
  it.each([
    ["numbers from the last name", ["root", "flow", "Store", "leaf"], { root: 4, flow: 3, Store: 2, leaf: 1 }],
    ["matches names regardless of case", ["ROOT", "store"], { root: 2, Store: 1 }],
    ["skips names the model does not have", ["root", "gone", "leaf"], { root: 2, leaf: 1 }],
    ["counts a repeated name once", ["root", "leaf", "root"], { root: 2, leaf: 1 }],
    ["has no steps without a chain", [], {}],
  ] as const)("%s", (_name, chain, expected) => {
    expect(Object.fromEntries(chainSteps(chain, ENTITIES))).toEqual(expected);
  });
});
