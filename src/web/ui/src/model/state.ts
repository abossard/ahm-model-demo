import type { HealthState } from "./types";

export type DiagrammoClass = "green" | "amber" | "red" | "purple";

export function classForState(state: HealthState): DiagrammoClass | null {
  switch (state) {
    case "Healthy":
      return "green";
    case "Degraded":
      return "amber";
    case "Unhealthy":
      return "red";
    case "Unknown":
      return null;
    case "Deleted":
      return "purple";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function paletteForState(state: HealthState): string {
  switch (state) {
    case "Healthy":
      return "#a0d8a0";
    case "Degraded":
      return "#db7500";
    case "Unhealthy":
      return "#ba0d16";
    case "Unknown":
      return "#c8c6c4";
    case "Deleted":
      return "#8661c5";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
