import { useRef, useState } from "react";
import { type Analysis, type AnalysisRow, type BuilderTask } from "./types";
import { PlanRevision } from "./PlanRevision";
import { RunActivity } from "./RunActivity";
import { WorkloadPlan } from "./WorkloadPlan";
import { BuilderProse } from "./BuilderAnswer";
import "./planRevision.css";

export function AnalysisStep({
  analysis,
  evidence,
  failedRevision,
  onRegenerate,
  onRevise,
  initialRows,
  busy,
  onBack,
  onConfirm,
}: {
  analysis: Analysis;
  evidence: BuilderTask<Analysis>["builder"];
  failedRevision: BuilderTask<Analysis> | undefined;
  onRegenerate: (() => void) | undefined;
  onRevise: (rows: AnalysisRow[], prompt: string) => void;
  initialRows: AnalysisRow[];
  busy: boolean;
  onBack: () => void;
  onConfirm: (rows: AnalysisRow[]) => void;
}) {
  const [rows, setRows] = useState<AnalysisRow[]>(() =>
    analysis.rows.map((row) => ({ ...row, ...initialRows.find((r) => r.resourceId === row.resourceId), displayName: row.displayName })),
  );
  const [included, setIncluded] = useState(() => new Set(initialRows.map((row) => row.resourceId)));
  const [prompt, setPrompt] = useState(failedRevision?.builder.revision?.prompt ?? "");
  const promptField = useRef<HTMLTextAreaElement>(null);
  const confirmed = rows.filter((row) => included.has(row.resourceId));
  const valid = confirmed.length > 0 && confirmed.every((row) => row.purpose.trim());
  const reviewedRows = () => confirmed.map((row) => ({ ...row, purpose: row.purpose.trim() }));
  function update(index: number, edit: Partial<AnalysisRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...edit } : row)));
  }
  return (
    <div className="builder-stack">
      <header className="workload-heading">
        <h2>Confirm the workload</h2>
        {analysis.plan && <button type="button" aria-controls="plan-change-request" disabled={busy}
          onClick={() => promptField.current?.focus()}>Request a change</button>}
      </header>
      <PlanRevision result={analysis} evidence={evidence} />
      {(!analysis.plan || analysis.showMe) && <p className="lead"><BuilderProse text={analysis.summary} /></p>}
      {analysis.plan ? <WorkloadPlan analysis={analysis} included={confirmed} evidence={evidence} /> :
        onRegenerate && <section>
          <h3>Proposed health model</h3>
          <p>This saved analysis contains the resource overview. Run a new analysis to plan the flows and check their signals.</p>
          <button type="button" onClick={onRegenerate} disabled={busy}>Generate model plan</button>
        </section>}
      <h3>Azure resource overview</h3>
      <p>Include the resources that support this workload and correct their roles before comparing designs.</p>
      <table className="analysis-table">
        <caption className="sr-only">Editable workload analysis</caption>
        <thead>
          <tr>
            <th scope="col">Azure resource</th>
            <th scope="col">Workload role</th>
            <th scope="col">Failure impact</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const resource = row.displayName;
            return (
              <tr key={row.resourceId}>
                <th scope="row">
                  <label className="include-analysis">
                    <input
                      type="checkbox"
                      aria-label={"Include " + resource}
                      disabled={busy}
                      checked={included.has(row.resourceId)}
                      onChange={() =>
                        setIncluded((previous) => {
                          const next = new Set(previous);
                          if (next.has(row.resourceId)) next.delete(row.resourceId);
                          else next.add(row.resourceId);
                          return next;
                        })
                      }
                    />
                    <strong>{resource}</strong>
                  </label>
                  <details>
                    <summary>Azure ID</summary>
                    <small>{row.resourceId}</small>
                  </details>
                </th>
                <td>
                  <label>
                    <span className="mobile-label">Workload role</span>
                    <textarea
                      required
                      maxLength={800}
                      disabled={busy || !included.has(row.resourceId)}
                      rows={2}
                      value={row.purpose}
                      aria-label={"Workload role of " + resource}
                      onChange={(e) => update(i, { purpose: e.target.value })}
                    />
                  </label>
                </td>
                <td>
                  <label>
                    <span className="mobile-label">Impact</span>
                    <select
                      disabled={busy || !included.has(row.resourceId)}
                      value={row.impact}
                      aria-label={"Impact of " + resource}
                      onChange={(e) => update(i, { impact: e.target.value as AnalysisRow["impact"] })}
                    >
                      <option>Standard</option>
                      <option>Limited</option>
                      <option>Suppressed</option>
                    </select>
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && (
        <p role="status">The analysis found no resources. Change the selection and analyze it again.</p>
      )}
      {analysis.plan && <form className="plan-revision-form" aria-labelledby="adjust-plan-title" onSubmit={event => {
        event.preventDefault();
        if (valid && prompt.trim() && !busy) onRevise(reviewedRows(), prompt.trim());
      }}>
        <h3 id="adjust-plan-title">Adjust the plan</h3>
        {failedRevision && <div className="error" role="alert">
          <strong>The revision could not be completed.</strong> {failedRevision.error?.message}
          <p>Review your request below and try again, or clear it to continue with the saved plan.</p>
          <RunActivity key={failedRevision.seq} task={failedRevision} label="Revision activity" />
        </div>}
        <label className="field">
          What should change?
          <textarea id="plan-change-request" ref={promptField} rows={3} maxLength={2000} value={prompt} onChange={event => setPrompt(event.target.value)}
            disabled={busy} aria-describedby="revision-guidance"
            placeholder="For example, make checkout the primary flow and flag CPU above 90% on the web app." />
        </label>
        <div className="revision-submit">
          <button type="submit" disabled={busy || !valid || !prompt.trim()}>Revise plan</button>
          <small id="revision-guidance">{!valid ? "Include at least one resource and give each included resource a role." :
            prompt.trim() ? "Submit the revision or clear the request to compare designs." :
            "The revision uses the included resources and their current roles."}</small>
        </div>
      </form>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={onBack}>
          Change resources
        </button>
        <button type="button" className="primary" disabled={!valid || busy || Boolean(prompt.trim())} onClick={() => onConfirm(reviewedRows())}>
          Confirm and suggest models
        </button>
      </div>
    </div>
  );
}
