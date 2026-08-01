import { describe, it, expect } from "vitest";
import { stateTokens, type StateTokens } from "./palette";
import type { HealthState } from "./types";

const CASES: readonly (readonly [HealthState, StateTokens])[] = [
  ["Healthy", { border: "#a0d8a0", fill: "#f2f8f2", dot: "#4c9a2a", word: "Healthy", dashed: false }],
  ["Degraded", { border: "#db7500", fill: "#fbf2e7", dot: "#c26a00", word: "Degraded", dashed: false }],
  ["Unhealthy", { border: "#ba0d16", fill: "#faeceb", dot: "#c50f18", word: "Unhealthy", dashed: false }],
  ["Unknown", { border: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", word: "Unknown", dashed: true }],
  ["Deleted", { border: "#8661c5", fill: "#f4f0fb", dot: "#8661c5", word: "Standby", dashed: false }],
];

describe("state palette", () => {
  it.each(CASES)("maps %s to its portal border, fill, dot, word and dash", (state, tokens) => {
    expect(stateTokens[state]).toEqual(tokens);
  });
});
