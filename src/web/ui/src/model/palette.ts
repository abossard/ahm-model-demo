import type { ThemeName } from "./theme";
import type { HealthState } from "./types";

/** Each state has a shape of its own, so a state never rests on colour alone. */
export type StateShape = "check" | "triangle" | "square" | "ring" | "diamond";

export interface StateTokens {
  readonly border: string;
  /** Neutral for Healthy: only the states that need attention are tinted. */
  readonly fill: string;
  readonly dot: string;
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
  pillFill: "var(--colorNeutralBackground1)",
  pillStroke: "var(--colorNeutralStroke1)",
  metricBars: ["var(--deleted-border)", "var(--colorBrandForeground1)", "var(--healthy-dot)"],
} as const;

type StatePart = "border" | "fill" | "dot" | "on" | "label" | "action-bg" | "action-ink";
type StateName = "healthy" | "degraded" | "unhealthy" | "unknown" | "deleted";
type StateColors = Readonly<Partial<Record<StatePart, string>>>;

const HEALTH_COLORS: Readonly<Record<ThemeName, Readonly<Record<StateName, StateColors>>>> = {
  light: {
    healthy: { border: "#d1d1d1", fill: "#ffffff", dot: "#4c9a2a", on: "#ffffff", label: "#2f7a1f", "action-bg": "#2f7a1f", "action-ink": "#ffffff" },
    degraded: { border: "#db7500", fill: "#fbf2e7", dot: "#c26a00", on: "#ffffff", label: "#8a4b00", "action-bg": "#8a4b00", "action-ink": "#ffffff" },
    unhealthy: { border: "#ba0d16", fill: "#faeceb", dot: "#c50f18", on: "#ffffff", label: "#9b111e", "action-bg": "#9b111e", "action-ink": "#ffffff" },
    unknown: { border: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", on: "#ffffff", label: "#5f5d5b", "action-bg": "#5f5d5b", "action-ink": "#ffffff" },
    deleted: { border: "#8661c5", fill: "#f4f0fb", on: "#ffffff", label: "#5b3a8f" },
  },
  dark: {
    healthy: { border: "#666666", fill: "#292929", dot: "#86efac", on: "#0f1f0f", label: "#bbf7d0", "action-bg": "#166534", "action-ink": "#ffffff" },
    degraded: { border: "#d97706", fill: "#451a03", dot: "#fdba74", on: "#2a1200", label: "#fed7aa", "action-bg": "#9a3412", "action-ink": "#ffffff" },
    unhealthy: { border: "#dc2626", fill: "#450a0a", dot: "#fca5a5", on: "#2e0509", label: "#fecaca", "action-bg": "#991b1b", "action-ink": "#ffffff" },
    unknown: { border: "#64748b", fill: "#0f172a", dot: "#cbd5e1", on: "#1f1f1f", label: "#e2e8f0", "action-bg": "#334155", "action-ink": "#ffffff" },
    deleted: { border: "#a78bfa", fill: "#2e1065", on: "#1f1f1f", label: "#ddd6fe" },
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

/** The one source of the `--<state>-<part>` custom properties that `stateTokens` refers to. */
export function healthVariables(theme: ThemeName): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(
      Object.entries(HEALTH_COLORS[theme]).flatMap(([state, colors]) =>
        Object.entries(colors).map(([part, value]) => [`${state}-${part}`, value] as const),
      ),
    ),
    ...Object.fromEntries(
      Object.entries(DIFF_COLORS[theme]).flatMap(([mark, colors]) =>
        Object.entries(colors).map(([part, value]) => [`${mark}-${part}`, value] as const),
      ),
    ),
    // The line a relationship takes when its child needs no attention.
    edge: HEALTH_COLORS[theme].unknown.dot as string,
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

/**
 * The line from a parent to its child: neutral unless the child needs attention, coloured by what
 * the child contributes (Limited caps Unhealthy at Degraded), dashed for Limited and dotted for
 * Suppressed, and in the diff's colour when the relationship is part of a diff.
 */
export function edgeAppearance(childState: string, childImpact: string, mark: DiffMark | null): EdgeAppearance {
  if (mark === "added") return { stroke: diffTokens.added.line, width: 2.6, dash: undefined, cap: "butt" };
  if (mark === "removed") return { stroke: diffTokens.removed.line, width: 1.8, dash: "3 3", cap: "butt" };
  const impact = impactOf(childImpact);
  const state = impact === "Limited" && childState === "Unhealthy" ? "Degraded" : childState;
  const loud = impact !== "Suppressed" && (state === "Degraded" || state === "Unhealthy");
  const style = impact === "Standard" ? null : impactStyle[impact];
  return {
    stroke: loud ? stateTokens[state as HealthState].dot : "var(--edge)",
    width: loud ? (state === "Unhealthy" ? 2.4 : 2) : 1.4,
    dash: style?.dash ?? (state === "Unknown" ? "4 3" : undefined),
    cap: style?.cap ?? "butt",
  };
}
