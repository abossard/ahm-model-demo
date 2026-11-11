import type { StateCreator } from "zustand";
import { parseActivityEvent } from "../model/activity";
import { changeIdsForEntity, writtenIds } from "../model/changes";
import { applyMayHaveWritten } from "../model/errors";
import { sameModel } from "../model/selection";
import {
  TASK_LIFETIME_MS,
  mayHoldRunningTask,
  planStart,
  runningIn,
  sessionTitle,
  type OpenSession,
  type RunningRef,
} from "../model/sessions";
import { buildTaskInput, inputOfTask, isUnfinished, taskTitle, type TaskDraft } from "../model/tasks";
import { TASK_KIND, proposedCount } from "../model/wording";
import type { LaunchStep } from "../model/errors";
import type {
  ActivityEvent,
  ApiError,
  ApplyOutcome,
  AsyncState,
  DiffView,
  HealthState,
  Task,
  TaskInput,
  TaskType,
} from "../model/types";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";

export type StreamStatus = "idle" | "live" | "ended" | "error";

/** A Session that one start created, so that a refusal can say what is left behind. */
export interface MadeSession {
  readonly id: string;
  readonly title: string;
}

/**
 * The one start the user is waiting for: while the Session is made and the Task posted, and what is kept when it
 * could not be done, so that Try again asks for the same thing whatever is selected by then.
 */
export type Launch =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly input: TaskInput; readonly label: string; readonly step: LaunchStep }
  | {
      readonly kind: "failed";
      readonly input: TaskInput;
      readonly label: string;
      readonly step: LaunchStep;
      readonly error: ApiError;
      /** The Session this start made, open and empty. */
      readonly made: MadeSession | null;
      /** The Task of the user that runs, when that is what refused the start. */
      readonly running: RunningRef | null;
    };

/** A Task that ended while the user was not looking at it. */
export interface FinishedNotice {
  readonly sessionId: string;
  readonly seq: number;
  readonly status: "done" | "failed";
  readonly title: string;
  readonly text: string;
  /** The words of the link that opens it: what the user will see. */
  readonly link: string;
}

const IDLE_LAUNCH: Launch = { kind: "idle" };

type Settled<T> = { readonly kind: "success"; readonly value: T } | { readonly kind: "failure"; readonly error: ApiError };

/** A request settled into its value or its error: `settle` never answers anything else. */
async function outcome<T>(request: Promise<T>, fallbackMessage: string): Promise<Settled<T>> {
  return (await settle(request, fallbackMessage)) as Settled<T>;
}
const WATCH_MS = 4000;
const TASK_RUNNING: ApiError = {
  code: "task_running",
  message: "The assistant is already working on something.",
  retryable: true,
  operationId: null,
};

export interface TasksState {
  readonly taskSeq: number | null;
  readonly task: AsyncState<Task>;
  /** The open Task's Activity timeline, appended to while the stream is live. */
  readonly events: readonly ActivityEvent[];
  readonly stream: StreamStatus;
  /** Why the stream closed, once the events endpoint was asked; null while unknown. */
  readonly streamError: ApiError | null;
  readonly diff: AsyncState<DiffView>;
  /** The changes the user ticked, a set kept as a sorted array. */
  readonly selectedChanges: readonly string[];
  readonly apply: AsyncState<ApplyOutcome>;
  /** An Apply that got no clear answer is being checked: the proposed changes are read again to see what it wrote. */
  readonly applyChecking: boolean;
  readonly compare: boolean;
  readonly draft: TaskDraft;
  readonly launch: Launch;
  /** Set when the form was opened on purpose (a Task instruction, a Design): it takes focus once, when it appears. */
  readonly focusForm: boolean;
  readonly notice: FinishedNotice | null;
  /** A Task that runs while its Session is not open: it is polled so that its end is told. */
  readonly watching: RunningRef | null;
}

