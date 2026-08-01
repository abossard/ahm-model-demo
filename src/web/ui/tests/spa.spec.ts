import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { healthModel, installStubs, journeyResponse, reportResponse } from "./fixture";

const STATE_PALETTE: Readonly<
  Record<string, { readonly border: string; readonly fill: string; readonly word: string }>
> = {
  "svc-a": { border: "rgb(160, 216, 160)", fill: "rgb(242, 248, 242)", word: "Healthy" },
  "svc-b": { border: "rgb(219, 117, 0)", fill: "rgb(251, 242, 231)", word: "Degraded" },
  "svc-c": { border: "rgb(186, 13, 22)", fill: "rgb(250, 236, 235)", word: "Unhealthy" },
  "svc-d": { border: "rgb(200, 198, 196)", fill: "rgb(246, 246, 245)", word: "Unknown" },
  "svc-e": { border: "rgb(134, 97, 197)", fill: "rgb(244, 240, 251)", word: "Standby" },
};

function validRelationships(): readonly { parent: string; child: string; label: string | null }[] {
  const names = new Set(healthModel.entities.map((entity) => entity.name));
  return healthModel.relationships
    .filter((rel) => names.has(rel.parentEntityName) && names.has(rel.childEntityName))
    .map((rel) => ({ parent: rel.parentEntityName, child: rel.childEntityName, label: rel.displayName }));
}

async function bootTopology(page: Page): Promise<void> {
  await installStubs(page, { healthModelFails: false });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
}

test("shell is one document with a single script and no server-rendered state", async ({ page }) => {
  const shell = await page.request.get("/");
  expect(shell.status()).toBe(200);
  const html = await shell.text();

  const scriptSrcCount = (html.match(/<script\b[^>]*\bsrc=/g) ?? []).length;
  expect(scriptSrcCount).toBe(1);

  for (const entity of healthModel.entities) {
    expect(html, `shell must not server-render ${entity.displayName}`).not.toContain(entity.displayName);
  }

  await page.goto("/");
  const domScriptSrc = await page.evaluate(() => document.querySelectorAll("script[src]").length);
  expect(domScriptSrc).toBe(1);
});

test("AC1 — one React Flow node per entity and one edge per valid relationship", async ({ page }) => {
  await bootTopology(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await expect(page.locator(".react-flow__edge")).toHaveCount(validRelationships().length);
});

test("AC2 — every parent node sits above its children", async ({ page }) => {
  await bootTopology(page);
  for (const rel of validRelationships()) {
    const parent = await page.locator(`.react-flow__node[data-id="${rel.parent}"]`).boundingBox();
    const child = await page.locator(`.react-flow__node[data-id="${rel.child}"]`).boundingBox();
    expect(parent, `parent box ${rel.parent}`).not.toBeNull();
    expect(child, `child box ${rel.child}`).not.toBeNull();
    const parentBottom = (parent?.y ?? 0) + (parent?.height ?? 0);
    expect(parentBottom, `${rel.parent} above ${rel.child}`).toBeLessThanOrEqual(child?.y ?? 0);
  }
});

test("AC3 — each card carries the portal state design and pill word", async ({ page }) => {
  await bootTopology(page);
  for (const [name, pair] of Object.entries(STATE_PALETTE)) {
    const card = page.locator(`.react-flow__node[data-id="${name}"] .entity-node`);
    const style = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderTopLeftRadius,
        width: cs.borderTopWidth,
        border: cs.borderTopColor,
        fill: cs.backgroundColor,
      };
    });
    expect(style.radius, `${name} radius`).toBe("10px");
    expect(style.width, `${name} border width`).toBe("2px");
    expect(style.border, `${name} border color`).toBe(pair.border);
    expect(style.fill, `${name} fill`).toBe(pair.fill);
    const word = await card.locator(".entity-node__pill-word").textContent();
    expect(word?.trim(), `${name} pill word`).toBe(pair.word);
  }
});

test("AC4 — Unknown card border is dashed, Healthy is solid", async ({ page }) => {
  await bootTopology(page);
  const styleOf = (name: string) =>
    page
      .locator(`.react-flow__node[data-id="${name}"] .entity-node`)
      .evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(await styleOf("svc-d")).toBe("dashed");
  expect(await styleOf("svc-a")).toBe("solid");
});

test("AC5 — signal rows render each signal name and its distinct value", async ({ page }) => {
  await bootTopology(page);
  const rows = page.locator(`.react-flow__node[data-id="svc-a"] .entity-node__row`);
  await expect(rows).toHaveCount(3);
  const texts = (await rows.allTextContents()).join(" | ");
  for (const fragment of ["CPU", "0.2", "Latency", "980", "Errors", "0"]) {
    expect(texts, `row text should contain ${fragment}`).toContain(fragment);
  }
});

test("AC6 — activating a node opens the detail panel by pointer and keyboard", async ({ page }) => {
  await bootTopology(page);

  const pointerRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/entities/svc-a") && req.method() === "GET",
  );
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  await pointerRequest;
  await expect(page.getByTestId("entity-panel")).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service A");

  const keyboardRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/entities/svc-e") && req.method() === "GET",
  );
  await page.locator(`.react-flow__node[data-id="svc-e"] .entity-node`).focus();
  await page.keyboard.press("Enter");
  await keyboardRequest;
  await expect(page.getByTestId("entity-name")).toHaveText("Service E (retired)");
});

test("AC7 — edges are labelled only where a display name exists", async ({ page }) => {
  await bootTopology(page);
  const labels = (await page.locator(".react-flow__edge-text").allTextContents())
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .sort();
  const expected = validRelationships()
    .map((rel) => rel.label ?? "")
    .filter((label) => label.length > 0)
    .sort();
  expect(labels).toEqual(expected);
});

test("report submission posts the exact body and shows the receipt", async ({ page }) => {
  await bootTopology(page);
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
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

test("empty custom reason blocks submission and announces the error", async ({ page }) => {
  await bootTopology(page);
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
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

test("the request-journey control posts and renders all three fields", async ({ page }) => {
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

test("health-model failure shows error and retry recovers the topology", async ({ page }) => {
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

  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
});
