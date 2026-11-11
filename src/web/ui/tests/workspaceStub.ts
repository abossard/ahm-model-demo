import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page, Route } from "@playwright/test";
import type {
  ActivityEvent,
  ActivityKind,
  ApplyOutcome,
  DiffChange,
  DiffView,
  ExplainResult,
  Finding,
  ModelCatalog,
  SessionSummary,
  Task,
  TaskError,
  TaskInput,
  TaskResult,
  TaskType,
  VerificationRow,
} from "../src/model/types";
import { SUBSCRIPTION_A, entity, healthModel, modelCatalog, signal } from "./fixture";

export const SESSION_ID = "s-demo";
export const TARGET = { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A } as const;
export const DESIGN_TARGET = { ...TARGET, name: "hm-demo-design" } as const;

/** The catalog of the fixtures plus the design model Design Tasks derive their target from. */
export const catalogWithDesign: ModelCatalog = {
  ...modelCatalog,
  models: [
    ...modelCatalog.models,
    {
      id: `/subscriptions/${SUBSCRIPTION_A}/resourceGroups/rg-demo/providers/Microsoft.CloudHealth/healthmodels/hm-demo-design`,
      name: "hm-demo-design",
      resourceGroup: "rg-demo",
      subscriptionId: SUBSCRIPTION_A,
      location: "northeurope",
      provisioningState: "Succeeded",
    },
  ],
};

const START = Date.parse("2026-11-10T10:00:00Z");
export const at = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

export function activity(
  seq: number,
  kind: ActivityKind,
  summary: string,
  payload: Readonly<Record<string, unknown>> = {},
): ActivityEvent {
  return { seq, ts: at(seq * 3), kind, summary, payload };
}

/** What a Review streams: a status, tool calls with their results, and the submitted result. */
export function reviewEvents(count = 10): readonly ActivityEvent[] {
  return [
    // The titles the app gives these steps (activity.py), so the specs read them as a person does.
    activity(1, "status", "Agent started"),
    activity(2, "text", "Reading the current model", { text: "Reading the current model before proposing changes." }),
    activity(3, "tool_call", "Inspect health model hm-demo (entity svc-a)", { name: "monitor_healthmodels_inspect", arguments: JSON.stringify({ healthModel: "hm-demo", entity: "svc-a" }) }),
    activity(4, "tool_result", "Inspect health model hm-demo (entity svc-a): ok, 12.0 KB", { name: "monitor_healthmodels_inspect", size: 12288, ok: true }),
    activity(5, "tool_call", "Run log query on Queue", { name: "monitor_workspace_log_query", arguments: JSON.stringify({ table: "Queue", query: "Queue | take 5" }) }),
    activity(6, "tool_result", "Run log query on Queue: ok, 1.1 KB", { name: "monitor_workspace_log_query", size: 1126, ok: true }),
    activity(7, "text", "Drafting the proposed changes"),
    activity(8, "tool_call", "Submit result (diff, 5 changes)", { name: "submit_result" }),
    activity(9, "tool_result", "Submit result (diff, 5 changes): accepted", { name: "submit_result", ok: true }),
    activity(10, "result", "Result accepted (diff, 5 changes)", { resultKind: "diff" }),
  ].slice(0, count);
}

const MODEL_SNAPSHOT = { entities: healthModel.entities, relationships: healthModel.relationships };

const SVC_G = entity({
  name: "svc-g",
  displayName: "Service G",
  healthState: "Unknown",
  parents: ["svc-b"],
  signals: [signal("queue-depth", "Queue depth", null, "Unknown")],
});

const PROPOSED = {
  entities: [
    ...healthModel.entities
      .filter((item) => item.name !== "svc-f")
      .map((item) =>
        item.name === "svc-a"
          ? { ...item, displayName: "Service A (edge)" }
          : item.name === "svc-b"
            ? { ...item, children: [...item.children, "svc-g"] }
            : item,
      ),
    SVC_G,
  ],
  relationships: [
    ...healthModel.relationships,
    { name: "r5", displayName: "feeds", parentEntityName: "svc-b", childEntityName: "svc-g" },
  ],
};

