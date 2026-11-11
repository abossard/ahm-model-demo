import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiError,
  ApplyOutcome,
  DiffChange,
  DiffView,
  ModelRef,
  SessionDetail,
  SessionSummary,
  Task,
  TaskInput,
} from "../model/types";
import * as api from "./api";
import { IDLE, LOADING } from "./asyncState";
import { actions, useStore } from "./store";

vi.mock("./api");

class FakeStream {
  static instances: FakeStream[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private readonly handlers: api.TaskStreamHandlers,
  ) {
    FakeStream.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** What the app sends: an `activity` event, or `done` once the Task has ended. */
  emit(type: "activity" | "done", data: unknown): void {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    if (type === "activity") this.handlers.onActivity(text);
    else this.handlers.onDone(text);
  }

  /** The stream ended for good without `done`. */
  fail(error: ApiError): void {
    this.handlers.onFailure(error);
  }
}

const frames: (() => void)[] = [];
const runFrame = (): void => {
  const pending = frames.splice(0);
  for (const callback of pending) callback();
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sources = (): FakeStream[] => FakeStream.instances;
const latest = (): FakeStream => sources().at(-1)!;

const SESSION: SessionSummary = { id: "s1", title: "Demo", createdAt: "2026-11-10T10:00:00Z", taskCount: 0, lastTaskAt: null };
const MODEL: ModelRef = { id: null, name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a", location: null, provisioningState: null };
const OTHER: ModelRef = { ...MODEL, name: "hm-b" };

function task(seq: number, patch: Partial<Task> = {}): Task {
  return {
    id: String(seq),
    sessionId: "s1",
    seq,
    type: "review",
    target: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" },
    instruction: "",
    status: "running",
    createdAt: "2026-11-10T10:00:00Z",
    ...patch,
  };
}

const DIFF_RESULT = { kind: "diff", summary: "s", changes: [], verification: [], findings: [] } as const;
const doneDiffTask = (seq: number): Task => task(seq, { status: "done", result: DIFF_RESULT, finishedAt: "2026-11-10T10:01:00Z" });

function change(id: string, name: string, kind: DiffChange["kind"] = "entity", dependsOn: string[] = []): DiffChange {
  return { id, op: "add", kind, name, reason: "r", after: {}, before: null, details: [], dependsOn, verification: [] };
}

function diffView(patch: Partial<DiffView> = {}): DiffView {
  return {
    base: { entities: [], relationships: [] },
    proposed: { entities: [], relationships: [] },
    changes: [change("c1", "svc-a"), change("c2", "svc-b", "entity", ["c3"]), change("c3", "sd-x", "signalDefinition")],
    verification: [],
    findings: [],
    summary: "s",
    target: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" },
    appliable: true,
    applies: [],
    ...patch,
  };
}

const event = (seq: number, kind = "status") => ({ seq, ts: "2026-11-10T10:00:00Z", kind, summary: `event ${seq}`, payload: {} });
const API_ERROR = (code: string): ApiError => ({ code, message: `message ${code}`, retryable: false, operationId: null });
const detail = (tasks: Task[] = []): SessionDetail => ({ session: { ...SESSION, taskCount: tasks.length }, tasks });

async function openSessionWith(tasks: Task[] = []): Promise<void> {
  vi.mocked(api.fetchSession).mockResolvedValue(detail(tasks));
  await actions.openSession("s1");
}

beforeEach(async () => {
  await actions.openTask(null);
  vi.resetAllMocks();
  FakeStream.instances = [];
  frames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.mocked(api.openTaskEvents).mockImplementation((sid, seq, handlers) => new FakeStream(`/api/sessions/${sid}/tasks/${seq}/events`, handlers));
  useStore.setState(useStore.getInitialState(), true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessions", () => {
  it("lists the Sessions and keeps them on screen while it reloads", async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue([SESSION]);
    await actions.loadSessions();
    expect(useStore.getState().sessions).toEqual({ kind: "success", value: [SESSION] });

    const pending = actions.loadSessions();
    expect(useStore.getState().sessions.kind).toBe("success");
    await pending;
  });

  it("shows a failure to list Sessions", async () => {
    vi.mocked(api.fetchSessions).mockRejectedValue(API_ERROR("sessions_unavailable"));
    await actions.loadSessions();
    expect(useStore.getState().sessions).toEqual({ kind: "failure", error: API_ERROR("sessions_unavailable") });
  });

  it("creates a Session, reloads the list and opens it", async () => {
    vi.mocked(api.createSession).mockResolvedValue(SESSION);
    vi.mocked(api.fetchSessions).mockResolvedValue([SESSION]);
    vi.mocked(api.fetchSession).mockResolvedValue(detail());

    await actions.createSession("Demo");

    expect(api.createSession).toHaveBeenCalledWith("Demo");
    expect(useStore.getState()).toMatchObject({ sessionId: "s1", creatingSession: IDLE, sessionDetail: { kind: "success" } });
    expect(api.fetchSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure of a Session that could not be created and opens nothing", async () => {
    vi.mocked(api.createSession).mockRejectedValue(API_ERROR("sessions_unavailable"));
    await actions.createSession();
    expect(useStore.getState()).toMatchObject({ sessionId: null, creatingSession: { kind: "failure" } });
  });

  it("opens a Session and drops a Session detail that arrives late", async () => {
    let release!: (value: SessionDetail) => void;
    vi.mocked(api.fetchSession).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const first = actions.openSession("s1");
    vi.mocked(api.fetchSession).mockResolvedValue({ session: { ...SESSION, id: "s2" }, tasks: [] });
    await actions.openSession("s2");

    release(detail());
    await first;

    expect(useStore.getState().sessionDetail).toMatchObject({ kind: "success", value: { session: { id: "s2" } } });
  });

  it("going back to the list closes the open Task and its stream", async () => {
    await openSessionWith([task(1)]);
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));
    await actions.openTask(1);

    await actions.openSession(null);

    expect(latest().closed).toBe(true);
    expect(useStore.getState()).toMatchObject({ sessionId: null, sessionDetail: IDLE, taskSeq: null, task: IDLE, events: [], stream: "idle" });
  });

  it("opens a Session created from the form on the New task tab", async () => {
    vi.mocked(api.createSession).mockResolvedValue(SESSION);
    vi.mocked(api.fetchSessions).mockResolvedValue([SESSION]);
    vi.mocked(api.fetchSession).mockResolvedValue(detail());
    expect(useStore.getState().workspaceTab).toBe("tasks");

    await actions.createSession();

    expect(useStore.getState().workspaceTab).toBe("new");
  });

  it.each([
    { name: "back to the list resets the tab", before: "new" as const, act: () => actions.openSession(null), expected: "tasks" },
    { name: "a prefill without a Session survives opening one", before: "tasks" as const, act: async () => { actions.prefillTask("explain"); await openSessionWith(); }, expected: "new" },
    { name: "opening a Session from the list keeps the tab", before: "tasks" as const, act: () => openSessionWith(), expected: "tasks" },
  ])("$name", async ({ before, act, expected }) => {
    useStore.setState({ workspaceTab: before });
    await act();
    expect(useStore.getState().workspaceTab).toBe(expected);
  });

  it.each([
    { search: "", workspaceOpen: false, session: null, seq: null },
    { search: "?task=2", workspaceOpen: false, session: null, seq: null },
    { search: "?session=s1", workspaceOpen: true, session: "s1", seq: null },
    { search: "?model=hm-a&session=s1&task=2", workspaceOpen: true, session: "s1", seq: 2 },
  ])("restores $search", async ({ search, workspaceOpen, session, seq }) => {
    vi.mocked(api.fetchSession).mockResolvedValue(detail([task(2)]));
    vi.mocked(api.fetchTask).mockResolvedValue(task(2));

    await actions.restoreWorkspace(search);

    expect(useStore.getState()).toMatchObject({ workspaceOpen, sessionId: session, taskSeq: seq });
  });
});

describe("starting a Task", () => {
  const INPUT: TaskInput = { type: "review", target: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" }, instruction: "look" };

  it("posts the Task to the open Session, clears the instruction and opens it", async () => {
    await openSessionWith();
    useStore.setState({ draft: { type: "review", instruction: "look", repositoryUrl: "" }, workspaceTab: "new" });
    vi.mocked(api.postTask).mockResolvedValue(task(1));
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));

    await actions.startTask(INPUT);

    expect(api.postTask).toHaveBeenCalledWith("s1", INPUT);
    expect(useStore.getState()).toMatchObject({ starting: IDLE, taskSeq: 1, workspaceTab: "tasks", draft: { instruction: "" } });
    expect(sources()).toHaveLength(1);
  });

  it("does nothing without an open Session", async () => {
    await actions.startTask(INPUT);
    expect(api.postTask).not.toHaveBeenCalled();
  });

  it("keeps a refusal because a Task is running, and refreshes the Task list", async () => {
    await openSessionWith();
    vi.mocked(api.postTask).mockRejectedValue(API_ERROR("task_running"));

    await actions.startTask(INPUT);
    await flush();

    expect(useStore.getState().starting).toEqual({ kind: "failure", error: API_ERROR("task_running") });
    expect(api.fetchSession).toHaveBeenCalledTimes(2);
    actions.updateDraft({ instruction: "x" });
    expect(useStore.getState().starting).toEqual(IDLE);
  });
});

describe("opening a Task", () => {
  beforeEach(async () => {
    await openSessionWith();
  });

  it("loads the Task and follows its events through one stream", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));

    await actions.openTask(1);

    expect(sources().map((source) => source.url)).toEqual(["/api/sessions/s1/tasks/1/events"]);
    expect(useStore.getState()).toMatchObject({ taskSeq: 1, task: { kind: "success" }, stream: "live" });
  });

  it("appends replayed and live events in order, once per animation frame", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));
    await actions.openTask(1);
    let updates = 0;
    const stop = useStore.subscribe((state, previous) => {
      if (state.events !== previous.events) updates += 1;
    });

    for (const seq of [1, 2, 3]) latest().emit("activity", event(seq));
    expect(useStore.getState().events).toEqual([]);
    runFrame();
    latest().emit("activity", event(4));
    runFrame();
    stop();

    expect(useStore.getState().events.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(updates).toBe(2);
  });

  it.each([
    { name: "a repeated sequence", frames: [[1, 2], [2, 3]], expected: [1, 2, 3] },
    { name: "an older sequence", frames: [[3], [2, 4]], expected: [3, 4] },
    { name: "a replay after a reconnect", frames: [[1, 2, 3], [1, 2, 3, 4]], expected: [1, 2, 3, 4] },
  ])("ignores $name", async ({ frames: batches, expected }) => {
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));
    await actions.openTask(1);
    for (const batch of batches) {
      for (const seq of batch) latest().emit("activity", event(seq));
      runFrame();
    }
    expect(useStore.getState().events.map((item) => item.seq)).toEqual(expected);
  });

  it("ignores frames that are not Activity events", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));
    await actions.openTask(1);
    latest().emit("activity", { nonsense: true });
    latest().emit("activity", event(1));
    runFrame();
    expect(useStore.getState().events.map((item) => item.seq)).toEqual([1]);
  });

  it.each([
    { name: "a refusal", error: API_ERROR("too_many_subscribers") },
    { name: "a connection that stayed down", error: { ...API_ERROR("network_error"), retryable: true } },
  ])("keeps $name as the reason a stream ended and closes it", async ({ error }) => {
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));
    await actions.openTask(1);
    expect(useStore.getState()).toMatchObject({ stream: "live", streamError: null });

    latest().fail(error);

    expect(useStore.getState()).toMatchObject({ stream: "error", streamError: error });
    expect(latest().closed).toBe(true);
  });

  it("ignores the end of a stream once another Task is open", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task(1));
    await actions.openTask(1);
    const first = latest();

    await actions.openTask(2);
    first.fail(API_ERROR("too_many_subscribers"));

    expect(useStore.getState()).toMatchObject({ taskSeq: 2, stream: "live", streamError: null });
  });

  it("flushes the last events, ends the stream and reloads a Task that was running", async () => {
    vi.mocked(api.fetchTask).mockResolvedValueOnce(task(1)).mockResolvedValue(doneDiffTask(1));
    vi.mocked(api.fetchDiff).mockResolvedValue(diffView());
    vi.mocked(api.fetchSession).mockResolvedValue(detail([doneDiffTask(1)]));
    await actions.openTask(1);
    latest().emit("activity", event(1));

    latest().emit("done", { status: "done" });
    await flush();

    expect(useStore.getState()).toMatchObject({ stream: "ended", task: { kind: "success", value: { status: "done" } }, diff: { kind: "success" } });
    expect(useStore.getState().events.map((item) => item.seq)).toEqual([1]);
    expect(latest().closed).toBe(true);
    expect(api.fetchTask).toHaveBeenCalledTimes(2);
  });

  it("reads the Task again when the stream ended while the first copy was loading", async () => {
    let release!: (value: Task) => void;
    vi.mocked(api.fetchTask)
      .mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
      .mockResolvedValue(doneDiffTask(1));
    vi.mocked(api.fetchDiff).mockResolvedValue(diffView());
    vi.mocked(api.fetchSession).mockResolvedValue(detail([doneDiffTask(1)]));
    const opening = actions.openTask(1);

    latest().emit("done", { status: "done" });
    await flush();
    release(task(1));
    await opening;
    await flush();

    expect(useStore.getState()).toMatchObject({ stream: "ended", task: { kind: "success", value: { status: "done" } }, diff: { kind: "success" } });
    expect(api.fetchTask).toHaveBeenCalledTimes(2);
  });

  it("loads the diff of a finished Task at once and does not reload it when the replay ends", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(doneDiffTask(1));
    vi.mocked(api.fetchDiff).mockResolvedValue(diffView());

    await actions.openTask(1);
    expect(useStore.getState().diff.kind).toBe("success");
    latest().emit("done", { status: "done" });
    await flush();

    expect(api.fetchTask).toHaveBeenCalledTimes(1);
    expect(api.fetchDiff).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "an Explain result", task: task(1, { type: "explain", status: "done", result: { kind: "explain", entity: "e", state: "Degraded", summary: "s", causes: [] } }) },
    { name: "a failed Task", task: task(1, { status: "failed", error: { code: "timeout", message: "m" } }) },
  ])("loads no diff for $name", async ({ task: finished }) => {
    vi.mocked(api.fetchTask).mockResolvedValue(finished);
    await actions.openTask(1);
    expect(api.fetchDiff).not.toHaveBeenCalled();
  });

  it("closes the stream when the selection changes and ignores what the old stream still says", async () => {
    vi.mocked(api.fetchTask).mockImplementation((_sid, seq) => Promise.resolve(task(seq)));
    await actions.openTask(1);
    const first = latest();
    first.emit("activity", event(1));

    await actions.openTask(2);
    first.emit("activity", event(2));
    first.emit("done", { status: "done" });
    runFrame();

    expect(first.closed).toBe(true);
    expect(sources()).toHaveLength(2);
    expect(useStore.getState()).toMatchObject({ taskSeq: 2, events: [], stream: "live" });
    await actions.openTask(null);
    expect(latest().closed).toBe(true);
  });

  it("shows a Task that could not be opened", async () => {
    vi.mocked(api.fetchTask).mockRejectedValue(API_ERROR("task_not_found"));
    await actions.openTask(9);
    expect(useStore.getState().task).toEqual({ kind: "failure", error: API_ERROR("task_not_found") });
  });

  it("drops a Task that arrives after another was opened", async () => {
    let release!: (value: Task) => void;
    vi.mocked(api.fetchTask).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const first = actions.openTask(1);
    vi.mocked(api.fetchTask).mockResolvedValue(task(2));
    await actions.openTask(2);

    release(task(1));
    await first;

    expect(useStore.getState().task).toMatchObject({ kind: "success", value: { seq: 2 } });
  });
});

