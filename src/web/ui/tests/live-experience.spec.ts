import { expect, test as base } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import type { AuthConfig, HealthModel, ModelCatalog, ModelRef, SessionSummary, TaskSummary } from "../src/model/types";

// Runs against the deployed app (LIVE_BASE_URL, see playwright.live.config.ts), which reads the real Azure
// health models. `@live-readonly` tests change nothing and cost no model tokens. `@live-mutation` tests send a
// health report and run an Explain Task, so they run only with LIVE_INCLUDE_MUTATION=1. Nothing here clicks Apply.
//
// A deployment in Entra mode (`GET /api/config` says `entra`) needs a signed-in browser, which cannot be had unattended:
// LIVE_STORAGE_STATE names a Playwright storage state saved after a sign-in (its Entra cookies let each page sign in
// again without a prompt). The tests read the API with the bearer token the app itself sends on its first call. Without
// that file every test skips and says why. A deployment without sign-in, or one that predates `/api/config`, needs nothing.

interface Access {
  readonly mode: AuthConfig["authMode"];
  /** The Authorization header the signed-in app sent, for the checks that read the API directly. */
  readonly bearer: string | null;
  readonly needsSignIn: boolean;
}

async function accessOf(baseURL: string, browser: import("@playwright/test").Browser): Promise<Access> {
  let mode: AuthConfig["authMode"] = "local";
  try {
    const answer = await fetch(new URL("/api/config", baseURL), { headers: { Accept: "application/json" } });
    const config = (await answer.json()) as Partial<AuthConfig>;
    if (config.authMode === "entra") mode = "entra";
  } catch {
    // No answer, or the app shell of a build that has no such route: nobody signs in.
  }
  if (mode === "local") return { mode, bearer: null, needsSignIn: false };
  const storageState = process.env.LIVE_STORAGE_STATE;
  if (!storageState) return { mode, bearer: null, needsSignIn: true };
  const context = await browser.newContext({ storageState });
  try {
    const page = await context.newPage();
    const called = page.waitForRequest((request) => /\/api\/(?!config)/.test(request.url()) && "authorization" in request.headers(), { timeout: 60_000 });
    await page.goto(baseURL);
    return { mode, bearer: (await called).headers()["authorization"] ?? null, needsSignIn: false };
  } finally {
    await context.close();
  }
}

// Worked out once per worker: a worker fixture cannot read the baseURL, so the first test that needs it does it.
let access: Promise<Access> | null = null;

const test = base.extend<{ access: Access }>({
  access: async ({ browser, baseURL }, use) => {
    access ??= accessOf(baseURL!, browser);
    await use(await access);
  },
  request: async ({ playwright, baseURL, access }, use) => {
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: access.bearer ? { Authorization: access.bearer } : {} });
    await use(context);
    await context.dispose();
  },
});

test.beforeEach(({ access }) => {
  test.skip(access.needsSignIn, "the deployment signs users in (Entra): set LIVE_STORAGE_STATE to a storage state saved after signing in");
});

const LAYOUTS = [
  "dagre-tb",
  "dagre-bt",
  "dagre-lr",
  "dagre-rl",
  "elk-layered",
  "elk-radial",
  "d3-force",
  "d3-force-adaptive",
] as const;

interface Findings {
  readonly console: string[];
  readonly csp: string[];
  readonly failed: string[];
  readonly pageErrors: string[];
  readonly rejections: string[];
}

