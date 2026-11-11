import type { StateCreator } from "zustand";
import { PersonalAccountError, createAuth, getAuth, setAuth, type AuthAccount, type SignInRequest } from "../auth";
import * as api from "./api";
import type { Store } from "./store";

/**
 * `signed-out`: the app asks the user to sign in. `personal`: the user signed in with a personal account, which has no
 * Azure of its own, so the app asks for the directory it belongs to.
 */
export type AuthStatus = "starting" | "signed-out" | "personal" | "ready" | "failed";

export interface AuthState {
  readonly authStatus: AuthStatus;
  /** Known once the app has read its config; null before. */
  readonly authMode: "entra" | "local" | null;
  /** Who is signed in. Only the name the top bar shows: a token never enters the store. */
  readonly account: AuthAccount | null;
  readonly authError: string | null;
  /** The personal account that landed in no directory, to offer first when the user names one. */
  readonly personalAccount: string | null;
}

export interface AuthActions {
  /** Reads the config, then signs in when it asks for it. A sign-in that redirects never settles. Safe to call twice. */
  readonly startAuth: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Signs in by redirect, to a directory when the request names one, and again for a session the app no longer accepts. */
  readonly signIn: (request?: SignInRequest) => Promise<void>;
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return "Signing in did not work.";
}

export const authSlice: StateCreator<Store, [], [], AuthState & AuthActions> = (set, get) => {
  // A start that is running is the one a second call waits for: two sign-in redirects would collide.
  let running: Promise<void> | null = null;

  const start = async (): Promise<void> => {
    set({ authStatus: "starting", authError: null, personalAccount: null });
    try {
      const config = await api.fetchAuthConfig();
      set({ authMode: config.authMode });
      const auth = createAuth(config);
      setAuth(auth);
      const account = await auth.ready();
      set(config.authMode === "entra" && account === null ? { authStatus: "signed-out", account } : { authStatus: "ready", account });
    } catch (error) {
      if (error instanceof PersonalAccountError) set({ authStatus: "personal", personalAccount: error.username });
      else set({ authStatus: "failed", authError: messageOf(error) });
    }
  };

  return {
    authStatus: "starting",
    authMode: null,
    account: null,
    authError: null,
    personalAccount: null,

    startAuth: () => {
      running ??= start().finally(() => {
        running = null;
      });
      return running;
    },

    signOut: async () => {
      await getAuth().signOut();
    },

    // Before the app is ready a sign-in that cannot start is the sign-in page's failure; afterwards it is the caller's.
    signIn: async (request) => {
      try {
        await getAuth().signIn(request);
      } catch (error) {
        if (get().authStatus === "ready") throw error;
        set({ authStatus: "failed", authError: messageOf(error) });
      }
    },
  };
};