const queueRow = (status: VerificationRow["status"], error: string | null = null): VerificationRow => ({
  entity: "svc-g",
  signal: "queue-depth",
  status,
  query: "Queue | summarize max(Depth)",
  value: status === "verified" ? 7 : null,
  error,
});

export function reviewChanges(): readonly DiffChange[] {
  return [
    {
      id: "c1",
      op: "change",
      kind: "entity",
      name: "svc-a",
      reason: "The edge service is the entry point, so its name says so.",
      before: { displayName: "Service A" },
      after: { displayName: "Service A (edge)" },
      details: [{ path: "properties.displayName", before: "Service A", after: "Service A (edge)" }],
      dependsOn: [],
      verification: [],
    },
    {
      id: "c2",
      op: "add",
      kind: "signalDefinition",
      name: "sd-queue-depth",
      reason: "Queue depth shows backlog before latency does.",
      before: null,
      after: { signalKind: "LogAnalyticsQuery", queryText: "Queue | summarize max(Depth)" },
      details: [{ path: "properties.queryText", before: null, after: "Queue | summarize max(Depth)" }],
      dependsOn: [],
      verification: [queueRow("verified")],
    },
    {
      id: "c3",
      op: "add",
      kind: "entity",
      name: "svc-g",
      reason: "The queue consumer has no entity, so its failures are invisible.",
      before: null,
      after: {
        displayName: "Service G",
        signalGroups: { logAnalytics: { signals: [{ name: "queue-depth", signalDefinitionName: "sd-queue-depth" }] } },
      },
      details: [
        { path: "properties.displayName", before: null, after: "Service G" },
        { path: "properties.signalGroups.logAnalytics", before: null, after: { signals: 1 } },
      ],
      dependsOn: ["c2", "c4"],
      verification: [queueRow("failing", "The query returned no rows.")],
    },
    {
      id: "c4",
      op: "add",
      kind: "relationship",
      name: "r5",
      reason: "Service B feeds the queue consumer.",
      before: null,
      after: { parentEntityName: "svc-b", childEntityName: "svc-g" },
      details: [],
      dependsOn: ["c2", "c3"],
      verification: [],
    },
    {
      id: "c5",
      op: "remove",
      kind: "entity",
      name: "svc-f",
      reason: "No relationship reaches it and it reports nothing the others do not.",
      before: { displayName: "Very Long Downstream Analytics And Reporting Service Name" },
      after: null,
      details: [],
      dependsOn: [],
      verification: [],
    },
  ];
}

const reviewFindings: readonly Finding[] = [
  { severity: "high", entity: "svc-g", text: "The queue consumer is not modeled.", changeIds: ["c3"] },
  { severity: "low", entity: null, text: "Service F is not connected to anything.", changeIds: ["c5"] },
  { severity: "medium", entity: "svc-a", text: "The entry point carries no hint of it.", changeIds: ["c1"] },
];

export function reviewDiff(patch: Partial<DiffView> = {}): DiffView {
  const changes = reviewChanges();
  return {
    base: MODEL_SNAPSHOT,
    proposed: PROPOSED,
    changes,
    verification: changes.flatMap((change) => change.verification),
    findings: reviewFindings,
    summary: "Add the queue consumer with its signal, rename the edge service and drop the unconnected one.",
    target: TARGET,
    appliable: true,
    applies: [],
    ...patch,
  };
}

export function reviewResult(): TaskResult {
  const diff = reviewDiff();
  return {
    kind: "diff",
    summary: diff.summary,
    changes: diff.changes.map(({ id, op, kind, name, after, reason }) => ({ id, op, kind, name, after, reason })),
    verification: diff.verification,
    findings: diff.findings,
  };
}

