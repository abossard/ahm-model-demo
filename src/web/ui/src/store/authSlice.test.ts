import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryConsentRequiredError, type Auth, type AuthAccount } from "../auth";
import { WorkspaceDenied } from "../auth/workspaceAccess";
import type { AuthConfig } from "../model/types";
import * as api from "./api";
import { actions, useStore } from "./store";

vi.mock("./api");

const created = vi.hoisted(() => ({ auth: null as unknown, config: null as unknown, installed: null as unknown }));

vi.mock("../auth", async () => {
  const real = await vi.importActual<typeof import("../auth")>("../auth");
  return {
    ...real,
    createAuth: (config: unknown) => {
      created.config = config;
      if (created.auth === null) throw new Error("The app's sign-in settings are incomplete: client or API scope is missing.");
      return created.auth;
    },
    setAuth: (auth: unknown) => { created.installed = auth; },
    getAuth: () => created.auth,
  };
});

const ENTRA: AuthConfig = { authMode: "entra", clientId: "c", apiScope: "api://c/access_as_user" };
const LOCAL: AuthConfig = { authMode: "local", clientId: null, apiScope: null };
const ADA: AuthAccount = { name: "Ada Lovelace", username: "ada@contoso.com", tenantId: "home" };
const GUEST_DIRECTORY = { displayName: "Fabrikam", tenantId: "guest", defaultDomain: "fabrikam.test" };
const GUEST: AuthAccount = { ...ADA, tenantName: GUEST_DIRECTORY.displayName, tenantId: GUEST_DIRECTORY.tenantId };

function installAuth(overrides: Partial<Auth> = {}) {
  const auth: Auth = {
    ready: vi.fn().mockResolvedValue(ADA), account: null, needsDirectory: true,
    listDirectories: vi.fn().mockResolvedValue({ directories: [GUEST_DIRECTORY] }),
    selectDirectory: vi.fn().mockResolvedValue(GUEST), requestDirectoryDiscovery: vi.fn(),
    getToken: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), ...overrides,
  };
  created.auth = auth;
  return auth;
}

beforeEach(() => {
  vi.resetAllMocks();
  created.auth = null;
  created.config = null;
  created.installed = null;
  useStore.setState(useStore.getInitialState(), true);
  vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA);
});

