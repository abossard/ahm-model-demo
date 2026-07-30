import { expect, test } from "@playwright/test";
import { healthModel, installStubs, journeyResponse, reportResponse } from "./fixture";

const CARD_STROKE: Readonly<Record<string, string>> = {
  "svc-a": "rgb(160, 216, 160)",
  "svc-b": "rgb(219, 117, 0)",
  "svc-c": "rgb(186, 13, 22)",
  "svc-d": "rgb(200, 198, 196)",
  "svc-e": "rgb(134, 97, 197)",
};

async function bootTopology(page: import("@playwright/test").Page): Promise<void> {
  await installStubs(page, { healthModelFails: false });
  await page.goto("/");
  await page.waitForSelector("#topology svg g[data-entity]");
}

test("AC2 — one swimlane card per entity with portal SVG root", async ({ page }) => {
  await bootTopology(page);

  const groups = page.locator("#topology svg g[data-entity]");
  await expect(groups).toHaveCount(healthModel.entities.length);

  const svg = page.locator("#topology svg").first();
  await expect(svg).toHaveAttribute("xmlns", "http://www.w3.org/2000/svg");
  const fontFamily = await svg.getAttribute("font-family");
  expect(fontFamily?.startsWith("Segoe UI")).toBeTruthy();
});

test("AC3 — card border stroke matches the portal state palette", async ({ page }) => {
  await bootTopology(page);

  for (const [name, rgb] of Object.entries(CARD_STROKE)) {
    const stroke = await page
      .locator(`#topology svg rect[data-entity-card="${name}"]`)
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(stroke, `stroke for ${name}`).toBe(rgb);
  }
});

test("AC4 — signal rows render display name and value in the card", async ({ page }) => {
  await bootTopology(page);

  const svgText = (await page.locator("#topology svg").first().textContent()) ?? "";
  for (const fragment of ["CPU", "0.2", "Latency", "980", "Errors", "Queue", "42"]) {
    expect(svgText, `svg text should contain ${fragment}`).toContain(fragment);
  }
});

test("AC5 — activating a card opens the detail panel with history", async ({ page }) => {
  await bootTopology(page);

  const detailRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/entities/svc-a") && req.method() === "GET",
  );
  await page.locator('#topology svg g[data-entity="svc-a"]').click();
  await detailRequest;

  const panel = page.getByTestId("entity-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service A");
  await expect(page.getByTestId("transition-row")).toHaveCount(2);
  await expect(page.getByTestId("signal-history-row")).toHaveCount(2);

  await page.locator('#topology svg g[data-entity="svc-e"]').click();
  await expect(page.getByTestId("report-ineligible")).toBeVisible();
});

test("AC6 — submitting the report posts the exact body and shows the receipt", async ({ page }) => {
  await bootTopology(page);
  await page.locator('#topology svg g[data-entity="svc-a"]').click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();

  await page.selectOption("#report-state", { label: "Degraded" });
  await page.selectOption("#report-value", { label: "0.5" });
  await page.selectOption("#report-expiry", { label: "15" });
  await page.selectOption("#report-reason", { label: "Maintenance window" });

  const postRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/entities/svc-a/health-reports") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Submit report" }).click();
  const body = (await postRequest).postDataJSON();

  expect(body).toEqual({
    signalName: "web-ui-health-report",
    healthState: "Degraded",
    value: 0.5,
    expiresInMinutes: 15,
    reasonPreset: "maintenance",
  });

  await expect(page.getByTestId("report-id")).toHaveText(reportResponse.reportId);
  await expect(page.getByTestId("report-expires")).toHaveText(reportResponse.expiresAt);
});

test("AC7 — empty custom reason blocks submission and announces the error", async ({ page }) => {
  await bootTopology(page);
  await page.locator('#topology svg g[data-entity="svc-a"]').click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();

  let postCount = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/health-reports")) postCount += 1;
  });

  await page.selectOption("#report-reason", { label: "Custom reason" });
  await page.getByRole("button", { name: "Submit report" }).click();

  const textarea = page.locator("#report-custom-reason");
  const describedBy = await textarea.getAttribute("aria-describedby");
  expect(describedBy).toBe("report-custom-reason-error");
  await expect(textarea).toHaveAttribute("aria-invalid", "true");
  const errorText = (await page.locator(`#${describedBy}`).textContent())?.trim() ?? "";
  expect(errorText.length).toBeGreaterThan(0);

  await page.waitForTimeout(200);
  expect(postCount).toBe(0);
});

test("AC8 — the request-journey control posts and renders all three fields", async ({ page }) => {
  await bootTopology(page);

  const journeyRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/demo-request") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Run request journey" }).click();
  await journeyRequest;

  await expect(page.getByTestId("journey-request-id")).toHaveText(journeyResponse.request_id);
  await expect(page.getByTestId("journey-queue-head")).toHaveText(
    journeyResponse.queue_head?.request_id ?? "none",
  );
  await expect(page.getByTestId("journey-row-count")).toHaveText(String(journeyResponse.row_count));
});

test("AC13 — health-model failure shows error and retry recovers the topology", async ({ page }) => {
  const state = { healthModelFails: true };
  await installStubs(page, state);
  await page.goto("/");

  await expect(page.getByTestId("status-error")).toBeVisible();
  await expect(page.getByTestId("status-error-message")).toHaveText(
    "The health model service is unavailable.",
  );
  await expect(page.getByTestId("status-last-observed")).toHaveText("No successful observation yet");

  state.healthModelFails = false;
  await page.getByTestId("status-retry").click();

  await page.waitForSelector("#topology svg g[data-entity]");
  await expect(page.locator("#topology svg g[data-entity]")).toHaveCount(
    healthModel.entities.length,
  );
});
