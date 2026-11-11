import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page, Request, Route } from "@playwright/test";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import { MODEL_QUERY, SESSION_WITH_TASK } from "./workspaceHelpers";
import { SESSION_ID, catalogWithDesign, installWorkspace, reviewEvents } from "./workspaceStub";

// Entra mode, end to end in the browser: the real MSAL library runs the real redirect flow, and the Entra
// endpoints (`https://login.microsoftonline.com`) are answered here, so nothing leaves the machine. The app is served
// under the Content-Security-Policy the web app sends, so the origins MSAL needs are proved by the run itself.

const TENANT = "7f1c0b1e-0000-4000-8000-00000000aaaa";
const CLIENT = "c11e47aa-0000-4000-8000-00000000bbbb";
const SCOPE = `api://${CLIENT}/access_as_user`;
const AUTHORITY = "https://login.microsoftonline.com";
const OID = "5d0e0f2a-0000-4000-8000-00000000cccc";
const ENTRA_CONFIG = { authMode: "entra", tenantId: TENANT, clientId: CLIENT, apiScope: SCOPE } as const;
const CLAIMS = '{"access_token":{"acr":{"essential":true,"value":"c1"}}}';
const DEEP_LINK = `${MODEL_QUERY}&session=${SESSION_ID}&task=1`;

/** The policy of `src/web/app/config.py`, read from the declaration graph-ux.spec.ts keeps (a backend test compares them). */
function servedPolicy(): string {
  const spec = readFileSync(fileURLToPath(new URL("./graph-ux.spec.ts", import.meta.url)), "utf8");
  const declaration = /const SERVED_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/.exec(spec);
  if (!declaration) throw new Error("SERVED_CSP is no longer a plain string expression in graph-ux.spec.ts");
  return [...declaration[1]!.matchAll(/"([^"]*)"/g)].map((piece) => piece[1]).join("");
}

const b64url = (value: object | string): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/**
 * Sends the browser back to the app the way a browser arrives from Entra: a page that navigates, not a 302. Playwright
 * does not route the target of a fulfilled redirect, so a 302 would bring the app back without its policy.
 */
function comeBack(route: Route, location: string): Promise<void> {
  return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Redirecting</title><script>location.replace(${JSON.stringify(location)})</script>` });
}

interface Idp {
  /** Whether the user has a session with Entra: without one the sign-in page asks, and with one it grants at once. */
  session: boolean;
  /** The authorizations Entra granted, one per sign-in or interactive step. */
  readonly authorizations: URL[];
  /** How often Entra asked the user instead, because they had no session. */
  prompts: number;
  readonly tokenRequests: URLSearchParams[];
  readonly logouts: URL[];
  /** Every host the page asked other than its own: the origins the policy has to name. */
  readonly hosts: Set<string>;
}

/** A stand-in for the Entra endpoints MSAL calls in the auth code flow with PKCE: metadata, authorize, token and logout. */
async function installIdp(page: Page): Promise<Idp> {
  const idp: Idp = { session: true, prompts: 0, authorizations: [], tokenRequests: [], logouts: [], hosts: new Set() };
  const codes = new Map<string, { nonce: string; claims: string | null }>();

  await page.route(`${AUTHORITY}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    idp.hosts.add(url.origin);
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const json = (body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });
    const base = `${AUTHORITY}/${TENANT}`;

    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      await json({
        token_endpoint: `${base}/oauth2/v2.0/token`,
        token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt"],
        jwks_uri: `${base}/discovery/v2.0/keys`,
        response_modes_supported: ["query", "fragment", "form_post"],
        subject_types_supported: ["pairwise"],
        id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        issuer: `${base}/v2.0`,
        request_uri_parameter_supported: false,
        userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
        authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
        end_session_endpoint: `${base}/oauth2/v2.0/logout`,
        claims_supported: ["sub", "iss", "aud", "exp", "iat", "name", "preferred_username", "oid", "tid", "nonce"],
        tenant_region_scope: "EU",
        cloud_instance_name: "microsoftonline.com",
        cloud_graph_host_name: "graph.windows.net",
        msgraph_host: "graph.microsoft.com",
      });
      return;
    }

    if (url.pathname.endsWith("/discovery/instance")) {
      await json({
        tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
        "api-version": "1.1",
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      });
      return;
    }

    if (url.pathname.endsWith("/oauth2/v2.0/authorize")) {
      if (!idp.session && url.searchParams.get("__granted") !== "1") {
        idp.prompts += 1;
        // Entra asks who the user is: a page with one button, which grants the sign-in it was asked for.
        const fields = [...url.searchParams].map(([name, value]) => `<input type="hidden" name="${name}" value="${value.replaceAll('"', "&quot;")}">`).join("");
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><title>Sign in</title><form method="get" action="${url.origin}${url.pathname}">${fields}<input type="hidden" name="__granted" value="1"><button id="idp-sign-in">Sign in to Contoso</button></form>`,
        });
        return;
      }
      idp.authorizations.push(url);
      idp.session = true;
      const code = `code-${codes.size + 1}`;
      // MSAL always asks for id token claims; only a request for access token claims is a claims challenge.
      const asked = url.searchParams.get("claims");
      const challenge = asked !== null && "access_token" in (JSON.parse(asked) as object);
      codes.set(code, { nonce: url.searchParams.get("nonce") ?? "", claims: challenge ? asked : null });
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      const answer = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "", client_info: b64url({ uid: OID, utid: TENANT }) }).toString();
      const location = url.searchParams.get("response_mode") === "query" ? `${redirect.origin}${redirect.pathname}?${answer}` : `${redirect.origin}${redirect.pathname}#${answer}`;
      await comeBack(route, location);
      return;
    }

    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      const form = new URLSearchParams(request.postData() ?? "");
      idp.tokenRequests.push(form);
      const issued = codes.get(form.get("code") ?? "") ?? [...codes.values()].at(-1) ?? { nonce: "", claims: null };
      const now = Math.floor(Date.now() / 1000);
      const idToken = [
        b64url({ alg: "none", typ: "JWT" }),
        b64url({ iss: `${base}/v2.0`, sub: "subject-1", aud: CLIENT, exp: now + 3600, iat: now, nbf: now, name: "Ada Lovelace", preferred_username: "ada@contoso.com", oid: OID, tid: TENANT, nonce: issued.nonce, ver: "2.0" }),
        "signature",
      ].join(".");
      await json({
        token_type: "Bearer",
        scope: `openid profile offline_access ${SCOPE}`,
        expires_in: 3600,
        ext_expires_in: 3600,
        access_token: issued.claims ? "access-with-claims" : "access-1",
        refresh_token: "refresh-1",
        id_token: idToken,
        client_info: b64url({ uid: OID, utid: TENANT }),
      });
      return;
    }

    if (url.pathname.endsWith("/oauth2/v2.0/logout")) {
      idp.logouts.push(url);
      idp.session = false;
      await comeBack(route, url.searchParams.get("post_logout_redirect_uri") ?? "/");
      return;
    }

    await route.fulfill({ status: 404, headers: CORS, body: "" });
  });
  return idp;
}

