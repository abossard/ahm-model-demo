import type { ThemeName } from "./theme";
import type { HealthState } from "./types";

export interface StateTokens {
  readonly border: string;
  readonly fill: string;
  readonly dot: string;
  readonly label: string;
  readonly word: string;
  readonly dashed: boolean;
}

export const stateTokens: Record<HealthState, StateTokens> = {
  Healthy: {
    border: "var(--healthy-border)",
    fill: "var(--healthy-fill)",
    dot: "var(--healthy-dot)",
    label: "var(--healthy-label)",
    word: "Healthy",
    dashed: false,
  },
  Degraded: {
    border: "var(--degraded-border)",
    fill: "var(--degraded-fill)",
    dot: "var(--degraded-dot)",
    label: "var(--degraded-label)",
    word: "Degraded",
    dashed: false,
  },
  Unhealthy: {
    border: "var(--unhealthy-border)",
    fill: "var(--unhealthy-fill)",
    dot: "var(--unhealthy-dot)",
    label: "var(--unhealthy-label)",
    word: "Unhealthy",
    dashed: false,
  },
  Unknown: {
    border: "var(--unknown-border)",
    fill: "var(--unknown-fill)",
    dot: "var(--unknown-dot)",
    label: "var(--unknown-label)",
    word: "Unknown",
    dashed: true,
  },
  Deleted: {
    border: "var(--deleted-border)",
    fill: "var(--deleted-fill)",
    dot: "var(--deleted-border)",
    label: "var(--deleted-label)",
    word: "Standby",
    dashed: false,
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

type StatePart = "border" | "fill" | "dot" | "label" | "action-bg" | "action-ink";
type StateName = "healthy" | "degraded" | "unhealthy" | "unknown" | "deleted";
type StateColors = Readonly<Partial<Record<StatePart, string>>>;

const HEALTH_COLORS: Readonly<Record<ThemeName, Readonly<Record<StateName, StateColors>>>> = {
  light: {
    healthy: { border: "#a0d8a0", fill: "#f2f8f2", dot: "#4c9a2a", label: "#2f7a1f", "action-bg": "#2f7a1f", "action-ink": "#ffffff" },
    degraded: { border: "#db7500", fill: "#fbf2e7", dot: "#c26a00", label: "#8a4b00", "action-bg": "#8a4b00", "action-ink": "#ffffff" },
    unhealthy: { border: "#ba0d16", fill: "#faeceb", dot: "#c50f18", label: "#9b111e", "action-bg": "#9b111e", "action-ink": "#ffffff" },
    unknown: { border: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", label: "#5f5d5b", "action-bg": "#5f5d5b", "action-ink": "#ffffff" },
    deleted: { border: "#8661c5", fill: "#f4f0fb", label: "#5b3a8f" },
  },
  dark: {
    healthy: { border: "#166534", fill: "#052e16", dot: "#86efac", label: "#bbf7d0", "action-bg": "#166534", "action-ink": "#ffffff" },
    degraded: { border: "#d97706", fill: "#451a03", dot: "#fdba74", label: "#fed7aa", "action-bg": "#9a3412", "action-ink": "#ffffff" },
    unhealthy: { border: "#dc2626", fill: "#450a0a", dot: "#fca5a5", label: "#fecaca", "action-bg": "#991b1b", "action-ink": "#ffffff" },
    unknown: { border: "#64748b", fill: "#0f172a", dot: "#cbd5e1", label: "#e2e8f0", "action-bg": "#334155", "action-ink": "#ffffff" },
    deleted: { border: "#a78bfa", fill: "#2e1065", label: "#ddd6fe" },
  },
};

/** The one source of the `--<state>-<part>` custom properties that `stateTokens` refers to. */
export function healthVariables(theme: ThemeName): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(HEALTH_COLORS[theme]).flatMap(([state, colors]) =>
      Object.entries(colors).map(([part, value]) => [`${state}-${part}`, value] as const),
    ),
  );
}
