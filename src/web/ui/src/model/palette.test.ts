import { describe, it, expect } from "vitest";
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { cardTokens, healthVariables, reportTokens, stateTokens, type StateTokens } from "./palette";
import type { HealthState } from "./types";

const CASES: readonly (readonly [HealthState, StateTokens])[] = [
  ["Healthy", { border: "var(--healthy-border)", fill: "var(--healthy-fill)", dot: "var(--healthy-dot)", label: "var(--healthy-label)", word: "Healthy", dashed: false }],
  ["Degraded", { border: "var(--degraded-border)", fill: "var(--degraded-fill)", dot: "var(--degraded-dot)", label: "var(--degraded-label)", word: "Degraded", dashed: false }],
  ["Unhealthy", { border: "var(--unhealthy-border)", fill: "var(--unhealthy-fill)", dot: "var(--unhealthy-dot)", label: "var(--unhealthy-label)", word: "Unhealthy", dashed: false }],
  ["Unknown", { border: "var(--unknown-border)", fill: "var(--unknown-fill)", dot: "var(--unknown-dot)", label: "var(--unknown-label)", word: "Unknown", dashed: true }],
  ["Deleted", { border: "var(--deleted-border)", fill: "var(--deleted-fill)", dot: "var(--deleted-border)", label: "var(--deleted-label)", word: "Standby", dashed: false }],
];

const variableName = (reference: string): string => /^var\(--(.+)\)$/.exec(reference)?.[1] ?? "";

describe("state palette", () => {
  it.each(CASES)("maps %s to its portal border, fill, dot, word and dash", (state, tokens) => {
    expect(stateTokens[state]).toEqual(tokens);
  });
});

describe("report palette", () => {
  it("offers a button colour for every state a report can carry and none for Deleted", () => {
    expect(Object.keys(reportTokens)).toEqual(["Healthy", "Degraded", "Unhealthy", "Unknown"]);
  });
});

describe("health variables", () => {
  const referenced = [
    ...Object.values(stateTokens).flatMap((tokens) =>
      [tokens.border, tokens.fill, tokens.dot, tokens.label].map(variableName),
    ),
    ...Object.values(reportTokens).flatMap((tokens) =>
      [tokens.actionFill, tokens.actionInk].map(variableName),
    ),
  ];

  it.each(["light", "dark"] as const)("defines every variable the state tokens use in %s", (theme) => {
    const defined = healthVariables(theme);
    expect(referenced.filter((name) => !(name in defined))).toEqual([]);
  });

  it.each(["light", "dark"] as const)("defines only colours in %s", (theme) => {
    expect(
      Object.entries(healthVariables(theme)).filter(([, value]) => !/^#[0-9a-f]{6}$/.test(value)),
    ).toEqual([]);
  });

  it("differs between themes for the fills the cards are painted with", () => {
    expect(healthVariables("light")["healthy-fill"]).not.toBe(healthVariables("dark")["healthy-fill"]);
  });
});

describe("card tokens", () => {
  it.each([
    ...Object.entries(cardTokens).filter(([, value]) => typeof value === "string"),
    ...cardTokens.metricBars.map((value) => ["metricBars", value] as const),
  ])("%s refers to a variable that exists", (_key, reference) => {
    const name = variableName(String(reference));
    const known = { ...webLightTheme, ...healthVariables("light") };
    expect(name in known).toBe(true);
    expect(name in { ...webDarkTheme, ...healthVariables("dark") }).toBe(true);
  });
});
