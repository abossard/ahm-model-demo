import type { ThemeName } from "./theme";
import type { HealthState } from "./types";

/** Each state has a shape of its own, so a state never rests on colour alone. */
export type StateShape = "check" | "triangle" | "square" | "ring" | "diamond";

export interface StateTokens {
  readonly border: string;
  /** Every state tints its card: Healthy green, Degraded amber, Unhealthy red, Unknown grey, Standby violet. */
  readonly fill: string;
  readonly dot: string;
  /** The colour of the line from a parent to a child in this state: the health that flows up. */
  readonly line: string;
  /** The mark drawn on the dot: white on a light theme's dots, dark on a dark theme's. */
  readonly on: string;
  readonly label: string;
  readonly word: string;
  readonly dashed: boolean;
  readonly shape: StateShape;
}

export const stateTokens: Record<HealthState, StateTokens> = {
  Healthy: {
    border: "var(--healthy-border)",
    fill: "var(--healthy-fill)",
    dot: "var(--healthy-dot)",
    line: "var(--healthy-line)",
    on: "var(--healthy-on)",
    label: "var(--healthy-label)",
    word: "Healthy",
    dashed: false,
    shape: "check",
  },
  Degraded: {
    border: "var(--degraded-border)",
    fill: "var(--degraded-fill)",
    dot: "var(--degraded-dot)",
    line: "var(--degraded-line)",
    on: "var(--degraded-on)",
    label: "var(--degraded-label)",
    word: "Degraded",
    dashed: false,
    shape: "triangle",
  },
  Unhealthy: {
    border: "var(--unhealthy-border)",
    fill: "var(--unhealthy-fill)",
    dot: "var(--unhealthy-dot)",
    line: "var(--unhealthy-line)",
    on: "var(--unhealthy-on)",
    label: "var(--unhealthy-label)",
    word: "Unhealthy",
    dashed: false,
    shape: "square",
  },
  Unknown: {
    border: "var(--unknown-border)",
    fill: "var(--unknown-fill)",
    dot: "var(--unknown-dot)",
    line: "var(--unknown-line)",
    on: "var(--unknown-on)",
    label: "var(--unknown-label)",
    word: "Unknown",
    dashed: true,
    shape: "ring",
  },
  Deleted: {
    border: "var(--deleted-border)",
    fill: "var(--deleted-fill)",
    dot: "var(--deleted-border)",
    line: "var(--deleted-line)",
    on: "var(--deleted-on)",
    label: "var(--deleted-label)",
    word: "Standby",
    dashed: false,
    shape: "diamond",
  },
};

export function tokensFor(state: string): StateTokens {
  return stateTokens[state as HealthState] ?? stateTokens.Unknown;
}

/** The states a health report can carry: a deleted entity cannot be reported on. */
export type ReportState = Exclude<HealthState, "Deleted">;

export interface ReportTokens {
  readonly actionFill: string;
  readonly actionInk: string;
}

export const reportTokens: Record<ReportState, ReportTokens> = {
  Healthy: { actionFill: "var(--healthy-action-bg)", actionInk: "var(--healthy-action-ink)" },
  Degraded: { actionFill: "var(--degraded-action-bg)", actionInk: "var(--degraded-action-ink)" },
  Unhealthy: { actionFill: "var(--unhealthy-action-bg)", actionInk: "var(--unhealthy-action-ink)" },
  Unknown: { actionFill: "var(--unknown-action-bg)", actionInk: "var(--unknown-action-ink)" },
};

export const cardTokens = {
  ink: "var(--colorNeutralForeground1)",
  muted: "var(--colorNeutralForeground2)",
  hair: "var(--colorNeutralStroke2)",
  pillFill: "var(--pill-fill)",
  pillStroke: "var(--pill-stroke)",
  /** The ground the graph views are drawn on, and the dots of its grid. */
  canvas: "var(--canvas-bg)",
  grid: "var(--canvas-grid)",
  /** The ring of the selected card, the stronger ring of the one the pointer or a search points at, and a changed card's mark. */
  select: "var(--select-ring)",
  highlight: "var(--highlight-ring)",
  marked: "var(--mark-ring)",
  minimapMask: "var(--minimap-mask)",
  /** A card's shadow at rest, and lifted under the pointer or when selected. */
  shadow: "var(--card-shadow)",
  shadowLift: "var(--card-shadow-lift)",
  metricBars: ["var(--deleted-border)", "var(--colorBrandForeground1)", "var(--healthy-dot)"],
} as const;

type StatePart = "border" | "fill" | "dot" | "line" | "on" | "label" | "action-bg" | "action-ink";
type StateName = "healthy" | "degraded" | "unhealthy" | "unknown" | "deleted";
type StateColors = Readonly<Partial<Record<StatePart, string>>>;