/** Listens for everything a visitor never sees but a deployment must not do; read it with `findings()`. */
async function watch(page: Page): Promise<() => Promise<Findings>> {
  const seen: Findings = { console: [], csp: [], failed: [], pageErrors: [], rejections: [] };
  page.on("console", (message) => {
    if (message.type() === "error") seen.console.push(message.text());
  });
  page.on("pageerror", (error) => seen.pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "failed";
    // Leaving a Task closes its event stream, which the browser reports as aborted.
    if (reason === "net::ERR_ABORTED" && request.url().includes("/events")) return;
    seen.failed.push(`${request.method()} ${request.url()} ${reason}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("favicon")) {
      seen.failed.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  await page.addInitScript(() => {
    const store = window as unknown as { __csp: string[]; __rejections: string[] };
    store.__csp = [];
    store.__rejections = [];
    document.addEventListener("securitypolicyviolation", (event) => store.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    window.addEventListener("unhandledrejection", (event) => store.__rejections.push(String(event.reason)));
  });
  return async () => {
    const inPage = await page.evaluate(() => {
      const store = window as unknown as { __csp?: string[]; __rejections?: string[] };
      return { csp: store.__csp ?? [], rejections: store.__rejections ?? [] };
    });
    return { ...seen, ...inPage };
  };
}

const CLEAN: Findings = { console: [], csp: [], failed: [], pageErrors: [], rejections: [] };

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), `${path} answers`).toBe(200);
  return (await response.json()) as T;
}

const catalogOf = (request: APIRequestContext): Promise<ModelCatalog> => json<ModelCatalog>(request, "/api/health-models");

function selector(model: Pick<ModelRef, "name" | "resourceGroup" | "subscriptionId">): string {
  return new URLSearchParams({ model: model.name, resourceGroup: model.resourceGroup, subscription: model.subscriptionId }).toString();
}

function modelOf(request: APIRequestContext, model: ModelRef): Promise<HealthModel> {
  return json<HealthModel>(request, `/api/health-model?${selector(model)}`);
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}`);
  await expect(page.getByTestId("model-name")).not.toHaveText("Health Pulse", { timeout: 30_000 });
}

/** The Session and the Done Tasks of one type the deployment already holds, or null. */
async function existing(request: APIRequestContext, type: "explain" | "review"): Promise<{ session: SessionSummary; task: TaskSummary } | null> {
  const { sessions } = await json<{ sessions: SessionSummary[] }>(request, "/api/sessions");
  for (const session of sessions) {
    const detail = await json<{ tasks: TaskSummary[] }>(request, `/api/sessions/${session.id}`);
    const task = detail.tasks.find((item) => item.type === type && item.status === "done");
    if (task) return { session, task };
  }
  return null;
}

const noHorizontalScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe("@live-readonly the shell and the catalog", () => {
  test("@live-readonly serves one script, a strict policy and a clean first load", async ({ page, request }) => {
    const findings = await watch(page);
    const shell = await request.get("/");
    expect(shell.status()).toBe(200);
    expect((await shell.text()).match(/<script\b[^>]*\bsrc=/g) ?? []).toHaveLength(1);
    const policy = shell.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).not.toContain("frame-src");

    await page.goto("/");
    await expect(page.getByTestId("status-bar")).toBeVisible();
    await expect(page.getByTestId("model-name")).not.toHaveText("Health Pulse", { timeout: 30_000 });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-readonly lists every model the app can read and opens the default one", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.map((model) => model.name)).toContain(catalog.default.name);

    await page.goto("/");
    await expect(page.getByTestId("model-name")).toHaveText(catalog.default.name, { timeout: 30_000 });
    await expect(page.getByTestId("model-picker-selected")).toContainText(catalog.default.name);
    await page.getByTestId("model-picker-search").click();
    for (const model of catalog.models) {
      await expect(page.getByTestId(`model-picker-option-${model.subscriptionId}/${model.resourceGroup}/${model.name}`)).toBeVisible();
    }
  });
});

