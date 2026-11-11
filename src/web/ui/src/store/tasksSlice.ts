import type { StateCreator } from "zustand";
import { parseActivityEvent } from "../model/activity";
import { changeIdsForEntity, writtenIds } from "../model/changes";
import { sameModel } from "../model/selection";
import { isUnfinished, type TaskDraft } from "../model/tasks";
import type {
  ActivityEvent,
  ApiError,
  ApplyOutcome,
  AsyncState,
  DiffView,
  Task,
  TaskInput,
  TaskType,
} from "../model/types";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";

export type StreamStatus = "idle" | "live" | "ended" | "error";

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
  readonly compare: boolean;
  readonly draft: TaskDraft;
  readonly starting: AsyncState<Task>;
}

export interface TasksActions {
  readonly updateDraft: (patch: Partial<TaskDraft>) => void;
  /** Opens the workspace with the form set to a Task type. */
  readonly prefillTask: (type: TaskType) => void;
  readonly startTask: (input: TaskInput) => Promise<void>;
  /** Opens a Task of the open Session, or closes the open one when the sequence is null. */
  readonly openTask: (seq: number | null) => Promise<void>;
  readonly toggleChange: (id: string) => void;
  readonly selectChanges: (ids: readonly string[]) => void;
  readonly deselectChanges: (ids: readonly string[]) => void;
  readonly selectAllChanges: () => void;
  readonly clearChanges: () => void;
  readonly toggleEntityChanges: (entity: string) => void;
  readonly applySelected: () => Promise<void>;
  readonly setCompare: (on: boolean) => void;
  /** What picking an entity on the graph means: its changes while comparing, its detail otherwise. */
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
    const diff = await settle(api.fetchDiff(sid, seq), "The Health model diff could not be loaded.");
    if (!isOpen(sid, seq)) return;
    if (!keepCurrent || diff.kind === "success") set({ diff });
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
    const task = await settle(api.fetchTask(sid, seq), "The Task could not be loaded.");
    if (!isOpen(sid, seq)) return;
    set({ task });
    void get().refreshSession();
    if (task.kind === "success") await loadDiffOf(task.value);
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

  return {
    ...NO_TASK,
    draft: { type: "review", instruction: "", repositoryUrl: "" },
    starting: IDLE,

    updateDraft: (patch) =>
      set((state) => ({
        draft: { ...state.draft, ...patch },
        starting: state.starting.kind === "failure" ? IDLE : state.starting,
      })),

    prefillTask: (type) =>
      set((state) => ({ draft: { ...state.draft, type }, workspaceOpen: true, workspaceTab: "new" })),

    startTask: async (input) => {
      const sid = get().sessionId;
      if (sid === null) return;
      set({ starting: LOADING });
      const created = await settle(api.postTask(sid, input), "The Task could not be started.");
      if (get().sessionId !== sid) return;
      if (created.kind !== "success") {
        set({ starting: created });
        if (created.kind === "failure" && created.error.code === "task_running") void get().refreshSession();
        return;
      }
      // The form did its work, so the way back from the new Task leads to the Task list it joined.
      set((state) => ({ starting: IDLE, workspaceTab: "tasks", draft: { ...state.draft, instruction: "" } }));
      void get().refreshSession();
      await get().openTask(created.value.seq);
    },

    openTask: async (seq) => {
      closeStream();
      set({ ...NO_TASK, taskSeq: seq, task: seq === null ? IDLE : LOADING });
      const sid = get().sessionId;
      if (seq === null || sid === null) return;
      openStream(sid, seq);
      const task = await settle(api.fetchTask(sid, seq), "The Task could not be opened.");
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
            ? `${entity} has no changes in this Health model diff.`
            : `The changes of ${entity} are applied already.`,
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
      if (outcome.kind !== "success") return;
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
      else void get().selectEntity(name);
    },
  };
};