interface ApiCall {
  readonly path: string;
  readonly authorization: string | null;
  readonly status: number;
}

interface Scenario {
  /** The API stops accepting the sign-in: every call answers 401 `unauthenticated`, token or not. */
  readonly rejectAll?: boolean;
  /** A Conditional Access policy that wants `CLAIMS` first: until a token carries them the API answers 401 `interaction_required`. */
  readonly challenge?: boolean;
}

/** The app's API in Entra mode: every call but `/api/config` needs the bearer token the Entra stand-in issues. */
async function installApi(page: Page, scenario: Scenario = {}): Promise<{ readonly calls: ApiCall[]; readonly challenges: () => number }> {
  await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign, authConfig: ENTRA_CONFIG });
  await installWorkspace(page, SESSION_WITH_TASK());
  const calls: ApiCall[] = [];
  let challenges = 0;

  // Registered last, so it sees every call first and passes the ones it accepts on to the stubs above.
  await page.route("**/api/**", async (route) => {
    const request: Request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/config") {
      await route.fallback();
      return;
    }
    const authorization = request.headers()["authorization"] ?? null;
    const refuse = async (status: number, code: string, extra: Record<string, unknown> = {}): Promise<void> => {
      calls.push({ path: pathname, authorization, status });
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message: `message of ${code}`, retryable: false, operationId: "op", ...extra } }) });
    };
    if (scenario.rejectAll || authorization === null || !/^Bearer access-(1|with-claims)$/.test(authorization)) {
      await refuse(401, "unauthenticated");
      return;
    }
    if (scenario.challenge && authorization !== "Bearer access-with-claims") {
      challenges += 1;
      await refuse(401, "interaction_required", { claims: CLAIMS });
      return;
    }
    calls.push({ path: pathname, authorization, status: 200 });
    if (pathname.endsWith("/events")) {
      // Answered here, from the app's own origin: the Session stub's event server is another origin, which the policy forbids.
      const frames = reviewEvents().map((event) => `id: ${event.seq}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `retry: 40\n\n${frames.join("")}event: done\ndata: {"status":"done"}\n\n` });
      return;
    }
    await route.fallback();
  });
  return { calls, challenges: () => challenges };
}

/** Serves the document under the policy the web app sends. The Entra stand-in answers its own origin. */
async function underPolicy(page: Page, baseURL: string, policy = servedPolicy()): Promise<{ readonly violations: string[] }> {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const origin = new URL(baseURL).origin;
  await page.route((url) => url.origin === origin && !url.pathname.startsWith("/api/"), async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = policy;
    await route.fulfill({ response, headers });
  });
  return { violations };
}

const inPage = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []);

test("no API call leaves without the bearer token, and the user menu shows who signed in", async ({ page, baseURL }) => {
  const policy = await underPolicy(page, baseURL!);
  const idp = await installIdp(page);
  const { calls } = await installApi(page);
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/events")) requested.push(request.headers()["authorization"] ?? "none");
  });

  // The address a visitor opens: the model, the Session and the Task. Signing in goes through Entra and back.
  await page.goto(`/?${DEEP_LINK}`);
  await expect(page.getByTestId("diff-result")).toBeVisible();
  await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();

  expect(idp.authorizations).toHaveLength(1);
  expect(idp.authorizations[0]!.searchParams.get("scope")).toContain(SCOPE);
  expect(idp.authorizations[0]!.searchParams.get("code_challenge_method")).toBe("S256");
  expect(idp.authorizations[0]!.searchParams.get("redirect_uri")).toBe(`${new URL(page.url()).origin}/`);
  expect(page.url()).toContain(`session=${SESSION_ID}&task=1`);
  expect(new URL(page.url()).searchParams.get("model")).toBe("hm-demo");
  expect(new URL(page.url()).searchParams.get("subscription")).toBe(SUBSCRIPTION_A);

  // Every call but the one that asks how to sign in carries the token, and none was refused for lacking it.
  expect(calls.length).toBeGreaterThan(3);
  for (const call of calls) expect(call, call.path).toMatchObject({ authorization: "Bearer access-1", status: 200 });
  expect([...new Set(calls.map((call) => call.path))]).toEqual(expect.arrayContaining(["/api/health-models", "/api/health-model", "/api/sessions/s-demo", "/api/sessions/s-demo/tasks/1", "/api/sessions/s-demo/tasks/1/diff", "/api/sessions/s-demo/tasks/1/events"]));
  // The activity stream is read with fetch, so it can send the header an EventSource cannot.
  expect(requested).toEqual(["Bearer access-1"]);

  await expect(page.getByTestId("user-name")).toHaveText("Ada Lovelace");
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-account")).toContainText("ada@contoso.com");
  await expect(page.getByTestId("user-account")).toContainText(`Tenant ${TENANT}`);
  await expect(page.getByTestId("sign-out")).toBeVisible();

  // MSAL asked one host besides the app, opened no frame, and the policy stopped nothing.
  expect([...idp.hosts]).toEqual([AUTHORITY]);
  expect(page.frames()).toHaveLength(1);
  expect(policy.violations).toEqual([]);
  expect(await inPage(page)).toEqual([]);
  // The token lives in session storage of the tab and never in local storage.
  const stored = await page.evaluate(() => ({ local: Object.keys(localStorage).join(" "), session: Object.keys(sessionStorage).length }));
  expect(stored.session).toBeGreaterThan(0);
  expect(stored.local).not.toMatch(/msal|token|access/i);
});

test("the policy is what lets MSAL reach Entra: without the authority in connect-src the sign-in fails", async ({ page, baseURL }) => {
  const policy = await underPolicy(page, baseURL!, servedPolicy().replace(` ${AUTHORITY}`, ""));
  await installIdp(page);
  await installApi(page);

  await page.goto("/");

  await expect(page.getByTestId("auth-failed")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toHaveCount(0);
  expect(policy.violations.some((message) => message.includes("connect-src") && message.includes(AUTHORITY))).toBe(true);
});

test("an address with no model in it still signs in and lands on the default model", async ({ page }) => {
  await installIdp(page);
  const { calls } = await installApi(page);

  await page.goto("/");

  await expect(page.getByTestId("model-name")).toHaveText("Contoso Platform Health");
  expect(calls.every((call) => call.authorization === "Bearer access-1")).toBe(true);
});

test("signing out leaves the app, and the next visit asks Entra who the user is", async ({ page, baseURL }) => {
  const idp = await installIdp(page);
  await installApi(page);
  await page.goto(`/?${MODEL_QUERY}`);
  await expect(page.getByTestId("user-menu")).toBeVisible();

  await page.getByTestId("user-menu").click();
  await page.getByTestId("sign-out").click();

  // Entra ends the session and the app, back at its root, finds nobody signed in: it is Entra that asks.
  await expect(page.locator("#idp-sign-in")).toBeVisible();
  expect(idp.logouts).toHaveLength(1);
  expect(idp.logouts[0]!.searchParams.get("post_logout_redirect_uri")).toBe(`${new URL(baseURL!).origin}/`);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("accesstoken") || key.includes("idtoken")).length)).toBe(0);

  expect(idp.prompts).toBe(1);

  await page.locator("#idp-sign-in").click();
  await expect(page.getByTestId("user-name")).toHaveText("Ada Lovelace");
  expect(idp.authorizations).toHaveLength(2);
});

test("a Conditional Access challenge sends the user through one interactive step and then goes on with the token it gets", async ({ page, baseURL }) => {
  const policy = await underPolicy(page, baseURL!);
  const idp = await installIdp(page);
  const api = await installApi(page, { challenge: true });

  await page.goto(`/?${DEEP_LINK}`);
  await expect(page.getByTestId("diff-result")).toBeVisible();

  // First sign-in without claims, then exactly one more authorization, the one that carries the claims the server named.
  expect(idp.authorizations).toHaveLength(2);
  const asked = idp.authorizations.map((url) => JSON.parse(url.searchParams.get("claims") ?? "{}") as Record<string, unknown>);
  expect(asked.map((claims) => "access_token" in claims)).toEqual([false, true]);
  expect(asked[1]).toMatchObject({ access_token: { acr: { essential: true, value: "c1" } } });
  expect(api.challenges()).toBeGreaterThanOrEqual(1);
  const answered = api.calls.filter((call) => call.status === 200);
  expect(answered.length).toBeGreaterThan(3);
  for (const call of answered) expect(call.authorization).toBe("Bearer access-with-claims");
  // The page that came back is on the address it left.
  expect(page.url()).toContain(`session=${SESSION_ID}&task=1`);
  expect(policy.violations).toEqual([]);
});

test("a sign-in the API stops accepting is retried once with a fresh token, then the page says so and signs in again on request", async ({ page }) => {
  const idp = await installIdp(page);
  const { calls } = await installApi(page, { rejectAll: true });

  await page.goto("/");

  await expect(page.getByTestId("catalog-error")).toContainText("Your sign-in is no longer accepted. Sign in again to go on.");
  // One try, then one retry with a token renewed from the refresh token, and no more.
  expect(calls.filter((call) => call.path === "/api/health-models")).toHaveLength(2);
  expect(idp.tokenRequests.map((form) => form.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
  expect(idp.authorizations).toHaveLength(1);

  await page.getByTestId("catalog-sign-in").click();
  await expect.poll(() => idp.authorizations.length).toBe(2);
});

test.describe("when signing in fails", () => {
  test("the page says so and offers to sign in again, and the app does not load", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign, authConfig: ENTRA_CONFIG });
    // Entra answers the sign-in with an error, as it does for a user who is not assigned to the app.
    await page.route(`${AUTHORITY}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ token_endpoint: `${AUTHORITY}/${TENANT}/oauth2/v2.0/token`, jwks_uri: `${AUTHORITY}/k`, issuer: `${AUTHORITY}/${TENANT}/v2.0`, authorization_endpoint: `${AUTHORITY}/${TENANT}/oauth2/v2.0/authorize`, end_session_endpoint: `${AUTHORITY}/${TENANT}/oauth2/v2.0/logout` }) });
      }
      if (url.pathname.endsWith("/discovery/instance")) {
        return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ tenant_discovery_endpoint: `${AUTHORITY}/${TENANT}/v2.0/.well-known/openid-configuration`, metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }] }) });
      }
      if (url.pathname.endsWith("/oauth2/v2.0/authorize")) {
        const redirect = url.searchParams.get("redirect_uri")!;
        const answer = new URLSearchParams({ error: "access_denied", error_description: "AADSTS50105: The signed in user is not assigned to a role for the application.", state: url.searchParams.get("state") ?? "" });
        return comeBack(route, `${redirect}#${answer.toString()}`);
      }
      return route.fulfill({ status: 404, headers: CORS, body: "" });
    });

    await page.goto("/");

    await expect(page.getByTestId("auth-failed")).toContainText("Sign-in failed");
    await expect(page.getByTestId("auth-failed-message")).toContainText("AADSTS50105");
    await expect(page.getByTestId("auth-retry")).toHaveText("Sign in again");
    await expect(page.getByTestId("status-bar")).toHaveCount(0);
  });

  test("the sign-in settings that cannot be loaded are said as such, and Try again loads them", async ({ page }) => {
    let up = false;
    await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign });
    await page.route("**/api/config", (route) =>
      up
        ? route.fallback()
        : route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "The app is starting.", retryable: true, operationId: "op" } }) }),
    );

    await page.goto("/");
    await expect(page.getByTestId("auth-failed")).toContainText("The sign-in settings could not be loaded");
    await expect(page.getByTestId("auth-failed-message")).toHaveText("The app is starting.");

    up = true;
    await page.getByTestId("auth-retry").click();
    await expect(page.getByTestId("status-bar")).toBeVisible();
    // Local mode: nobody signs in, so there is no menu.
    await expect(page.getByTestId("user-menu")).toHaveCount(0);
  });
});
