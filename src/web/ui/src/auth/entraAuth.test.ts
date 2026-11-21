import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { DirectoryConsentRequiredError, createAuth, getAuth, localAuth, setAuth } from "./index";
import { createEntraAuth, defaultScope, msalConfiguration, type EntraSettings } from "./entraAuth";
import { AUTHORITY_HOST, CONSUMERS_TENANT_ID } from "./directory";

const SETTINGS = { clientId: "client-1", apiScope: "api://client-1/access_as_user" } as const;
const SCOPE = "client-1/.default";
const ARM_SCOPE = "https://management.azure.com//user_impersonation";
const HOME = "aaaaaaaa-cccc-4444-8888-111111111111";
const GUEST = "bbbbbbbb-cccc-4444-8888-111111111111";
const PARTNER = "cccccccc-cccc-4444-8888-111111111111";
const GUEST_SETTINGS = { ...SETTINGS, homeDirectory: GUEST };
const DIR = { tenantId: GUEST, displayName: "Fabrikam" };
const ACCOUNT = { homeAccountId: "h", environment: "e", tenantId: HOME, localAccountId: "l", username: "ada@contoso.com", name: "Ada Lovelace" } as AccountInfo;
const PERSONAL = { ...ACCOUNT, tenantId: CONSUMERS_TENANT_ID, username: "ada@example.test" } as AccountInfo;
const DEEP_LINK = "?model=hm-demo&resourceGroup=rg-demo&subscription=sub-1&session=c4c19c774d06&task=2";

function token(user = ACCOUNT, tenantId = user.tenantId) {
  return { account: { ...user, tenantId }, tenantId, authority: `${AUTHORITY_HOST}/${tenantId}/`, accessToken: "access-1" };
}

function fakeClient() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    handleRedirectPromise: vi.fn().mockResolvedValue(null),
    getAccount: vi.fn().mockReturnValue(null),
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

function build(client = fakeClient(), settings: EntraSettings = SETTINGS) {
  return { client, auth: createEntraAuth(settings, client as unknown as PublicClientApplication) };
}