export interface TasksActions {
  readonly updateDraft: (patch: Partial<TaskDraft>) => void;
  /** Opens the workspace on the form set to a Task type, for a Task instruction or the Design a form needs. */
  readonly prefillTask: (type: TaskType) => void;
  /**
   * One click, one Task: builds the request from the model and entity on screen, puts it in the open Session (or in a
   * new one, titled by what it is about, when none is open or a Task of the user does not run there) and opens it.
   */
  readonly startTask: (draft: Pick<TaskDraft, "type"> & Partial<TaskDraft>) => Promise<void>;
  /** Starts the Task again with what it asked for, not with what is on screen now. */
  readonly rerunTask: (task: Pick<Task, "type" | "target" | "workload" | "instruction">) => Promise<void>;
  /** Asks again for the start that was refused. */
  readonly retryStart: () => Promise<void>;
  readonly dismissLaunch: () => void;
  /** The form has taken the focus it was opened for. */
  readonly formFocused: () => void;
  /** Opens the Task of the user that refused the start. */
  readonly openRunningTask: () => Promise<void>;
  /** Opens the Task a notice is about. */
  readonly showFinished: () => Promise<void>;
  readonly dismissNotice: () => void;
  /** Opens a Task of the open Session, or closes the open one when the sequence is null. A Task just posted needs no fetch. */
  readonly openTask: (seq: number | null, known?: Task) => Promise<void>;
  readonly toggleChange: (id: string) => void;
  readonly selectChanges: (ids: readonly string[]) => void;
  readonly deselectChanges: (ids: readonly string[]) => void;
  readonly selectAllChanges: () => void;
  readonly clearChanges: () => void;
  readonly toggleEntityChanges: (entity: string) => void;
  readonly applySelected: () => Promise<void>;
  readonly setCompare: (on: boolean) => void;
  /** What picking an entity on the graph means: its changes while comparing, its detail and its place in the timeline otherwise. */
  readonly activateEntity: (name: string) => void;
}

interface Stream {
  handle: api.TaskStream | null;
  readonly queue: ActivityEvent[];
  frame: number | null;
  lastSeq: number;
}

function requestFrame(callback: () => void): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

function sorted(ids: Iterable<string>): readonly string[] {
  return [...new Set(ids)].sort();
}

const NO_TASK = {
  taskSeq: null,
  task: IDLE,
  events: [],
  stream: "idle",
  streamError: null,
  diff: IDLE,
  selectedChanges: [],
  apply: IDLE,
  applyChecking: false,
  compare: false,
  chainNames: [],
} as const;

