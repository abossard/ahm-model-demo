import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openView } from "./views";

// Runs against the real web app in its offline mode (see playwright.real.config.ts): real Sessions, a real
// event stream, the scripted agent and the two fixture models. Nothing here is stubbed.
// The tests share one process in order, because Apply writes the fixture model the next test reads.

const LIVE_MODEL = "hm-local";
// The question an Explain asks names the entity in the state it has (Degraded, Healthy, Unhealthy, or "the state ... unknown"), and
// no state while the answer is not there yet; the entity is "Orders API (reviewed)" once an Apply renamed it.
const ASKED = "(Orders API( \\(reviewed\\))? (Healthy|Degraded|Unhealthy|in this state)|the state of Orders API( \\(reviewed\\))? unknown)";
const EXPLAIN_TITLE = new RegExp(`^Why is ${ASKED}\\?$`);
const EXPLAIN_SESSION_TITLE = new RegExp(`^Why is ${ASKED}\\? \\(\\d{1,2} \\w{3} \\d{2}:\\d{2}\\)$`);
test.describe.configure({ mode: "serial" });

// The offline backend answers `GET /api/config` with `authMode: "local"`: nobody signs in. A backend that does not
// know the route yet answers with the app shell, and then the run answers for it and says so in the report.
test.beforeEach(async ({ page, request }) => {
  const answer = await request.get("/api/config");
  const config = answer.ok() ? ((await answer.json().catch(() => null)) as { authMode?: string } | null) : null;
  if (config?.authMode) {
    expect(config.authMode).toBe("local");
    return;
  }
  test.info().annotations.push({ type: "note", description: "the backend has no GET /api/config yet: this run answers it as local" });
  await page.route("**/api/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authMode: "local", clientId: null, apiScope: null }) }),
  );
});

const workspace = (page: Page): Locator => page.getByTestId("session-workspace");

function node(page: Page, graph: string, name: string): Locator {
  return page.getByTestId(graph).locator(`.entity-node[data-entity="${name}"]`);
}

async function boot(page: Page): Promise<void> {
  await openView(page, "zoom");
  await expect(page.getByTestId("model-name")).not.toHaveText("Health Pulse");
  await expect(node(page, "topology", "orders-api")).toBeVisible();
}

async function newSession(page: Page, title: string): Promise<void> {
  if (!(await workspace(page).isVisible())) await page.getByTestId("workspace-toggle").click();
  await page.getByTestId("session-title").fill(title);
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("session-title-heading")).toHaveText(title);
}

/** The ids the address carries once a Task is open. */
function openTaskIds(page: Page): { session: string; task: string } {
  const params = new URL(page.url()).searchParams;
  return { session: params.get("session") ?? "", task: params.get("task") ?? "" };
}