describe("selecting changes", () => {
  beforeEach(async () => {
    await openSessionWith();
    vi.mocked(api.fetchTask).mockResolvedValue(doneDiffTask(1));
    vi.mocked(api.fetchDiff).mockResolvedValue(diffView());
    await actions.openTask(1);
  });

  it.each([
    { name: "adds a change in sorted order", run: () => { actions.toggleChange("c3"); actions.toggleChange("c1"); }, expected: ["c1", "c3"] },
    { name: "removes a ticked change", run: () => { actions.toggleChange("c1"); actions.toggleChange("c1"); }, expected: [] },
    { name: "adds a group without repeating", run: () => { actions.toggleChange("c1"); actions.selectChanges(["c1", "c2"]); }, expected: ["c1", "c2"] },
    { name: "drops a group", run: () => { actions.selectAllChanges(); actions.deselectChanges(["c2", "c1", "nope"]); }, expected: ["c3"] },
    { name: "selects all", run: () => actions.selectAllChanges(), expected: ["c1", "c2", "c3"] },
    { name: "clears", run: () => { actions.selectAllChanges(); actions.clearChanges(); }, expected: [] },
  ])("$name", ({ run, expected }) => {
    run();
    expect(useStore.getState().selectedChanges).toEqual(expected);
  });

  it.each([
    { name: "selects the changes of an entity", picks: ["svc-a"], expected: ["c1"] },
    { name: "deselects them on the second pick", picks: ["svc-a", "svc-a"], expected: [] },
    { name: "selects the changes of two entities", picks: ["svc-a", "svc-b"], expected: ["c1", "c2"] },
    { name: "ignores an entity without changes", picks: ["nobody"], expected: [] },
  ])("picking a graph node $name", ({ picks, expected }) => {
    useStore.setState({ compare: true });
    for (const name of picks) actions.activateEntity(name);
    expect(useStore.getState().selectedChanges).toEqual(expected);
  });

  describe("after an Apply wrote c1", () => {
    beforeEach(async () => {
      vi.mocked(api.fetchDiff).mockResolvedValue(
        diffView({ applies: [{ outcome: "applied", written: ["c1"], failed: null, expanded: ["c1"] }] }),
      );
      await actions.openTask(1);
    });

    it.each([
      { name: "select all skips it", run: () => actions.selectAllChanges(), expected: ["c2", "c3"] },
      { name: "a group skips it", run: () => actions.selectChanges(["c1", "c2"]), expected: ["c2"] },
      { name: "a click on it does nothing", run: () => actions.toggleChange("c1"), expected: [] },
    ])("$name", ({ run, expected }) => {
      run();
      expect(useStore.getState().selectedChanges).toEqual(expected);
    });

    it.each([
      { entity: "svc-a", message: "The changes of svc-a are applied already." },
      { entity: "nobody", message: "nobody has no changes in this Health model diff." },
    ])("a node with nothing left to pick announces it ($entity)", ({ entity, message }) => {
      useStore.setState({ compare: true });
      actions.activateEntity(entity);
      expect(useStore.getState()).toMatchObject({ selectedChanges: [], announcement: message });
    });
  });

  it("picking a graph node outside compare mode opens the entity instead", () => {
    vi.mocked(api.fetchEntityDetail).mockReturnValue(new Promise(() => {}));
    actions.activateEntity("svc-a");
    expect(useStore.getState()).toMatchObject({ selectedName: "svc-a", selectedChanges: [] });
  });

  it("starts from no selection for every Task", async () => {
    actions.selectAllChanges();
    vi.mocked(api.fetchTask).mockResolvedValue(task(2));
    await actions.openTask(2);
    expect(useStore.getState()).toMatchObject({ selectedChanges: [], compare: false, diff: IDLE, apply: IDLE });
  });

  it("switches compare mode", () => {
    actions.setCompare(true);
    expect(useStore.getState().compare).toBe(true);
  });
});

