import { useEffect, useRef, useState } from "react";
import { AnalysisStep } from "./AnalysisStep";
import { BuilderAnswer, BuilderProse } from "./BuilderAnswer";
import { ModelPreview } from "./ModelPreview";
import { ResourcesStep } from "./ResourcesStep";
import { RunActivity } from "./RunActivity";
import { errorMessage, isRunning, type BuilderState, type BuilderTools, type Preview } from "./types";

type Step = "resources" | "workload" | "designs" | "create";
const steps: { id: Step; label: string }[] = [
  { id: "resources", label: "Resources" },
  { id: "workload", label: "Workload" },
  { id: "designs", label: "Designs" },
  { id: "create", label: "Create" },
];

function currentStep(state: BuilderState): Step {
  if (state.creation) return "create";
  if (state.proposal) return "designs";
  if (state.analysis) return "workload";
  return "resources";
}

export function Builder({ initial, tools }: { initial: BuilderState; tools: BuilderTools }) {
  const [state, setState] = useState(initial);
  const [manualStep, setManualStep] = useState<Step | null>(null);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const locked = useRef(false);
  const heading = useRef<HTMLDivElement>(null);
  const step = manualStep ?? currentStep(state);
  const analysis = state.analysis,
    proposal = state.proposal;
  const options = proposal?.result?.proposals ?? [];
  const proposalId =
    state.creation?.proposalId ?? (options.some((o) => o.id === selected) ? selected : (options[0]?.id ?? ""));
  const created = state.creation?.status === "created";
  const pending = isRunning(analysis) || isRunning(proposal) || state.creation?.status === "creating";
  const reviewedPlanSeq = step === "workload" && analysis?.result ? analysis.seq : null;

  useEffect(() => {
    setState(initial);
    setManualStep(null);
    setPreview(null);
    setSelected("");
    setError("");
    setPollError("");
  }, [initial]);

  // Only the web app owns a running Task. Closing and reopening the frame simply resumes this read.
  useEffect(() => {
    if (!pending || !state.sessionId || pollError) return;
    const sessionId = state.sessionId;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const latest = await tools.open(sessionId);
        if (active) setState(latest);
      } catch (problem) {
        if (active) setPollError(errorMessage(problem));
      }
    }, 1800);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state, pending, pollError, tools]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo?.({ top: 0, behavior: "instant" });
  }, [step, reviewedPlanSeq]);

  async function act(label: string, work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setOperation(label);
    setError("");
    try {
      await work();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      locked.current = false;
      setOperation("");
    }
  }
  function navigate(next: Step) {
    setManualStep(next);
    setError("");
    setPollError("");
    if (next !== "create") setPreview(null);
  }
  function accept(next: BuilderState) {
    setState(next);
    setPreview(null);
    setManualStep(null);
    setSelected("");
    setPollError("");
  }
  function loadPreview() {
    if (!state.sessionId || !proposal || !proposalId) return;
    const sessionId = state.sessionId,
      seq = proposal.seq;
    void act("Preparing the model preview…", async () => {
      const result = await tools.preview(sessionId, seq, proposalId);
      setPreview(result);
      navigate("create");
    });
  }
  function refresh() {
    if (!state.sessionId) return;
    const sessionId = state.sessionId;
    void act("Checking the saved builder…", async () => accept(await tools.open(sessionId)));
  }
  function openModel(tour?: "created") {
    const { sessionId } = state;
    if (!sessionId || !proposal) return;
    void act(tour ? "Opening the model tour…" : "Opening model…",
      () => tools.showModel(sessionId, proposal.seq, tour));
  }
  const busy = Boolean(operation);
  return (
    <main className="builder">
      <nav aria-label="Builder progress">
        <ol className="steps">
          {steps.map(({ id, label }, i) => (
            <li
              key={id}
              aria-current={id === step ? "step" : undefined}
              data-complete={i < steps.findIndex((s) => s.id === step)}
            >
              <span className="step-number" aria-hidden="true">
                {i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </nav>
      <BuilderAnswer key={JSON.stringify([state.sessionId, step])}
        task={step === "workload" ? analysis : step === "designs" ? proposal : undefined}
        analysis={analysis} sessionId={state.sessionId} tools={tools}>
      <div
        className="step-content"
        ref={heading}
        tabIndex={-1}
        aria-label={steps.find((s) => s.id === step)?.label}
      >
        {step === "workload" && analysis && <RunActivity key={analysis.seq} task={analysis} label="Analysis activity" />}
        {step === "designs" && proposal && <RunActivity key={proposal.seq} task={proposal} label="Design activity" />}
        {step === "resources" && (
          <ResourcesStep
            tools={tools}
            {...(analysis?.builder ? { initial: analysis.builder } : {})}
            busy={busy}
            onAnalyze={(scope) =>
              void act("Starting workload analysis…", async () =>
                accept(await tools.analyze(scope, state.sessionId)),
              )
            }
          />
        )}
        {step === "workload" &&
          (analysis?.result && !isRunning(analysis) ? (
            <AnalysisStep
              key={`review-${state.failedRevision?.seq ?? analysis.seq}`}
              analysis={analysis.result}
              evidence={analysis.builder}
              failedRevision={state.failedRevision}
              onRegenerate={state.creation ? undefined : () => {
                const { resourceIds, groupIds, destinationGroupId, modelName } = analysis.builder;
                if (!resourceIds || !groupIds || !destinationGroupId || !modelName) { navigate("resources"); return; }
                void act("Planning the health model…", async () =>
                  accept(await tools.analyze({ resourceIds, groupIds, destinationGroupId, modelName }, state.sessionId)));
              }}
              initialRows={state.failedRevision?.builder.rows ?? proposal?.builder.rows ?? analysis.builder.rows ?? analysis.result.rows}
              busy={busy}
              onRevise={(rows, prompt) => {
                const id = state.sessionId;
                if (id) void act("Submitting your plan revision…", async () =>
                  accept(await tools.revise(id, analysis.seq, rows, prompt)));
              }}
              onBack={() => navigate("resources")}
              onConfirm={(rows) => {
                if (state.sessionId) {
                  const id = state.sessionId;
                  void act("Starting model design…", async () =>
                    accept(await tools.propose(id, analysis.seq, rows)),
                  );
                }
              }}
            />
          ) : (
            <section>
              <h2>{analysis?.builder.revision ? "Revising the workload plan" : "Analyze selected resources"}</h2>
              {analysis?.builder.revision && <p className="revision-request">{analysis.builder.revision.prompt}</p>}
              {analysis?.error ? (
                <>
                  <p className="error" role="alert">
                    {analysis.error.message}
                  </p>
                  <button onClick={() => navigate("resources")}>Review resources and try again</button>
                </>
              ) : !analysis?.activity?.length && <p role="status">Waiting for the first recorded activity…</p>}
            </section>
          ))}
        {step === "designs" &&
          (options.length ? (
            <div className="builder-stack">
              <h2>Compare model designs</h2>
              <p className="lead">Choose the design that best represents how you operate this workload.</p>
              <fieldset className="design-options">
                <legend className="sr-only">Suggested models</legend>
                {options.map((option) => (
                  <div className="design-option" key={option.id} data-selected={proposalId === option.id}>
                    <input
                      type="radio"
                      id={"choose-design-" + option.id}
                      name="proposal"
                      value={option.id}
                      checked={proposalId === option.id}
                      onChange={() => setSelected(option.id)}
                    />
                    <span>
                      <label htmlFor={"choose-design-" + option.id}><strong>{option.title}</strong></label>
                      <span><BuilderProse text={option.summary} /></span>
                      <span className="tradeoff">
                        <b>Trade-off</b> <BuilderProse text={option.tradeoff} />
                      </span>
                      <small>{option.groups.map((g) => g.name).join(" · ")}</small>
                    </span>
                  </div>
                ))}
              </fieldset>
              <div className="actions">
                <button disabled={busy} onClick={() => navigate("workload")}>
                  Edit workload
                </button>
                <button className="primary" disabled={busy || !proposalId} onClick={loadPreview}>
                  Preview selected model
                </button>
              </div>
            </div>
          ) : (
            <section>
              <h2>Design alternatives</h2>
              {proposal?.error ? (
                <>
                  <p className="error" role="alert">
                    {proposal.error.message}
                  </p>
                  <button onClick={() => navigate("workload")}>Review workload and try again</button>
                </>
              ) : (
                <p role="status">
                  The assistant is designing alternatives from the confirmed workload. You can reopen this builder
                  from History.
                </p>
              )}
            </section>
          ))}
        {step === "create" &&
          (preview && state.target ? (
            <ModelPreview
              key={preview.id}
              preview={preview}
              analysis={analysis}
              target={state.target}
              busy={busy}
              creation={state.creation?.status}
              onBack={() => {
                if (state.creation) setPreview(null);
                else navigate("designs");
              }}
              onCreate={() => {
                if (state.sessionId && proposal) {
                  const id = state.sessionId;
                  void act("Creating the model in Azure…", async () =>
                    accept(await tools.create(id, proposal.seq, preview.id)),
                  );
                }
              }}
              onDownload={(name, markdown) =>
                void act("Downloading " + name + "…", async () => tools.download(name, markdown))
              }
            />
          ) : state.creation ? (
            <section className="builder-stack">
              <h2>
                {created
                  ? "Health model created"
                  : state.creation.status === "partial"
                    ? "Creation needs attention"
                    : "Creating the health model"}
              </h2>
              <p className="lead">{state.creation.target?.name ?? state.target?.name}</p>
              {created && (
                <>
                  <p>
                    The model and its Designer layout are saved in{" "}{state.creation.target?.resourceGroup ?? state.target?.resourceGroup}.
                    {" "}Take a tour to see which signals have readings, which are still waiting, and where Azure reports an error.
                  </p>
                  <div className="actions">
                    <button disabled={busy} onClick={loadPreview}>View plan and modelspec</button>
                    <button disabled={busy} onClick={() => openModel()}>Open health model</button>
                    <button className="primary" disabled={busy} onClick={() => openModel("created")}>Tour this model</button>
                  </div>
                </>
              )}
              {state.creation.error && (
                <p role="alert" className="error">
                  {state.creation.error}
                </p>
              )}
              {state.creation.principalId && (
                <p>
                  <strong>Managed identity</strong> <code>{state.creation.principalId}</code>
                </p>
              )}
              {created && Boolean(state.creation.monitoringScopes?.length) && (
                <section aria-label="Signal access">
                  <h3>Signal access</h3>
                  <p>Use your Azure account to grant this model’s identity Monitoring Reader on the resources below.
                    The model uses that identity to collect readings after you sign out.</p>
                  <ul className="hierarchy">
                    {state.creation.monitoringScopes!.map(scope => {
                      const result = state.creation?.monitoringAccess?.[scope];
                      return <li key={scope}><code>{scope}</code><br />
                        {result?.status === "confirmed" ? "Monitoring Reader confirmed" : result?.message ?? "Awaiting grant"}
                      </li>;
                    })}
                  </ul>
                  {state.creation.monitoringScopes!.some(scope => state.creation?.monitoringAccess?.[scope]?.status !== "confirmed") ? (
                    <button disabled={busy} onClick={() => {
                      if (state.sessionId && proposal) {
                        const id = state.sessionId;
                        void act("Confirming monitoring access in Azure…", async () => accept(await tools.grantMonitoring(id, proposal.seq)));
                      }
                    }}>Grant Monitoring Reader</button>
                  ) : <p role="status">Access confirmed. Signals can show Unknown until Azure collects a reading.</p>}
                </section>
              )}
              {state.creation.written?.length > 0 && (
                <details>
                  <summary>Written to Azure ({state.creation.written.length})</summary>
                  <ul>
                    {state.creation.written.map((name, i) => (
                      <li key={i}>{name}</li>
                    ))}
                  </ul>
                </details>
              )}
              {!created && (
                <div className="actions">
                  <button disabled={busy} onClick={refresh}>
                    Check creation status
                  </button>
                  <button disabled={busy} onClick={loadPreview}>
                    Review and resume creation
                  </button>
                </div>
              )}
            </section>
          ) : null)}
        {operation && (
          <p className="operation" role="status">
            <span className="spinner" aria-hidden="true" />
            {operation}
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            {state.sessionId && (
              <button disabled={busy} onClick={refresh}>
                Check saved state
              </button>
            )}
          </div>
        )}
        {pollError && (
          <div className="error" role="alert">
            {pollError}
            <button onClick={refresh} disabled={busy}>
              Reconnect
            </button>
          </div>
        )}
      </div>
      </BuilderAnswer>
    </main>
  );
}
