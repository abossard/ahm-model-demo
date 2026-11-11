import type { StateCreator } from "zustand";
import { createAuth, getAuth, setAuth, type AuthAccount } from "../auth";
import * as api from "./api";
import type { Store } from "./store";

export type AuthStatus = "starting" | "ready" | "failed";

export interface AuthState {
  readonly authStatus: AuthStatus;
  /** Known once the app has read its config; null before. */
  readonly authMode: "entra" | "local" | null;
  /** Who is signed in. Only the name the top bar shows: a token never enters the store. */
  readonly account: AuthAccount | null;
  readonly authError: string | null;
}

export interface AuthActions {
  /** Reads the config, then signs in when it asks for it. A sign-in that redirects never settles. Safe to call twice. */
  readonly startAuth: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Signs in again by redirect, for a session the app no longer accepts. */
  readonly signIn: () => Promise<void>;
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return "Signing in did not work.";
}

export const authSlice: StateCreator<Store, [], [], AuthState & AuthActions> = (set) => {
  // A start that is running is the one a second call waits for: two sign-in redirects would collide.
  let running: Promise<void> | null = null;

  const start = async (): Promise<void> => {
    set({ authStatus: "starting", authError: null });
    try {
      const config = await api.fetchAuthConfig();
      set({ authMode: config.authMode });
      const auth = createAuth(config);
      setAuth(auth);
      const account = await auth.ready();
      set({ authStatus: "ready", account });
    } catch (error) {
      set({ authStatus: "failed", authError: messageOf(error) });
    }
  };

  return {
    authStatus: "starting",
    authMode: null,
    account: null,
    authError: null,

    startAuth: () => {
      running ??= start().finally(() => {
        running = null;
      });
      return running;
    },

    signOut: async () => {
      await getAuth().signOut();
    },

    signIn: async () => {
      await getAuth().signIn();
    },
  };
};