describe("applying", () => {
  const outcome = (patch: Partial<ApplyOutcome> = {}): ApplyOutcome => ({ outcome: "applied", written: ["c1"], failed: null, expanded: ["c1"], ...patch });

  beforeEach(async () => {
    await openSessionWith();
    vi.mocked(api.fetchTask).mockResolvedValue(doneDiffTask(1));
    vi.mocked(api.fetchDiff).mockResolvedValue(diffView());
    await actions.openTask(1);
    useStore.setState({ selected: MODEL });
  });

  it("applies the selection, reloads the diff and the model that is on screen", async () => {
    vi.mocked(api.postApply).mockResolvedValue(outcome({ written: ["c1", "c3"], expanded: ["c1", "c3"] }));
    vi.mocked(api.fetchHealthModel).mockReturnValue(new Promise(() => {}));
    actions.toggleChange("c1");
    actions.toggleChange("c2");

    const running = actions.applySelected();
    expect(useStore.getState().apply).toEqual(LOADING);
    await running;

    expect(api.postApply).toHaveBeenCalledWith("s1", 1, ["c1", "c2"]);
    expect(useStore.getState()).toMatchObject({ apply: { kind: "success" }, selectedChanges: ["c2"] });
    expect(api.fetchDiff).toHaveBeenCalledTimes(2);
    expect(api.fetchHealthModel).toHaveBeenCalledTimes(1);
  });

  it("leaves the model on screen alone when the Apply targeted another model", async () => {
    useStore.setState({ selected: OTHER });
    vi.mocked(api.postApply).mockResolvedValue(outcome());
    actions.toggleChange("c1");
    await actions.applySelected();
    expect(api.fetchHealthModel).not.toHaveBeenCalled();
  });

  it("reports a partial Apply with what was written and what failed", async () => {
    const failed = { changeId: "c2", code: "change_rejected", message: "Azure did not accept it." };
    vi.mocked(api.postApply).mockResolvedValue(outcome({ outcome: "partial", written: ["c1"], failed }));
    vi.mocked(api.fetchHealthModel).mockReturnValue(new Promise(() => {}));
    actions.selectAllChanges();

    await actions.applySelected();

    expect(useStore.getState().apply).toMatchObject({ kind: "success", value: { outcome: "partial", failed } });
    expect(useStore.getState().selectedChanges).toEqual(["c2", "c3"]);
  });

  it.each(["base_changed", "forbidden"])("keeps the selection and reloads nothing after %s", async (code) => {
    vi.mocked(api.postApply).mockRejectedValue(API_ERROR(code));
    actions.toggleChange("c1");

    await actions.applySelected();

    expect(useStore.getState()).toMatchObject({ apply: { kind: "failure", error: { code } }, selectedChanges: ["c1"] });
    expect(api.fetchDiff).toHaveBeenCalledTimes(1);
    expect(api.fetchHealthModel).not.toHaveBeenCalled();
  });

  it("does nothing without a selection or while an Apply runs", async () => {
    await actions.applySelected();
    actions.toggleChange("c1");
    useStore.setState({ apply: LOADING });
    await actions.applySelected();
    expect(api.postApply).not.toHaveBeenCalled();
  });

  it("clears an old outcome when the selection changes", () => {
    useStore.setState({ apply: { kind: "success", value: outcome() } });
    actions.toggleChange("c1");
    expect(useStore.getState().apply).toEqual(IDLE);
  });
});

describe("the form", () => {
  it("opens the workspace on the form with the Task type set", () => {
    actions.prefillTask("explain");
    expect(useStore.getState()).toMatchObject({ workspaceOpen: true, workspaceTab: "new", draft: { type: "explain" } });
  });

  it.each([
    { name: "keeps what else was typed", patch: { instruction: "why" }, expected: { type: "design", instruction: "why", repositoryUrl: "" } },
    { name: "sets the repository", patch: { repositoryUrl: "https://github.com/o/r" }, expected: { type: "design", instruction: "", repositoryUrl: "https://github.com/o/r" } },
  ])("$name", ({ patch, expected }) => {
    actions.prefillTask("design");
    actions.updateDraft(patch);
    expect(useStore.getState().draft).toEqual(expected);
  });

  it.each([
    { width: 100, expected: 320 },
    { width: 500.4, expected: 500 },
    { width: 4000, expected: 760 },
  ])("keeps the workspace $width px wide as $expected", ({ width, expected }) => {
    actions.setWorkspaceWidth(width);
    expect(useStore.getState().workspaceWidth).toBe(expected);
  });
});
