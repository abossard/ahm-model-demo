import type { ShowMeDescriptor } from "../showMe";
import type { BuilderState } from "./types";

export type AnswerTask = NonNullable<BuilderState["analysis"] | BuilderState["proposal"]>;

/** R1 always refers to the first item in this Task's saved inventory. Revisions may have a different R1. */
export function builderDestination(phase: "analyze" | "propose"): ShowMeDescriptor {
  const resourceIds = "resource/Rn for a resource or signal/Rn for its recorded signal evidence. Use the exact resource ref (e.g. R1) in this Task's builder.resources";
  return {
    name: "builder",
    description: phase === "propose" ? "Inspect a proposed design or its evidence beside the answer." : "Inspect resource and signal evidence beside the workload plan.",
    idDescription: resourceIds + (phase === "propose" ? "; design/<id> for a proposals[].id in this answer." : "."),
  };
}

export function resourceEvidence(task: AnswerTask, analysis: BuilderState["analysis"], ref: string) {
  if (!/^R[1-9][0-9]*$/.test(ref)) return null;
  const resource = task.builder.resources?.[Number(ref.slice(1)) - 1];
  if (!resource) return null;
  const matches = (r: { resourceId: string }) => r.resourceId.toLowerCase() === resource.id.toLowerCase();
  const source = analysis?.seq === task.builder.analysisSeq ? analysis : undefined;
  const rows = task.result?.kind === "builderAnalysis" ? task.result.rows : task.builder.rows;
  const metrics = task.result?.kind === "builderAnalysis" ? task.result.metrics : task.builder.metrics ?? source?.result?.metrics;
  const metric = metrics?.find(matches);
  const observation = (task.builder.observedMetrics ?? source?.builder.observedMetrics)?.find(matches);
  const check = (task.builder.signalChecks ?? source?.builder.signalChecks)?.find(matches);
  return { resource, row: rows?.find(matches), metric, observation, check };
}
