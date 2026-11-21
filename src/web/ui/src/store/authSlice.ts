import type { StateCreator } from "zustand";
import { createAuth, DirectoryConsentRequiredError, getAuth, setAuth, type AuthAccount, type AzureDirectory, type DirectoryDiscovery } from "../auth";
import { WorkspaceDenied } from "../auth/workspaceAccess";
import * as api from "./api";
import type { Store } from "./store";

export type AuthStatus = "starting" | "signed-out" | "signing-out" | "choose-directory" | "ready" | "failed";

export type DirectoryList =
  | { readonly status: "loading" }
  | ({ readonly status: "available" } & DirectoryDiscovery)
  | { readonly status: "error"; readonly message: string };

export interface AuthState {
  readonly authStatus: AuthStatus;
  readonly authMode: "entra" | "local" | null;
  readonly account: AuthAccount | null;
  readonly authError: string | null;
  readonly directoryList: DirectoryList;
}

export interface AuthActions {
  readonly startAuth: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly signIn: () => Promise<void>;
  readonly loadDirectories: (requestConsent?: boolean, sourceTenantId?: string) => Promise<void>;
  readonly selectDirectory: (directory: AzureDirectory) => Promise<void>;
}

function messageOf(error: unknown, fallback = "Signing in did not work."): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return fallback;
}

export const authSlice: StateCreator<Store, [], [], AuthState & AuthActions> = (set, get) => {
  let running: Promise<void> | null = null;

  const loadDirectories = async (requestConsent = false, sourceTenantId?: string): Promise<void> => {
    const auth = getAuth();
    if (get().authStatus !== "choose-directory" || !auth.listDirectories) return;
    set({ directoryList: { status: "loading" } });
    let directoryList: DirectoryList;
    try {
      if (requestConsent) {
        if (sourceTenantId) await auth.requestDirectoryDiscovery?.(sourceTenantId);
        else await auth.requestDirectoryDiscovery?.();
      }
      directoryList = { status: "available", ...await auth.listDirectories() };
    } catch (error) {
      // Selecting manually or retrying may cancel the lookup already in flight.
      if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return;
      directoryList = error instanceof DirectoryConsentRequiredError
        ? { status: "available", directories: [], consentRequired: true, ...(error.discoverySources && { discoverySources: error.discoverySources }) }
        : { status: "error", message: messageOf(error, "Azure could not return your directories.") };
    }
    if (get().authStatus === "choose-directory" && auth === getAuth()) set({ directoryList });
  };

  const start = async (): Promise<void> => {
    set({ authStatus: "starting", authMode: null, authError: null, account: null });
    try {
      const config = await api.fetchAuthConfig();
      const auth = createAuth(config);
      setAuth(auth);
      set({ authMode: config.authMode });
      const account = await auth.ready();
      if (config.authMode === "local") set({ authStatus: "ready", account });
      else if (!account) set({ authStatus: "signed-out" });
      else if (auth.needsDirectory) {
        set({ authStatus: "choose-directory", account, authError: auth.directoryError ?? null });
        await loadDirectories();
      } else set({ authStatus: "ready", account });
    } catch (error) {
      set({ authStatus: "failed", authError: messageOf(error) });
    }
  };

  return {
    authStatus: "starting",
    authMode: null,
    account: null,
    authError: null,
    directoryList: { status: "loading" },

    startAuth: () => {
      running ??= start().finally(() => {
        running = null;
      });
      return running;
    },

    signOut: async () => {
      if (get().authStatus === "signing-out") return;
      // Removing the account immediately also unmounts the workspace while Microsoft finishes the redirect.
      set({ authStatus: "signing-out", account: null, authError: null, directoryList: { status: "loading" } });
      try {
        await getAuth().signOut();
        set({ authStatus: "signed-out" });
      } catch (error) {
        set({ authStatus: "signed-out", authError: messageOf(error, "Microsoft could not finish signing you out.") });
      }
    },

    signIn: async () => {
      try {
        await getAuth().signIn();
      } catch (error) {
        if (get().authStatus === "ready") throw error;
        set({ authStatus: "failed", authError: messageOf(error) });
      }
    },

    loadDirectories,
    selectDirectory: async (directory) => {
      const auth = getAuth();
      if (get().authStatus !== "choose-directory" || !auth.selectDirectory) return;
      set({ authError: null });
      try {
        const account = await auth.selectDirectory(directory);
        if (get().authStatus === "choose-directory" && auth === getAuth()) set({ authStatus: "ready", account });
      } catch (error) {
        if (get().authStatus !== "choose-directory" || auth !== getAuth()) return;
        let directoryList = get().directoryList;
        if (directoryList.status === "available" && error instanceof WorkspaceDenied) {
          const otherDirectory = (item: AzureDirectory) => item.tenantId !== directory.tenantId;
          directoryList = {
            ...directoryList,
            directories: directoryList.directories.filter(otherDirectory),
            needsCheck: directoryList.needsCheck?.filter(otherDirectory) ?? [],
          };
        }
        set({ authError: messageOf(error), directoryList });
        if (directoryList.status === "loading") await loadDirectories();
      }
    },
  };
};
