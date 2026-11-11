import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalAccountError, type Auth, type AuthAccount } from "../auth";
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
    setAuth: (auth: unknown) => {
      created.installed = auth;
    },
    getAuth: () => created.auth,
  };
});

const ENTRA: AuthConfig = { authMode: "entra", clientId: "c", apiScope: "api://c/access_as_user" };
const LOCAL: AuthConfig = { authMode: "local", clientId: null, apiScope: null };
const ADA: AuthAccount = { name: "Ada Lovelace", username: "ada@contoso.com", tenantId: "t" };

function fakeAuth(ready: Auth["ready"]): Auth {
  return { ready, account: null, getToken: vi.fn(), signIn: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.resetAllMocks();
  created.auth = null;
  created.config = null;
  created.installed = null;
  useStore.setState(useStore.getInitialState(), true);
});

describe("startAuth", () => {
  it.each([
    { name: "local mode goes straight on, with nobody signed in", config: LOCAL, ready: () => Promise.resolve(null), account: null, mode: "local" },
    { name: "Entra mode shows who signed in", config: ENTRA, ready: () => Promise.resolve(ADA), account: ADA, mode: "entra" },
  ] as const)("$name", async ({ config, ready, account, mode }) => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(config);
    const auth = fakeAuth(ready);
    created.auth = auth;

    await actions.startAuth();

    expect(created.config).toEqual(config);
    expect(created.installed).toBe(auth);
    expect(useStore.getState()).toMatchObject({ authStatus: "ready", authMode: mode, account, authError: null });
  });

  it.each([
    { name: "the sign-in settings cannot be loaded", setup: () => vi.mocked(api.fetchAuthConfig).mockRejectedValue({ code: "network_error", message: "Failed to fetch", retryable: true }), mode: null, message: "Failed to fetch" },
    { name: "the settings are incomplete", setup: () => vi.mocked(api.fetchAuthConfig).mockResolvedValue({ ...ENTRA, clientId: null }), mode: "entra", message: "sign-in settings are incomplete" },
    { name: "the sign-in itself fails", setup: () => { vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA); created.auth = fakeAuth(() => Promise.reject(new Error("AADSTS50105: not assigned"))); }, mode: "entra", message: "AADSTS50105" },
    { name: "the failure says nothing", setup: () => { vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA); created.auth = fakeAuth(() => Promise.reject(new Error(""))); }, mode: "entra", message: "Signing in did not work." },
  ])("fails when $name, and says why", async ({ setup, mode, message }) => {
    setup();

    await actions.startAuth();

    const state = useStore.getState();
    expect(state.authStatus).toBe("failed");
    expect(state.authMode).toBe(mode);
    expect(state.authError).toContain(message);
    expect(state.account).toBeNull();
  });

  it("asks a user who is not signed in to sign in, and starts nothing itself", async () => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA);
    const auth = fakeAuth(() => Promise.resolve(null));
    created.auth = auth;

    await actions.startAuth();

    expect(useStore.getState()).toMatchObject({ authStatus: "signed-out", authMode: "entra", account: null, authError: null, personalAccount: null });
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it("asks a personal account that landed in no directory for the directory, and remembers the account to offer first", async () => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA);
    created.auth = fakeAuth(() => Promise.reject(new PersonalAccountError("ada@example.test")));

    await actions.startAuth();

    expect(useStore.getState()).toMatchObject({ authStatus: "personal", authMode: "entra", account: null, authError: null, personalAccount: "ada@example.test" });
  });

  it("forgets the personal account when it starts again", async () => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA);
    created.auth = fakeAuth(() => Promise.reject(new PersonalAccountError("ada@example.test")));
    await actions.startAuth();
    created.auth = fakeAuth(() => Promise.resolve(ADA));

    await actions.startAuth();

    expect(useStore.getState()).toMatchObject({ authStatus: "ready", account: ADA, personalAccount: null });
  });

  it("starts once however often it is called, so two redirects never collide", async () => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA);
    const ready = vi.fn().mockResolvedValue(ADA);
    created.auth = fakeAuth(ready);

    await Promise.all([actions.startAuth(), actions.startAuth(), actions.startAuth()]);

    expect(api.fetchAuthConfig).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("tries again after a failure", async () => {
    vi.mocked(api.fetchAuthConfig).mockRejectedValueOnce(new Error("down")).mockResolvedValue(LOCAL);
    created.auth = fakeAuth(() => Promise.resolve(null));

    await actions.startAuth();
    expect(useStore.getState().authStatus).toBe("failed");
    const retry = actions.startAuth();
    expect(useStore.getState()).toMatchObject({ authStatus: "starting", authError: null });
    await retry;

    expect(useStore.getState()).toMatchObject({ authStatus: "ready", authError: null });
    expect(api.fetchAuthConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps no token in the store", async () => {
    vi.mocked(api.fetchAuthConfig).mockResolvedValue(ENTRA);
    created.auth = fakeAuth(() => Promise.resolve(ADA));
    await actions.startAuth();
    expect(JSON.stringify(useStore.getState())).not.toMatch(/token|bearer/i);
  });
});

describe("a sign-in that cannot start", () => {
  it.each(["signed-out", "personal", "failed"] as const)("is the failure of the sign-in page when the app is %s", async (authStatus) => {
    const auth = fakeAuth(() => Promise.resolve(ADA));
    vi.mocked(auth.signIn).mockRejectedValue(new Error("Refused to connect: connect-src"));
    created.auth = auth;
    useStore.setState({ authStatus, authMode: "entra" });

    await actions.signIn({ directory: "contoso.com" });

    expect(useStore.getState()).toMatchObject({ authStatus: "failed", authError: "Refused to connect: connect-src" });
  });

  it("is left to the caller once the app is ready, which keeps running", async () => {
    const auth = fakeAuth(() => Promise.resolve(ADA));
    vi.mocked(auth.signIn).mockRejectedValue(new Error("down"));
    created.auth = auth;
    useStore.setState({ authStatus: "ready", authMode: "entra" });

    await expect(actions.signIn()).rejects.toThrow("down");

    expect(useStore.getState().authStatus).toBe("ready");
  });
});

describe("signOut and signIn", () => {
  it.each([
    { name: "signs out", act: () => actions.signOut(), called: "signOut", with: [] },
    { name: "signs in again", act: () => actions.signIn(), called: "signIn", with: [undefined] },
    { name: "signs in to a directory", act: () => actions.signIn({ directory: "contoso.com", loginHint: "ada@example.test" }), called: "signIn", with: [{ directory: "contoso.com", loginHint: "ada@example.test" }] },
  ] as const)("$name through the auth the app runs with", async ({ act, called, with: args }) => {
    const auth = fakeAuth(() => Promise.resolve(ADA));
    vi.mocked(auth.signIn).mockResolvedValue(undefined);
    created.auth = auth;
    await act();
    expect(auth[called]).toHaveBeenCalledTimes(1);
    expect(auth[called]).toHaveBeenCalledWith(...args);
  });
});