export function explainResult(): ExplainResult {
  return {
    kind: "explain",
    entity: "svc-c",
    state: "Unhealthy",
    summary: "Service C is unhealthy because Service B's queue is past its threshold and a service takes the worst state of what it depends on.",
    causes: [
      { entity: "svc-c", signal: null, state: "Unhealthy", threshold: null, value: null, rollup: "Worst of its inputs", note: "Service C reports no signal of its own." },
      { entity: "svc-b", signal: "queue", state: "Degraded", threshold: "above 40", value: 42, rollup: null, note: "The queue holds 42 items; Degraded starts above 40." },
      { entity: "svc-a", signal: "latency", state: "Degraded", threshold: "above 900 ms", value: 980, rollup: null, note: "Latency adds to the load on Service B." },
    ],
  };
}

export function explainEvents(): readonly ActivityEvent[] {
  return [
    activity(1, "status", "Agent started"),
    activity(2, "tool_call", "Inspect health model hm-demo (entity svc-c)", { name: "monitor_healthmodels_inspect", arguments: JSON.stringify({ healthModel: "hm-demo", entity: "svc-c" }) }),
    activity(3, "tool_result", "Inspect health model hm-demo (entity svc-c): ok, 4.0 KB", { name: "monitor_healthmodels_inspect", size: 4096, ok: true }),
    activity(4, "result", "Result accepted (explain, 3 causes)", { resultKind: "explain" }),
  ];
}

/** A diff with many changes, to show that a long list is windowed. */
export function longDiff(count: number): DiffView {
  const changes: DiffChange[] = Array.from({ length: count }, (_, index) => ({
    id: `c${index + 1}`,
    op: "add",
    kind: "entity",
    name: `svc-extra-${index + 1}`,
    reason: `Entity ${index + 1} is not modeled yet.`,
    before: null,
    after: { displayName: `Extra ${index + 1}` },
    details: [],
    dependsOn: [],
    verification: [],
  }));
  return { ...reviewDiff(), changes, findings: [], verification: [], summary: `${count} entities are not modeled.` };
}

export function designDiff(): DiffView {
  const web = entity({ name: "web", displayName: "Web front end", healthState: "Unknown", children: ["api"] });
  const api = entity({ name: "api", displayName: "Orders API", healthState: "Unknown", parents: ["web"] });
  const added = (id: string, kind: DiffChange["kind"], name: string, after: Record<string, unknown>, dependsOn: string[] = []): DiffChange => ({
    id,
    op: "add",
    kind,
    name,
    reason: `Design adds ${name}.`,
    before: null,
    after,
    details: [],
    dependsOn,
    verification: [],
  });
  const changes = [
    added("d1", "entity", "web", { displayName: "Web front end" }, ["d3"]),
    added("d2", "entity", "api", { displayName: "Orders API" }, ["d3"]),
    added("d3", "relationship", "web-api", { parentEntityName: "web", childEntityName: "api" }, ["d1", "d2"]),
  ];
  return {
    base: { entities: [], relationships: [] },
    proposed: {
      entities: [web, api],
      relationships: [{ name: "web-api", displayName: "calls", parentEntityName: "web", childEntityName: "api" }],
    },
    changes,
    verification: [],
    findings: [],
    summary: "A web front end calling the orders API.",
    target: DESIGN_TARGET,
    appliable: true,
    applies: [],
  };
}

export function designEvents(): readonly ActivityEvent[] {
  return [activity(1, "status", "Agent started"), activity(2, "result", "Result accepted (diff, 3 changes)", { resultKind: "diff" })];
}

export interface StubScript {
  readonly events: readonly ActivityEvent[];
  /** Deliver this many events, then keep the stream waiting until `release` is called. */
  readonly hold?: number;
  readonly outcome:
    | { readonly status: "done"; readonly result: TaskResult; readonly diff?: DiffView }
    | { readonly status: "failed"; readonly error: TaskError };
}

