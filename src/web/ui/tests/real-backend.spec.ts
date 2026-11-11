import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// Runs against the real web app in its offline mode (see playwright.real.config.ts): real Sessions, a real
// event stream, the scripted agent and the two fixture models. Nothing here is stubbed.
// The tests share one process in order, because Apply writes the fixture model the next test reads.

const LIVE_MODEL = "hm-local";
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
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authMode: "local", tenantId: null, clientId: null, apiScope: null }) }),
  );
});

const workspace = (page: Page): Locator => page.getByTestId("session-workspace");

function node(page: Page, graph: string, name: string): Locator {
  return page.getByTestId(graph).locator(`.entity-node[data-entity="${name}"]`);
}

async function boot(page: Page): Promise<void> {
  await page.goto("/");
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
  await expect(page.getByTestId("task-title")).toHaveText("Review #1");
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

  // The way out is a new Review of the changed model.
  await page.getByTestId("apply-new-review").click();
  await expect(page.getByTestId("task-type-review")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-title")).toHaveText("Review #2");
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
});

test("an Explain runs on the selected entity and marks its chain on the graph", async ({ page }) => {
  await boot(page);
  await node(page, "topology", "orders-api").click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();
  await page.getByTestId("explain-entity").click();
  await expect(workspace(page)).toBeVisible();

  await page.getByTestId("session-title").fill("Real backend explain");
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("task-type-explain")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("task-entity")).toHaveValue(/Orders API/);
  await page.getByTestId("task-instruction-input").fill("Why is it degraded?");
  await page.getByTestId("task-submit").click();

  await expect(page.getByTestId("task-title")).toHaveText("Explain #1");
  await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("explain-result")).toBeVisible();
  await expect(page.getByTestId("explain-summary")).toContainText("orders-api is degraded");
  await expect(page.getByTestId("explain-state")).toContainText("Degraded");
  await expect(node(page, "topology", "orders-api")).toHaveAttribute("data-chain", "true");
  await expect(node(page, "topology", "payments")).not.toHaveAttribute("data-chain", "true");
  await expect(page.getByTestId("task-instruction")).toContainText("Why is it degraded?");

  // The Task is part of the Session: it is still there after a reload, opened from the address.
  await page.reload();
  await expect(page.getByTestId("task-title")).toHaveText("Explain #1");
  await expect(page.getByTestId("explain-result")).toBeVisible();
});

test("a Design targets the design model and proposes its entities as a diff", async ({ page }) => {
  await boot(page);
  await newSession(page, "Real backend design");
  await page.getByTestId("task-type-design").click();
  await expect(page.getByTestId("task-target")).toHaveValue("hm-local-design (rg-local)");
  await expect(page.getByTestId("task-workload")).toHaveValue("rg-local");
  await page.getByTestId("task-repository").fill("https://github.com/contoso/orders");
  await page.getByTestId("task-submit").click();

  await expect(page.getByTestId("task-title")).toHaveText("Design #1");
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