describe("startAuth", () => {
  it.each([
    { name: "local development", config: LOCAL, account: null, needsDirectory: false, status: "ready" },
    { name: "signed out", config: ENTRA, account: null, needsDirectory: true, status: "signed-out" },
    { name: "restored tenant session", config: ENTRA, account: GUEST, needsDirectory: false, status: "ready" },
  ] as const)("opens the correct page for $name without looking up directories", async ({ config, account, needsDirectory, status }) => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(config);
    const auth = installAuth({ ready: vi.fn().mockResolvedValue(account), needsDirectory });
    await actions.startAuth();
    expect(created.config).toEqual(config);
    expect(created.installed).toBe(auth);
    expect(useStore.getState()).toMatchObject({ authStatus: status, authMode: config.authMode, account, authError: null });
    expect(auth.listDirectories).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it.each([
    { name: "member", account: ADA, error: null },
    { name: "personal account with a guest membership", account: { ...ADA, username: "ada@outlook.com" }, error: null },
    { name: "directory consent declined on redirect", account: ADA, error: "AADSTS65001: consent declined" },
  ])("asks for a choice after sign-in for a $name", async ({ account, error }) => {
    const auth = installAuth({ ready: vi.fn().mockResolvedValue(account), directoryError: error });
    await actions.startAuth();
    expect(useStore.getState()).toMatchObject({
      authStatus: "choose-directory", account, authError: error,
      directoryList: { status: "available", directories: [GUEST_DIRECTORY] },
    });
    expect(auth.selectDirectory).not.toHaveBeenCalled();
    expect(auth.getToken).not.toHaveBeenCalled();
  });

  it.each([
    { name: "config lookup", setup: () => vi.mocked(api.fetchAuthConfig).mockRejectedValue({ message: "Failed to fetch" }), mode: null, message: "Failed to fetch" },
    { name: "incomplete configuration", setup: () => vi.mocked(api.fetchAuthConfig).mockResolvedValue({ ...ENTRA, clientId: null }), mode: null, message: "sign-in settings are incomplete" },
    { name: "rejected login", setup: () => installAuth({ ready: vi.fn().mockRejectedValue(new Error("AADSTS50105: not assigned")) }), mode: "entra", message: "AADSTS50105" },
    { name: "unknown login error", setup: () => installAuth({ ready: vi.fn().mockRejectedValue(new Error("")) }), mode: "entra", message: "Signing in did not work." },
  ])("allows retry after $name", async ({ setup, mode, message }) => {
    setup();
    await actions.startAuth();
    expect(useStore.getState()).toMatchObject({ authStatus: "failed", authMode: mode, account: null });
    expect(useStore.getState().authError).toContain(message);
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(LOCAL);
    installAuth({ ready: vi.fn().mockResolvedValue(null) });
    await actions.startAuth();
    expect(useStore.getState()).toMatchObject({ authStatus: "ready", authError: null });
  });

  it("starts once when mounted twice", async () => {
    const auth = installAuth();
    await Promise.all([actions.startAuth(), actions.startAuth(), actions.startAuth()]);
    expect(api.fetchAuthConfig).toHaveBeenCalledTimes(1);
    expect(auth.ready).toHaveBeenCalledTimes(1);
    expect(auth.listDirectories).toHaveBeenCalledTimes(1);
  });

  it("keeps tokens out of the store", async () => {
    installAuth();
    await actions.startAuth();
    expect(JSON.stringify(useStore.getState())).not.toMatch(/token|bearer/i);
  });
});

describe("choosing a directory", () => {
  it.each([
    { error: new DirectoryConsentRequiredError(), expected: { status: "available", directories: [], consentRequired: true }, requestConsent: true },
    { error: new Error("Azure unavailable"), expected: { status: "error", message: "Azure unavailable" }, requestConsent: false },
  ])("allows recovery from $expected.status without signing in again", async ({ error, expected, requestConsent }) => {
    const listDirectories = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ directories: [GUEST_DIRECTORY] });
    const auth = installAuth({ listDirectories });
    await actions.startAuth();
    expect(useStore.getState()).toMatchObject({ authStatus: "choose-directory", directoryList: expected });
    expect(auth.requestDirectoryDiscovery).not.toHaveBeenCalled();
    await actions.loadDirectories(requestConsent);
    expect(auth.requestDirectoryDiscovery).toHaveBeenCalledTimes(Number(requestConsent));
    if (requestConsent) expect(auth.requestDirectoryDiscovery).toHaveBeenCalledWith();
    expect(useStore.getState()).toMatchObject({ authStatus: "choose-directory", directoryList: { status: "available", directories: [GUEST_DIRECTORY] } });
  });

  it.each(["guest", "home"])("uses the chosen %s directory to look up memberships without opening a workspace", async sourceTenantId => {
    const discoverySources = [
      { tenantId: "guest", displayName: "App directory" },
      { tenantId: "home", displayName: "Sign-in directory" },
    ];
    const listDirectories = vi.fn().mockRejectedValueOnce(new DirectoryConsentRequiredError(discoverySources))
      .mockResolvedValue({ directories: [GUEST_DIRECTORY] });
    const auth = installAuth({ listDirectories });
    await actions.startAuth();
    expect(useStore.getState().directoryList).toEqual({ status: "available", directories: [], consentRequired: true, discoverySources });
    await actions.loadDirectories(true, sourceTenantId);
    expect(auth.requestDirectoryDiscovery).toHaveBeenCalledWith(sourceTenantId);
    expect(auth.selectDirectory).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({ authStatus: "choose-directory", account: ADA, directoryList: { directories: [GUEST_DIRECTORY] } });
  });

  it.each([
    { incomplete: true },
    { consentRequired: true },
    { incomplete: true, consentRequired: true },
  ])("offers verified results from an incomplete search without a redirect: %j", async (coverage) => {
    const result = { directories: [GUEST_DIRECTORY], ...coverage };
    const auth = installAuth({ listDirectories: vi.fn().mockResolvedValue(result) });
    await actions.startAuth();
    expect(useStore.getState()).toMatchObject({ authStatus: "choose-directory", directoryList: { status: "available", ...result } });
    expect(auth.requestDirectoryDiscovery).not.toHaveBeenCalled();
    expect(auth.selectDirectory).not.toHaveBeenCalled();
  });

  it("enters the checked directory only after an explicit selection and locks further changes", async () => {
    const auth = installAuth();
    await actions.startAuth();
    await actions.selectDirectory(GUEST_DIRECTORY);
    expect(auth.selectDirectory).toHaveBeenCalledWith(GUEST_DIRECTORY);
    expect(useStore.getState()).toMatchObject({ authStatus: "ready", account: GUEST, authError: null });
    await actions.selectDirectory({ tenantId: "home", displayName: "Contoso" });
    await actions.loadDirectories(true);
    expect(auth.selectDirectory).toHaveBeenCalledTimes(1);
    expect(auth.requestDirectoryDiscovery).not.toHaveBeenCalled();
  });

  it("resumes an interrupted lookup if a manual selection fails", async () => {
    let cancel!: (error: Error) => void;
    const pendingLookup = new Promise<never>((_, reject) => { cancel = reject; });
    const listDirectories = vi.fn().mockReturnValueOnce(pendingLookup).mockResolvedValue({ directories: [GUEST_DIRECTORY] });
    installAuth({ listDirectories, selectDirectory: async () => {
      cancel(new DOMException("Selection started", "AbortError"));
      throw new Error("Directory unavailable");
    } });
    const started = actions.startAuth();
    await vi.waitFor(() => expect(listDirectories).toHaveBeenCalledTimes(1));
    await actions.selectDirectory(GUEST_DIRECTORY);
    await started;
    expect(useStore.getState()).toMatchObject({
      authStatus: "choose-directory", authError: "Directory unavailable",
      directoryList: { status: "available", directories: [GUEST_DIRECTORY] },
    });
  });

  it("keeps the chooser usable when the selected directory denies access", async () => {
    const selectDirectory = vi.fn().mockRejectedValueOnce(new Error("Access denied")).mockResolvedValue(GUEST);
    installAuth({ selectDirectory });
    await actions.startAuth();
    await actions.selectDirectory({ tenantId: "rejected", displayName: "Rejected" });
    expect(useStore.getState()).toMatchObject({ authStatus: "choose-directory", account: ADA, authError: "Access denied" });
    await actions.selectDirectory(GUEST_DIRECTORY);
    expect(useStore.getState()).toMatchObject({ authStatus: "ready", authError: null });
  });

  it.each([
    { scenario: "a denied membership", verified: false, error: new WorkspaceDenied("Access denied"), keep: false },
    { scenario: "a revoked workspace", verified: true, error: new WorkspaceDenied("Access revoked"), keep: false },
    { scenario: "a cancelled sign-in", verified: false, error: new Error("Verification cancelled"), keep: true },
    { scenario: "a temporary outage", verified: true, error: new TypeError("Failed to fetch"), keep: true },
  ])("updates the available options after $scenario", async ({ verified, error, keep }) => {
    const other = { tenantId: "other", displayName: "Contoso" };
    const listing = {
      directories: verified ? [other, GUEST_DIRECTORY] : [other],
      needsCheck: verified ? [] : [GUEST_DIRECTORY],
      discoveredCount: 2,
    };
    installAuth({ listDirectories: vi.fn().mockResolvedValue(listing), selectDirectory: vi.fn().mockRejectedValue(error) });
    await actions.startAuth();
    await actions.selectDirectory(GUEST_DIRECTORY);
    expect(useStore.getState()).toMatchObject({
      authStatus: "choose-directory", authError: error.message, account: ADA,
      directoryList: {
        status: "available", discoveredCount: 2,
        directories: keep ? listing.directories : [other], needsCheck: keep ? listing.needsCheck : [],
      },
    });
  });
});