beforeEach(() => {
  created.length = 0;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  setAuth(localAuth);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "/api/workspace/access") throw new Error("Unexpected request " + url);
    return Response.json({ tenantId: new Headers(init?.headers).get("X-Workspace-Tenant") });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("msalConfiguration", () => {
  it.each(["https://app.example.azurecontainerapps.io", "http://127.0.0.1:4173"])("asks Microsoft accounts for an auth code through the root of %s, with the cache in session storage", (origin) => {
    expect(msalConfiguration(SETTINGS, origin)).toEqual({
      auth: {
        clientId: "client-1",
        authority: `${AUTHORITY_HOST}/common`,
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
  it.each(["/builder", "/builder?session=saved-topic"])("returns to %s after signing in at the root", async (destination) => {
    const { auth, client } = build();
    window.history.replaceState(null, "", destination);
    await auth.signIn();
    window.history.replaceState(null, "", "/");
    client.handleRedirectPromise.mockResolvedValue({ account: ACCOUNT });
    await auth.ready();
    expect(window.location.pathname + window.location.search).toBe(destination);
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBeNull();
  });

  it.each([
    { name: "a returning identity", returned: { account: ACCOUNT }, active: null, all: [] },
    { name: "a returning personal account", returned: { account: PERSONAL }, active: null, all: [] },
    { name: "the active cached account", returned: null, active: ACCOUNT, all: [] },
    { name: "a legacy account without an explicit choice", returned: null, active: null, all: [ACCOUNT] },
  ])("requires a directory choice for $name and preserves a saved link", async ({ returned, active, all }) => {
    const { client, auth } = build();
    client.handleRedirectPromise.mockResolvedValue(returned);
    client.getActiveAccount.mockReturnValue(active);
    client.getAllAccounts.mockReturnValue(all);
    window.sessionStorage.setItem("health-pulse-return-query", DEEP_LINK);
    await expect(auth.ready()).resolves.toMatchObject({ name: "Ada Lovelace" });
    expect(window.location.search).toBe(DEEP_LINK);
    expect(auth.needsDirectory).toBe(true);
    await expect(auth.getToken()).rejects.toThrow("Choose an Azure directory");
    expect(client.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it("keeps an address that already has a query", async () => {
    window.history.replaceState(null, "", "/?model=other");
    window.sessionStorage.setItem("health-pulse-return-query", DEEP_LINK);
    await build().auth.ready();
    expect(window.location.search).toBe("?model=other");
  });

  it.each(["handleRedirectPromise", "initialize"] as const)("shows the initial sign-in failure from %s", async (method) => {
    const { client, auth } = build();
    client[method].mockRejectedValue(new Error("AADSTS50105: the user is not assigned"));
    await expect(auth.ready()).rejects.toThrow("AADSTS50105");
    expect(client.loginRedirect).not.toHaveBeenCalled();
  });
});

async function chooser(user = ACCOUNT, settings: EntraSettings = SETTINGS) {
  const { client, auth } = build(fakeClient(), settings);
  client.getActiveAccount.mockReturnValue(user);
  client.getAccount.mockImplementation(({ homeAccountId, tenantId }) =>
    homeAccountId === user.homeAccountId && (!tenantId || tenantId === user.tenantId) ? user : null);
  await auth.ready();
  return { client, auth };
}

async function selected() {
  const { client, auth } = await chooser();
  client.acquireTokenSilent.mockResolvedValueOnce(token(ACCOUNT, GUEST));
  await auth.selectDirectory!(DIR);
  client.acquireTokenSilent.mockClear();
  return { client, auth };
}

describe("consent and directory discovery", () => {
  it("uses the ARM token for inventory and separate candidate-tenant API tokens only for the protected access check", async () => {
    const { client, auth } = await chooser();
    client.setActiveAccount.mockClear();
    client.acquireTokenSilent.mockResolvedValueOnce({ ...token(), accessToken: "arm-token" }).mockResolvedValueOnce(token(ACCOUNT, GUEST));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: [DIR] }));
    await expect(auth.listDirectories!()).resolves.toEqual({ directories: [DIR], discoveredCount: 1 });
    expect(client.acquireTokenSilent).toHaveBeenNthCalledWith(1, expect.objectContaining({ scopes: ["https://management.azure.com//user_impersonation"], authority: `${AUTHORITY_HOST}/${HOME}` }));
    expect(client.acquireTokenSilent).toHaveBeenNthCalledWith(2, expect.objectContaining({ scopes: [SETTINGS.apiScope], authority: `${AUTHORITY_HOST}/${GUEST}`, cacheLookupPolicy: 3 }));
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("management.azure.com/tenants?"), expect.objectContaining({ headers: { Authorization: "Bearer arm-token" } }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/workspace/access", expect.objectContaining({ headers: { Authorization: "Bearer access-1", "X-Workspace-Tenant": GUEST }, redirect: "error" }));
    expect(client.setActiveAccount).not.toHaveBeenCalled();
    expect(auth.account?.tenantId).toBe(HOME);
    await expect(auth.getToken()).rejects.toThrow("Choose an Azure directory");
  });

  it.each([
    { status: 401, body: {}, hint: {} },
    { status: 401, body: { error: { code: "interaction_required" } }, hint: { needsCheck: [DIR] } },
    { status: 403, body: { error: { code: "workspace_access_denied" } }, hint: {} },
    { status: 200, body: { tenantId: HOME }, hint: {} },
    { status: 503, body: {}, hint: { needsCheck: [DIR], incomplete: true } },
  ])("classifies an unverified candidate on HTTP $status and never redirects", async ({ status, body, hint }) => {
    const { client, auth } = await chooser();
    client.acquireTokenSilent.mockResolvedValueOnce(token()).mockResolvedValueOnce(token(ACCOUNT, GUEST));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: [DIR] })).mockResolvedValueOnce(Response.json(body, { status }));
    await expect(auth.listDirectories!()).resolves.toEqual({ directories: [], discoveredCount: 1, ...hint });
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Azure is offline", error: new TypeError("network unavailable") },
    { name: "the guest directory denies consent", error: Object.assign(new Error("Consent denied"), { errorCode: "access_denied" }) },
  ])("verifies the deployment tenant without redirecting when $name", async ({ error }) => {
    const { client, auth } = await chooser(ACCOUNT, GUEST_SETTINGS);
    client.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError("login_required", "")).mockRejectedValueOnce(error)
      .mockRejectedValueOnce(new InteractionRequiredAuthError("login_required", "")).mockResolvedValueOnce(token(ACCOUNT, GUEST));
    await expect(auth.listDirectories!()).resolves.toMatchObject({ directories: [{ ...DIR, displayName: "App directory" }] });
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  async function beginGuestDiscovery(homeError: Error = new InteractionRequiredAuthError("interaction_required", "")) {
    const { client, auth } = build(fakeClient(), GUEST_SETTINGS);
    await auth.signIn();
    client.handleRedirectPromise.mockResolvedValueOnce({ account: ACCOUNT });
    client.getAccount.mockImplementation(({ tenantId }) => !tenantId || tenantId === HOME ? ACCOUNT : null);
    await auth.ready();
    client.acquireTokenSilent.mockImplementation(async ({ authority, scopes }) => {
      const tenantId = new URL(authority).pathname.slice(1);
      if (scopes[0] === ARM_SCOPE && tenantId === HOME) throw homeError;
      if (scopes[0] === ARM_SCOPE || tenantId === HOME) throw new InteractionRequiredAuthError("interaction_required", "");
      return token(ACCOUNT, tenantId);
    });
    expect(await outcome(auth.listDirectories!())).toBe("pending");
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith(expect.objectContaining({
      account: ACCOUNT, authority: `${AUTHORITY_HOST}/${GUEST}`, scopes: [ARM_SCOPE], prompt: "none",
    }));
    return { client, state: client.acquireTokenRedirect.mock.calls[0]![0].state as string };
  }

  it.each([
    { name: "requires interaction", homeError: new InteractionRequiredAuthError("interaction_required", "") },
    { name: "denies consent", homeError: Object.assign(new Error("This application requires admin approval at home"), { errorCode: "access_denied" }) },
  ])("uses the returned guest ARM grant to discover other memberships when the home tenant $name", async ({ homeError }) => {
    const { client, state } = await beginGuestDiscovery(homeError);
    client.handleRedirectPromise.mockResolvedValueOnce({ ...token(ACCOUNT, GUEST), accessToken: "guest-arm-grant", state });
    const back = build(client, GUEST_SETTINGS).auth;
    await back.ready();
    client.acquireTokenSilent.mockClear();
    const partner = { tenantId: PARTNER, displayName: "Partner engineering" };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: [partner] }));
    await expect(back.listDirectories!()).resolves.toEqual({ directories: [partner], discoveredCount: 1 });
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("management.azure.com/tenants?"), expect.objectContaining({
      headers: { Authorization: "Bearer guest-arm-grant" },
    }));
    expect(client.acquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(client.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ authority: `${AUTHORITY_HOST}/${PARTNER}`, scopes: [SETTINGS.apiScope] }));
    expect(back.needsDirectory).toBe(true);
    await expect(back.getToken()).rejects.toThrow("Choose an Azure directory");
    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "Microsoft requires interaction", error: new InteractionRequiredAuthError("interaction_required", "") },
    { name: "the user cancels", error: Object.assign(new Error("Cancelled"), { errorCode: "user_cancelled" }) },
    { name: "the return is interrupted", result: null },
    { name: "another account returns", result: token({ ...ACCOUNT, homeAccountId: "someone-else" }, GUEST) },
    { name: "another directory issues the grant", result: token(ACCOUNT, HOME) },
  ])("returns to the chooser without reusing a grant or repeating the redirect when $name", async row => {
    const { client, state } = await beginGuestDiscovery();
    if (row.error) client.handleRedirectPromise.mockRejectedValueOnce(row.error);
    else if (row.result) client.handleRedirectPromise.mockResolvedValueOnce({ ...row.result, accessToken: "unexpected-grant", state });
    const back = build(client, GUEST_SETTINGS).auth;
    await expect(back.ready()).resolves.toMatchObject({ tenantId: HOME });
    expect(back.needsDirectory).toBe(true);
    await expect(back.listDirectories!()).resolves.toMatchObject({ directories: [{ ...DIR, displayName: "App directory" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/workspace/access", expect.anything());
    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { search: "", target: GUEST },
    { search: `?tenant=${PARTNER}`, target: PARTNER },
  ])("requests explicit directory discovery at the intended authority for '$search'", async ({ search, target }) => {
    window.history.replaceState(null, "", "/" + search);
    const { client, auth } = await chooser(ACCOUNT, GUEST_SETTINGS);
    expect(await outcome(auth.requestDirectoryDiscovery!())).toBe("pending");
    const [request] = client.acquireTokenRedirect.mock.calls[0]!;
    expect(request).toMatchObject({ account: ACCOUNT, authority: `${AUTHORITY_HOST}/${target}`, scopes: [ARM_SCOPE] });
    expect(request.prompt).not.toBe("none");
  });

  it("can list memberships through a linked directory with no cached profile", async () => {
    window.history.replaceState(null, "", `/?tenant=${PARTNER}`);
    const { client, auth } = await chooser(ACCOUNT, GUEST_SETTINGS);
    client.acquireTokenSilent.mockImplementation(async ({ authority, scopes }) => {
      const tenantId = new URL(authority).pathname.slice(1);
      if (scopes[0] === ARM_SCOPE && tenantId !== PARTNER) throw new InteractionRequiredAuthError("interaction_required", "");
      return token(ACCOUNT, tenantId);
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: [DIR] }));
    await expect(auth.listDirectories!()).resolves.toEqual({ directories: [DIR], discoveredCount: 1 });
    expect(client.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ authority: `${AUTHORITY_HOST}/${PARTNER}`, scopes: [ARM_SCOPE] }));
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("remembers the guest discovery attempt after a workspace check fails", async () => {
    const { client } = await beginGuestDiscovery();
    client.handleRedirectPromise.mockRejectedValueOnce(new InteractionRequiredAuthError("interaction_required", ""));
    const back = build(client, GUEST_SETTINGS).auth;
    await back.ready();
    await back.listDirectories!();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: "workspace_access_denied" } }, { status: 403 }));
    await expect(back.selectDirectory!(DIR)).rejects.toThrow();
    await expect(back.listDirectories!()).resolves.toMatchObject({ directories: [{ ...DIR, displayName: "App directory" }] });
    expect(back.needsDirectory).toBe(true);
    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
  });

  it("stops checking after sign-out even if an MSAL silent request finishes later", async () => {
    const { client, auth } = await chooser();
    let finish: (value: ReturnType<typeof token>) => void = () => undefined;
    const pendingToken = new Promise<ReturnType<typeof token>>(resolve => { finish = resolve; });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: [DIR] }));
    client.acquireTokenSilent.mockResolvedValueOnce(token()).mockReturnValueOnce(pendingToken);
    const listing = auth.listDirectories!();
    await vi.waitFor(() => expect(client.acquireTokenSilent).toHaveBeenCalledTimes(2));
    await auth.signOut();
    finish(token(ACCOUNT, GUEST));
    await expect(listing).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.account).toBeNull();
  });

  it("only asks interactively for ARM consent after an explicit request, and returns to the chooser", async () => {
    const { client, auth } = await chooser();
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("consent_required", ""));
    await expect(auth.listDirectories!()).rejects.toBeInstanceOf(DirectoryConsentRequiredError);
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
    expect(await outcome(auth.requestDirectoryDiscovery!())).toBe("pending");
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith(expect.objectContaining({
      account: ACCOUNT, authority: `${AUTHORITY_HOST}/${HOME}`, scopes: ["https://management.azure.com//user_impersonation"],
    }));
    client.handleRedirectPromise.mockResolvedValueOnce({ ...token(), state: "list-directories" });
    const back = build(client).auth;
    await expect(back.ready()).resolves.toMatchObject({ tenantId: HOME });
    expect(back.needsDirectory).toBe(true);
  });
});

