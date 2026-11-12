import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo, PublicClientApplication } from "@azure/msal-browser";

const created: unknown[] = [];

vi.mock("@azure/msal-browser", () => {
  class InteractionRequiredAuthError extends Error {}
  class FakeClient {
    constructor(configuration: unknown) {
      created.push(configuration);
    }
  }
  return {
    PublicClientApplication: FakeClient,
    InteractionRequiredAuthError,
    CacheLookupPolicy: { Default: 0, AccessToken: 1, AccessTokenAndRefreshToken: 2, RefreshToken: 3, RefreshTokenAndNetwork: 4, Skip: 5 },
  };
});

import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { PersonalAccountError, createAuth, getAuth, localAuth, setAuth } from "./index";
import { createEntraAuth, defaultScope, msalConfiguration } from "./entraAuth";
import { AUTHORITY_HOST, CONSUMERS_TENANT_ID } from "./directory";

const SETTINGS = { clientId: "client-1", apiScope: "api://client-1/access_as_user" } as const;
const SCOPE = "client-1/.default";
const ACCOUNT = { homeAccountId: "h", environment: "e", tenantId: "tenant-1", localAccountId: "l", username: "ada@contoso.com", name: "Ada Lovelace" } as AccountInfo;
const PERSONAL = { ...ACCOUNT, tenantId: CONSUMERS_TENANT_ID, username: "ada@example.test" } as AccountInfo;
const DEEP_LINK = "?model=hm-demo&resourceGroup=rg-demo&subscription=sub-1&session=c4c19c774d06&task=2";

function fakeClient() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    handleRedirectPromise: vi.fn().mockResolvedValue(null),
    getActiveAccount: vi.fn().mockReturnValue(null),
    getAllAccounts: vi.fn().mockReturnValue([]),
    setActiveAccount: vi.fn(),
    acquireTokenSilent: vi.fn(),
    acquireTokenRedirect: vi.fn().mockResolvedValue(undefined),
    loginRedirect: vi.fn().mockResolvedValue(undefined),
    logoutRedirect: vi.fn().mockResolvedValue(undefined),
  };
}

/** `pending` when a promise is still waiting after a moment: a page that navigates away never settles it. */
async function outcome(promise: Promise<unknown>): Promise<"pending" | "settled"> {
  return Promise.race([promise.then(() => "settled" as const, () => "settled" as const), new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20))]);
}

function build(client = fakeClient()) {
  return { client, auth: createEntraAuth(SETTINGS, client as unknown as PublicClientApplication) };
}

beforeEach(() => {
  created.length = 0;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  setAuth(localAuth);
});

describe("msalConfiguration", () => {
  it.each(["https://app.example.azurecontainerapps.io", "http://127.0.0.1:4173"])("asks any work or school directory for an auth code through the root of %s, with the cache in session storage", (origin) => {
    expect(msalConfiguration(SETTINGS, origin)).toEqual({
      auth: {
        clientId: "client-1",
        authority: `${AUTHORITY_HOST}/organizations`,
        redirectUri: `${origin}/`,
        postLogoutRedirectUri: `${origin}/`,
      },
      cache: { cacheLocation: "sessionStorage" },
    });
  });

  it("builds its client from that configuration", () => {
    createEntraAuth(SETTINGS);
    expect(created).toEqual([msalConfiguration(SETTINGS, window.location.origin)]);
  });
});

describe("defaultScope", () => {
  it.each([
    { clientId: "client-1", expected: "client-1/.default" },
    { clientId: "11111111-2222-3333-4444-555555555555", expected: "11111111-2222-3333-4444-555555555555/.default" },
  ])("asks for the whole API of $clientId by its bare id, which Entra requires of an app that asks for itself", ({ clientId, expected }) => {
    expect(defaultScope(clientId)).toBe(expected);
  });

  it.each(["", " ", "api://client-1", "api://client-1/access_as_user"])("refuses %j, which is no client id", (clientId) => {
    expect(() => defaultScope(clientId)).toThrow("sign-in settings are incomplete");
  });
});