describe("sign in and sign out", () => {
  it.each(["signed-out", "failed"] as const)("shows a login failure while %s", async (authStatus) => {
    installAuth({ signIn: vi.fn().mockRejectedValue(new Error("Cannot connect")) });
    useStore.setState({ authStatus, authMode: "entra" });
    await actions.signIn();
    expect(useStore.getState()).toMatchObject({ authStatus: "failed", authError: "Cannot connect" });
  });

  it("preserves the active workspace on reauthentication failure", async () => {
    installAuth({ signIn: vi.fn().mockRejectedValue(new Error("Cannot connect")) });
    useStore.setState({ authStatus: "ready", authMode: "entra" });
    await expect(actions.signIn()).rejects.toThrow("Cannot connect");
    expect(useStore.getState().authStatus).toBe("ready");
  });

  it("closes the workspace immediately even when Microsoft fails to finish logout", async () => {
    const signOut = vi.fn().mockRejectedValue(new Error("Logout endpoint unavailable"));
    installAuth({ signOut });
    useStore.setState({ authStatus: "ready", account: GUEST });
    const loggingOut = actions.signOut();
    expect(useStore.getState()).toMatchObject({ authStatus: "signing-out", account: null });
    await actions.signOut();
    await loggingOut;
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useStore.getState()).toMatchObject({ authStatus: "signed-out", authError: "Logout endpoint unavailable" });
  });

  it("ignores a late directory selection after logout", async () => {
    let finishSelection!: (account: AuthAccount) => void;
    const selection = new Promise<AuthAccount>(resolve => { finishSelection = resolve; });
    installAuth({ selectDirectory: vi.fn().mockReturnValue(selection) });
    await actions.startAuth();
    const opening = actions.selectDirectory(GUEST_DIRECTORY);
    await actions.signOut();
    finishSelection(GUEST);
    await opening;
    expect(useStore.getState()).toMatchObject({ authStatus: "signed-out", account: null });
  });

  it.each(["signIn", "signOut"] as const)("calls %s on the installed client", async (method) => {
    const auth = installAuth();
    await actions[method]();
    expect(auth[method]).toHaveBeenCalledTimes(1);
    expect(auth[method]).toHaveBeenCalledWith();
  });
});
