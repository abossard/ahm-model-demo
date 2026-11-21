import type { Analysis, BuilderEvidence } from "./types";

type Metric = NonNullable<Analysis["metrics"]>[number];

export function metricPrediction(metric: Metric) {
  const unhealthy = metric.operator === "GreaterThan" ? metric.sample > metric.threshold : metric.sample < metric.threshold;
  return unhealthy ? "Unhealthy" : "Healthy";
}

export function metricObservation(metric: Metric, evidence: BuilderEvidence) {
  return evidence.observedMetrics?.find(observation =>
    observation.resourceId.toLowerCase() === metric.resourceId.toLowerCase() &&
    observation.metricName.toLowerCase() === metric.metricName.toLowerCase() &&
    observation.metricNamespace.toLowerCase() === metric.metricNamespace.toLowerCase() &&
    observation.aggregation === metric.aggregation && observation.sample === metric.sample);
}

export function availabilityPrediction(value: string | undefined) {
  switch (value) {
    case "Available": return "Healthy";
    case "Unavailable": return "Unhealthy";
    case "Degraded": return "Degraded";
    default: return undefined;
  }
}