test.describe("@live-readonly the models", () => {
  test("@live-readonly draws every model of the catalog from its address, with a node per entity", async ({ page, request }) => {
    const findings = await watch(page);
    const catalog = await catalogOf(request);
    for (const model of catalog.models) {
      const entities = (await modelOf(request, model)).entities.filter((entity) => entity.healthState !== "Deleted");
      await open(page, selector(model));
      await expect(page.getByTestId("model-name")).toHaveText(model.name);
      await expect(page.getByTestId("model-picker-selected")).toContainText(model.name);
      if (entities.length === 0) {
        await expect(page.getByTestId("topology-placeholder")).toBeVisible();
        await expect(page.getByTestId("status-error")).toHaveCount(0);
        continue;
      }
      await expect(page.locator(".react-flow__node")).toHaveCount(entities.length);
      expect(await page.locator(".react-flow__node").first().isVisible()).toBe(true);
    }
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-readonly switches models with the picker and keeps the address in step", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    test.skip(catalog.models.length < 2, "needs two models");
    await page.goto("/");
    await expect(page.getByTestId("model-name")).toHaveText(catalog.default.name, { timeout: 30_000 });
    const other = catalog.models.find((model) => model.name !== catalog.default.name)!;
    await page.getByTestId("model-picker-search").click();
    await page.getByTestId(`model-picker-option-${other.subscriptionId}/${other.resourceGroup}/${other.name}`).click();
    await expect(page.getByTestId("model-name")).toHaveText(other.name, { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`model=${other.name}`));
    await expect(page.getByTestId("entity-panel")).toHaveCount(0);
  });

  test("@live-readonly falls back to the default model for an address that names an unknown one", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    await page.goto(`/?model=no-such-model&resourceGroup=rg-nowhere&subscription=${catalog.default.subscriptionId}`);
    await expect(page.getByTestId("model-name")).toHaveText(catalog.default.name, { timeout: 30_000 });
    await expect(page.getByTestId("model-picker-unavailable-selection")).toContainText("no-such-model");
  });

  test("@live-readonly draws the default model in every layout without an error", async ({ page, request }) => {
    test.setTimeout(240_000);
    const findings = await watch(page);
    const catalog = await catalogOf(request);
    const expected = (await modelOf(request, catalog.models.find((model) => model.name === catalog.default.name)!)).entities.filter((entity) => entity.healthState !== "Deleted").length;
    await open(page, selector(catalog.default));
    for (const layout of LAYOUTS) {
      await page.getByTestId("layout-picker").selectOption(layout);
      await expect(page.getByTestId("layout-picker")).toHaveValue(layout);
      await page.waitForTimeout(layout === "d3-force-adaptive" ? 2500 : 800);
      await expect(page.locator(".react-flow__node")).toHaveCount(expected);
    }
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-readonly finds an entity by search and opens its panel with its transitions and report form", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    const model = await modelOf(request, catalog.models.find((item) => item.name === catalog.default.name)!);
    const target = model.entities.find((entity) => entity.displayName.length > 3 && entity.healthState !== "Deleted")!;
    await open(page, selector(catalog.default));
    await page.getByTestId("search-open").click();
    await page.getByTestId("search-input").fill(target.displayName.slice(0, 5));
    await expect(page.getByTestId("search-overlay")).toContainText(target.displayName);
    await page.keyboard.press("Escape");

    await page.locator(`.entity-node[data-entity="${target.name}"]`).first().click();
    await expect(page.getByTestId("entity-panel")).toBeVisible();
    await expect(page.getByTestId("entity-name")).toHaveText(target.displayName);
    await expect(page.getByText("Health-state transitions")).toBeVisible();
    await expect(page.getByText("Report health")).toBeVisible();
    await expect(page.getByTestId("quick-send")).toBeVisible();
    await expect(page.getByTestId("explain-entity")).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page.getByTestId("entity-panel")).toHaveCount(0);
  });

  test("@live-readonly refreshes the model on demand and reads the new observation", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    await open(page, selector(catalog.default));
    const before = await page.getByTestId("model-observed").innerText();
    await page.getByTestId("refresh-now").click();
    await expect(page.getByTestId("model-observed")).not.toHaveText(before, { timeout: 30_000 });
    await expect(page.getByTestId("status-error")).toHaveCount(0);
  });
});