test("the security policy the app serves lets the UI style itself", async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __violations: string[] }).__violations = seen;
    document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} blocked ${event.blockedURI}`));
  });
  await boot(page);
  const violations = await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
  // Fluent adds its rules through empty style elements; style-src must carry their hash (see AC23 in graph-ux.spec.ts).
  expect(violations, "style-src of SECURITY_POLICY in src/web/app/config.py needs the hash of the empty style element").toEqual([]);
});

test("a Review streams to done, compares, applies one change and then finds the model changed", async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId("model-picker-selected")).toContainText(LIVE_MODEL);

  // Create a Session and run a Review: the timeline fills over the real event stream.
  await newSession(page, "Real backend review");
  await expect(page.getByTestId("task-target")).toHaveValue(`${LIVE_MODEL} (rg-local)`);
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-title")).toHaveText("Check hm-local");
  await expect(page.getByTestId("timeline-event-1")).toBeVisible();
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("diff-result")).toBeVisible();
  await expect(page).toHaveURL(/session=[^&]+&task=1/);
  await expect(page.getByTestId("change-select-c1")).toBeVisible();
  await expect(page.getByTestId("change-select-c3")).toBeVisible();

  // Every step of the scripted run reached the timeline, in order, once.
  await page.getByTestId("task-tab-timeline").click();
  await expect(page.getByTestId("timeline-event-15")).toBeVisible();
  await expect(page.locator("[data-testid^=timeline-event-]")).toHaveCount(15);
  await page.getByTestId("task-tab-result").click();

  // Compare: the Proposed model has the queue the Base model lacks.
  await page.getByTestId("compare-toggle").click();
  await expect(page.getByTestId("graph-base")).toBeVisible();
  await expect(node(page, "graph-base", "orders-api")).toBeVisible();
  await expect(node(page, "graph-base", "order-queue")).toHaveCount(0);
  await expect(node(page, "graph-proposed", "order-queue")).toHaveAttribute("data-badge", "added");
  await expect(node(page, "graph-proposed", "orders-api")).toHaveAttribute("data-badge", "changed");

  // Apply one change: the live model shows it once the pane returns to the model on screen.
  await page.getByTestId("change-select-c1").click();
  await expect(page.getByTestId("apply-button")).toHaveText("Apply 1 change");
  await page.getByTestId("apply-button").click();
  await expect(page.getByTestId("apply-dialog-target")).toHaveText(`${LIVE_MODEL} (rg-local)`);
  await page.getByTestId("apply-confirm").click();
  await expect(page.getByTestId("apply-result")).toHaveAttribute("data-outcome", "applied");
  await expect(page.getByTestId("change-applied-c1")).toBeVisible();
  await page.getByTestId("compare-exit").click();
  await expect(node(page, "topology", "orders-api")).toContainText("Orders API (reviewed)");

  // The live model moved on, so the next Apply of this Review is refused.
  await page.getByTestId("change-select-c2").click();
  await page.getByTestId("apply-button").click();
  await page.getByTestId("apply-confirm").click();
  await expect(page.getByTestId("apply-result")).toHaveAttribute("data-outcome", "base_changed");

  // The same refusal over HTTP for the selection that was applied.
  const { session, task } = openTaskIds(page);
  const again = await page.request.post(`/api/sessions/${session}/tasks/${task}/apply`, { data: { changeIds: ["c1"] } });
  expect(again.status()).toBe(409);
  expect((await again.json()).error.code).toBe("base_changed");

  // The way out is a new Review of the changed model, started by the one click.
  await page.getByTestId("apply-new-review").click();
  await expect(page.getByTestId("task-title")).toHaveText("Check hm-local");
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
});

test("one click on Explain this entity makes the Session, runs the Task and marks its chain on the graph", async ({ page }) => {
  await boot(page);
  await node(page, "topology", "orders-api").click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await page.getByTestId("explain-entity").click();

  // No other click: the Session, the Task and its result.
  await expect(workspace(page)).toBeVisible();
  await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("explain-result")).toBeVisible();
  await expect(page.getByTestId("result-heading")).toContainText("orders-api is degraded");
  await expect(page.getByTestId("explain-state")).toContainText("Degraded");
  await expect(node(page, "topology", "orders-api")).toHaveAttribute("data-chain", "true");
  await expect(node(page, "topology", "payments")).not.toHaveAttribute("data-chain", "true");
  await expect(page.getByTestId("session-title-heading")).toHaveText(EXPLAIN_SESSION_TITLE);
  await expect(page).toHaveURL(/session=[^&]+&task=1/);
  const { session } = openTaskIds(page);

  // The Session and the Task are real: they are in the Session list with their whole Activity timeline, and a reload opens the same Task.
  const listed = await (await page.request.get("/api/sessions")).json();
  expect(listed.sessions.find((item: { id: string; taskCount: number }) => item.id === session)?.taskCount).toBe(1);
  await page.getByTestId("task-tab-timeline").click();
  await expect(page.locator("[data-testid^=timeline-event-][data-kind=tool_call]").first()).toBeVisible();
  await expect(page.locator("[data-testid^=timeline-event-][data-kind=result]")).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
  await expect(page.getByTestId("explain-result")).toBeVisible();

  // The Task instruction is the secondary way in: the form opens on the entity, and sending it adds a Task to the same Session.
  await page.getByTestId("task-back").click();
  await node(page, "topology", "orders-api").click();
  await page.getByTestId("explain-add-instruction").click();
  await expect(page.getByTestId("task-type-explain")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("task-entity")).toHaveValue(/Orders API/);
  await page.getByTestId("task-instruction-input").fill("Why is it degraded?");
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
  await expect(page.getByTestId("task-instruction")).toContainText("Why is it degraded?");
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
});

test("a question about a past moment reaches the app and the assistant with that moment, and a model check started then is about now", async ({ page }) => {
  await boot(page);
  await node(page, "topology", "orders-db").click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await expect(page.getByTestId("tl-busy")).toHaveCount(0);
  // Now the database is Unhealthy. Twelve hours ago, in the history of the fixture model, it was Healthy.
  await expect(page.getByTestId("explain-entity")).toHaveText("Why is Orders database Unhealthy?");
  const plot = await page.getByTestId("tl-canvas").boundingBox();
  if (!plot) throw new Error("no plot");
  await page.mouse.click(plot.x + plot.width / 2, plot.y + 110);
  await expect(page.getByTestId("moment-bar")).toBeVisible();
  await expect(page.getByTestId("moment-shown")).toHaveText(/^Showing .*, (11|12) h( \d{1,2} min)? ago$/);
  await expect(node(page, "topology", "orders-db")).toHaveAttribute("aria-label", /\(Healthy/);
  await expect(page.getByTestId("explain-entity")).toHaveText(/^Why was Orders database Healthy at (\d{1,2} \w{3} )?\d{2}:\d{2}\?$/);
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).not.toBeNull();
  const at = Date.parse(new URL(page.url()).searchParams.get("at") ?? "");

  await page.getByTestId("explain-entity").click();

  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("task-title")).toHaveText(/^Why was Orders database Healthy at \d{1,2} \w{3} \d{2}:\d{2}\?$/);
  await expect(page.getByTestId("session-title-heading")).toHaveText(/^Why was Orders database Healthy at .+\? \(\d{1,2} \w{3} \d{2}:\d{2}\)$/);
  await expect(page.getByTestId("explain-state-label")).toHaveText(/^State at \d{1,2} \w{3} \d{2}:\d{2}$/);
  await expect(page.getByTestId("explain-state")).toContainText("Healthy");
  await expect(page.getByTestId("explain-moment")).toContainText("The state now may differ.");
  await expect(page.getByTestId("explain-window")).toContainText("the last 24 hours (until");

  // The app keeps the moment with the question, and the scripted assistant read the model as it was then.
  const { session, task } = openTaskIds(page);
  const stored = await (await page.request.get(`/api/sessions/${session}/tasks/${task}`)).json();
  expect(Math.abs(Date.parse(stored.asOf) - at)).toBeLessThan(1000);
  expect(stored.result).toMatchObject({ state: "Healthy", causes: [], window: { to: stored.asOf } });
  const stream = await (await page.request.get(`/api/sessions/${session}/tasks/${task}/events`)).text();
  const read = stream
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { kind?: string; payload?: { name?: string; arguments?: string } })
    .find((event) => event.kind === "tool_call" && event.payload?.name === "monitor_healthmodels_inspect");
  expect(JSON.parse(read?.payload?.arguments ?? "{}")).toMatchObject({ entity: "orders-db", timestamp: stored.asOf, "end-at": stored.asOf, "start-at": stored.result.window.from });

  // A reload shows the same moment and the same answer.
  await page.reload();
  await expect(page.getByTestId("moment-bar")).toBeVisible();
  await expect(page.getByTestId("explain-moment")).toBeVisible();
  await expect(node(page, "topology", "orders-db")).toHaveAttribute("aria-label", /\(Healthy/);

  // A model check is about now: the menu says so, the Task names no moment, and the app takes none for one.
  await page.getByTestId("task-menu").click();
  await expect(page.getByTestId("menu-review")).toContainText("as it is now");
  await page.getByTestId("menu-review").click();
  await expect(page.getByTestId("task-title")).toHaveText("Check hm-local");
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  const check = openTaskIds(page);
  expect(await (await page.request.get(`/api/sessions/${check.session}/tasks/${check.task}`)).json()).not.toHaveProperty("asOf");
  const refused = await page.request.post(`/api/sessions/${check.session}/tasks`, { data: { type: "review", target: stored.target, asOf: stored.asOf } });
  expect([refused.status(), (await refused.json()).error.code]).toEqual([400, "invalid_as_of"]);

  await page.getByTestId("moment-now").click();
  await expect(page.getByTestId("moment-bar")).toHaveCount(0);
  await expect(node(page, "topology", "orders-db")).toHaveAttribute("aria-label", /\(Unhealthy/);
});

test("a Design targets the design model and proposes its entities as a diff", async ({ page }) => {
  await boot(page);
  await newSession(page, "Real backend design");
  await page.getByTestId("task-type-design").click();
  await expect(page.getByTestId("task-target")).toHaveValue("hm-local-design (rg-local)");
  await expect(page.getByTestId("task-workload")).toHaveValue("rg-local");
  await page.getByTestId("task-repository").fill("https://github.com/contoso/orders");
  await page.getByTestId("task-submit").click();

  await expect(page.getByTestId("task-title")).toHaveText("Design for contoso/orders");
  await expect(page.getByTestId("task-target")).toContainText("hm-local-design");
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("diff-result")).toBeVisible();
  await expect(page.getByTestId("change-c2")).toContainText("catalog-api");

  // The design model is not the one on screen: the comparison draws both sides from the diff itself.
  await page.getByTestId("compare-toggle").click();
  await expect(node(page, "graph-proposed", "catalog-api")).toHaveAttribute("data-badge", "added");
  await expect(node(page, "graph-base", "catalog-api")).toHaveCount(0);

  // The Apply dialog names the design model, never the live one.
  await page.getByTestId("select-all").click();
  await page.getByTestId("apply-button").click();
  await expect(page.getByTestId("apply-dialog-target")).toHaveText("hm-local-design (rg-local)");
  await page.getByTestId("apply-cancel").click();
});

test("the timeline reads the model's history through the real app in tiles, and a tile that closed is confirmed instead of sent again", async ({ page }) => {
  const answers: { url: URL; status: number }[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/timeline") answers.push({ url, status: response.status() });
  });
  await boot(page);
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await page.getByTestId("tl-expand-all").click();
  await expect(page.getByTestId("tl-label-signal").first()).toBeVisible();
  await expect.poll(() => answers.some((answer) => answer.url.searchParams.get("include") === "signals" && answer.status === 200)).toBe(true);

  // Every window begins and ends on a day (a week for the states), so the same window is always the same address.
  const DAY = 86_400_000;
  for (const { url } of answers) {
    expect(Date.parse(url.searchParams.get("from") ?? "") % DAY, url.search).toBe(0);
    expect(Date.parse(url.searchParams.get("to") ?? "") % DAY, url.search).toBe(0);
  }
  expect(answers.every((answer) => answer.status === 200)).toBe(true);
  await expect(page.getByTestId("tl-retry")).toHaveCount(0);

  // A day that is over: the app says the browser may keep it, and the second time only confirms it.
  const today = Math.floor(Date.now() / DAY) * DAY;
  const closed = `/api/timeline?model=${LIVE_MODEL}&resourceGroup=rg-local&subscription=00000000-0000-0000-0000-000000000000&from=${new Date(today - 2 * DAY).toISOString()}&to=${new Date(today - DAY).toISOString()}&include=signals&entity=orders-db`;
  const read = await page.evaluate(async (target) => {
    const first = await fetch(target);
    const one = await first.text();
    const second = await fetch(target);
    const same = (await second.text()) === one;
    const asked = await fetch(target, { headers: { "If-None-Match": first.headers.get("etag") ?? "" } });
    const sizes = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((entry) => entry.name.endsWith(target)).map((entry) => entry.transferSize);
    return { caching: first.headers.get("cache-control"), tagged: first.headers.get("etag") !== null, same, asked: asked.status, sizes, points: (JSON.parse(one) as { series: { points: unknown[] }[] }).series[0]?.points.length ?? 0 };
  }, closed);

  expect(read).toMatchObject({ caching: "private, no-cache", tagged: true, same: true, asked: 304 });
  expect(read.points).toBeGreaterThan(10);
  // The browser's own second read went to the app and came back without a body: a few hundred bytes of headers.
  expect(read.sizes[1]).toBeGreaterThan(0);
  expect(read.sizes[1]).toBeLessThan((read.sizes[0] ?? 0) / 5);
});
