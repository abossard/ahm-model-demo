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
import { createAuth, getAuth, localAuth, setAuth } from "./index";
import { AUTHORITY_HOST, createEntraAuth, msalConfiguration } from "./entraAuth";

const SETTINGS = { tenantId: "tenant-1", clientId: "client-1", apiScope: "api://client-1/access_as_user" } as const;
const ACCOUNT = { homeAccountId: "h", environment: "e", tenantId: "tenant-1", localAccountId: "l", username: "ada@contoso.com", name: "Ada Lovelace" } as AccountInfo;
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
  it.each(["https://app.example.azurecontainerapps.io", "http://127.0.0.1:4173"])("asks one tenant for an auth code through the root of %s, with the cache in session storage", (origin) => {
    expect(msalConfiguration(SETTINGS, origin)).toEqual({
      auth: {
        clientId: "client-1",
        authority: `${AUTHORITY_HOST}/tenant-1`,
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

  it("keeps the deep link and redirects to sign in when nobody is signed in, and never settles", async () => {
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    const { client, auth } = build();

    expect(await outcome(auth.ready())).toBe("pending");

    expect(client.loginRedirect).toHaveBeenCalledTimes(1);
    expect(client.loginRedirect).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope] });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBe(DEEP_LINK);
    expect(auth.account).toBeNull();
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

    expect(client.acquireTokenSilent).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope], account: ACCOUNT, cacheLookupPolicy: policy });
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("falls back to a redirect when the session cannot renew silently, keeping the address", async () => {
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    const { client, auth } = await signedIn();
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("interaction_required", "The session needs the user."));

    expect(await outcome(auth.getToken())).toBe("pending");

    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope], account: ACCOUNT });
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
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope], account: ACCOUNT, claims: "eyJhY2Nlc3NfdG9rZW4iOnt9fQ==" });
  });

  it("refuses to ask for a token before anybody signed in", async () => {
    const { auth } = build();
    await expect(auth.getToken()).rejects.toThrow("Nobody is signed in.");
  });
});

describe("signIn and signOut", () => {
  it("starts a sign-in on request, keeping the address", async () => {
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    const { client, auth } = build();

    await auth.signIn();

    expect(client.loginRedirect).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope] });
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
    { name: "local mode", config: { authMode: "local", tenantId: null, clientId: null, apiScope: null } as const },
    { name: "local mode that names a tenant anyway", config: { authMode: "local", tenantId: "t", clientId: "c", apiScope: "s" } as const },
  ])("signs nobody in for $name", async ({ config }) => {
    const auth = createAuth(config);
    expect(auth).toBe(localAuth);
    await expect(auth.ready()).resolves.toBeNull();
    await expect(auth.getToken()).resolves.toBeNull();
  });

  it.each([
    { name: "a tenant", config: { authMode: "entra", tenantId: null, clientId: "c", apiScope: "s" } as const },
    { name: "a client", config: { authMode: "entra", tenantId: "t", clientId: null, apiScope: "s" } as const },
    { name: "a scope", config: { authMode: "entra", tenantId: "t", clientId: "c", apiScope: null } as const },
  ])("refuses Entra mode without $name", ({ config }) => {
    expect(() => createAuth(config)).toThrow("sign-in settings are incomplete");
  });

  it("builds the Entra auth a complete config names, and the app runs with the one it was given", () => {
    const auth = createAuth({ authMode: "entra", tenantId: "t", clientId: "c", apiScope: "api://c/access_as_user" });
    expect(auth).not.toBe(localAuth);
    expect(created).toEqual([msalConfiguration({ tenantId: "t", clientId: "c", apiScope: "api://c/access_as_user" }, window.location.origin)]);
    setAuth(auth);
    expect(getAuth()).toBe(auth);
  });
});