test.describe("@live-readonly the Sessions workspace", () => {
  test("@live-readonly lists the Sessions newest first and opens one on its Tasks", async ({ page, request }) => {
    const findings = await watch(page);
    const { sessions } = await json<{ sessions: SessionSummary[] }>(request, "/api/sessions");
    test.skip(sessions.length === 0, "the deployment holds no Session");
    const catalog = await catalogOf(request);
    await open(page, selector(catalog.default));
    await page.getByTestId("workspace-toggle").click();
    await expect(page.getByTestId("session-list")).toBeVisible();

    const newest = [...sessions].sort((left, right) => Date.parse(right.lastTaskAt ?? right.createdAt) - Date.parse(left.lastTaskAt ?? left.createdAt));
    const listed = await page.getByTestId("session-list").getByRole("listitem").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(listed).toEqual(newest.map((session) => `session-row-${session.id}`));

    const first = newest[0]!;
    await page.getByTestId(`session-open-${first.id}`).click();
    await expect(page.getByTestId("session-title-heading")).toHaveText(first.title);
    await expect(page).toHaveURL(new RegExp(`session=${first.id}`));
    if (first.taskCount > 0) {
      await expect(page.getByTestId("task-list").getByRole("listitem")).toHaveCount(first.taskCount);
      await expect(page.getByTestId("session-tab-tasks")).toContainText(`(${first.taskCount})`);
    }
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-readonly offers the three Task types and states the design target from the catalog", async ({ page, request }) => {
    const { sessions } = await json<{ sessions: SessionSummary[] }>(request, "/api/sessions");
    test.skip(sessions.length === 0, "the deployment holds no Session");
    const catalog = await catalogOf(request);
    await open(page, `${selector(catalog.default)}&session=${sessions[0]!.id}`);
    await page.getByTestId("session-tab-new").click();
    await expect(page.getByTestId("task-form")).toBeVisible();
    for (const type of ["review", "explain", "design"]) await expect(page.getByTestId(`task-type-${type}`)).toBeVisible();

    await page.getByTestId("task-type-design").click();
    const design = catalog.models.find((model) => model.name === `${catalog.default.name}-design`);
    if (design) await expect(page.getByTestId("task-target")).toHaveValue(`${design.name} (${design.resourceGroup})`);
    await expect(page.getByTestId("task-workload")).toHaveValue(catalog.default.resourceGroup);
    await expect(page.getByTestId("task-submit")).toHaveText("Start Design");
  });

  test("@live-readonly shows a finished Explain with its cause chain, marks it on the graph and replays its timeline", async ({ page, request }) => {
    const findings = await watch(page);
    const found = await existing(request, "explain");
    test.skip(found === null, "the deployment holds no finished Explain");
    const { session, task } = found!;
    const full = await json<{ result: { causes: unknown[] } }>(request, `/api/sessions/${session.id}/tasks/${task.seq}`);
    const events = await (await request.get(`/api/sessions/${session.id}/tasks/${task.seq}/events`)).text();
    const count = (events.match(/^event: activity$/gm) ?? []).length;

    await open(page, `${selector(task.target)}&session=${session.id}&task=${task.seq}`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("explain-state")).toBeVisible();
    await expect(page.getByTestId("explain-summary")).not.toBeEmpty();
    await expect(page.getByTestId("explain-chain").getByRole("listitem")).toHaveCount(full.result.causes.length);
    // The chain is marked on the graph while the result is open, when its model is the one on screen.
    await expect(page.locator('.entity-node[data-chain="true"]').first()).toBeAttached();
    await expect(page.getByTestId("explain-off-screen")).toHaveCount(0);

    await page.getByTestId("task-tab-timeline").click();
    await expect(page.getByTestId("task-tab-timeline")).toContainText(`(${count})`);
    await expect(page.getByTestId("timeline")).toHaveAttribute("data-stream", /ended|live/);
    await expect(page.getByTestId("timeline-scroller").getByRole("listitem").first()).toBeVisible();
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-readonly shows a finished Review with its findings and nothing to Apply when it proposes nothing", async ({ page, request }) => {
    const findings = await watch(page);
    const found = await existing(request, "review");
    test.skip(found === null, "the deployment holds no finished Review");
    const { session, task } = found!;
    const diff = await json<{ changes: unknown[]; findings: unknown[]; verification: unknown[] }>(request, `/api/sessions/${session.id}/tasks/${task.seq}/diff`);

    await open(page, `${selector(task.target)}&session=${session.id}&task=${task.seq}`);
    await expect(page.getByTestId("diff-result")).toBeVisible();
    await expect(page.getByTestId("diff-summary")).not.toBeEmpty();
    if (diff.findings.length > 0) await expect(page.getByTestId("findings").getByRole("listitem")).toHaveCount(diff.findings.length);
    if (diff.verification.length > 0) await expect(page.getByTestId("verification-summary")).toBeVisible();
    if (diff.changes.length === 0) {
      await expect(page.getByTestId("change-list-empty")).toBeVisible();
    } else {
      await expect(page.getByTestId("change-list")).toBeVisible();
      // Apply writes to the live model: this run looks and never picks.
      await expect(page.getByTestId("apply-button")).toBeDisabled();
    }
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-readonly opens a Task from its address and again after a reload", async ({ page, request }) => {
    const found = await existing(request, "explain");
    test.skip(found === null, "the deployment holds no finished Explain");
    const { session, task } = found!;
    const query = `${selector(task.target)}&session=${session.id}&task=${task.seq}`;
    await open(page, query);
    await expect(page.getByTestId("task-title")).toHaveText(`Explain #${task.seq}`);
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
    await page.reload();
    await expect(page.getByTestId("task-title")).toHaveText(`Explain #${task.seq}`);
    await expect(page).toHaveURL(new RegExp(`session=${session.id}&task=${task.seq}`));
  });

  test("@live-readonly says so for an address that names a Session or Task that does not exist", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    await open(page, `${selector(catalog.default)}&session=000000000000`);
    await expect(page.getByTestId("session-error")).toBeVisible();
    const { sessions } = await json<{ sessions: SessionSummary[] }>(request, "/api/sessions");
    test.skip(sessions.length === 0, "the deployment holds no Session");
    await open(page, `${selector(catalog.default)}&session=${sessions[0]!.id}&task=999`);
    await expect(page.getByTestId("task-error")).toBeVisible();
  });
});

