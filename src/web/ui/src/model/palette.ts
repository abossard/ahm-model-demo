import type { HealthState } from "./types";

export interface StateTokens {
  readonly border: string;
  readonly fill: string;
  readonly dot: string;
  readonly actionFill: string;
  readonly actionInk: string;
  readonly label: string;
  readonly word: string;
  readonly dashed: boolean;
}

export const stateTokens: Record<HealthState, StateTokens> = {
  Healthy: {
    border: "var(--healthy-border)",
    fill: "var(--healthy-fill)",
    dot: "var(--healthy-dot)",
    actionFill: "var(--healthy-action-bg)",
    actionInk: "var(--healthy-action-ink)",
    label: "var(--healthy-label)",
    word: "Healthy",
    dashed: false,
  },
  Degraded: {
    border: "var(--degraded-border)",
    fill: "var(--degraded-fill)",
    dot: "var(--degraded-dot)",
    actionFill: "var(--degraded-action-bg)",
    actionInk: "var(--degraded-action-ink)",
    label: "var(--degraded-label)",
    word: "Degraded",
    dashed: false,
  },
  Unhealthy: {
    border: "var(--unhealthy-border)",
    fill: "var(--unhealthy-fill)",
    dot: "var(--unhealthy-dot)",
    actionFill: "var(--unhealthy-action-bg)",
    actionInk: "var(--unhealthy-action-ink)",
    label: "var(--unhealthy-label)",
    word: "Unhealthy",
    dashed: false,
  },
  Unknown: {
    border: "var(--unknown-border)",
    fill: "var(--unknown-fill)",
    dot: "var(--unknown-dot)",
    actionFill: "var(--unknown-action-bg)",
    actionInk: "var(--unknown-action-ink)",
    label: "var(--unknown-label)",
    word: "Unknown",
    dashed: true,
  },
  Deleted: {
    border: "var(--deleted-border)",
    fill: "var(--deleted-fill)",
    dot: "var(--deleted-border)",
    actionFill: "var(--deleted-action-bg)",
    actionInk: "var(--deleted-action-ink)",
    label: "var(--deleted-label)",
    word: "Standby",
    dashed: false,
  },
};

export function tokensFor(state: string): StateTokens {
  return stateTokens[state as HealthState] ?? stateTokens.Unknown;
}

export const cardTokens = {
  ink: "var(--ink)",
  muted: "var(--muted)",
  hair: "var(--hair)",
  pillFill: "var(--pill-fill)",
  pillStroke: "var(--pill-stroke)",
  metricBars: ["var(--deleted-border)", "var(--signal)", "var(--healthy-dot)"],
} as const;
