import { expect, test } from "@playwright/test";
import { DISCOVERED_SIGNALS, healthModel, installStubs, realShapeModel, showCardSignals } from "./fixture";
import { openView } from "./views";

// Shapes the deployed app served that the first fixtures never had.

test("a card row keeps a long fraction on one line, rounded, with the raw value on hover", async ({ page }) => {
  await showCardSignals(page);
  await installStubs(page, { healthModelFails: false, model: realShapeModel });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");

  const rows = await page
    .locator('.react-flow__node[data-id="2cfe8745-bb71-b592-3736-7d3343a007dc"] .entity-node__row')
    .evaluateAll((items) =>
      items.map((row) => {
        const value = row.querySelector(".entity-node__row-value") as HTMLElement;
        const name = row.querySelector(".entity-node__row-name") as HTMLElement;
        return {
          name: name.textContent,
          value: value.textContent,
          title: value.title,
          lines: new Set([...value.getClientRects()].map((rect) => Math.round(rect.top))).size,
          // Layout pixels: the graph is zoomed, and a transform does not change them.
          height: value.offsetHeight,
          rowHeight: (row as HTMLElement).offsetHeight,
        };
      }),
    );

  // A signal the app discovered has no display name, so the card shows its name.
  expect(rows.map((row) => row.name)).toEqual(DISCOVERED_SIGNALS.map((signal) => signal.name));
  expect(rows.map((row) => row.value)).toEqual(["100", "6.982", "3.821"]);
  expect(rows.map((row) => row.title)).toEqual(DISCOVERED_SIGNALS.map((signal) => String(signal.value)));
  for (const row of rows) {
    expect(row.lines).toBe(1);
    // One line is about 20px; two would be about 40.
    expect(row.height).toBeLessThan(28);
    expect(row.rowHeight).toBeLessThan(36);
  }
});

test("the signal history heading and its empty note sit on separate lines", async ({ page }) => {
  await installStubs(page, { healthModelFails: false, model: healthModel });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.locator('.react-flow__node[data-id="svc-e"] .entity-node').click();
  await page.getByTestId("report-open").click();

  const heading = page.locator("#signal-heading");
  const note = page.getByText("No history for this signal yet.");
  await expect(note).toBeVisible();
  const [head, text] = await Promise.all([heading.boundingBox(), note.boundingBox()]);
  expect(text!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
});

test("a reload that fails keeps the last observation on screen and says so", async ({ page }) => {
  await installStubs(page, { healthModelFails: false, model: realShapeModel });
  await openView(page, "zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
  const nodes = realShapeModel.entities.length;
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes);

  await page.route("**/api/health-model*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "health_model_busy", message: "Azure is temporarily busy. Try again.", retryable: true, operationId: "op" } }),
    }),
  );
  await page.getByTestId("refresh-now").click();

  await expect(page.getByTestId("status-error")).toContainText("Health model not refreshed");
  await expect(page.getByTestId("status-error-message")).toHaveText("Azure is temporarily busy. Try again.");
  await expect(page.getByTestId("status-last-observed")).toHaveText(/^Last updated 30 Jul \d{2}:05:00$/);
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes);
  await expect(page.getByTestId("model-name")).toHaveText("hm-real");

  await page.unroute("**/api/health-model*");
  await page.getByTestId("status-retry").click();
  await expect(page.getByTestId("status-error")).toHaveCount(0);
});

test("a model with no entity says so instead of showing an unexplained blank canvas", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  await installStubs(page, { healthModelFails: false, model: { ...healthModel, entities: [], relationships: [] } });
  await openView(page, "zoom");

  await expect(page.getByTestId("graph-empty")).toHaveText("This health model has no entities.");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.getByTestId("graph-toolbar")).toBeVisible();
  expect(errors).toEqual([]);
});