export function defaultScript(type: TaskType): StubScript {
  if (type === "explain") return { events: explainEvents(), outcome: { status: "done", result: explainResult() } };
  if (type === "design") {
    const diff = designDiff();
    return {
      events: designEvents(),
      outcome: {
        status: "done",
        diff,
        result: { kind: "diff", summary: diff.summary, changes: [], verification: [], findings: [] },
      },
    };
  }
  return { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: reviewDiff() } };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

interface StubTask {
  task: Task;
  readonly script: StubScript;
  diff: DiffView | null;
  readonly gate: Deferred;
  released: boolean;
  /** The streams a held Task has open right now. */
  readonly open: Set<http.ServerResponse>;
}

export interface ApplyReply {
  readonly status: number;
  readonly body: unknown;
}

export interface WorkspaceOptions {
  readonly sessions?: readonly SessionSummary[];
  /** Finished or running Tasks the Sessions already hold, with the script that serves each. */
  readonly tasks?: readonly { readonly task: Task; readonly script: StubScript }[];
  /** What the next Tasks of a type stream; the defaults are the fixtures above. */
  readonly scripts?: Partial<Record<TaskType, StubScript>>;
  readonly listFails?: boolean;
}

/** A Task someone else started: the next start in the Session finds it running. */
export const OTHER_USERS_TASK: StubScript = {
  events: reviewEvents(3),
  hold: 3,
  outcome: { status: "done", result: reviewResult(), diff: reviewDiff() },
};

export function errorEnvelope(code: string, message: string, retryable = false): unknown {
  return { error: { code, message, retryable, operationId: "op-test" } };
}

/** An answer the app gives when it is full, busy or refuses a request: its status and error envelope. */
export interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** The refusals the app's limits produce, with the words the app uses for them. */
export const REFUSALS = {
  agentsBusy: { status: 503, code: "agents_busy", message: "All agents are busy with other tasks. Try again in a few minutes.", retryable: true },
  taskLimit: { status: 409, code: "task_limit", message: "This session has reached its limit of tasks. Start a new session.", retryable: false },
  sessionLimit: { status: 409, code: "session_limit", message: "The app has reached its limit of sessions.", retryable: false },
  payloadTooLarge: { status: 413, code: "payload_too_large", message: "The request body must be at most 64 KB.", retryable: false },
  tooManySubscribers: { status: 503, code: "too_many_subscribers", message: "Too many viewers are following this task. Try again shortly.", retryable: true },
  invalidLastEventId: { status: 400, code: "invalid_last_event_id", message: "lastEventId must be a whole number of at most 9 digits.", retryable: false },
} as const satisfies Record<string, Refusal>;

export function sessionSummary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return { id: SESSION_ID, title: "Queue review", createdAt: at(0), taskCount: 0, lastTaskAt: null, ...patch };
}

export function taskOf(seq: number, patch: Partial<Task> = {}): Task {
  const task: Task = {
    id: String(seq),
    sessionId: SESSION_ID,
    seq,
    type: "review",
    target: TARGET,
    instruction: "",
    status: "done",
    base: { modelId: "/subscriptions/x/hm", fingerprint: "f".repeat(64), capturedAt: at(0) },
    createdAt: at(0),
    finishedAt: at(40),
    ...patch,
  };
  // A Task that runs has not finished.
  if (task.status === "running") {
    const { finishedAt: _finished, ...running } = task;
    return running;
  }
  return task;
}

