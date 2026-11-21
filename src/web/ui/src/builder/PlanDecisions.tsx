import type { Analysis, AnalysisRow, BuilderEvidence } from "./types";
import { BuilderProse, BuilderSource } from "./BuilderAnswer";
import "./planDecisions.css";

export const decisionSources = {
  inventory: "Azure inventory",
  measurement: "Signal check",
  assumption: "Planning assumption",
  userInput: "Your adjustment",
};

export function PlanDecisions({ analysis, evidence, included }: {
  analysis: Analysis;
  evidence: BuilderEvidence;
  included: AnalysisRow[];
}) {
  const decisions = analysis.plan?.decisions;
  const resources = new Map(included.map(row => [row.resourceId.toLowerCase(), row]));
  const observations = new Map(evidence.observedMetrics?.map(metric => [metric.resourceId.toLowerCase(), metric]));
  const visible = decisions?.filter(decision => decision.resourceIds.every(id => resources.has(id.toLowerCase())));
  if (!visible?.length) return null;
  return <section className="plan-decisions" aria-label="Why these choices were made">
    <h4>Why these choices were made</h4>
    <ol>{visible.map((decision, index) => <li key={index}>
      <strong>{decision.choice}</strong>
      <p><BuilderProse text={decision.reason} /></p>
      <div className="decision-sources">
        <span data-basis={decision.basis}>{decisionSources[decision.basis]}</span>
        {decision.resourceIds.map(id => {
          const key = id.toLowerCase();
          const metric = decision.basis === "measurement" && observations.get(key);
          const name = resources.get(key)!.displayName;
          const label = metric ? `${name} · ${metric.metricName} ${metric.sample} ${metric.unit}` : name;
          return <small key={key}><BuilderSource resourceId={id} measured={decision.basis === "measurement"} label={label} reason={decision.reason} /></small>;
        })}
      </div>
    </li>)}</ol>
  </section>;
}
