import { PlanDiagram, workloadDiagram } from "./PlanDiagram";
import { PlanDecisions } from "./PlanDecisions";
import { StateGlyph } from "../components/StateGlyph";
import { tokensFor } from "../model/palette";
import { metricPrediction, metricObservation } from "./signalPrediction";
import "./planSignals.css";
import type { Analysis, AnalysisRow, BuilderEvidence } from "./types";

type Props = {
  analysis: Analysis;
  evidence: BuilderEvidence;
  included: AnalysisRow[];
};

export function WorkloadPlan({ analysis, evidence, included }: Props) {
  const plan = analysis.plan;
  if (!plan) return null;
  const names = new Map(included.map(row => [row.resourceId.toLowerCase(), row.displayName]));
  const active = (id: string) => names.has(id.toLowerCase());
  const metrics = (analysis.metrics ?? []).filter(metric => active(metric.resourceId));
  const availability = (evidence.resources ?? []).filter(r => active(r.id) && r.availabilityState);
  return <section className="workload-plan" aria-label="Proposed health model">
    <h3>Proposed health model</h3>
    <p className="lead">{plan.objective}</p>
    <PlanDiagram diagram={workloadDiagram(analysis, included, evidence)} title="Workload structure" />
    <p>Each component contributes its worst dependency state to the flow. Unknown readings are included.
      Limited dependencies can degrade their parent. Suppressed dependencies are visible without changing its state.</p>
    <PlanDecisions analysis={analysis} evidence={evidence} included={included} />
    <h4>Signals to create</h4>
    {metrics.length + availability.length > 0 ? <ul className="plan-signals" aria-label="Signals to create">
      {metrics.map(metric => {
        const observation = metricObservation(metric, evidence);
        const prediction = metricPrediction(metric);
        const colors = tokensFor(prediction);
        const percent = observation?.unit?.toLowerCase() === "percent";
        const unit = percent ? "%" : observation?.unit ? " " + observation.unit : "";
        const percentRange = percent
          && [metric.sample, metric.threshold].every(n => n >= 0 && n <= 100);
        return <li key={metric.resourceId}>
          <strong>{names.get(metric.resourceId.toLowerCase())} · {metric.metricName}</strong>
          <p className="signal-reading">Observed <b>{metric.sample}{unit}</b>{observation?.observedAt ?
            <> at <time dateTime={observation.observedAt}>{new Date(observation.observedAt).toLocaleString()}</time></> : " during the Azure metric check"}.</p>
          {percentRange && <div className="signal-scale" aria-hidden="true">
            <span className="signal-range" style={{ width: metric.sample + "%", background: colors.line }} />
            <span className="signal-observation" style={{ left: metric.sample + "%", background: colors.dot }} />
            <span className="signal-threshold" style={{ left: metric.threshold + "%" }} />
          </div>}
          <p>{metric.metricNamespace} · {metric.aggregation} over 5 minutes. Unhealthy when {metric.operator === "GreaterThan" ? "above" : "below"} {metric.threshold}{unit} (proposed threshold).</p>
          <p className="signal-verdict" style={{background: colors.fill, color: colors.label, borderColor: colors.border}}>
            <StateGlyph state={prediction} size={14} /> <span>Predicted <span className="sr-only">state for this sample: </span><strong>{prediction}</strong></span>
          </p>
          {observation?.count !== undefined && <p>Azure Monitor returned {observation.count} five-minute readings in this 24-hour check. The prediction uses the last reading in that check.</p>}
        </li>;
      })}
      {availability.map(r => <li key={r.id}><strong>{r.name} · Azure Resource Health</strong>
        <p>Azure reported {r.availabilityState}. The signal uses Azure’s platform availability assessment.</p>
      </li>)}
    </ul> : <p>No measured signal is available for the included resources. Their health will start Unknown.</p>}
    <details><summary>Evidence and coverage gaps</summary>
      <ul>{plan.gaps.map((gap, i) => <li key={i}>{gap}</li>)}
        {evidence.signalChecks?.filter(s => active(s.resourceId) && s.status !== "verified").map(s =>
          <li key={s.resourceId}>{names.get(s.resourceId.toLowerCase())} · {s.detail}</li>)}
        {analysis.omittedMetrics?.filter(s => active(s.resourceId)).map(s =>
          <li key={s.resourceId}>{names.get(s.resourceId.toLowerCase())} · {s.reason}</li>)}
      </ul>
      <p>Thresholds are proposed operating assumptions. The model starts evaluating after creation and access configuration.</p>
    </details>
  </section>;
}