/** The Sessions, Tasks, Activity timelines, diffs and Apply of the Session workspace, served from memory. */
export class WorkspaceStub {
  readonly sessions: SessionSummary[];
  readonly posts: { readonly sessionId: string; readonly body: TaskInput }[] = [];
  readonly applies: { readonly sessionId: string; readonly seq: number; readonly changeIds: readonly string[] }[] = [];
  readonly eventRequests: { readonly seq: number; readonly lastEventId: string | null }[] = [];
  /** Replies for the next Apply calls; without one, Apply writes the expanded selection once. */
  readonly applyReplies: ApplyReply[] = [];
  /** Set to start a Task behind the page's back: the next start answers 409 `task_running`. */
  conflictWith: StubScript | null = null;
  /** Refusals for the next Task starts and the next Session creations, one each. */
  readonly startRefusals: Refusal[] = [];
  readonly sessionRefusals: Refusal[] = [];
  /** While set, every event stream request is refused instead of streamed. */
  streamRefusal: Refusal | null = null;
  /** How many of the next requests for a diff fail. */
  diffFailures = 0;
  readonly scripts: Partial<Record<TaskType, StubScript>>;
  readonly listFails: boolean;
  private readonly records = new Map<string, StubTask[]>();
  private appliedOnce = false;
  private port = 0;
  private readonly server = http.createServer((request, response) => {
    const [sid, seq] = (request.url ?? "").split("/").filter(Boolean);
    const record = this.list(decodeURIComponent(sid ?? "")).find((item) => item.task.seq === Number(seq));
    if (!record) {
      response.writeHead(404, { "access-control-allow-origin": "*" });
      response.end();
      return;
    }
    this.serveStream(request, response, record);
  });

  /** The Sessions that hold no Task, as the app lists them: what a start that went wrong must not leave behind. */
  emptySessions(): SessionSummary[] {
    return this.sessions.flatMap((item) => {
      const listed = this.summary(item.id);
      return listed && listed.taskCount === 0 ? [listed] : [];
    });
  }

  private startGate: Deferred | null = null;

  /** Makes the next Task starts wait, so the page can be seen while it waits; the returned function lets them go. */
  holdStarts(): () => void {
    const gate = deferred();
    this.startGate = gate;
    return () => {
      this.startGate = null;
      gate.resolve();
    };
  }

  /** The app lets a user run one Task at a time, in any Session. */
  private runsAnywhere(): boolean {
    return [...this.records.values()].some((records) => records.some(({ task }) => task.status === "running"));
  }

  /** Starts the event stream server; `close` stops it. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  constructor(options: WorkspaceOptions) {
    this.sessions = [...(options.sessions ?? [])];
    this.scripts = options.scripts ?? {};
    this.listFails = options.listFails ?? false;
    for (const { task, script } of options.tasks ?? []) this.add(task, script);
  }

  private add(task: Task, script: StubScript): StubTask {
    const finished = task.status !== "running";
    const record: StubTask = {
      task,
      script,
      diff: finished && script.outcome.status === "done" ? (script.outcome.diff ?? null) : null,
      gate: deferred(),
      released: finished,
      open: new Set(),
    };
    this.records.set(task.sessionId, [...(this.records.get(task.sessionId) ?? []), record]);
    return record;
  }

  private list(sid: string): StubTask[] {
    return this.records.get(sid) ?? [];
  }

  private summary(sid: string): SessionSummary | undefined {
    const session = this.sessions.find((item) => item.id === sid);
    if (!session) return undefined;
    const tasks = this.list(sid);
    return { ...session, taskCount: tasks.length, lastTaskAt: tasks.at(-1)?.task.createdAt ?? null };
  }

  /** Lets the stream of a held Task finish. */
  release(seq: number, sid = SESSION_ID): void {
    const record = this.list(sid).find((item) => item.task.seq === seq);
    if (record) {
      record.released = true;
      record.gate.resolve();
      // The app finishes a Task whether or not anyone follows its stream.
      if (record.task.status === "running" && record.open.size === 0) this.finalize(record);
    }
  }

  /** Makes a Task of the Session look finished without a stream, as if it ended elsewhere. */
  private finalize(record: StubTask): void {
    const { outcome } = record.script;
    record.task =
      outcome.status === "done"
        ? { ...record.task, status: "done", result: outcome.result, finishedAt: new Date().toISOString() }
        : { ...record.task, status: "failed", error: outcome.error, finishedAt: new Date().toISOString() };
    if (outcome.status === "done") record.diff = outcome.diff ?? null;
  }

  private json(route: Route, status: number, body: unknown): Promise<void> {
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  }

