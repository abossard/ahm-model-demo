import { describe, it, expect } from "vitest";
import { classForState, paletteForState, type DiagrammoClass } from "./state";
import type { HealthState } from "./types";

const CASES: readonly (readonly [HealthState, DiagrammoClass | null, string])[] = [
  ["Healthy", "green", "#a0d8a0"],
  ["Degraded", "amber", "#db7500"],
  ["Unhealthy", "red", "#ba0d16"],
  ["Unknown", null, "#c8c6c4"],
  ["Deleted", "purple", "#8661c5"],
];

describe("health state mapping", () => {
  it.each(CASES)("maps %s to its diagrammo class and portal hex", (state, cls, hex) => {
    expect(classForState(state)).toBe(cls);
    expect(paletteForState(state)).toBe(hex);
  });
});
