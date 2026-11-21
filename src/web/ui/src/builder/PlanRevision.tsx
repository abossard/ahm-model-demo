import type { Analysis, BuilderTask } from "./types";
import { decisionSources } from "./PlanDecisions";
import { withoutShowMeMarkers } from "../showMe/markers";

type Plan = NonNullable<Analysis["plan"]>;

// Compare the parts a reviewer can act on. A newer sample alone does not change the plan.
function planFields(plan: Plan, metrics: Analysis["metrics"], omitted: Analysis["omittedMetrics"], names: Map<string, string>, withButtons = false) {
  const fields = new Map<string, { label: string; value: string }>();
  const add = (key: string, label: string, value: string) => fields.set(key, { label, value });
  const resourceName = (id: string) => names.get(id.toLowerCase()) ?? id;
  add("objective", "Workload objective", plan.objective);
  for (const flow of plan.flows) {
    add("flow/" + flow.name, flow.name, [flow.objective, flow.failureScenario].join("\n"));
    for (const component of flow.components) {
      add(JSON.stringify([flow.name, component.name]), flow.name + " › " + component.name,
        [component.resourceIds.map(resourceName).sort().join(", "), component.signal].join("\n"));
    }
  }
  for (const metric of metrics ?? []) {
    const label = resourceName(metric.resourceId) + " · " + metric.metricName;
    add(JSON.stringify([metric.resourceId, metric.metricNamespace, metric.metricName]).toLowerCase(), label,
      metric.aggregation + " over 5 minutes, unhealthy " + (metric.operator === "GreaterThan" ? "above " : "below ") + metric.threshold);
  }
  for (const metric of omitted ?? []) {
    add("omission/" + metric.resourceId.toLowerCase(), resourceName(metric.resourceId) + " · omitted signal", metric.reason);
  }
  add("gaps", "Evidence gaps", plan.gaps.join("\n"));
  add("decisions", "Design decisions", (plan.decisions ?? []).map(d => {
    const sources = [decisionSources[d.basis], ...d.resourceIds.map(resourceName)];
    return [d.choice, withButtons ? withoutShowMeMarkers(d.reason) : d.reason, sources.join(" · ")].join("\n");
  }).join("\n\n"));
  return fields;
}

export function PlanRevision({ result, evidence }: { result: Analysis; evidence: BuilderTask<Analysis>["builder"] }) {
  const { previousPlan, previousMetrics, previousOmittedMetrics, revision } = evidence;
  if (!revision || !result.plan) return null;
  const names = new Map(result.rows.map(r => [r.resourceId.toLowerCase(), r.displayName]));
  const before = previousPlan && planFields(previousPlan, previousMetrics, previousOmittedMetrics, names);
  const after = planFields(result.plan, result.metrics, result.omittedMetrics, names, Boolean(result.showMe));
  const changes = before ? [...new Set([...before.keys(), ...after.keys()])].filter(key =>
    before.get(key)?.value !== after.get(key)?.value) : [];
  return <section className="revision-receipt" aria-label="Latest plan revision">
    <h3>Latest plan revision</h3>
    <p className="revision-request">{revision.prompt}</p>
    {before && (changes.length ? <details>
      <summary>What changed ({changes.length})</summary>
      <p>Comparison for the resources included in this revision.</p>
      <table aria-label="Plan changes">
        <thead><tr><th scope="col">Plan item</th><th scope="col">Previous</th><th scope="col">Revised</th></tr></thead>
        <tbody>{changes.map(key => <tr key={key}>
          <th scope="row">{(after.get(key) ?? before.get(key))!.label}</th>
          <td>{before.get(key)?.value || "—"}</td><td>{after.get(key)?.value || "—"}</td>
        </tr>)}</tbody>
      </table>
    </details> : <p>The flow structure and signal rules match the previous plan.</p>)}
  </section>;
}
