import type { Page } from "@playwright/test";
import { stateName, type TimelineResponse } from "../../src/model/timeline";
import type {
  ActivityEvent, DiffChange, DiffTaskResult, DiffView, ExplainResult, HealthModel, ModelSelection,
} from "../../src/model/types";
import { installWorkspace, type StubScript } from "../../tests/workspaceStub";

export const topic = "core-incident";
const iso = (t: number) => new Date(t).toISOString();

/** The answers and edits are examples. Evidence in the Explain comes from this recording's actual model and history. */
export async function installExampleTopic(page: Page, model: HealthModel, history: TimelineResponse, target: ModelSelection) {
  const web = model.entities.find(entity => entity.name === "container-app");
  const transitions = history.states.find(item => item.entity === web?.name)?.transitions ?? [];
  const transition = transitions.filter(item => item.to === 3).at(-1) ?? transitions.at(-1);
  if (!web || !transition) throw new Error("The CORE snapshot needs Web / View state history for the example question.");
  const asOf = iso(transition.t);
  const state = stateName(transition.to);
  const reading = history.series.filter(series => series.entity === web.name)
    .flatMap(series => {
      const point = series.points.filter(([t]) => t <= transition.t).at(-1);
      return point && transition.t - point[0] <= 5 * 60_000 && point[2] === transition.to
        ? [{ signal: series.signal, value: point[1] }] : [];
    })[0];
  const lane = reading ? `signal/${web.name}/${reading.signal}` : `entity/${web.name}`;
  const signal = history.entities.find(item => item.name === web.name)?.signals.find(item => item.name === reading?.signal);
  const unit = signal?.unit === "MilliSeconds" ? " ms" : signal?.unit ? " " + signal.unit : "";
  const measured = reading?.value == null ? "" : reading.value.toLocaleString("en-US", { maximumFractionDigits: 4 }) + unit;
  const rule = state === "Unhealthy" ? signal?.rules.unhealthy : state === "Degraded" ? signal?.rules.degraded : null;
  const threshold = rule && (rule.operator === "GreaterThan" || rule.operator === "LessThan")
    ? (rule.operator === "GreaterThan" ? "above " : "below ") + rule.threshold.toLocaleString("en-US") + unit : null;
  const evidence = measured ? `${signal?.displayName ?? reading!.signal} measured ${measured}. ` : "";
  const answer: ExplainResult = {
    kind: "explain", entity: web.name, state, confidence: "medium",
    summary: `The web app behind View a health model entered ${state} at ${asOf.slice(11, 19)} UTC. ${evidence}Open its recorded history [[show:1]] to inspect the transition.`,
    causes: [{ entity: web.name, state, signal: reading?.signal ?? null, value: reading?.value ?? null, threshold, rollup: null,
      note: reading ? "This signal had the same state in the five minutes before the transition." : "The state history records the transition. Inspect the signal lanes for evidence of the cause." }],
    window: { from: iso(transition.t - 5 * 60_000), to: asOf },
    showMe: { "1": { handle: "timeline", id: lane, highlight: { color: "amber" } },
      "2": { handle: "graph", id: `node/${web.name}`, highlight: { color: "violet" } } },
    nextSteps: [{ id: "1", label: "Open the recorded history" }, { id: "2", label: "Find the web app on the graph" }],
  };
  const started = transition.t + 120_000;
  const events: ActivityEvent[] = [
    { seq: 1, ts: iso(started), kind: "status", summary: "Agent started", payload: {} },
    { seq: 2, ts: iso(started + 2_000), kind: "tool_call", summary: "Inspect the web app’s recorded state",
      payload: { name: "monitor_healthmodels_inspect", arguments: JSON.stringify({ healthModel: target.name, entity: web.name, asOf }) } },
    { seq: 3, ts: iso(started + 4_000), kind: "tool_result", summary: `Found the transition to ${state}`,
      payload: { name: "monitor_healthmodels_inspect", ok: true } },
    { seq: 4, ts: iso(started + 6_000), kind: "result", summary: "Explanation ready", payload: { resultKind: "explain" } },
  ];

  // This proposal changes two display names. Both Azure resource bindings and the recorded topology stay intact.
  const suggested = new Map([["session-storage", "Session blob storage"], ["session-storage-apply", "Apply receipts storage"]]);
  const changes: DiffChange[] = Array.from(suggested, ([name, displayName], index) => {
    const entity = model.entities.find(item => item.name === name);
    if (!entity) throw new Error(`Missing CORE storage entity: ${name}`);
    return { id: `c${index + 1}`, kind: "entity", op: "change", name,
      reason: "Name this storage dependency for the work it supports.",
      before: { properties: { displayName: entity.displayName } }, after: { properties: { displayName } },
      details: [{ path: "properties.displayName", before: entity.displayName, after: displayName }], dependsOn: [], verification: [] };
  });
  const review: DiffTaskResult = {
    kind: "diff", summary: "Give the two Blob Storage dependencies shorter labels so readers can distinguish saving a Session from saving an Apply receipt.",
    findings: [{ severity: "low", entity: null, text: "The Task and Apply flows use distinct model entities for the same storage account.", changeIds: ["c1", "c2"] }],
    changes, verification: [],
  };
  const diff: DiffView = {
    ...review, changes, target, appliable: true, applies: [],
    base: { entities: model.entities, relationships: model.relationships },
    proposed: { entities: model.entities.map(item => suggested.has(item.name) ? { ...item, displayName: suggested.get(item.name)! } : item), relationships: model.relationships },
  };
  const reviewScript: StubScript = { events: [
    { seq: 1, ts: model.observedAt, kind: "status", summary: "Reading the CORE model", payload: {} },
    { seq: 2, ts: model.observedAt, kind: "result", summary: "Two label changes proposed", payload: { resultKind: "diff" } },
  ], outcome: { status: "done", result: review, diff } };
  const stub = await installWorkspace(page, {
    sessions: [{ id: topic, title: "CORE incident review", createdAt: iso(started), lastTaskAt: iso(started), taskCount: 1 }],
    tasks: [{ task: { id: "1", sessionId: topic, seq: 1, type: "explain", status: "done", instruction: "",
      target: { ...target, entity: web.name }, createdAt: iso(started), finishedAt: iso(started + 6_000), asOf,
      showMeHandles: [
        { name: "timeline", description: "Show a recorded state or signal", idDescription: "entity or signal path" },
        { name: "graph", description: "Find an entity on the graph", idDescription: "node path" },
      ], result: answer }, script: { events, outcome: { status: "done", result: answer } } }],
    scripts: { review: reviewScript },
  });
  return { stub, lane, asOf };
}