test.describe("@live-readonly the look", () => {
  test("@live-readonly switches between light and dark and keeps the graph readable in both", async ({ page, request }) => {
    const catalog = await catalogOf(request);
    await open(page, selector(catalog.default));
    const before = await page.locator("html").getAttribute("data-theme");
    const background = (): Promise<string> => page.getByTestId("app-shell").evaluate((element) => getComputedStyle(element).backgroundColor);
    const first = await background();
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", before ?? "");
    expect(await background()).not.toBe(first);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", before ?? "light");
  });

  test("@live-readonly fits a phone: no sideways scroll on the graph, the workspace or a result", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const findings = await watch(page);
    const catalog = await catalogOf(request);
    await open(page, selector(catalog.default));
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);

    const found = await existing(request, "explain");
    if (found) {
      await open(page, `${selector(found.task.target)}&session=${found.session.id}&task=${found.task.seq}`);
      await expect(page.getByTestId("explain-result")).toBeVisible();
      const box = await page.getByTestId("session-workspace").boundingBox();
      expect(box!.width).toBeLessThanOrEqual(390);
      expect(await noHorizontalScroll(page)).toBe(true);
      // The cause chain never makes the pane it sits in scroll sideways.
      const sideways = await page.getByTestId("explain-chain").evaluate((chain) => {
        const pane = (chain.closest('[role="tabpanel"]') ?? chain.parentElement) as HTMLElement;
        return pane.scrollWidth - pane.clientWidth;
      });
      expect(sideways).toBeLessThanOrEqual(1);
    }
    expect(await findings()).toEqual(CLEAN);
  });
});

test.describe("@live-mutation health reports and Tasks", () => {
  const entity = process.env.LIVE_REPORT_ENTITY ?? "session-storage";

  test("@live-mutation sends a 1 minute health report and follows the countdown to the refresh", async ({ page, request }) => {
    const findings = await watch(page);
    const catalog = await catalogOf(request);
    await open(page, selector(catalog.default));
    await page.locator(`.entity-node[data-entity="${entity}"]`).first().click();
    await expect(page.getByTestId("quick-send")).toBeVisible();
    await expect(page.locator("#report-expiry")).toHaveValue("1");
    await page.getByTestId("quick-send-Unhealthy").click();
    await expect(page.getByTestId("report-confirmation")).toContainText("accepted");
    await expect(page.getByTestId("refresh-countdown")).toBeVisible();
    await expect(page.getByTestId("refresh-countdown")).toHaveCount(0, { timeout: 30_000 });
    expect(await findings()).toEqual(CLEAN);
  });

  test("@live-mutation creates a Session and watches an Explain Task run to its result over the event stream", async ({ page, request }) => {
    test.setTimeout(240_000);
    const findings = await watch(page);
    const catalog = await catalogOf(request);
    await open(page, selector(catalog.default));
    await page.locator(`.entity-node[data-entity="${entity}"]`).first().click();
    await page.getByTestId("explain-entity").click();
    await page.getByTestId("session-title").fill("Playwright live check");
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("task-type-explain")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("task-submit")).toBeEnabled();
    await page.getByTestId("task-submit").click();

    await expect(page.getByTestId("task-title")).toHaveText("Explain #1");
    await expect(page.getByTestId("timeline-live")).toBeVisible();
    await expect(page.getByTestId("timeline-event-1")).toBeVisible();
    await expect(page.getByTestId("explain-result")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("explain-chain").getByRole("listitem").first()).toBeVisible();
    await expect(page).toHaveURL(/session=[^&]+&task=1/);
    expect(await findings()).toEqual(CLEAN);
  });
});
