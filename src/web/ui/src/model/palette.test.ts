import { describe, it, expect } from "vitest";
import { stateTokens, type StateTokens } from "./palette";
import type { HealthState } from "./types";

const CASES: readonly (readonly [HealthState, StateTokens])[] = [
  ["Healthy", { border: "var(--healthy-border)", fill: "var(--healthy-fill)", dot: "var(--healthy-dot)", actionFill: "var(--healthy-action-bg)", actionInk: "var(--healthy-action-ink)", label: "var(--healthy-label)", word: "Healthy", dashed: false }],
  ["Degraded", { border: "var(--degraded-border)", fill: "var(--degraded-fill)", dot: "var(--degraded-dot)", actionFill: "var(--degraded-action-bg)", actionInk: "var(--degraded-action-ink)", label: "var(--degraded-label)", word: "Degraded", dashed: false }],
  ["Unhealthy", { border: "var(--unhealthy-border)", fill: "var(--unhealthy-fill)", dot: "var(--unhealthy-dot)", actionFill: "var(--unhealthy-action-bg)", actionInk: "var(--unhealthy-action-ink)", label: "var(--unhealthy-label)", word: "Unhealthy", dashed: false }],
  ["Unknown", { border: "var(--unknown-border)", fill: "var(--unknown-fill)", dot: "var(--unknown-dot)", actionFill: "var(--unknown-action-bg)", actionInk: "var(--unknown-action-ink)", label: "var(--unknown-label)", word: "Unknown", dashed: true }],
  ["Deleted", { border: "var(--deleted-border)", fill: "var(--deleted-fill)", dot: "var(--deleted-border)", actionFill: "var(--deleted-action-bg)", actionInk: "var(--deleted-action-ink)", label: "var(--deleted-label)", word: "Standby", dashed: false }],
];

describe("state palette", () => {
  it.each(CASES)("maps %s to its portal border, fill, dot, word and dash", (state, tokens) => {
    expect(stateTokens[state]).toEqual(tokens);
  });
});