export const tasksSlice: StateCreator<Store, [], [], TasksState & TasksActions> = (set, get) => {
  // The one stream of the open Task. It lives here so that every selection change closes it.
  let stream: Stream | null = null;

  const closeStream = (): void => {
    if (stream === null) return;
    if (stream.frame !== null) cancelFrame(stream.frame);
    stream.handle?.close();
    stream = null;
  };

  // Events of a burst are collected and appended once per animation frame.
  const flush = (current: Stream): void => {
    current.frame = null;
    if (stream !== current || current.queue.length === 0) return;
    const batch = current.queue.splice(0);
    set((state) => ({ events: [...state.events, ...batch] }));
  };

  const isOpen = (sid: string, seq: number): boolean =>
    get().sessionId === sid && get().taskSeq === seq;

  // What an earlier Apply wrote is in the live model already, so it is never picked again.
  const pickable = (ids: readonly string[]): readonly string[] => {
    const { diff } = get();
    if (diff.kind !== "success") return ids;
    const written = writtenIds(diff.value.applies);
    return ids.filter((id) => !written.has(id));
  };

  const loadDiff = async (sid: string, seq: number, keepCurrent: boolean): Promise<void> => {
    if (!keepCurrent) set({ diff: LOADING });
    const diff = await settle(api.fetchDiff(sid, seq), "The proposed changes could not be loaded.");
    if (!isOpen(sid, seq)) return;
    if (!keepCurrent || diff.kind === "success") set({ diff });
  };

  /** What an Apply that got no clear answer wrote is in the history of the proposed changes: read it, and what was written shows as Applied. */
  const checkApply = async (sid: string, seq: number, before: DiffView): Promise<void> => {
    set({ applyChecking: true });
    await loadDiff(sid, seq, true);
    if (!isOpen(sid, seq)) return;
    const { diff, selected } = get();
    const written = diff.kind === "success" ? writtenIds(diff.value.applies) : new Set<string>();
    set((state) => ({ applyChecking: false, selectedChanges: state.selectedChanges.filter((id) => !written.has(id)) }));
    if (diff.kind === "success" && diff.value.applies.length > before.applies.length && selected && sameModel(diff.value.target, selected)) void get().loadHealthModel();
  };

  const loadDiffOf = async (task: Task): Promise<void> => {
    if (task.status === "done" && task.result?.kind === "diff") {
      await loadDiff(task.sessionId, task.seq, false);
    }
  };

  const finish = async (sid: string, seq: number): Promise<void> => {
    const known = get().task;
    // A Task still loading is read after the stream ended anyway; one that finished needs no reload.
    if (known.kind !== "success" || !isUnfinished(known.value.status)) return;
    const task = await settle(api.fetchTask(sid, seq), "The question could not be loaded.");
    if (!isOpen(sid, seq)) return;
    set({ task });
    void get().refreshSession();
    if (task.kind !== "success") return;
    // With the workspace closed nobody sees the result open by itself, so the user is told.
    if (!get().workspaceOpen) notify(task.value);
    await loadDiffOf(task.value);
  };

  const entityLabelOf = (name: string | undefined): string | null => {
    const { model } = get();
    return name === undefined || model.kind !== "success"
      ? (name ?? null)
      : (model.value.entities.find((entity) => entity.name === name)?.displayName ?? name);
  };

  // The state the entity has now, which is the one the user asks about.
  const stateOf = (name: string | undefined): HealthState | null => {
    const { model } = get();
    if (name === undefined || model.kind !== "success") return null;
    return model.value.entities.find((entity) => entity.name === name)?.healthState ?? null;
  };

  const notify = (task: Task): void => {
    const title = task.status === "failed" ? "The assistant could not finish" : `${TASK_KIND[task.type]} ready`;
    const { result } = task;
    const text =
      task.status === "failed"
        ? (task.error?.message ?? "It stopped without an answer.")
        : result?.kind === "explain"
          ? `${entityLabelOf(task.target.entity) ?? result.entity} is ${result.state}.`
          : result?.kind === "diff"
            ? `${proposedCount(result.changes.length)}.`
            : "The result is ready.";
    const link = task.status === "failed" ? "Show details" : result?.kind === "diff" ? "Show proposed changes" : "Show answer";
    set({ notice: { sessionId: task.sessionId, seq: task.seq, status: task.status === "failed" ? "failed" : "done", title, text, link } });
  };

  // A Task the user left while it ran has no stream, so it is asked for until it ends.
  const watch = (sid: string, seq: number): void => {
    const ref = { sessionId: sid, seq };
    const until = Date.now() + TASK_LIFETIME_MS;
    const stillWatched = (): boolean => get().watching?.sessionId === sid && get().watching?.seq === seq;
    const poll = async (): Promise<void> => {
      if (!stillWatched()) return;
      const task = await settle(api.fetchTask(sid, seq), "The question could not be loaded.");
      if (!stillWatched()) return;
      if (task.kind === "success" && !isUnfinished(task.value.status)) {
        set({ watching: null });
        if (get().sessionId === sid) void get().refreshSession();
        notify(task.value);
        return;
      }
      if (Date.now() < until) setTimeout(() => void poll(), WATCH_MS);
      else set({ watching: null });
    };
    set({ watching: ref });
    setTimeout(() => void poll(), WATCH_MS);
  };

  const openSessionOf = (): OpenSession | null => {
    const { sessionId, sessionDetail } = get();
    if (sessionId === null || sessionDetail.kind === "failure") return null;
    return { id: sessionId, tasks: sessionDetail.kind === "success" ? sessionDetail.value.tasks : null };
  };

  // The Session list says which Sessions saw a Task lately; only those are asked what runs in them.
  const findRunning = async (): Promise<RunningRef | null> => {
    const listed = await settle(api.fetchSessions(), "The history could not be loaded.");
    if (listed.kind !== "success") return null;
    set({ sessions: listed });
    const details = await Promise.all(
      mayHoldRunningTask(listed.value, Date.now()).map((session) => settle(api.fetchSession(session.id), "The topic could not be opened.")),
    );
    for (const detail of details) {
      const running = detail.kind === "success" ? runningIn(detail.value.tasks) : undefined;
      if (detail.kind === "success" && running) return { sessionId: detail.value.session.id, seq: running.seq };
    }
    return null;
  };

  const openStream = (sid: string, seq: number): void => {
    const current: Stream = { handle: null, queue: [], frame: null, lastSeq: 0 };
    stream = current;
    set({ stream: "live", streamError: null });
    // The stream reconnects by itself and resumes where it stopped; only the end of it reaches here.
    current.handle = api.openTaskEvents(sid, seq, {
      onActivity: (data) => {
        if (stream !== current) return;
        const event = parseActivityEvent(data);
        if (event === null || event.seq <= current.lastSeq) return;
        current.lastSeq = event.seq;
        current.queue.push(event);
        current.frame ??= requestFrame(() => flush(current));
      },
      onDone: () => {
        if (stream !== current) return;
        if (current.frame !== null) cancelFrame(current.frame);
        flush(current);
        closeStream();
        set({ stream: "ended" });
        void finish(sid, seq);
      },
      onFailure: (error) => {
        if (stream !== current) return;
        closeStream();
        set({ stream: "error", streamError: error });
      },
    });
  };

  // Every part of one start that the user can see goes through here, so a refusal always leaves the same things behind.
  const run = async (input: TaskInput): Promise<void> => {
    if (get().launch.kind === "starting") return;
    const entityLabel = entityLabelOf(input.target.entity);
    const entityState = stateOf(input.target.entity);
    const label = taskTitle(input, entityLabel, entityState);
    const refuse = (
      step: LaunchStep,
      error: ApiError,
      made: MadeSession | null = null,
      running: RunningRef | null = null,
    ): void => {
      set({ launch: { kind: "failed", input, label, step, error, made, running } });
    };
    // The workspace opens at once on what is being done, so the click is never dead.
    set({ launch: { kind: "starting", input, label, step: get().sessionId === null ? "session" : "task" }, workspaceOpen: true });

    let open = openSessionOf();
    // The open Session may still show a Task that has ended since: ask again before saying one runs.
    if (open?.tasks && runningIn(open.tasks)) {
      await get().refreshSession();
      open = openSessionOf();
    }
    let plan = planStart(open, null);
    if (plan.kind === "create") plan = planStart(null, await findRunning());
    if (plan.kind === "blocked") return refuse("task", TASK_RUNNING, null, plan.running);

    const where: { sid: string; made: MadeSession | null } = { sid: plan.kind === "use" ? plan.sessionId : "", made: null };
    const makeSession = async (): Promise<boolean> => {
      set({ launch: { kind: "starting", input, label, step: "session" } });
      const created = await outcome(api.createSession(sessionTitle(input, entityLabel, entityState, new Date())), "The topic could not be created.");
      if (created.kind === "failure") {
        refuse("session", created.error);
        return false;
      }
      // A Session that was just made has no Tasks, so there is nothing to fetch.
      get().enterSession({ session: created.value, tasks: [] });
      void get().loadSessions();
      where.sid = created.value.id;
      where.made = { id: created.value.id, title: created.value.title };
      return true;
    };
    if (plan.kind === "create" && !(await makeSession())) return;

    set({ launch: { kind: "starting", input, label, step: "task" } });
    let posted = await outcome(api.postTask(where.sid, input), "The question could not be asked.");
    // A full Session is no reason to stop: the Task goes into a new one, which is what the user would do next.
    if (posted.kind === "failure" && posted.error.code === "task_limit" && where.made === null) {
      if (!(await makeSession())) return;
      set({ launch: { kind: "starting", input, label, step: "task" } });
      posted = await outcome(api.postTask(where.sid, input), "The question could not be asked.");
    }
    if (posted.kind === "failure") {
      const running = posted.error.code === "task_running" ? await findRunning() : null;
      return refuse("task", posted.error, where.made, running);
    }

    const task = posted.value;
    set((state) => ({ launch: IDLE_LAUNCH, workspaceTab: "tasks", draft: { ...state.draft, instruction: "" } }));
    // The user may have moved to another Session while it was posted: the Task is what they asked to see.
    if (get().sessionId !== where.sid) await get().openSession(where.sid);
    const { sessionDetail } = get();
    if (sessionDetail.kind === "success" && !sessionDetail.value.tasks.some((item) => item.seq === task.seq)) {
      const { result: _result, ...summary } = task;
      const session = { ...sessionDetail.value.session, taskCount: sessionDetail.value.tasks.length + 1, lastTaskAt: task.createdAt };
      set({ sessionDetail: { kind: "success", value: { session, tasks: [...sessionDetail.value.tasks, summary] } } });
    }
    await get().openTask(task.seq, task);
  };

  return {
    ...NO_TASK,
    draft: { type: "review", instruction: "", repositoryUrl: "" },
    launch: IDLE_LAUNCH,
    focusForm: false,
    notice: null,
    watching: null,

    updateDraft: (patch) =>
      set((state) => ({
        draft: { ...state.draft, ...patch },
        launch: state.launch.kind === "failed" ? IDLE_LAUNCH : state.launch,
      })),

    prefillTask: (type) => {
      set((state) => ({
        draft: { ...state.draft, type },
        workspaceOpen: true,
        workspaceTab: "new",
        focusForm: true,
        launch: state.launch.kind === "failed" ? IDLE_LAUNCH : state.launch,
      }));
      // An open Task would hide the form, and the form is what was asked for.
      void get().openTask(null);
    },

    startTask: async (draft) => {
      const { selected, selectedName, catalog } = get();
      const ready = buildTaskInput(
        { instruction: "", repositoryUrl: "", ...draft },
        { selected, entity: selectedName, catalog: catalog.kind === "success" ? catalog.value : null },
      );
      if (ready.input === null) {
        get().announce(ready.problem);
        return;
      }
      await run(ready.input);
    },

    rerunTask: (task) => run(inputOfTask(task)),

    retryStart: async () => {
      const { launch } = get();
      if (launch.kind === "failed") await run(launch.input);
    },

    dismissLaunch: () => set({ launch: IDLE_LAUNCH }),

    formFocused: () => set({ focusForm: false }),

    openRunningTask: async () => {
      const { launch } = get();
      if (launch.kind !== "failed" || launch.running === null) return;
      const { sessionId, seq } = launch.running;
      set({ launch: IDLE_LAUNCH, workspaceOpen: true, workspaceTab: "tasks" });
      if (get().sessionId !== sessionId) await get().openSession(sessionId);
      if (get().taskSeq !== seq) await get().openTask(seq);
    },

    showFinished: async () => {
      const { notice } = get();
      if (notice === null) return;
      set({ notice: null, workspaceOpen: true, workspaceTab: "tasks" });
      if (get().sessionId !== notice.sessionId) await get().openSession(notice.sessionId);
      if (get().taskSeq !== notice.seq) await get().openTask(notice.seq);
    },

    dismissNotice: () => set({ notice: null }),

    openTask: async (seq, known) => {
      const leaving = get();
      // The Task the user turns away from keeps running; its end is told when they are not looking.
      if (
        leaving.taskSeq !== null &&
        leaving.taskSeq !== seq &&
        leaving.sessionId !== null &&
        leaving.task.kind === "success" &&
        isUnfinished(leaving.task.value.status)
      ) {
        watch(leaving.sessionId, leaving.taskSeq);
      }
      closeStream();
      const sid = get().sessionId;
      set((state) => ({
        ...NO_TASK,
        taskSeq: seq,
        task: seq === null ? IDLE : known ? { kind: "success", value: known } : LOADING,
        watching: state.watching?.sessionId === sid && state.watching?.seq === seq ? null : state.watching,
        notice: state.notice?.sessionId === sid && state.notice?.seq === seq ? null : state.notice,
      }));
      if (seq === null || sid === null) return;
      openStream(sid, seq);
      const task: AsyncState<Task> = known
        ? { kind: "success", value: known }
        : await settle(api.fetchTask(sid, seq), "The question could not be opened.");
      if (!isOpen(sid, seq)) return;
      set({ task });
      if (task.kind !== "success") return;
      // The stream may have ended while the Task loaded, and then the copy read first is out of date.
      if (isUnfinished(task.value.status) && get().stream === "ended") {
        await finish(sid, seq);
        return;
      }
      await loadDiffOf(task.value);
    },

    toggleChange: (id) =>
      set((state) => ({
        selectedChanges: state.selectedChanges.includes(id)
          ? state.selectedChanges.filter((item) => item !== id)
          : sorted([...state.selectedChanges, ...pickable([id])]),
        apply: IDLE,
      })),

    selectChanges: (ids) =>
      set((state) => ({ selectedChanges: sorted([...state.selectedChanges, ...pickable(ids)]), apply: IDLE })),

    deselectChanges: (ids) => {
      const dropped = new Set(ids);
      set((state) => ({ selectedChanges: state.selectedChanges.filter((id) => !dropped.has(id)), apply: IDLE }));
    },

    selectAllChanges: () => {
      const { diff } = get();
      if (diff.kind === "success") {
        set({ selectedChanges: sorted(pickable(diff.value.changes.map((change) => change.id))), apply: IDLE });
      }
    },

    clearChanges: () => set({ selectedChanges: [], apply: IDLE }),

    toggleEntityChanges: (entity) => {
      const { diff, selectedChanges } = get();
      if (diff.kind !== "success") return;
      const owned = changeIdsForEntity(diff.value.changes, entity);
      const ids = pickable(owned);
      if (ids.length === 0) {
        get().announce(
          owned.length === 0
            ? `${entity} has no proposed changes.`
            : `The proposed changes of ${entity} are applied already.`,
        );
        return;
      }
      const chosen = new Set(selectedChanges);
      const all = ids.every((id) => chosen.has(id));
      for (const id of ids) {
        if (all) chosen.delete(id);
        else chosen.add(id);
      }
      set({ selectedChanges: sorted(chosen), apply: IDLE });
      get().announce(`${all ? "Deselected" : "Selected"} ${ids.length} changes of ${entity}.`);
    },

    applySelected: async () => {
      const { sessionId, taskSeq, selectedChanges, diff, apply } = get();
      if (sessionId === null || taskSeq === null || diff.kind !== "success") return;
      if (selectedChanges.length === 0 || apply.kind === "loading") return;
      set({ apply: LOADING });
      const outcome = await settle(
        api.postApply(sessionId, taskSeq, selectedChanges),
        "The changes could not be applied.",
      );
      if (!isOpen(sessionId, taskSeq)) return;
      set({ apply: outcome });
      if (outcome.kind !== "success") {
        if (outcome.kind === "failure" && applyMayHaveWritten(outcome.error)) await checkApply(sessionId, taskSeq, diff.value);
        return;
      }
      const written = new Set(outcome.value.written);
      set((state) => ({ selectedChanges: state.selectedChanges.filter((id) => !written.has(id)) }));
      await loadDiff(sessionId, taskSeq, true);
      // What was written changes the model that may be on screen, so show it.
      const { selected } = get();
      if (written.size > 0 && selected && sameModel(diff.value.target, selected)) void get().loadHealthModel();
    },

    setCompare: (compare) => set({ compare }),

    activateEntity: (name) => {
      if (get().compare && get().diff.kind === "success") get().toggleEntityChanges(name);
      else {
        get().showInTimeline(name);
        void get().selectEntity(name);
      }
    },
  };
};
