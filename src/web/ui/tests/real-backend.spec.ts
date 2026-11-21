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
  const events = page.locator("[data-testid^=timeline-event-]");
  const { session: reviewSession, task: reviewTask } = openTaskIds(page);
  const review = await (await page.request.get(`/api/sessions/${reviewSession}/tasks/${reviewTask}`)).json();
  const count = 15 + 2 * Object.keys(review.result.showMe).length;
  await expect(events.last()).toHaveAttribute("aria-setsize", String(count));
  const stream = await (await page.request.get(`/api/sessions/${reviewSession}/tasks/${reviewTask}/events`)).text();
  const sequences = stream.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)).seq);
  expect(sequences).toEqual(Array.from({ length: count }, (_, i) => i + 1));
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

/** Hit-test the visible part so a target hidden under the phone sheet cannot pass. */
async function expectExposed(target: Locator) {
  await expect(target).toBeInViewport();
  await expect.poll(() => target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    return [0.3, 0.6].some(fraction =>
      element.contains(document.elementFromPoint((left + right) / 2, top + fraction * (bottom - top))));
  })).toBe(true);
}

test("Show me advertises destinations, restores inline buttons and reveals the target beside the answer", async ({ page }) => {
  await boot(page);
  await newSession(page, "Show me this finding");
  const post = page.waitForRequest(req => req.method() === "POST" && /\/tasks$/.test(new URL(req.url()).pathname));
  await page.getByTestId("task-submit").click();
  const offered = (await post).postDataJSON().showMeHandles;
  expect(offered).toEqual([
    expect.objectContaining({ name: "graph", idDescription: expect.stringMatching(/connection.*coverage/) }),
    expect.objectContaining({ name: "timeline", idDescription: expect.stringMatching(/signal\//) }),
    expect.objectContaining({ name: "panel", idDescription: expect.stringMatching(/change.*comparison/) }),
  ]);
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  const { session, task } = openTaskIds(page);
  const saved = await (await page.request.get(`/api/sessions/${session}/tasks/${task}`)).json();
  expect(saved.showMeHandles).toEqual(offered);
  expect(Object.values(saved.result.showMe)).toContainEqual(expect.objectContaining({ handle: "panel", id: "entity/orders-api" }));
  const finding = page.getByTestId("finding-0");
  const entityButton = finding.getByRole("button", { name: /^Show me/ });
  const viewButton = workspace(page).locator('[data-show-me-id="view/coverage"]');
  await expect(entityButton).toBeVisible();
  await expect(finding).not.toContainText("[[show:");
  await expect(page.locator("[data-show-me-highlight]")).toHaveCount(0);
  await expect(page).toHaveURL(/view=zoom/);

  await viewButton.focus();
  await page.keyboard.press("Enter");
  const coverage = page.locator('[data-graph-area][data-view="coverage"]');
  await expect(coverage).toHaveAttribute("data-show-me-highlight", "blue");
  await expectExposed(coverage);
  await expectExposed(page.getByTestId("task-title"));
  await page.reload();
  await expect(entityButton).toBeVisible();
  await expect(page.locator("[data-show-me-highlight]")).toHaveCount(0);

  const result = workspace(page);
  await result.locator('[data-show-me-id="node/orders-api"]').click();
  await expect(page.locator('[data-graph-area] [data-show-me-highlight="blue"]'))
    .toHaveAttribute("data-entity", "orders-api");
  await result.locator('[data-show-me-id="change/c3"]').click();
  const details = page.getByTestId("change-details-c3");
  await expect(details).toHaveAttribute("data-show-me-highlight", "amber");
  await expect(details).toContainText("Details");
  await expect(page.getByTestId("change-select-c3")).not.toBeChecked();
  await result.locator('[data-show-me-id="connection/orders-api-orders-db"]').click();
  const edge = page.locator('.react-flow__edge[data-id="orders-api-orders-db"] .react-flow__edge-path');
  await expect(edge).toHaveAttribute("data-show-me-highlight", "violet");
  await expect(edge).toHaveCSS("stroke", "rgb(117, 66, 171)");
  await expect(edge).toBeInViewport();
  for (const name of ["orders-api", "orders-db"]) {
    await expectExposed(page.locator(`.react-flow__node[data-id="${name}"]`));
  }
  await expect(page.locator("[data-show-me-highlight]")).toHaveCount(1);
  await expectExposed(page.getByTestId("task-title"));

  await page.setViewportSize({width: 390, height: 844});
  const edgeButton = result.locator('[data-show-me-id="connection/orders-api-orders-db"]');
  await edgeButton.click();
  await expect(edge).toBeInViewport();
  await expectExposed(edgeButton);
  await entityButton.click();
  const entity = page.locator('[data-show-me-entity="orders-api"]');
  await expect(entity).toHaveAttribute("data-show-me-highlight", "amber");
  await expectExposed(entity);
  await expectExposed(page.getByTestId("task-title"));
  await expect(page.locator("[data-show-me-annotation]")).toHaveText("Entity in this finding");
  await expect(page.locator("[data-show-me-annotation]")).toBeInViewport();
  await expect(page.locator("[data-show-me-highlight]")).toHaveCount(1);
  expect(openTaskIds(page)).toEqual({ session, task });
  await page.getByTestId("workspace-close").click();
  await expect(page.locator("[data-show-me-annotation]")).toHaveCount(0);
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

  const laneButton = workspace(page).locator('[data-show-me-handle="timeline"][data-show-me-id="signal/orders-api/order-errors"]');
  await laneButton.click();
  const lane = page.locator('[data-testid="tl-label-signal"][data-row="orders-api"][data-signal="order-errors"][data-show-me-highlight]');
  await expect(lane).toHaveAttribute("data-show-me-highlight", "amber");
  await expectExposed(lane);
  const band = page.locator(".tl-show-me-band");
  await expect(band).toBeInViewport();
  await expect.poll(async () => Math.abs((await band.boundingBox())!.y - (await lane.boundingBox())!.y)).toBeLessThan(2);
  await expectExposed(page.getByTestId("task-title"));

  await page.setViewportSize({width: 390, height: 844});
  await laneButton.click();
  await expectExposed(lane);
  await expectExposed(laneButton);
  await expect(band).toBeInViewport();
  await expect.poll(async () => Math.abs((await band.boundingBox())!.y - (await lane.boundingBox())!.y)).toBeLessThan(2);
  await page.setViewportSize({width: 1280, height: 720});

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

  // A reader can go back to live health and follow the saved explanation to the moment it describes.
  await page.getByTestId("moment-now").click();
  await expect(page.getByTestId("moment-bar")).toHaveCount(0);
  await workspace(page).locator('[data-show-me-handle="panel"][data-show-me-id="entity/orders-db"]').click();
  await expect(page.locator('[data-show-me-entity="orders-db"]')).toHaveAttribute("data-show-me-highlight", "violet");
  await expect.poll(() => Date.parse(new URL(page.url()).searchParams.get("at") ?? "")).toBe(Date.parse(stored.asOf));
  await expect(node(page, "topology", "orders-db")).toHaveAttribute("aria-label", /Healthy/);

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

  await workspace(page).locator('[data-show-me-id="comparison"]').click();
  await expect(page.locator("[data-show-me-comparison]")).toHaveAttribute("data-show-me-highlight", "violet");
  await expectExposed(page.getByTestId("task-title"));

  // The Apply dialog names the design model, never the live one.
  await page.getByTestId("select-all").click();
  await page.getByTestId("apply-button").click();
  await expect(page.getByTestId("apply-dialog-target")).toHaveText("hm-local-design (rg-local)");
  await page.getByTestId("apply-cancel").click();

  const ids = openTaskIds(page);
  await workspace(page).locator('[data-show-me-id="view/coverage"]').click();
  await expect(page.getByTestId("model-picker-selected")).toContainText("hm-local-design");
  await expect(page.locator('[data-graph-area][data-view="coverage"]')).toHaveAttribute("data-show-me-highlight", "blue");
  await expectExposed(page.getByTestId("task-title"));
  expect(openTaskIds(page)).toEqual(ids);
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

test("a builder session reviews signal evidence, creates the workload plan and grants monitoring access", async ({
  page,
  request,
}) => {
  await page.goto("/builder");
  const builder = page.frameLocator('iframe[title="Health model builder"]');
  await expect(builder.getByRole("heading", { name: "Select Azure resources" })).toBeVisible();
  const prefix = builder.getByLabel("Model name prefix");
  const suggestions = builder.getByRole("group", {name: "Suggested model names"});
  await prefix.fill("custom-checkout");
  await builder.getByRole("checkbox", {name: /^orders-api /}).check();
  await expect(suggestions.getByRole("button", {name: "hm-orders-api", exact: true})).toBeVisible();
  await builder.getByRole("checkbox", { name: /Include the entire rg-local/ }).check();
  await expect(prefix).toHaveValue("custom-checkout");
  await suggestions.getByRole("button", {name: "hm-local", exact: true}).click();
  await expect(prefix).toHaveValue("hm-local");
  await builder.getByRole("button", { name: "Analyze resources" }).click();

  await expect(builder.getByRole("heading", { name: "Confirm the workload" })).toBeVisible();
  await expect(page).toHaveURL(/\/builder\?session=/);
  const sessionUrl = page.url();
  await page.reload();
  const inspector = builder.getByRole("complementary", {name: "Show me details"});
  const resourceButton = builder.locator('[data-show-me-id="resource/R1"]').first();
  await resourceButton.focus();
  await resourceButton.press("Enter");
  await expect(inspector.locator('[data-builder-id="resource/R1"]')).toHaveAttribute("data-show-me-highlight", "blue");
  await expect(inspector).toContainText("Azure ID");
  await expectExposed(resourceButton);
  await inspector.getByRole("button", {name: "Close details"}).click();
  await expect(resourceButton).toBeFocused();
  await page.setViewportSize({width: 390, height: 844});
  const evidenceButton = builder.getByRole("button", {name: "Show me – Observed signal"}).first();
  await evidenceButton.click();
  const evidence = inspector.locator('[data-builder-target="signal"]');
  await expect(evidence).toHaveAttribute("data-show-me-highlight", "amber");
  await expect(evidence).toContainText("Observed");
  await expectExposed(evidenceButton);
  await expectExposed(evidence);
  await inspector.getByRole("button", {name: "Close details"}).click();
  await page.setViewportSize({width: 1280, height: 720});
  const plan = builder.getByRole("region", { name: "Proposed health model" });
  const structure = plan.getByRole("region", { name: /^Workload structure/ });
  const flow = structure.getByRole("button", { name: "Complete an order, User flow" });
  await flow.focus();
  await flow.press("Enter");
  await expect(flow).toHaveAttribute("aria-pressed", "true");
  await expect(plan.locator(".plan-node-detail")).toContainText("Depends on Order processing");
  const paintedEdges = (diagram: Locator) => diagram.locator("path.react-flow__edge-path").evaluateAll(paths =>
    paths.filter(path => (path as SVGPathElement).getTotalLength() > 0 && getComputedStyle(path).stroke !== "none").length,
  );
  await expect.poll(() => paintedEdges(structure)).toBe(await structure.locator(".react-flow__node").count() - 1);
  const signal = plan.getByRole("list", {name: "Signals to create"}).getByRole("listitem").filter({hasText: "orders-api · CpuPercentage"});
  await expect(signal).toContainText("Average over 5 minutes");
  await expect(signal).toContainText("Unhealthy when above 80%");
  await expect(signal).toContainText("Observed 12%");
  await expect(signal).toContainText("Predicted state for this sample: Healthy");
  const activity = builder.locator("details.run-activity");
  await expect(activity.locator("summary")).toContainText("Analysis activity");
  await expect(activity.locator("summary")).toContainText("5 tool calls");
  await expect(activity.getByRole("list", {name: "Steps"})).toBeHidden();
  await activity.locator("summary").click();
  await expect(activity.getByText("Requesting workload analysis from Foundry", { exact: true })).toBeVisible();
  await activity.getByRole("button", {name: /technical details of Wrote the result/}).click();
  const returned = builder.getByRole("region", {name: "Technical details"});
  await expect(returned).toContainText("submit_result");
  await expect(returned).toContainText("Accepted by the result validator.");
  await returned.press("Escape");
  await expect(builder.getByLabel("Display name of orders-api", { exact: true })).toHaveCount(0);
  await builder.getByLabel("Workload role of orders-api", { exact: true }).fill("Accepts checkout requests");
  await builder.getByLabel("Include orders-db", { exact: true }).uncheck();
  await expect(structure.getByRole("button", { name: "orders-db, Azure resource" })).toHaveCount(0);
  const adjustment = "Prioritize order fulfillment.";
  await builder.getByRole("textbox", {name: "What should change?"}).fill(adjustment);
  await builder.getByRole("button", {name: "Revise plan", exact: true}).click();
  const revised = builder.getByRole("region", {name: "Latest plan revision"});
  await expect(revised).toContainText(adjustment);
  await page.reload();
  await expect(revised).toContainText(adjustment);
  await expect(plan.getByRole("region", {name: "Why these choices were made"})).toContainText("Prioritize order fulfillment");
  await expect(builder.getByLabel("Workload role of orders-api", {exact: true})).toHaveValue("Accepts checkout requests");
  await expect(structure.getByRole("button", {name: "orders-db, Azure resource"})).toHaveCount(0);
  await builder.getByRole("button", { name: "Confirm and suggest models" }).click();
  await expect(builder.getByRole("heading", { name: "Compare model designs" })).toBeVisible();
  await expect(builder.getByRole("radio")).toHaveCount(2);
  const alternate = await builder.getByRole("radio", {checked: false}).inputValue();
  const designButton = builder.locator(`[data-show-me-id="design/${alternate}"]`);
  const before = await builder.getByRole("radio", {checked: true}).getAttribute("value");
  await designButton.click();
  await expect(inspector.locator(`[data-builder-id="design/${alternate}"]`)).toHaveAttribute("data-show-me-highlight", "violet");
  await expect(inspector.getByRole("region", {name: /^Design preview/})).toBeVisible();
  await expectExposed(designButton);
  await inspector.getByRole("button", {name: "Close details"}).click();
  await expect(builder.getByRole("radio", {checked: true})).toHaveValue(before!);
  await builder.getByRole("radio", { name: /^Workload operation/ }).check();
  await expect(builder.getByRole("radio", { name: /^Workload operation/ })).toHaveValue("planned-workload");
  await builder.getByRole("button", { name: "Preview selected model" }).click();

  const name = await builder.locator(".target dd").first().innerText();
  expect(name).toMatch(/^hm-local-[a-f0-9]{16}$/);
  const diagram = builder.getByRole("region", { name: /^Designer layout/ });
  await expect(builder.locator(".diagram-canvas")).toHaveCount(1);
  await diagram.getByRole("button", { name: "orders-api, Azure resource" }).click();
  await expect(builder.getByRole("figure", { name: /^Designer layout/ }).locator(".plan-node-detail")).toContainText("Accepts checkout requests");
  const positions = await diagram.locator(".react-flow__node").evaluateAll((nodes) =>
    nodes.map((node) => {
      const transform = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      return { displayName: node.querySelector(".entity-node__name")!.textContent!, position: [transform.e, transform.f] };
    }),
  );
  await expect.poll(() => paintedEdges(diagram)).toBe(positions.length - 1);
  expect(positions.some((node) => node.displayName === "orders-api")).toBe(true);
  expect(positions.map((node) => node.displayName)).toEqual(expect.arrayContaining(["Complete an order", "Order processing"]));
  expect(positions.map((node) => node.displayName)).not.toContain("orders-db");
  for (const filename of ["plan.md", "modelspec.md"]) {
    const downloaded = page.waitForEvent("download");
    await builder.getByRole("button", { name: "Download " + filename }).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe(filename);
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const markdown = Buffer.concat(chunks).toString("utf8");
    expect(markdown).toContain("orders-api");
    expect(markdown).toContain(name);
    expect(markdown).toContain(adjustment);
    expect(markdown).toContain("Prioritize order fulfillment");
    expect(markdown).not.toContain("```mermaid");
    expect(markdown).not.toContain("[[show:");
    if (filename === "modelspec.md") expect(markdown).toContain("Accepts checkout requests");
  }
  const catalog = async () =>
    (await (await request.get("/api/health-models")).json()).models as { name: string }[];
  await builder.getByRole("button", { name: "Create health model", exact: true }).click();
  await builder.getByText("Resources that need monitoring access (1)", { exact: true }).click();
  await expect(builder.getByRole("group", { name: /^Create .* in Azure\?/ })).toContainText("/providers/Microsoft.App/containerApps/orders-api");
  await builder.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await catalog()).some((m) => m.name === name)).toBe(false);
  await builder.getByRole("button", { name: "Create health model", exact: true }).click();
  await builder.getByRole("button", { name: "Confirm creation in Azure" }).click();
  await expect(builder.getByRole("heading", { name: "Health model created" })).toBeVisible();
  const access = builder.getByRole("region", { name: "Signal access" });
  await expect(access).toContainText("orders-api");
  await expect(access).not.toContainText("orders-store");
  await access.getByRole("button", { name: "Grant Monitoring Reader" }).click();
  await expect(access).toContainText("Monitoring Reader confirmed");
  await page.goto(sessionUrl);
  await expect(access).toContainText("Monitoring Reader confirmed");
  await expect(builder.getByRole("heading", { name: "Health model created" })).toBeVisible();
  await builder.getByRole("button", { name: "Open health model" }).click();
  await expect(page.getByTestId("model-picker-selected")).toContainText(name);
  const data = await request.get("/api/health-model" + new URL(page.url()).search);
  expect(data.ok()).toBe(true);
  const model = await data.json();
  expect(model.entities).toHaveLength(positions.length);
  for (const node of positions) {
    expect(model.entities).toContainEqual(
      expect.objectContaining({
        displayName: node.displayName,
        canvasPosition: { x: node.position[0], y: node.position[1] },
      }),
    );
  }
  const session = await (
    await request.get("/api/sessions/" + new URL(sessionUrl).searchParams.get("session"))
  ).json();
  expect(session.tasks).toHaveLength(3);
});