/**
 * One palette per theme, each designed on its own rather than derived from the other: the dark one
 * is a night canvas with deep tinted cards and light lines, the light one a calm grey-blue canvas
 * with pale tinted cards and saturated lines. A colour of eight digits carries alpha.
 */
interface Palette {
  /** The ground the graphs are drawn on, and the dots of their grid. */
  readonly canvas: { readonly bg: string; readonly grid: string };
  /** What lies on the canvas and over a line: the label pill, the card's shadow at rest and lifted, the mini-map's mask. */
  readonly surface: {
    readonly pillFill: string;
    readonly pillStroke: string;
    readonly shadow: string;
    readonly shadowLift: string;
    readonly minimapMask: string;
  };
  /** The rings of a selected card, a highlighted card and a changed card. */
  readonly ring: { readonly select: string; readonly highlight: string; readonly marked: string };
  /** The line of a relationship that carries nothing to the parent. */
  readonly edge: string;
  readonly states: Readonly<Record<StateName, StateColors>>;
}

export const PALETTES: Readonly<Record<ThemeName, Palette>> = {
  light: {
    canvas: { bg: "#e7ebf0", grid: "#c3cad4" },
    surface: { pillFill: "#ffffff", pillStroke: "#b7c0cc", shadow: "0 1px 2px #1b2a3d1f, 0 3px 8px #1b2a3d1f", shadowLift: "0 2px 4px #1b2a3d26, 0 10px 22px #1b2a3d40", minimapMask: "#6b778833" },
    ring: { select: "#0f6cbd", highlight: "#0a4a86", marked: "#a35f00" },
    edge: "#6b6967",
    states: {
      healthy: { border: "#3b8a35", fill: "#e4f5e0", dot: "#3b8a1f", line: "#3b8a35", on: "#ffffff", label: "#2a6e1c", "action-bg": "#2f7a1f", "action-ink": "#ffffff" },
      degraded: { border: "#b86a00", fill: "#fdf0d5", dot: "#b86300", line: "#b86a00", on: "#ffffff", label: "#7a4200", "action-bg": "#8a4b00", "action-ink": "#ffffff" },
      unhealthy: { border: "#c4262e", fill: "#fbe1df", dot: "#c50f18", line: "#c4262e", on: "#ffffff", label: "#8f0f1b", "action-bg": "#9b111e", "action-ink": "#ffffff" },
      unknown: { border: "#707b8b", fill: "#f1f3f6", dot: "#6b6967", line: "#707b8b", on: "#ffffff", label: "#4f5560", "action-bg": "#5f5d5b", "action-ink": "#ffffff" },
      deleted: { border: "#7c56bf", fill: "#efe8fa", line: "#7c56bf", on: "#ffffff", label: "#58389a" },
    },
  },
  dark: {
    canvas: { bg: "#12151a", grid: "#2a303a" },
    surface: { pillFill: "#1d2128", pillStroke: "#3d4552", shadow: "0 1px 2px #00000080, 0 3px 8px #00000066", shadowLift: "0 2px 4px #00000099, 0 10px 22px #000000b3", minimapMask: "#0000008c" },
    ring: { select: "#5aa9f5", highlight: "#a8d2ff", marked: "#f2c94c" },
    edge: "#8995a6",
    states: {
      healthy: { border: "#3f9d5f", fill: "#163a24", dot: "#86efac", line: "#46b36b", on: "#0f1f0f", label: "#bbf7d0", "action-bg": "#166534", "action-ink": "#ffffff" },
      degraded: { border: "#d9901e", fill: "#3d2b0b", dot: "#fcc34d", line: "#e8a62e", on: "#2a1200", label: "#fde8b0", "action-bg": "#9a3412", "action-ink": "#ffffff" },
      unhealthy: { border: "#e5484d", fill: "#461619", dot: "#fca5a5", line: "#f0585d", on: "#2e0509", label: "#fecaca", "action-bg": "#991b1b", "action-ink": "#ffffff" },
      unknown: { border: "#6f7b8c", fill: "#242a33", dot: "#b4bdca", line: "#8995a6", on: "#1f1f1f", label: "#dfe4ea", "action-bg": "#334155", "action-ink": "#ffffff" },
      deleted: { border: "#a78bfa", fill: "#2c2150", line: "#a78bfa", on: "#1f1f1f", label: "#ddd6fe" },
    },
  },
};

/** What a compared Health model diff does to an entity or a relationship. */
export type DiffMark = "added" | "changed" | "removed";

export interface DiffTokens {
  readonly tint: string;
  readonly ink: string;
  readonly line: string;
  readonly word: string;
  /** Drawn in front of the word, so the mark does not rest on colour alone. */
  readonly glyph: string;
}

