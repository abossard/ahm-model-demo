import type { HealthState } from "./types";

export interface StateTokens {
  readonly border: string;
  readonly fill: string;
  readonly dot: string;
  readonly word: string;
  readonly dashed: boolean;
}

export const stateTokens: Record<HealthState, StateTokens> = {
  Healthy: { border: "#a0d8a0", fill: "#f2f8f2", dot: "#4c9a2a", word: "Healthy", dashed: false },
  Degraded: { border: "#db7500", fill: "#fbf2e7", dot: "#c26a00", word: "Degraded", dashed: false },
  Unhealthy: { border: "#ba0d16", fill: "#faeceb", dot: "#c50f18", word: "Unhealthy", dashed: false },
  Unknown: { border: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", word: "Unknown", dashed: true },
  Deleted: { border: "#8661c5", fill: "#f4f0fb", dot: "#8661c5", word: "Standby", dashed: false },
};

export const cardTokens = {
  ink: "#242424",
  muted: "#605e5c",
  hair: "#e6e4e2",
  pillFill: "#ffffff",
  pillStroke: "#d8d6d4",
  metricBars: ["#8661c5", "#0078D4", "#3fb0ac"],
} as const;
