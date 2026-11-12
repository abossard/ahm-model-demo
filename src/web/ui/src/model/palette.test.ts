import { describe, it, expect } from "vitest";
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";
import {
  cardTokens,
  diffTokens,
  edgeAppearance,
  healthVariables,
  PALETTES,
  impactOf,
  reportTokens,
  stateTokens,
  type StateTokens,
} from "./palette";
import type { ThemeName } from "./theme";
import type { HealthState } from "./types";

const CASES: readonly (readonly [HealthState, StateTokens])[] = [
  ["Healthy", { border: "var(--healthy-border)", fill: "var(--healthy-fill)", dot: "var(--healthy-dot)", line: "var(--healthy-line)", on: "var(--healthy-on)", label: "var(--healthy-label)", word: "Healthy", dashed: false, shape: "check" }],
  ["Degraded", { border: "var(--degraded-border)", fill: "var(--degraded-fill)", dot: "var(--degraded-dot)", line: "var(--degraded-line)", on: "var(--degraded-on)", label: "var(--degraded-label)", word: "Degraded", dashed: false, shape: "triangle" }],
  ["Unhealthy", { border: "var(--unhealthy-border)", fill: "var(--unhealthy-fill)", dot: "var(--unhealthy-dot)", line: "var(--unhealthy-line)", on: "var(--unhealthy-on)", label: "var(--unhealthy-label)", word: "Unhealthy", dashed: false, shape: "square" }],
  ["Unknown", { border: "var(--unknown-border)", fill: "var(--unknown-fill)", dot: "var(--unknown-dot)", line: "var(--unknown-line)", on: "var(--unknown-on)", label: "var(--unknown-label)", word: "Unknown", dashed: true, shape: "ring" }],
  ["Deleted", { border: "var(--deleted-border)", fill: "var(--deleted-fill)", dot: "var(--deleted-border)", line: "var(--deleted-line)", on: "var(--deleted-on)", label: "var(--deleted-label)", word: "Standby", dashed: false, shape: "diamond" }],
];

const variableName = (reference: string): string => /^var\(--(.+)\)$/.exec(reference)?.[1] ?? "";
const THEMES: readonly ThemeName[] = ["light", "dark"];