describe("selecting a directory", () => {
  it.each(["invalid_grant", "invalid_resource"])("offers a tenant-specific sign-in for %s only after selection", async errorCode => {
    const { client, auth } = await chooser();
    const failure = Object.assign(new Error("Microsoft could not issue the token silently"), { errorCode });
    client.acquireTokenSilent.mockResolvedValueOnce(token()).mockRejectedValue(failure);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: [DIR] }));
    await expect(auth.listDirectories!()).resolves.toEqual({ directories: [], needsCheck: [DIR], discoveredCount: 1 });
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
    expect(await outcome(auth.selectDirectory!(DIR))).toBe("pending");
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith(expect.objectContaining({ authority: `${AUTHORITY_HOST}/${GUEST}`, state: "select-directory" }));
  });

  it.each([{}, { claims: "target-tenant-claims" }])("honors a challenge from the Azure access check %j", async extra => {
    const { client, auth } = await chooser();
    client.acquireTokenSilent.mockResolvedValue(token(ACCOUNT, GUEST));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: "interaction_required", ...extra } }, { status: 401 }));
    expect(await outcome(auth.selectDirectory!(DIR))).toBe("pending");
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({
      account: ACCOUNT, authority: `${AUTHORITY_HOST}/${GUEST}`, scopes: [SCOPE], state: "select-directory", ...extra,
    });
  });
  it("keeps the chooser open when the workspace probe rejects an explicitly entered directory", async () => {
    const { client, auth } = await chooser();
    client.acquireTokenSilent.mockResolvedValueOnce(token(ACCOUNT, GUEST));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "Azure access denied" } }, { status: 403 }));
    await expect(auth.selectDirectory!(DIR)).rejects.toThrow("Azure access denied");
    expect(auth.needsDirectory).toBe(true);
    await expect(auth.getToken()).rejects.toThrow("Choose an Azure directory");
  });
  it.each([ACCOUNT, PERSONAL])("uses the same home identity when entering a guest directory from $tenantId", async (user) => {
    const { client, auth } = await chooser(user);
    client.acquireTokenSilent.mockResolvedValueOnce(token(user, GUEST));
    await expect(auth.selectDirectory!(DIR)).resolves.toMatchObject({ tenantId: GUEST, tenantName: "Fabrikam" });
    expect(client.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({
      scopes: [SETTINGS.apiScope], authority: `${AUTHORITY_HOST}/${GUEST}`, account: user, cacheLookupPolicy: 3,
    }));
    expect(auth.needsDirectory).toBe(false);
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
    await expect(auth.selectDirectory!({ tenantId: HOME, displayName: "Contoso" })).rejects.toThrow("Sign out");
    await expect(auth.listDirectories!()).rejects.toThrow("Sign out");
  });

  it("restores an interactive selection through the callback and a normal reload", async () => {
    const { client, auth } = await chooser();
    window.history.replaceState(null, "", "/builder?session=saved");
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("consent_required", ""));
    expect(await outcome(auth.selectDirectory!(DIR))).toBe("pending");
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({ account: ACCOUNT, authority: `${AUTHORITY_HOST}/${GUEST}`, scopes: [SCOPE], state: "select-directory" });
    const granted = token(ACCOUNT, GUEST);
    client.handleRedirectPromise.mockResolvedValueOnce({ ...granted, state: "select-directory" });
    window.history.replaceState(null, "", "/");
    const back = build(client).auth;
    await expect(back.ready()).resolves.toMatchObject({ tenantId: GUEST, tenantName: "Fabrikam" });
    expect(window.location.pathname + window.location.search).toBe("/builder?session=saved");
    client.getAccount.mockImplementation(({ tenantId }) => tenantId === GUEST ? granted.account : ACCOUNT);
    const reload = build(client).auth;
    await expect(reload.ready()).resolves.toMatchObject({ tenantId: GUEST, tenantName: "Fabrikam" });
    expect(reload.needsDirectory).toBe(false);
  });

  it("rechecks Azure access after a directory-specific interactive grant and keeps the chooser on denial", async () => {
    const { client, auth } = await chooser();
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("consent_required", ""));
    expect(await outcome(auth.selectDirectory!(DIR))).toBe("pending");
    client.handleRedirectPromise.mockResolvedValueOnce({ ...token(ACCOUNT, GUEST), state: "select-directory" });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "No Azure resource access" } }, { status: 403 }));
    const back = build(client).auth;
    await expect(back.ready()).resolves.toMatchObject({ tenantId: HOME });
    expect(back.needsDirectory).toBe(true);
    expect(back.directoryError).toContain("No Azure resource access");
    expect(client.acquireTokenRedirect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "cancelled", error: new Error("Access denied"), returned: null },
    { name: "abandoned", error: null, returned: null },
    { name: "wrong tenant", error: null, returned: { ...token(), state: "select-directory" } },
    { name: "wrong identity", error: null, returned: { ...token({ ...ACCOUNT, homeAccountId: "else" }, GUEST), state: "select-directory" } },
    { name: "unrelated redirect", error: null, returned: { ...token(ACCOUNT, GUEST), state: "list-directories" } },
  ])("returns to the original identity's chooser after a $name selection", async ({ error, returned }) => {
    const { client, auth } = await chooser();
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("consent_required", ""));
    expect(await outcome(auth.selectDirectory!(DIR))).toBe("pending");
    if (error) client.handleRedirectPromise.mockRejectedValueOnce(error);
    else client.handleRedirectPromise.mockResolvedValueOnce(returned);
    const back = build(client).auth;
    await expect(back.ready()).resolves.toMatchObject({ tenantId: HOME });
    expect(back.needsDirectory).toBe(true);
    expect(back.directoryError).toBeTruthy();
    await expect(back.getToken()).rejects.toThrow("Choose an Azure directory");
  });
});