  private frame(event: ActivityEvent): string {
    return `id: ${event.seq}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private doneFrame(record: StubTask): string {
    const { task } = record;
    return `event: done\ndata: ${JSON.stringify(task.status === "failed" ? { status: "failed", error: task.error } : { status: "done" })}\n\n`;
  }

  /**
   * The Activity timeline as a real event stream, so the browser reconnects with `Last-Event-ID` as it does
   * against the app. A held Task writes its first events and keeps the connection open until `release`.
   */
  private serveStream(request: http.IncomingMessage, response: http.ServerResponse, record: StubTask): void {
    const header = request.headers["last-event-id"];
    const lastEventId = typeof header === "string" ? header : null;
    this.eventRequests.push({ seq: record.task.seq, lastEventId });
    if (this.streamRefusal) {
      const { status, code, message, retryable } = this.streamRefusal;
      response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify(errorEnvelope(code, message, retryable)));
      return;
    }
    const last = Number(lastEventId ?? 0);
    const { script } = record;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    });
    // A short retry keeps a dropped stream from slowing the tests down.
    response.write("retry: 40\n\n");

    const finish = (from: number): void => {
      for (const event of script.events.filter((item) => item.seq > from)) response.write(this.frame(event));
      if (record.task.status === "running") this.finalize(record);
      response.write(this.doneFrame(record));
      response.end();
    };

    if (script.hold === undefined || record.released) {
      finish(last);
      return;
    }
    for (const event of script.events.filter((item) => item.seq > last && item.seq <= (script.hold ?? 0))) {
      response.write(this.frame(event));
    }
    record.open.add(response);
    response.on("close", () => record.open.delete(response));
    void record.gate.promise.then(() => {
      if (!response.writableEnded && !response.destroyed) finish(Math.max(last, script.hold ?? 0));
    });
  }

  /** Cuts the open streams of a held Task, as a dropped connection would. */
  dropStreams(seq: number, sid = SESSION_ID): void {
    const record = this.list(sid).find((item) => item.task.seq === seq);
    for (const response of record?.open ?? []) response.destroy();
  }

  private expand(record: StubTask, changeIds: readonly string[]): string[] {
    const changes = record.diff?.changes ?? [];
    const wanted = new Set(changeIds);
    for (const change of changes) if (wanted.has(change.id)) change.dependsOn.forEach((id) => wanted.add(id));
    return changes.filter((change) => wanted.has(change.id)).map((change) => change.id);
  }

  private async apply(route: Route, record: StubTask, changeIds: readonly string[]): Promise<void> {
    this.applies.push({ sessionId: record.task.sessionId, seq: record.task.seq, changeIds });
    const reply = this.applyReplies.shift();
    if (reply) {
      const body = reply.body as ApplyOutcome;
      if (reply.status === 200 && record.diff) {
        record.diff = { ...record.diff, applies: [...record.diff.applies, { ...body, at: new Date().toISOString(), changeIds }] };
        this.appliedOnce = true;
      }
      await this.json(route, reply.status, reply.body);
      return;
    }
    if (this.appliedOnce) {
      await this.json(route, 409, errorEnvelope("base_changed", "The live model changed after this Task captured its Base model."));
      return;
    }
    const expanded = this.expand(record, changeIds);
    const outcome: ApplyOutcome = { outcome: "applied", written: expanded, failed: null, expanded };
    if (record.diff) {
      record.diff = { ...record.diff, applies: [...record.diff.applies, { ...outcome, at: new Date().toISOString(), changeIds }] };
    }
    this.appliedOnce = true;
    await this.json(route, 200, outcome);
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
    const [sid, section, rawSeq, leaf] = parts;
    const method = request.method();

    if (sid === undefined) {
      if (this.listFails) {
        await this.json(route, 503, errorEnvelope("sessions_unavailable", "The Session store is unavailable."));
        return;
      }
      if (method === "POST") {
        const refusal = this.sessionRefusals.shift();
        if (refusal) {
          await this.json(route, refusal.status, errorEnvelope(refusal.code, refusal.message, refusal.retryable));
          return;
        }
        const body = request.postDataJSON() as { title?: string } | null;
        const session = sessionSummary({
          id: `s-${this.sessions.length + 1}`,
          title: body?.title ?? "Session 2026-11-10 10:00",
          createdAt: new Date().toISOString(),
        });
        this.sessions.unshift(session);
        await this.json(route, 201, session);
        return;
      }
      await this.json(route, 200, { sessions: this.sessions.map((item) => this.summary(item.id) ?? item) });
      return;
    }

    const session = this.summary(sid);
    if (!session) {
      await this.json(route, 404, errorEnvelope("session_not_found", "The Session does not exist."));
      return;
    }
    if (section === undefined) {
      await this.json(route, 200, { session, tasks: this.list(sid).map(({ task }) => ({ ...task, result: undefined })) });
      return;
    }
    if (section !== "tasks") {
      await this.json(route, 404, errorEnvelope("not_found", "Unknown route."));
      return;
    }

    if (rawSeq === undefined) {
      const body = request.postDataJSON() as TaskInput;
      this.posts.push({ sessionId: sid, body });
      await this.startGate?.promise;
      const refusal = this.startRefusals.shift();
      if (refusal) {
        await this.json(route, refusal.status, errorEnvelope(refusal.code, refusal.message, refusal.retryable));
        return;
      }
      if (this.conflictWith) {
        const script = this.conflictWith;
        this.conflictWith = null;
        this.add(taskOf(this.list(sid).length + 1, { status: "running", createdAt: new Date().toISOString() }), script);
      }
      if (this.runsAnywhere()) {
        await this.json(route, 409, errorEnvelope("task_running", "You already have a task running in another session. Wait for it to finish."));
        return;
      }
      const script = this.scripts[body.type] ?? defaultScript(body.type);
      const record = this.add(
        {
          id: String(this.list(sid).length + 1),
          sessionId: sid,
          seq: this.list(sid).length + 1,
          type: body.type,
          target: body.target,
          ...(body.workload ? { workload: body.workload } : {}),
          instruction: body.instruction,
          status: "running",
          createdAt: new Date().toISOString(),
        },
        script,
      );
      await this.json(route, 202, record.task);
      return;
    }

    const record = this.list(sid).find((item) => item.task.seq === Number(rawSeq));
    if (!record) {
      await this.json(route, 404, errorEnvelope("task_not_found", "The Task does not exist."));
      return;
    }
    if (leaf === undefined) {
      await this.json(route, 200, record.task);
    } else if (leaf === "events") {
      // The stream is served by a real HTTP server; the page is sent there with its headers intact.
      await route.continue({ url: `http://127.0.0.1:${this.port}/${encodeURIComponent(sid)}/${record.task.seq}` });
    } else if (leaf === "diff") {
      if (this.diffFailures > 0) {
        this.diffFailures -= 1;
        await this.json(route, 503, errorEnvelope("diff_unavailable", "The proposed changes could not be built."));
        return;
      }
      await (record.diff
        ? this.json(route, 200, record.diff)
        : this.json(route, 409, errorEnvelope("no_diff", "This Task has no Health model diff.")));
    } else if (leaf === "apply" && method === "POST") {
      const body = request.postDataJSON() as { changeIds: string[] };
      await this.apply(route, record, body.changeIds);
    } else {
      await this.json(route, 404, errorEnvelope("not_found", "Unknown route."));
    }
  }
}

/** Serves the Session API from memory. Install after `installStubs`, which answers everything else. */
export async function installWorkspace(page: Page, options: WorkspaceOptions = {}): Promise<WorkspaceStub> {
  const stub = new WorkspaceStub(options);
  await stub.listen();
  page.on("close", () => stub.close());
  await page.route(/\/api\/sessions(\/|\?|$)/, async (route) => {
    try {
      await stub.handle(route);
    } catch {
      // The page closed while a held stream was waiting.
    }
  });
  return stub;
}