describe("state palette", () => {
  it.each(CASES)("maps %s to its border, fill, dot, line, mark, word, dash and shape", (state, tokens) => {
    expect(stateTokens[state]).toEqual(tokens);
  });

  it("gives every state its own shape", () => {
    const shapes = Object.values(stateTokens).map((tokens) => tokens.shape);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it.each(THEMES)("tints every state's card in its own hue in %s", (theme) => {
    const colors = healthVariables(theme);
    const channels = (hex: string): readonly number[] => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    const [healthy, degraded, unhealthy, deleted] = ["healthy", "degraded", "unhealthy", "deleted"].map((name) => channels(colors[`${name}-fill`] as string)) as [number[], number[], number[], number[]];
    expect(healthy[1]).toBeGreaterThan(healthy[0]!);
    expect(healthy[1]).toBeGreaterThan(healthy[2]!);
    expect(degraded[0]).toBeGreaterThan(degraded[2]!);
    expect(degraded[1]).toBeGreaterThan(degraded[2]!);
    expect(unhealthy[0]).toBeGreaterThan(unhealthy[1]!);
    expect(unhealthy[0]).toBeGreaterThan(unhealthy[2]!);
    expect(deleted[2]).toBeGreaterThan(deleted[1]!);
    expect(deleted[0]).toBeGreaterThan(deleted[1]!);
  });

  it.each(THEMES)("gives no two states the same fill, border or line in %s", (theme) => {
    const colors = healthVariables(theme);
    for (const part of ["fill", "border", "line"]) {
      const values = ["healthy", "degraded", "unhealthy", "unknown", "deleted"].map((name) => colors[`${name}-${part}`]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("is a night canvas in the dark palette and a light one in the bright palette", () => {
    expect(luminance(PALETTES.dark.canvas.bg)).toBeLessThan(luminance(webDarkTheme.colorNeutralBackground2));
    expect(luminance(PALETTES.light.canvas.bg)).toBeGreaterThan(0.5);
    expect(luminance(PALETTES.light.canvas.bg)).toBeLessThan(luminance(webLightTheme.colorNeutralBackground1));
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
      [tokens.border, tokens.fill, tokens.dot, tokens.line, tokens.on, tokens.label].map(variableName),
    ),
    ...Object.values(reportTokens).flatMap((tokens) => [tokens.actionFill, tokens.actionInk].map(variableName)),
    ...Object.values(diffTokens).flatMap((tokens) => [tokens.tint, tokens.ink, tokens.line].map(variableName)),
    "edge",
    ...["canvas-bg", "canvas-grid", "pill-fill", "pill-stroke", "card-shadow", "card-shadow-lift", "minimap-mask", "select-ring", "highlight-ring", "mark-ring"],
  ];

  it.each(THEMES)("defines every variable the tokens use in %s", (theme) => {
    const defined = healthVariables(theme);
    expect(referenced.filter((name) => !(name in defined))).toEqual([]);
  });

  it.each(THEMES)("defines only colours in %s", (theme) => {
    expect(
      Object.entries(healthVariables(theme)).filter(([name, value]) => !name.startsWith("card-shadow") && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value)),
    ).toEqual([]);
  });

  it("differs between themes for the fills the cards are painted with", () => {
    expect(healthVariables("light")["degraded-fill"]).not.toBe(healthVariables("dark")["degraded-fill"]);
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

// WCAG 2.x contrast, computed from the palette source for both themes.
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const TEXT = 4.5;
const GRAPHIC = 3;

interface Pair {
  readonly what: string;
  readonly foreground: string;
  readonly background: string;
  readonly need: number;
}

const STATES = ["healthy", "degraded", "unhealthy", "unknown", "deleted"] as const;

function pairs(theme: ThemeName): readonly Pair[] {
  const colors = healthVariables(theme);
  const fluent = theme === "light" ? webLightTheme : webDarkTheme;
  const pill = colors["pill-fill"] as string;
  const canvas = colors["canvas-bg"] as string;
  const out: Pair[] = [];
  for (const state of STATES) {
    const fill = colors[`${state}-fill`] as string;
    const label = colors[`${state}-label`] as string;
    const dot = (colors[`${state}-dot`] ?? colors[`${state}-border`]) as string;
    out.push(
      { what: `body text on a ${state} card`, foreground: fluent.colorNeutralForeground1, background: fill, need: TEXT },
      { what: `secondary text on a ${state} card`, foreground: fluent.colorNeutralForeground2, background: fill, need: TEXT },
      { what: `tertiary text on a ${state} card`, foreground: fluent.colorNeutralForeground3, background: fill, need: TEXT },
      { what: `${state} text on the canvas`, foreground: label, background: canvas, need: TEXT },
      { what: `${state} text on a pill`, foreground: label, background: pill, need: TEXT },
      { what: `${state} glyph on its own fill`, foreground: dot, background: fill, need: GRAPHIC },
      { what: `${state} glyph on the canvas`, foreground: dot, background: canvas, need: GRAPHIC },
      { what: `${state} mark on its glyph`, foreground: colors[`${state}-on`] as string, background: dot, need: GRAPHIC },
      { what: `${state} border on the canvas`, foreground: colors[`${state}-border`] as string, background: canvas, need: GRAPHIC },
      { what: `${state} line on the canvas`, foreground: colors[`${state}-line`] as string, background: canvas, need: GRAPHIC },
      { what: `${state} line on a pill`, foreground: colors[`${state}-line`] as string, background: pill, need: GRAPHIC },
    );
    // A signal row inside a card is written in its own state's colour, on any card.
    for (const other of STATES) {
      out.push({ what: `${other} signal text on a ${state} card`, foreground: colors[`${other}-label`] as string, background: fill, need: TEXT });
    }
  }
  for (const state of ["healthy", "degraded", "unhealthy", "unknown"] as const) {
    out.push({ what: `${state} report button text`, foreground: colors[`${state}-action-ink`] as string, background: colors[`${state}-action-bg`] as string, need: TEXT });
  }
  for (const mark of ["added", "changed", "removed"] as const) {
    out.push(
      { what: `${mark} text on its tint`, foreground: colors[`${mark}-ink`] as string, background: colors[`${mark}-tint`] as string, need: TEXT },
      { what: `${mark} text on a pill`, foreground: colors[`${mark}-ink`] as string, background: pill, need: TEXT },
      { what: `${mark} outline on the canvas`, foreground: colors[`${mark}-line`] as string, background: canvas, need: GRAPHIC },
    );
  }
  out.push(
    { what: "body text on the canvas", foreground: fluent.colorNeutralForeground1, background: canvas, need: TEXT },
    { what: "body text on a pill", foreground: fluent.colorNeutralForeground1, background: pill, need: TEXT },
    { what: "secondary text on the canvas", foreground: fluent.colorNeutralForeground2, background: canvas, need: TEXT },
    { what: "tertiary text on the canvas", foreground: fluent.colorNeutralForeground3, background: canvas, need: TEXT },
    { what: "neutral edge on the canvas", foreground: colors.edge as string, background: canvas, need: GRAPHIC },
    { what: "grid dots on the canvas stay quiet", foreground: colors["canvas-grid"] as string, background: canvas, need: 1.2 },
    { what: "pill outline on the canvas", foreground: colors["pill-stroke"] as string, background: canvas, need: 1.2 },
  );
  for (const ring of ["select", "highlight", "mark"] as const) {
    out.push({ what: `${ring} ring on the canvas`, foreground: colors[`${ring}-ring`] as string, background: canvas, need: GRAPHIC });
    for (const state of STATES) {
      out.push({ what: `${ring} ring on a ${state} card`, foreground: colors[`${ring}-ring`] as string, background: colors[`${state}-fill`] as string, need: GRAPHIC });
    }
  }
  return out;
}

describe("palette contrast (WCAG AA)", () => {
  it.each(THEMES.flatMap((theme) => pairs(theme).map((pair) => [theme, pair.what, pair] as const)))(
    "%s: %s",
    (_theme, _what, pair) => {
      expect(contrast(pair.foreground, pair.background)).toBeGreaterThanOrEqual(pair.need);
    },
  );
});

describe("impact", () => {
  it.each([
    ["Standard", "Standard"],
    ["Limited", "Limited"],
    ["Suppressed", "Suppressed"],
    ["High", "Standard"],
    ["Unknown", "Standard"],
    ["", "Standard"],
  ] as const)("reads %j as %s", (value, expected) => {
    expect(impactOf(value)).toBe(expected);
  });
});

describe("edge appearance", () => {
  const NEUTRAL = "var(--edge)";
  it.each([
    ["Healthy", "Standard", null, { stroke: "var(--healthy-line)", width: 1.6, dash: undefined, cap: "butt" }],
    ["Unknown", "Standard", null, { stroke: "var(--unknown-line)", width: 1.4, dash: "4 3", cap: "butt" }],
    ["Degraded", "Standard", null, { stroke: "var(--degraded-line)", width: 2, dash: undefined, cap: "butt" }],
    ["Unhealthy", "Standard", null, { stroke: "var(--unhealthy-line)", width: 2.4, dash: undefined, cap: "butt" }],
    ["Deleted", "Standard", null, { stroke: "var(--deleted-line)", width: 1.6, dash: undefined, cap: "butt" }],
    ["Healthy", "Limited", null, { stroke: "var(--healthy-line)", width: 1.6, dash: "6 4", cap: "butt" }],
    ["Unhealthy", "Limited", null, { stroke: "var(--degraded-line)", width: 2, dash: "6 4", cap: "butt" }],
    ["Degraded", "Suppressed", null, { stroke: NEUTRAL, width: 1.4, dash: "1.5 4", cap: "round" }],
    ["Healthy", "Standard", "added", { stroke: "var(--added-line)", width: 2.6, dash: undefined, cap: "butt" }],
    ["Degraded", "Standard", "removed", { stroke: "var(--removed-line)", width: 1.8, dash: "3 3", cap: "butt" }],
  ] as const)("draws a %s child with %s impact and mark %s", (state, impact, mark, expected) => {
    expect(edgeAppearance(state, impact, mark)).toEqual(expected);
  });
});
