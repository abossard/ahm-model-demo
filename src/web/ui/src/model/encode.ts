import type { Entity, HealthModelSnapshot, HealthState, SignalValue } from "./types";
import type { DiagrammoClass } from "./state";
import { classForState } from "./state";

function signalStateWord(state: HealthState): string {
  switch (state) {
    case "Healthy":
      return "healthy";
    case "Degraded":
      return "degraded";
    case "Unhealthy":
      return "unhealthy";
    case "Unknown":
    case "Deleted":
      return "unknown";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function sanitizeLabel(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/</g, "(")
    .replace(/>/g, ")")
    .trim();
}

function sanitizeRowPart(text: string): string {
  return sanitizeLabel(text).replace(/[=()]/g, " ").replace(/\s+/g, " ").trim();
}

function formatValue(value: SignalValue): string {
  if (value === null) return "";
  return sanitizeRowPart(String(value));
}

function signalRow(name: string, value: SignalValue, state: HealthState): string {
  const label = sanitizeRowPart(name);
  const result = formatValue(value);
  const word = signalStateWord(state);
  return result ? `${label} = ${result} (${word})` : `${label} (${word})`;
}

export function encodeSnapshot(snapshot: HealthModelSnapshot): string {
  const idOf = new Map<string, string>();
  snapshot.entities.forEach((entity, index) => idOf.set(entity.name, `e${index}`));

  const lines: string[] = ["flowchart BT"];

  const nodeLabel = (entity: Entity): string => {
    const parts = [sanitizeLabel(entity.displayName || entity.name)];
    if (entity.impact && entity.impact !== "Unknown") {
      parts.push(sanitizeLabel(entity.impact));
    }
    return parts.join("<br/>");
  };

  snapshot.entities.forEach((entity, index) => {
    lines.push(`    e${index}["${nodeLabel(entity)}"]`);
  });

  for (const relationship of snapshot.relationships) {
    const child = idOf.get(relationship.childEntityName);
    const parent = idOf.get(relationship.parentEntityName);
    if (!child || !parent) continue;
    const label = relationship.displayName
      ? sanitizeLabel(relationship.displayName)
      : "";
    lines.push(label ? `    ${child} -- "${label}" --> ${parent}` : `    ${child} --> ${parent}`);
  }

  const signalIds: string[] = [];
  snapshot.entities.forEach((entity, index) => {
    if (entity.signals.length === 0) return;
    const sigId = `e${index}s`;
    const rows = entity.signals.map((signal) =>
      signalRow(signal.displayName || signal.name, signal.value, signal.healthState),
    );
    signalIds.push(sigId);
    lines.push(`    ${sigId}["${rows.join("<br/>")}"]`);
    lines.push(`    ${sigId} --> e${index}`);
  });

  const CLASSES: readonly DiagrammoClass[] = ["green", "amber", "red", "purple"];

  const byClass = new Map<DiagrammoClass, string[]>();
  snapshot.entities.forEach((entity, index) => {
    const cls = classForState(entity.healthState);
    if (!cls) return;
    const bucket = byClass.get(cls) ?? [];
    bucket.push(`e${index}`);
    byClass.set(cls, bucket);
  });

  if (signalIds.length > 0) {
    lines.push(`    class ${signalIds.join(",")} blue;`);
  }
  for (const cls of CLASSES) {
    const ids = byClass.get(cls);
    if (ids && ids.length > 0) lines.push(`    class ${ids.join(",")} ${cls};`);
  }

  return lines.join("\n");
}