describe("workspace tokens", () => {
  it.each([
    { name: "cached", request: {}, policy: 2 },
    { name: "fresh", request: { refresh: true }, policy: 3 },
  ])("asks only the chosen tenant for a $name token", async ({ request, policy }) => {
    const { client, auth } = await selected();
    client.acquireTokenSilent.mockResolvedValue(token(ACCOUNT, GUEST));
    await expect(auth.getToken(request)).resolves.toBe("access-1");
    expect(client.acquireTokenSilent).toHaveBeenCalledWith({ scopes: [SETTINGS.apiScope], authority: `${AUTHORITY_HOST}/${GUEST}`, account: token(ACCOUNT, GUEST).account, cacheLookupPolicy: policy });
  });

  it.each([
    token(ACCOUNT, HOME), token({ ...ACCOUNT, homeAccountId: "else" }, GUEST), { ...token(ACCOUNT, GUEST), authority: AUTHORITY_HOST + "/common" },
  ])("rejects a token with a different issuing tenant or identity", async (result) => {
    const { client, auth } = await selected();
    client.acquireTokenSilent.mockResolvedValue(result);
    await expect(auth.getToken()).rejects.toThrow("different account or directory");
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it.each([{}, { claims: "extra-policy-claims" }])("keeps the chosen authority and claims on interactive renewal", async (request) => {
    const { client, auth } = await selected();
    client.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("interaction_required", ""));
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    expect(await outcome(auth.getToken(request))).toBe("pending");
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({
      account: token(ACCOUNT, GUEST).account, authority: `${AUTHORITY_HOST}/${GUEST}`, scopes: [SCOPE], state: "workspace", ...request,
    });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBe(DEEP_LINK);
  });

  it("reports an ordinary token service failure without redirecting", async () => {
    const { client, auth } = await selected();
    client.acquireTokenSilent.mockRejectedValue(new Error("network down"));
    await expect(auth.getToken()).rejects.toThrow("network down");
    expect(client.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it("refuses to ask for a token before sign-in", async () => {
    await expect(build().auth.getToken()).rejects.toThrow("Nobody is signed in.");
  });
});

describe("sign-in and logout", () => {
  it("requests only identity on the initial common-authority login", async () => {
    const { client, auth } = build();
    window.history.replaceState(null, "", `/${DEEP_LINK}`);
    await auth.signIn();
    expect(client.loginRedirect).toHaveBeenCalledWith({ scopes: ["openid", "profile"], authority: `${AUTHORITY_HOST}/common`, prompt: "select_account" });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBe(DEEP_LINK);
  });

  it("re-authenticates an expired workspace in the same tenant", async () => {
    const { client, auth } = await selected();
    window.history.replaceState(null, "", `/?tenant=${HOME}`);
    await auth.signIn();
    expect(client.loginRedirect).toHaveBeenCalledWith(expect.objectContaining({ account: token(ACCOUNT, GUEST).account, authority: `${AUTHORITY_HOST}/${GUEST}`, scopes: [SCOPE] }));
  });

  it("retains the directory on cache loss until the user explicitly signs out", async () => {
    const { client } = await selected();
    client.getAccount.mockReturnValue(null);
    const reload = build(client).auth;
    await expect(reload.ready()).rejects.toThrow("saved sign-in expired");
    await reload.signIn();
    expect(client.loginRedirect).toHaveBeenLastCalledWith(expect.objectContaining({ authority: `${AUTHORITY_HOST}/${GUEST}` }));
    await reload.signOut();
    await reload.signIn();
    expect(client.loginRedirect).toHaveBeenLastCalledWith(expect.objectContaining({ authority: `${AUTHORITY_HOST}/common` }));
  });

  it.each([
    { tenant: GUEST, authority: GUEST }, { tenant: CONSUMERS_TENANT_ID, authority: "common" },
    { tenant: "contoso.com", authority: "common" }, { tenant: "https://example.test/", authority: "common" },
  ])("uses only an organizational directory ID on a workspace link for bootstrap: $tenant", async ({ tenant, authority }) => {
    const { client, auth } = build();
    window.history.replaceState(null, "", `/?tenant=${encodeURIComponent(tenant)}`);
    await auth.signIn();
    expect(client.loginRedirect).toHaveBeenCalledWith({ scopes: ["openid", "profile"], authority: `${AUTHORITY_HOST}/${authority}`, prompt: "select_account" });
    client.handleRedirectPromise.mockResolvedValueOnce({ account: { ...ACCOUNT, tenantId: GUEST } });
    await auth.ready();
    expect(auth.needsDirectory).toBe(true);
    await expect(auth.getToken()).rejects.toThrow("Choose an Azure directory");
  });

  it.each([
    { address: DEEP_LINK, keep: false },
    { address: `?tenant=${GUEST}&session=topic`, keep: false },
    { address: `?tenant=${HOME}&session=topic`, keep: true },
  ])("logs out without restoring a cached user and preserves only a link to a different tenant: $address", async ({ address, keep }) => {
    const { client, auth } = await selected();
    window.history.replaceState(null, "", "/" + address);
    await auth.signOut();
    expect(client.logoutRedirect).toHaveBeenCalledWith({ account: token(ACCOUNT, GUEST).account });
    expect(window.sessionStorage.getItem("health-pulse-return-query")).toBe(keep ? address : null);
    expect(auth.account).toBeNull();
    const reload = build(client).auth;
    await expect(reload.ready()).resolves.toBeNull();
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
