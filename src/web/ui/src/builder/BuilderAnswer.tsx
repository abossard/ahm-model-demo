import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createShowMe } from "../showMe";
import { ShowMeButton, ShowMeText, type ShowMeTextProps } from "../showMe/ShowMeText";
import { SHOW_ME_MARKER } from "../showMe/markers";
import { builderDestination, resourceEvidence, type AnswerTask } from "./builderDestinations";
import { designerDiagram, PlanDiagram } from "./PlanDiagram";
import { metricPrediction } from "./signalPrediction";
import type { BuilderState, BuilderTools, Preview } from "./types";
import "./builderAnswer.css";

const Answer = createContext<{
  task: AnswerTask;
  registry: ShowMeTextProps["registry"];
  actions: ShowMeTextProps["actions"] | undefined;
} | null>(null);

export function BuilderProse({ text }: { text: string }) {
  const answer = useContext(Answer);
  return answer?.actions ? <ShowMeText registry={answer.registry} actions={answer.actions} text={text} /> : <>{text}</>;
}

/** A saved decision can cite inventory or a reading even when its agent did not issue a marker. */
export function BuilderSource({ resourceId, measured, label, reason }: {
  resourceId: string; measured: boolean; label: string; reason: string;
}) {
  const answer = useContext(Answer);
  const index = answer?.task.builder.resources?.findIndex(resource => resource.id.toLowerCase() === resourceId.toLowerCase());
  if (!answer || index === undefined || index < 0) return <>{label}</>;
  const ref = "R" + (index + 1);
  const signal = measured && resourceEvidence(answer.task, undefined, ref);
  const id = (signal && hasSignal(signal) ? "signal/" : "resource/") + ref;
  for (const match of reason.matchAll(SHOW_ME_MARKER)) {
    const action = answer.actions?.[match[1]!];
    if (action?.handle === "builder" && action.id === id) return <>{label}</>;
  }
  return <ShowMeButton registry={answer.registry} action={{ handle: "builder", id }}>{label}</ShowMeButton>;
}

type Evidence = NonNullable<ReturnType<typeof resourceEvidence>>;
const hasSignal = (evidence: Evidence) => Boolean(evidence.metric || evidence.observation || evidence.check || evidence.resource.availabilityState);
type Inspection =
  | { kind: "resource" | "signal"; id: string; evidence: Evidence }
  | { kind: "design"; id: string; title: string; preview?: Preview };

function EvidenceDetails({ kind, evidence }: { kind: "resource" | "signal"; evidence: Evidence }) {
  const { resource, row, metric, observation, check } = evidence;
  if (kind === "resource") return <>
    <h3>{resource.name}</h3>
    {row && <p>{row.purpose}</p>}
    <dl>
      <dt>Resource type</dt><dd>{resource.type}</dd>
      <dt>Location</dt><dd>{resource.location}</dd>
      {row && <><dt>Proposed impact</dt><dd>{row.impact}</dd></>}
      <dt>Azure ID</dt><dd><code>{resource.id}</code></dd>
    </dl>
  </>;
  return <>
    <h3>{resource.name} · Signal evidence</h3>
    {observation && <p><strong>{observation.metricName}</strong> · {observation.aggregation} {observation.sample} {observation.unit}
      {" at "}<time dateTime={observation.observedAt}>{new Date(observation.observedAt).toLocaleString()}</time>.</p>}
    {metric && <p>{metric.metricName} · Observed {metric.sample}. Proposed unhealthy threshold {metric.operator === "GreaterThan" ? "above" : "below"} {metric.threshold}.
      {" "}Predicted state for this sample: {metricPrediction(metric)}.</p>}
    {resource.availabilityState && <p>Azure Resource Health · {resource.availabilityState}</p>}
    {check && <p>{check.detail}</p>}
  </>;
}

/** Keep the source passage mounted beside the evidence. The frame owns the inspector and its Task-scoped IDs. */
export function BuilderAnswer({ task, analysis, sessionId, tools, children }: {
  task: AnswerTask | undefined;
  analysis: BuilderState["analysis"];
  sessionId: string | null;
  tools: Pick<BuilderTools, "preview">;
  children: ReactNode;
}) {
  const [detail, setDetail] = useState<Inspection | null>(null);
  const target = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const registry = useMemo(() => {
    if (!task) return createShowMe([]);
    const proposing = task.result?.kind === "builderProposals";
    return createShowMe([{
      ...builderDestination(proposing ? "propose" : "analyze"),
      async open(id, signal) {
        if (!id) return null;
        const show = (next: Inspection) => {
          flushSync(() => setDetail(next));
          opener.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
          if (document.activeElement === opener.current) target.current?.focus({ preventScroll: true });
          return target.current;
        };
        signal.addEventListener("abort", () => setDetail(null), { once: true });
        if (id.startsWith("design/") && task.result?.kind === "builderProposals" && sessionId) {
          const design = task.result.proposals.find(option => "design/" + option.id === id);
          if (!design) return null;
          show({ kind: "design", id, title: design.title });
          const preview = await tools.preview(sessionId, task.seq, design.id);
          if (signal.aborted || preview.id !== design.id) return null;
          return show({ kind: "design", id, title: design.title, preview });
        }
        const match = /^(resource|signal)\/(R[1-9][0-9]*)$/.exec(id);
        const evidence = match && resourceEvidence(task, analysis, match[2]!);
        if (!evidence || (match[1] === "signal" && !hasSignal(evidence))) return null;
        return show({ kind: match[1] === "signal" ? "signal" : "resource", id, evidence });
      },
    }]);
  }, [task, analysis, sessionId, tools]);
  useLayoutEffect(() => () => registry.clear(), [registry]);
  const offered = task?.showMeHandles?.some(h => h.name === "builder");
  const actions = task?.result?.showMe;
  const answer = task ? { task, registry, actions: actions && !offered ? {} : actions } : null;
  const close = () => {
    flushSync(() => registry.clear());
    opener.current?.focus({ preventScroll: true });
    opener.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  };
  return <Answer.Provider value={answer}>
    <div className="builder-answer" data-inspecting={detail ? "" : undefined}
      onKeyDown={event => { if (detail && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); } }}>
      <div className="builder-answer-source" onClickCapture={event => {
        const button = event.target instanceof Element && event.target.closest<HTMLElement>("[data-show-me-handle]");
        if (button) opener.current = button;
      }}>{children}</div>
      {detail && <aside className="builder-inspector" aria-label="Show me details">
        <button type="button" className="close-inspector" onClick={close}>Close details</button>
        <section ref={target} tabIndex={-1} aria-label={detail.kind === "design" ? detail.title : detail.evidence.resource.name}
          data-builder-target={detail.kind} data-builder-id={detail.id}>
          {detail.kind === "design" ? <>
            <h3>{detail.title}</h3>
            {detail.preview ? <PlanDiagram diagram={designerDiagram(detail.preview, analysis?.result, analysis?.builder)} title="Design preview" />
              : <p role="status">Opening design preview…</p>}
          </> : <EvidenceDetails kind={detail.kind} evidence={detail.evidence} />}
        </section>
      </aside>}
    </div>
  </Answer.Provider>;
}
