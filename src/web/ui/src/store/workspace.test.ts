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
const API_ERROR = (code: string, status?: number): ApiError => ({ code, message: `message ${code}`, retryable: false, operationId: null, ...(status === undefined ? {} : { status }) });
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

describe("starting a Task with one click", () => {
  const BASE = { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" };
  const now = (): string => new Date().toISOString();
  const recent = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({ ...SESSION, id, title: id, taskCount: 1, lastTaskAt: now(), ...patch });

  /** The model on screen is `hm-a` (not necessarily the catalog default) and an entity is selected. */
  function onScreen(patch: Partial<ReturnType<typeof useStore.getState>> = {}): void {
    useStore.setState({
      selected: MODEL,
      selectedName: "svc-a",
      catalog: { kind: "success", value: { models: [MODEL, OTHER], default: { name: "hm-b", resourceGroup: "rg-a", subscriptionId: "sub-a" } } },
      model: { kind: "success", value: { entities: [{ name: "svc-a", displayName: "Service A", healthState: "Unhealthy" }] } as never },
      ...patch,
    });
  }

  beforeEach(() => {
    onScreen();
    vi.mocked(api.fetchSessions).mockResolvedValue([]);
  });

  it("puts the Task in the open Session and opens it without asking for it again", async () => {
    await openSessionWith();
    useStore.setState({ draft: { type: "review", instruction: "look", repositoryUrl: "" }, workspaceTab: "new" });
    vi.mocked(api.postTask).mockResolvedValue(task(1));

    await actions.startTask({ type: "review", instruction: "look" });

    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.postTask).toHaveBeenCalledWith("s1", { type: "review", target: BASE, instruction: "look" });
    expect(api.fetchTask).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({
      launch: { kind: "idle" },
      workspaceOpen: true,
      workspaceTab: "tasks",
      taskSeq: 1,
      task: { kind: "success", value: { seq: 1 } },
      draft: { instruction: "" },
      sessionDetail: { kind: "success", value: { session: { taskCount: 1 }, tasks: [{ seq: 1 }] } },
    });
    expect(sources()).toHaveLength(1);
  });

  it.each([
    { type: "explain" as const, title: /^Why is Service A Unhealthy\? \(\d{1,2} \w{3} \d{2}:\d{2}\)$/, target: { ...BASE, entity: "svc-a" } },
    { type: "review" as const, title: /^Check hm-a \(\d{1,2} \w{3} \d{2}:\d{2}\)$/, target: BASE },
  ])("makes a Session titled by the $type when none is open, and starts the Task in it", async ({ type, title, target }) => {
    vi.mocked(api.createSession).mockImplementation(async (name) => ({ ...SESSION, title: name ?? "" }));
    vi.mocked(api.postTask).mockResolvedValue(task(1));

    await actions.startTask({ type });

    expect(vi.mocked(api.createSession).mock.calls[0]?.[0]).toMatch(title);
    expect(api.postTask).toHaveBeenCalledWith("s1", { type, target, instruction: "" });
    expect(useStore.getState()).toMatchObject({ sessionId: "s1", taskSeq: 1, workspaceOpen: true, launch: { kind: "idle" } });
    expect(useStore.getState().sessionDetail).toMatchObject({ kind: "success", value: { tasks: [{ seq: 1 }] } });
  });

  it("starts on the model on screen, not on the catalog default", async () => {
    await openSessionWith();
    vi.mocked(api.postTask).mockResolvedValue(task(1));
    await actions.startTask({ type: "explain" });
    expect(vi.mocked(api.postTask).mock.calls[0]?.[1].target).toMatchObject({ name: "hm-a", entity: "svc-a" });
  });

  it("is busy at once: the workspace opens on what is being started before anything answers", async () => {
    let answer!: (value: Task) => void;
    await openSessionWith();
    vi.mocked(api.postTask).mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const started = actions.startTask({ type: "explain" });

    expect(useStore.getState()).toMatchObject({ workspaceOpen: true, launch: { kind: "starting", label: "Why is Service A Unhealthy?" } });
    // A second click while the first is under way starts nothing.
    await actions.startTask({ type: "explain" });
    expect(api.postTask).toHaveBeenCalledTimes(1);
    answer(task(1));
    await started;
    expect(useStore.getState().launch).toEqual({ kind: "idle" });
  });

  it.each([
    { name: "without a model on screen", patch: { selected: null }, type: "review" as const },
    { name: "without an entity", patch: { selectedName: null }, type: "explain" as const },
  ])("asks for nothing $name and says why", async ({ patch, type }) => {
    onScreen(patch);
    await actions.startTask({ type });
    expect(useStore.getState().announcement).toBeTruthy();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.postTask).not.toHaveBeenCalled();
    expect(useStore.getState().launch).toEqual({ kind: "idle" });
  });

  describe("when a Task of the user runs already", () => {
    it("says so without posting when the open Session shows it, and makes no Session", async () => {
      await openSessionWith([task(1)]);
      vi.mocked(api.fetchSession).mockResolvedValue(detail([task(1)]));

      await actions.startTask({ type: "explain" });

      expect(api.postTask).not.toHaveBeenCalled();
      expect(api.createSession).not.toHaveBeenCalled();
      expect(useStore.getState().launch).toMatchObject({ kind: "failed", error: { code: "task_running" }, running: { sessionId: "s1", seq: 1 } });
    });

    it("starts after all when the Task the open Session showed has ended since", async () => {
      await openSessionWith([task(1)]);
      vi.mocked(api.fetchSession).mockResolvedValue(detail([doneDiffTask(1)]));
      vi.mocked(api.postTask).mockResolvedValue(task(2));

      await actions.startTask({ type: "explain" });

      expect(api.postTask).toHaveBeenCalledWith("s1", expect.anything());
      expect(useStore.getState()).toMatchObject({ launch: { kind: "idle" }, taskSeq: 2 });
    });

    it("finds it in a recent Session before making a Session, so none is left empty", async () => {
      vi.mocked(api.fetchSessions).mockResolvedValue([recent("s7"), recent("s8", { lastTaskAt: "2020-01-01T00:00:00Z" })]);
      vi.mocked(api.fetchSession).mockImplementation(async (id) => ({ session: recent(id), tasks: id === "s7" ? [task(3, { sessionId: "s7" })] : [] }));

      await actions.startTask({ type: "review" });

      expect(api.createSession).not.toHaveBeenCalled();
      expect(api.postTask).not.toHaveBeenCalled();
      expect(api.fetchSession).toHaveBeenCalledTimes(1);
      expect(useStore.getState().launch).toMatchObject({ kind: "failed", running: { sessionId: "s7", seq: 3 }, made: null });
      expect(useStore.getState().sessionId).toBeNull();
    });

    it("keeps the refusal of the app for a Task started elsewhere, and finds that Task for Open it", async () => {
      await openSessionWith();
      vi.mocked(api.postTask).mockRejectedValue(API_ERROR("task_running"));
      vi.mocked(api.fetchSessions).mockResolvedValue([recent("s9")]);
      vi.mocked(api.fetchSession).mockImplementation(async (id) => ({ session: recent(id), tasks: id === "s9" ? [task(2, { sessionId: "s9" })] : [] }));

      await actions.startTask({ type: "explain" });

      expect(api.createSession).not.toHaveBeenCalled();
      expect(useStore.getState().launch).toMatchObject({ kind: "failed", step: "task", error: { code: "task_running" }, running: { sessionId: "s9", seq: 2 } });

      vi.mocked(api.fetchTask).mockResolvedValue(task(2, { sessionId: "s9" }));
      await actions.openRunningTask();
      expect(useStore.getState()).toMatchObject({ launch: { kind: "idle" }, sessionId: "s9", taskSeq: 2 });
    });
  });

  describe("when the start is refused", () => {
    it("keeps the Session it made open and empty, says so, and Try again starts in that same Session", async () => {
      vi.mocked(api.createSession).mockResolvedValue(SESSION);
      vi.mocked(api.postTask).mockRejectedValueOnce(API_ERROR("agents_busy"));

      await actions.startTask({ type: "explain" });

      expect(useStore.getState()).toMatchObject({
        sessionId: "s1",
        launch: { kind: "failed", step: "task", error: { code: "agents_busy" }, made: { id: "s1" } },
        sessionDetail: { kind: "success", value: { tasks: [] } },
      });

      // The intention is kept: it is asked again as it was, even when the selection moved on.
      useStore.setState({ selectedName: "svc-b" });
      vi.mocked(api.postTask).mockResolvedValue(task(1));
      await actions.retryStart();

      expect(api.createSession).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.postTask).mock.calls.at(-1)).toEqual(["s1", { type: "explain", target: { ...BASE, entity: "svc-a" }, instruction: "" }]);
      expect(useStore.getState()).toMatchObject({ launch: { kind: "idle" }, taskSeq: 1 });
    });

    it("makes no Task and no Session when the Session cannot be made, and keeps the intention", async () => {
      vi.mocked(api.createSession).mockRejectedValue(API_ERROR("session_limit"));

      await actions.startTask({ type: "review" });

      expect(api.postTask).not.toHaveBeenCalled();
      expect(useStore.getState()).toMatchObject({ sessionId: null, launch: { kind: "failed", step: "session", error: { code: "session_limit" }, made: null } });
    });

    it("starts in a new Session when the open one is full", async () => {
      await openSessionWith([doneDiffTask(1)]);
      vi.mocked(api.postTask).mockRejectedValueOnce(API_ERROR("task_limit")).mockResolvedValueOnce(task(1, { sessionId: "s2" }));
      vi.mocked(api.createSession).mockResolvedValue({ ...SESSION, id: "s2" });

      await actions.startTask({ type: "review" });

      expect(vi.mocked(api.postTask).mock.calls.map((call) => call[0])).toEqual(["s1", "s2"]);
      expect(useStore.getState()).toMatchObject({ sessionId: "s2", taskSeq: 1, launch: { kind: "idle" } });
    });

    it.each(["forbidden", "unauthenticated", "payload_too_large", "network_error"])("keeps %s for the notice and opens no Task", async (code) => {
      await openSessionWith();
      vi.mocked(api.postTask).mockRejectedValue(API_ERROR(code));
      await actions.startTask({ type: "review" });
      expect(useStore.getState()).toMatchObject({ launch: { kind: "failed", error: { code } }, taskSeq: null });
    });

    it("forgets the refusal when the form changes or it is dismissed", async () => {
      await openSessionWith();
      vi.mocked(api.postTask).mockRejectedValue(API_ERROR("agents_busy"));
      await actions.startTask({ type: "review" });
      actions.updateDraft({ instruction: "x" });
      expect(useStore.getState().launch).toEqual({ kind: "idle" });

      await actions.startTask({ type: "review" });
      actions.dismissLaunch();
      expect(useStore.getState().launch).toEqual({ kind: "idle" });
    });
  });

  it("starts a Task again with what it asked for, not with what is on screen", async () => {
    await openSessionWith([doneDiffTask(1)]);
    useStore.setState({ selectedName: "other" });
    vi.mocked(api.postTask).mockResolvedValue(task(2));
    const target = { name: "hm-z", resourceGroup: "rg-z", subscriptionId: "sub-z", entity: "db" };

    await actions.rerunTask({ type: "explain", target, instruction: "why" });

    expect(api.postTask).toHaveBeenCalledWith("s1", { type: "explain", target, instruction: "why" });
  });

  it("opens the Task a notice is about, in its Session", async () => {
    useStore.setState({ notice: { sessionId: "s5", seq: 4, status: "done", title: "Explanation ready", text: "t", link: "Show answer" } });
    vi.mocked(api.fetchSession).mockResolvedValue({ session: { ...SESSION, id: "s5" }, tasks: [] });
    vi.mocked(api.fetchTask).mockResolvedValue(task(4, { sessionId: "s5", status: "done" }));

    await actions.showFinished();

    expect(useStore.getState()).toMatchObject({ notice: null, workspaceOpen: true, sessionId: "s5", taskSeq: 4 });
  });

  describe("a Task the user is not looking at", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("tells when it ends after the user left it, and stops asking", async () => {
      vi.useFakeTimers();
      await openSessionWith([task(1)]);
      vi.mocked(api.fetchTask).mockResolvedValue(task(1));
      await actions.openTask(1);
      await actions.openSession(null);
      expect(useStore.getState().watching).toEqual({ sessionId: "s1", seq: 1 });

      vi.mocked(api.fetchTask).mockResolvedValueOnce(task(1)).mockResolvedValue(doneDiffTask(1));
      await vi.advanceTimersByTimeAsync(4000);
      expect(useStore.getState().notice).toBeNull();
      await vi.advanceTimersByTimeAsync(4000);

      expect(useStore.getState()).toMatchObject({ watching: null, notice: { sessionId: "s1", seq: 1, status: "done", title: "Model check ready" } });
      const calls = vi.mocked(api.fetchTask).mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(vi.mocked(api.fetchTask).mock.calls.length).toBe(calls);
    });

    it("tells when it ends with the workspace closed and the Task still open", async () => {
      await openSessionWith([task(1)]);
      vi.mocked(api.fetchTask).mockResolvedValue(task(1));
      await actions.openTask(1);
      vi.mocked(api.fetchTask).mockResolvedValue(doneDiffTask(1));
      vi.mocked(api.fetchDiff).mockResolvedValue(diffView());

      latest().emit("done", { status: "done" });
      await flush();

      expect(useStore.getState().notice).toMatchObject({ seq: 1, status: "done" });
      actions.dismissNotice();
      expect(useStore.getState().notice).toBeNull();
    });

    it("stays quiet when the workspace is open on it", async () => {
      useStore.setState({ workspaceOpen: true });
      await openSessionWith([task(1)]);
      vi.mocked(api.fetchTask).mockResolvedValue(task(1));
      await actions.openTask(1);
      vi.mocked(api.fetchTask).mockResolvedValue(doneDiffTask(1));
      vi.mocked(api.fetchDiff).mockResolvedValue(diffView());

      latest().emit("done", { status: "done" });
      await flush();

      expect(useStore.getState().notice).toBeNull();
    });
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
      { entity: "svc-a", message: "The proposed changes of svc-a are applied already." },
      { entity: "nobody", message: "nobody has no proposed changes." },
    ])("a node with nothing left to pick announces it ($entity)", ({ entity, message }) => {
      useStore.setState({ compare: true });
      actions.activateEntity(entity);
      expect(useStore.getState()).toMatchObject({ selectedChanges: [], announcement: message });
    });
  });

  it("picking a graph node outside compare mode opens the entity, and its row in the timeline, instead", () => {
    vi.mocked(api.fetchEntityDetail).mockReturnValue(new Promise(() => {}));
    actions.activateEntity("svc-a");
    expect(useStore.getState()).toMatchObject({ selectedName: "svc-a", selectedChanges: [], timelineOpen: true, timelineFocus: { name: "svc-a", key: null } });
  });

  it("picking a graph node while comparing leaves the timeline alone", () => {
    useStore.setState({ compare: true });
    actions.activateEntity("svc-a");
    expect(useStore.getState()).toMatchObject({ timelineOpen: false, timelineFocus: null });
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

  it.each([
    { code: "base_changed", status: 409 },
    { code: "forbidden", status: 403 },
    { code: "invalid_change_ids", status: 400 },
    { code: "diff_not_found", status: 404 },
  ])("keeps the selection and reloads nothing after the refusal $code, which comes before the first write", async ({ code, status }) => {
    vi.mocked(api.postApply).mockRejectedValue(API_ERROR(code, status));
    actions.toggleChange("c1");

    await actions.applySelected();

    expect(useStore.getState()).toMatchObject({ apply: { kind: "failure", error: { code } }, applyChecking: false, selectedChanges: ["c1"] });
    expect(api.fetchDiff).toHaveBeenCalledTimes(1);
    expect(api.fetchHealthModel).not.toHaveBeenCalled();
  });

  describe.each([
    { name: "no answer at all", error: API_ERROR("network_error") },
    { name: "a 502 from the proxy", error: API_ERROR("http_error", 502) },
    { name: "a 503 from the app", error: API_ERROR("health_model_unavailable", 503) },
    { name: "a 504 when the ingress gave up", error: API_ERROR("http_error", 504) },
  ])("an Apply that ends with $name", ({ error }) => {
    const wrote = diffView({ applies: [{ outcome: "applied", written: ["c1"], failed: null, expanded: ["c1"] }] });

    it("reads the proposed changes again, so what was written shows as Applied and is no longer picked, and reloads the model on screen", async () => {
      let reread!: (value: DiffView) => void;
      vi.mocked(api.postApply).mockRejectedValue(error);
      vi.mocked(api.fetchDiff).mockReturnValueOnce(new Promise((resolve) => (reread = resolve)));
      vi.mocked(api.fetchHealthModel).mockReturnValue(new Promise(() => {}));
      actions.toggleChange("c1");
      actions.toggleChange("c2");

      const running = actions.applySelected();
      await flush();
      expect(useStore.getState()).toMatchObject({ apply: { kind: "failure", error }, applyChecking: true, selectedChanges: ["c1", "c2"] });
      reread(wrote);
      await running;

      expect(useStore.getState()).toMatchObject({ apply: { kind: "failure", error }, applyChecking: false, selectedChanges: ["c2"] });
      expect(useStore.getState().diff).toEqual({ kind: "success", value: wrote });
      expect(api.fetchDiff).toHaveBeenCalledTimes(2);
      expect(api.fetchHealthModel).toHaveBeenCalledTimes(1);
    });

    it("leaves the model alone when the check finds nothing written", async () => {
      vi.mocked(api.postApply).mockRejectedValue(error);
      actions.toggleChange("c1");

      await actions.applySelected();

      expect(useStore.getState()).toMatchObject({ applyChecking: false, selectedChanges: ["c1"] });
      expect(api.fetchDiff).toHaveBeenCalledTimes(2);
      expect(api.fetchHealthModel).not.toHaveBeenCalled();
    });
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
