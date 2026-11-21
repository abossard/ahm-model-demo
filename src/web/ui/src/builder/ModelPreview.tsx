import { useMemo, useState } from "react";
import { designerDiagram, PlanDiagram } from "./PlanDiagram";
import type { BuilderState, Preview } from "./types";

export function ModelPreview({
  preview,
  analysis,
  target,
  busy,
  creation,
  onBack,
  onCreate,
  onDownload,
}: {
  preview: Preview;
  analysis: BuilderState["analysis"];
  target: NonNullable<BuilderState["target"]>;
  busy: boolean;
  creation: NonNullable<BuilderState["creation"]>["status"] | undefined;
  onBack: () => void;
  onCreate: () => void;
  onDownload: (name: "plan.md" | "modelspec.md", markdown: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const created = creation === "created";
  const diagram = useMemo(() => designerDiagram(preview, analysis?.result, analysis?.builder), [preview, analysis]);
  return (
    <div className="builder-stack">
      <h2>{created ? "Created model" : "Review and create"}</h2>
      <p className="lead">{preview.title}</p>
      <dl className="target">
        <div>
          <dt>Azure model name</dt>
          <dd>{target.name}</dd>
        </div>
        <div>
          <dt>Resource group</dt>
          <dd>{target.resourceGroup}</dd>
        </div>
        <div>
          <dt>Subscription</dt>
          <dd>{target.subscriptionId}</dd>
        </div>
        {target.location && (
          <div>
            <dt>Region</dt>
            <dd>{target.location}</dd>
          </div>
        )}
      </dl>
      <PlanDiagram diagram={diagram} title="Designer layout" />
      <details>
        <summary>
          Signal checks · {preview.diff.verification.filter((v) => v.status === "verified").length} of{" "}
          {preview.diff.verification.length} passed
        </summary>
        <ul className="hierarchy">
          {preview.diff.verification.map((v) => (
            <li key={v.entity + "/" + v.signal}>
              <strong>{preview.entities.find((e) => e.name === v.entity)?.displayName ?? v.entity}</strong>
              {" — "}
              {v.signal}
              {v.status === "verified" ? " passed" : v.status === "failing" ? " failed" : " was not run"}.
              {v.error ? " " + v.error : ""}
            </li>
          ))}
        </ul>
      </details>
      {preview.diff.findings.length > 0 && (
        <div className="coverage">
          <strong>Coverage gaps</strong>
          <ul className="hierarchy">
            {preview.diff.findings.map((f, i) => (
              <li key={i}>
                {f.entity && (
                  <strong>{preview.entities.find((e) => e.name === f.entity)?.displayName ?? f.entity}. </strong>
                )}
                {f.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="documents">
        {(["plan.md", "modelspec.md"] as const).map((name) => (
          <div key={name}>
            <details>
              <summary>{name}</summary>
              <pre>{name === "plan.md" ? preview.plan : preview.modelspec}</pre>
            </details>
            <button
              type="button"
              disabled={busy}
              aria-label={"Download " + name}
              onClick={() => onDownload(name, name === "plan.md" ? preview.plan : preview.modelspec)}
            >
              Download
            </button>
          </div>
        ))}
      </div>
      {created ? (
        <div className="actions">
          <button onClick={onBack}>Back to creation result</button>
        </div>
      ) : confirming ? (
        <fieldset className="confirmation">
          <legend>
            {creation ? "Resume creation of" : "Create"} {target.name} in Azure?
          </legend>
          <p>
            This writes the model, its entities, relationships and Designer positions to {target.resourceGroup}.
            The app cannot undo this creation.
          </p>
          {preview.monitoringScopes?.length > 0 && (
            <details>
              <summary>Resources that need monitoring access ({preview.monitoringScopes.length})</summary>
              <p>After creation, you can grant the model’s identity Monitoring Reader on these resources using your Azure account.</p>
              <ul>{preview.monitoringScopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul>
            </details>
          )}
          <div className="actions">
            <button disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy} onClick={onCreate}>
              Confirm creation in Azure
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="actions">
          <button disabled={busy} onClick={onBack}>
            {creation ? "Back to creation status" : "Back to designs"}
          </button>
          <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
            {creation ? "Resume creation" : "Create health model"}
          </button>
        </div>
      )}
    </div>
  );
}