/** Diff marks have colours of their own, apart from the four health states. */
export const diffTokens: Record<DiffMark, DiffTokens> = {
  added: { tint: "var(--added-tint)", ink: "var(--added-ink)", line: "var(--added-line)", word: "Added", glyph: "+" },
  changed: { tint: "var(--changed-tint)", ink: "var(--changed-ink)", line: "var(--changed-line)", word: "Changed", glyph: "≠" },
  removed: { tint: "var(--removed-tint)", ink: "var(--removed-ink)", line: "var(--removed-line)", word: "Removed", glyph: "−" },
};

const DIFF_COLORS: Readonly<Record<ThemeName, Readonly<Record<DiffMark, { tint: string; ink: string; line: string }>>>> = {
  light: {
    added: { tint: "#e6f2fb", ink: "#0b5a9e", line: "#0f6cbd" },
    changed: { tint: "#f1edfb", ink: "#5b3a9e", line: "#7a56c8" },
    removed: { tint: "#ececec", ink: "#3b3b3b", line: "#6b6b6b" },
  },
  dark: {
    added: { tint: "#0f2a44", ink: "#8cc8ff", line: "#479ef5" },
    changed: { tint: "#2b2347", ink: "#cdbdf5", line: "#a58cee" },
    removed: { tint: "#3a3a3a", ink: "#e0e0e0", line: "#a0a0a0" },
  },
};

/** The one source of the `--<state>-<part>` and the canvas, shadow and ring custom properties that the tokens refer to. */
export function healthVariables(theme: ThemeName): Readonly<Record<string, string>> {
  const palette = PALETTES[theme];
  return {
    ...Object.fromEntries(
      Object.entries(palette.states).flatMap(([state, colors]) =>
        Object.entries(colors).map(([part, value]) => [`${state}-${part}`, value] as const),
      ),
    ),
    ...Object.fromEntries(
      Object.entries(DIFF_COLORS[theme]).flatMap(([mark, colors]) =>
        Object.entries(colors).map(([part, value]) => [`${mark}-${part}`, value] as const),
      ),
    ),
    "canvas-bg": palette.canvas.bg,
    "canvas-grid": palette.canvas.grid,
    "pill-fill": palette.surface.pillFill,
    "pill-stroke": palette.surface.pillStroke,
    "card-shadow": palette.surface.shadow,
    "card-shadow-lift": palette.surface.shadowLift,
    "minimap-mask": palette.surface.minimapMask,
    "select-ring": palette.ring.select,
    "highlight-ring": palette.ring.highlight,
    "mark-ring": palette.ring.marked,
    edge: palette.edge,
  };
}

/** How an entity's impact on its parents is drawn: a line style and a chip, never colour alone. */
export type Impact = "Standard" | "Limited" | "Suppressed";

export function impactOf(value: string): Impact {
  return value === "Limited" || value === "Suppressed" ? value : "Standard";
}

export const impactStyle: Record<Exclude<Impact, "Standard">, { readonly dash: string; readonly cap: "butt" | "round"; readonly word: string; readonly glyph: string }> = {
  Limited: { dash: "6 4", cap: "butt", word: "Limited impact", glyph: "◐" },
  Suppressed: { dash: "1.5 4", cap: "round", word: "Suppressed", glyph: "⊘" },
};

export interface EdgeAppearance {
  readonly stroke: string;
  readonly width: number;
  readonly dash: string | undefined;
  readonly cap: "butt" | "round";
}

/** How heavy the line of a child in this state is drawn: the louder the state, the heavier. */
const LINE_WIDTH: Record<HealthState, number> = { Healthy: 1.6, Degraded: 2, Unhealthy: 2.4, Unknown: 1.4, Deleted: 1.6 };

/**
 * The line from a parent to its child, in the colour of the health it carries up: the child's state,
 * where Limited caps Unhealthy at Degraded. A Suppressed child carries nothing up, so its line is
 * neutral. Dashed for Limited and dotted for Suppressed, and in the diff's colour when the
 * relationship is part of a diff.
 */
export function edgeAppearance(childState: string, childImpact: string, mark: DiffMark | null): EdgeAppearance {
  if (mark === "added") return { stroke: diffTokens.added.line, width: 2.6, dash: undefined, cap: "butt" };
  if (mark === "removed") return { stroke: diffTokens.removed.line, width: 1.8, dash: "3 3", cap: "butt" };
  const impact = impactOf(childImpact);
  const state = impact === "Limited" && childState === "Unhealthy" ? "Degraded" : childState;
  const known = state in stateTokens ? (state as HealthState) : "Unknown";
  const style = impact === "Standard" ? null : impactStyle[impact];
  return {
    stroke: impact === "Suppressed" ? "var(--edge)" : stateTokens[known].line,
    width: impact === "Suppressed" ? 1.4 : LINE_WIDTH[known],
    dash: style?.dash ?? (known === "Unknown" ? "4 3" : undefined),
    cap: style?.cap ?? "butt",
  };
}