describe("ready", () => {
  it("completes a sign-in that returns, shows who signed in and goes back to the address it left", async () => {
    window.sessionStorage.setItem("health-pulse-return-query", DEEP_LINK);
    const { client, auth } = build();
    client.handleRedirectPromise.mockResolvedValue({ account: ACCOUNT });

    await expect(auth.ready()).resolves.toEqual({ name: "Ada Lovelace", username: "ada@contoso.com", tenantId: "tenant-1" });

    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.handleRedirectPromise).toHaveBeenCalledWith({ navigateToLoginRequestUrl: false });
    expect(client.setActiveAccount).toHaveBeenCalledWith(ACCOUNT);
    expect(client.loginRedirect).not.toHaveBeenCalled();
    expect(window.location.search).toBe(DEEP_LINK);
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBeNull();
    expect(auth.account).toEqual({ name: "Ada Lovelace", username: "ada@contoso.com", tenantId: "tenant-1" });
  });

  it.each([
    { name: "the active account", active: ACCOUNT, all: [] },
    { name: "the first cached account", active: null, all: [ACCOUNT] },
  ])("signs in with $name without a redirect", async ({ active, all }) => {
    const { client, auth } = build();
    client.getActiveAccount.mockReturnValue(active);
    client.getAllAccounts.mockReturnValue(all);

    await expect(auth.ready()).resolves.toMatchObject({ username: "ada@contoso.com" });

    expect(client.loginRedirect).not.toHaveBeenCalled();
  });

  it("falls back to the user name when the account has no display name", async () => {
    const { client, auth } = build();
    client.getActiveAccount.mockReturnValue({ ...ACCOUNT, name: undefined });
    await expect(auth.ready()).resolves.toMatchObject({ name: "ada@contoso.com" });
  });

  it("starts nothing when nobody is signed in: the app offers the ways to sign in", async () => {
    const { client, auth } = build();

    await expect(auth.ready()).resolves.toBeNull();

    expect(client.loginRedirect).not.toHaveBeenCalled();
    expect(auth.account).toBeNull();
  });

  it.each([
    { name: "one that returns from a sign-in", returned: { account: PERSONAL }, active: null, all: [] },
    { name: "the active account", returned: null, active: PERSONAL, all: [] },
    { name: "a cached account", returned: null, active: null, all: [PERSONAL] },
  ])("says so when the only account is a personal one with no directory: $name", async ({ returned, active, all }) => {
    const { client, auth } = build();
    client.handleRedirectPromise.mockResolvedValue(returned);
    client.getActiveAccount.mockReturnValue(active);
    client.getAllAccounts.mockReturnValue(all);

    const failure = await auth.ready().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PersonalAccountError);
    expect((failure as PersonalAccountError).username).toBe("ada@example.test");
    expect(client.setActiveAccount).not.toHaveBeenCalled();
    expect(auth.account).toBeNull();
  });

  it("signs in with the account of a directory when a personal account without one is cached too", async () => {
    const { client, auth } = build();
    client.getActiveAccount.mockReturnValue(PERSONAL);
    client.getAllAccounts.mockReturnValue([PERSONAL, ACCOUNT]);

    await expect(auth.ready()).resolves.toMatchObject({ tenantId: "tenant-1" });

    expect(client.setActiveAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it("does not replace an address that already has a query", async () => {
    window.history.replaceState(null, "", "/?model=other");
    window.sessionStorage.setItem("health-pulse-return-query", DEEP_LINK);
    const { client, auth } = build();
    client.getActiveAccount.mockReturnValue(ACCOUNT);

    await auth.ready();

    expect(window.location.search).toBe("?model=other");
  });

  it.each([
    { name: "a failed redirect", failing: "handleRedirectPromise" },
    { name: "a client that cannot start", failing: "initialize" },
  ] as const)("fails with $name, for the sign-in failure page to show", async ({ failing }) => {
    const { client, auth } = build();
    client[failing].mockRejectedValue(new Error("AADSTS50105: the user is not assigned to a role"));

    await expect(auth.ready()).rejects.toThrow("AADSTS50105");

    expect(client.loginRedirect).not.toHaveBeenCalled();
  });
});

describe("getToken", () => {
  async function signedIn() {
    const built = build();
    built.client.getActiveAccount.mockReturnValue(ACCOUNT);
    await built.auth.ready();
    return built;
  }

  it.each([
    { name: "silently, from the cache or the refresh token", request: {}, policy: 2 },
    { name: "from the refresh token when the API refused the cached token", request: { refresh: true }, policy: 3 },
  ])("gets a token $name, and never asks for a hidden frame", async ({ request, policy }) => {
    const { client, auth } = await signedIn();
    client.acquireTokenSilent.mockResolvedValue({ accessToken: "access-1" });

    await expect(auth.getToken(request)).resolves.toBe("access-1");

    expect(client.acquireTokenSilent).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope], authority: `${AUTHORITY_HOST}/tenant-1`, account: ACCOUNT, cacheLookupPolicy: policy });
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("falls back to a redirect when the session cannot renew silently, keeping the address", async () => {
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    const { client, auth } = await signedIn();
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("interaction_required", "The session needs the user."));

    expect(await outcome(auth.getToken())).toBe("pending");

    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({ scopes: [SCOPE], authority: `${AUTHORITY_HOST}/tenant-1`, account: ACCOUNT });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBe(DEEP_LINK);
  });

  it("does not hide another failure behind a redirect", async () => {
    const { client, auth } = await signedIn();
    client.acquireTokenSilent.mockRejectedValue(new Error("network down"));

    await expect(auth.getToken()).rejects.toThrow("network down");

    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("answers a claims challenge with one interactive step that carries the claims, and no silent try", async () => {
    const { client, auth } = await signedIn();

    expect(await outcome(auth.getToken({ claims: "eyJhY2Nlc3NfdG9rZW4iOnt9fQ==" }))).toBe("pending");

    expect(client.acquireTokenSilent).not.toHaveBeenCalled();
    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({ scopes: [SCOPE], authority: `${AUTHORITY_HOST}/tenant-1`, account: ACCOUNT, claims: "eyJhY2Nlc3NfdG9rZW4iOnt9fQ==" });
  });

  it("refuses to ask for a token before anybody signed in", async () => {
    const { auth } = build();
    await expect(auth.getToken()).rejects.toThrow("Nobody is signed in.");
  });
});

describe("signIn and signOut", () => {
  it.each([
    { name: "any work or school directory by default", request: undefined, authority: `${AUTHORITY_HOST}/organizations`, extra: { prompt: "select_account" } },
    { name: "the directory a tenant ID names", request: { directory: "7f1c0b1e-0000-4000-8000-00000000aaaa" }, authority: `${AUTHORITY_HOST}/7f1c0b1e-0000-4000-8000-00000000aaaa`, extra: { prompt: "select_account" } },
    { name: "the directory a domain names, offering the account first", request: { directory: "contoso.com", loginHint: "ada@example.test" }, authority: `${AUTHORITY_HOST}/contoso.com`, extra: { loginHint: "ada@example.test" } },
  ])("starts a sign-in on request to $name, asking which account unless one is offered, and keeping the address", async ({ request, authority, extra }) => {
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    const { client, auth } = build();

    await auth.signIn(request);

    expect(client.loginRedirect).toHaveBeenCalledWith({ scopes: [SCOPE], authority, ...extra });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBe(DEEP_LINK);
  });

  it("signs the account out through the authority, forgets the address and the account", async () => {
    const { client, auth } = build();
    client.getActiveAccount.mockReturnValue(ACCOUNT);
    await auth.ready();
    window.sessionStorage.setItem("health-pulse-return-query", DEEP_LINK);

    await auth.signOut();

    expect(client.logoutRedirect).toHaveBeenCalledWith({ account: ACCOUNT });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBeNull();
    expect(auth.account).toBeNull();
  });
});

describe("createAuth", () => {
  it.each([
    { name: "local mode", config: { authMode: "local", clientId: null, apiScope: null } as const },
    { name: "local mode that names a client anyway", config: { authMode: "local", clientId: "c", apiScope: "s" } as const },
  ])("signs nobody in for $name", async ({ config }) => {
    const auth = createAuth(config);
    expect(auth).toBe(localAuth);
    await expect(auth.ready()).resolves.toBeNull();
    await expect(auth.getToken()).resolves.toBeNull();
  });

  it.each([
    { name: "a client", config: { authMode: "entra", clientId: null, apiScope: "s" } as const },
    { name: "a scope", config: { authMode: "entra", clientId: "c", apiScope: null } as const },
  ])("refuses Entra mode without $name", ({ config }) => {
    expect(() => createAuth(config)).toThrow("sign-in settings are incomplete");
  });

  it("builds the Entra auth a complete config names, and the app runs with the one it was given", () => {
    const auth = createAuth({ authMode: "entra", clientId: "c", apiScope: "api://c/access_as_user" });
    expect(auth).not.toBe(localAuth);
    expect(created).toEqual([msalConfiguration({ clientId: "c", apiScope: "api://c/access_as_user" }, window.location.origin)]);
    setAuth(auth);
    expect(getAuth()).toBe(auth);
  });
});
