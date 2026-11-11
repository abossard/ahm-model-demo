import type { StateCreator } from "zustand";
import { workspaceFromSearch } from "../model/selection";
import type { AsyncState, SessionDetail, SessionSummary } from "../model/types";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";

export interface SessionsState {
  readonly sessions: AsyncState<readonly SessionSummary[]>;
  readonly sessionId: string | null;
  readonly sessionDetail: AsyncState<SessionDetail>;
  readonly creatingSession: AsyncState<SessionSummary>;
}

export interface SessionsActions {
  readonly loadSessions: () => Promise<void>;
  readonly createSession: (title?: string) => Promise<void>;
  /** Opens a Session, or the Session list when the id is null. */
  readonly openSession: (id: string | null) => Promise<void>;
  /** Opens a Session the app just made: it holds no Tasks, so there is nothing to fetch. */
  readonly enterSession: (detail: SessionDetail) => void;
  /** Reloads the open Session so its Task list shows current statuses. */
  readonly refreshSession: () => Promise<void>;
  /** Opens the Session and Task an address names. */
  readonly restoreWorkspace: (search: string) => Promise<void>;
}

export const sessionsSlice: StateCreator<Store, [], [], SessionsState & SessionsActions> = (
  set,
  get,
) => ({
  sessions: IDLE,
  sessionId: null,
  sessionDetail: IDLE,
  creatingSession: IDLE,

  loadSessions: async () => {
    if (get().sessions.kind !== "success") set({ sessions: LOADING });
    const sessions = await settle(api.fetchSessions(), "The history could not be loaded.");
    set({ sessions });
  },

  createSession: async (title) => {
    set({ creatingSession: LOADING });
    const created = await settle(api.createSession(title), "The topic could not be created.");
    set({ creatingSession: created.kind === "success" ? IDLE : created });
    if (created.kind !== "success") return;
    void get().loadSessions();
    // A Session without Tasks has nothing to list, so it opens on the form.
    set({ workspaceTab: "new" });
    await get().openSession(created.value.id);
  },

  enterSession: (detail) => {
    void get().openTask(null);
    set({ sessionId: detail.session.id, sessionDetail: { kind: "success", value: detail }, workspaceTab: "tasks" });
  },

  openSession: async (id) => {
    get().openTask(null);
    set({ sessionId: id, sessionDetail: id === null ? IDLE : LOADING });
    if (id === null) {
      set({ workspaceTab: "tasks" });
      return;
    }
    const detail = await settle(api.fetchSession(id), "The topic could not be opened.");
    if (get().sessionId === id) set({ sessionDetail: detail });
  },

  refreshSession: async () => {
    const id = get().sessionId;
    if (id === null) return;
    const detail = await settle(api.fetchSession(id), "The topic could not be opened.");
    if (get().sessionId === id && detail.kind === "success") set({ sessionDetail: detail });
  },

  restoreWorkspace: async (search) => {
    const { session, task } = workspaceFromSearch(search);
    if (session === null) return;
    set({ workspaceOpen: true });
    await get().openSession(session);
    if (task !== null) await get().openTask(task);
  },
});
