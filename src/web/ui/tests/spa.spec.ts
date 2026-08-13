import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  healthModel,
  installStubs,
  journeyResponse,
  modelCatalog,
  paymentsHealthModel,
  reportResponse,
} from "./fixture";

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
    (req) => new URL(req.url()).pathname === "/api/entities/svc-a" && req.method() === "GET",
  );
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  expect(new URL((await pointerRequest).url()).searchParams.get("model")).toBe("hm-demo");
  await expect(page.getByTestId("entity-panel")).toBeVisible();
  await expect(page.getByTestId("entity-name")).toHaveText("Service A");

  const keyboardRequest = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/api/entities/svc-e" && req.method() === "GET",
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

test("edges carry no arrowhead marker", async ({ page }) => {
  await bootTopology(page);
  const paths = page.locator(".react-flow__edge .react-flow__edge-path");
  await expect(paths).toHaveCount(validRelationships().length);
  const markers = await paths.evaluateAll((els) =>
    els.map((el) => ({
      attr: el.getAttribute("marker-end"),
      computed: getComputedStyle(el).markerEnd,
    })),
  );
  for (const marker of markers) {
    expect(marker.attr, "no marker-end attribute").toBeNull();
    expect(marker.computed, "no computed marker-end").toBe("none");
  }
  await expect(page.locator(".react-flow__arrowclosed")).toHaveCount(0);
});

test("each edge is stroked with its child entity health colour", async ({ page }) => {
  await bootTopology(page);
  const expected: Readonly<Record<string, string>> = {
    r1: "rgb(194, 106, 0)",
    r2: "rgb(197, 15, 24)",
    r3: "rgb(138, 136, 134)",
    r4: "rgb(197, 15, 24)",
  };
  for (const [id, colour] of Object.entries(expected)) {
    const stroke = await page
      .locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`)
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(stroke, `edge ${id} stroke`).toBe(colour);
  }
});

test("cards of different heights on the same rank are top aligned", async ({ page }) => {
  await bootTopology(page);
  const boxes = await Promise.all(
    ["svc-a", "svc-e", "svc-f"].map((name) =>
      page.locator(`.react-flow__node[data-id="${name}"]`).boundingBox(),
    ),
  );
  const heights = boxes.map((box) => box?.height ?? 0);
  expect(new Set(heights).size, "rank 0 cards must differ in height").toBeGreaterThan(1);
  const tops = boxes.map((box) => box?.y ?? 0);
  for (const top of tops) {
    expect(Math.abs(top - (tops[0] ?? 0)), `top alignment ${tops.join(",")}`).toBeLessThanOrEqual(1);
  }
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
    (req) =>
      new URL(req.url()).pathname === "/api/entities/svc-a/health-reports" && req.method() === "POST",
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

test("AC8 — the status bar lists every discoverable model with the active one selected", async ({ page }) => {
  await bootTopology(page);

  const picker = page.getByTestId("model-picker");
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toHaveCount(modelCatalog.models.length);
  await expect(picker.locator("option")).toHaveText(
    modelCatalog.models.map((item) => `${item.name} (${item.resourceGroup})`),
  );
  await expect(picker).toHaveValue("rg-demo/hm-demo");
  await expect(page.getByTestId("model-name")).toHaveText(healthModel.model.name);
});

test("AC9 — choosing a model refetches it, closes the entity panel and redraws the topology", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: { "hm-demo": healthModel, "hm-payments": paymentsHealthModel },
  });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");

  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();

  const refetch = page.waitForRequest(
    (req) => req.url().includes("/api/health-model?") && req.url().includes("model=hm-payments"),
  );
  await page.getByTestId("model-picker").selectOption("rg-demo/hm-payments");
  const url = new URL((await refetch).url());
  expect(url.searchParams.get("model")).toBe("hm-payments");
  expect(url.searchParams.get("resourceGroup")).toBe("rg-demo");

  await expect(page.getByTestId("entity-panel")).toHaveCount(0);
  await expect(page.getByTestId("model-name")).toHaveText(paymentsHealthModel.model.name);
  await expect(page.locator(".react-flow__node")).toHaveCount(paymentsHealthModel.entities.length);
});

test("AC10 — the selected model round-trips through the URL on reload", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: { "hm-demo": healthModel, "hm-payments": paymentsHealthModel },
  });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.getByTestId("model-picker").selectOption("rg-demo/hm-payments");
  await expect(page.getByTestId("model-name")).toHaveText(paymentsHealthModel.model.name);

  const shared = page.url();
  expect(new URL(shared).search).toBe("?model=hm-payments&resourceGroup=rg-demo");

  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/health-model?") || req.url().endsWith("/api/health-model")) {
      requests.push(req.url());
    }
  });
  await page.goto(shared);
  await page.waitForSelector(".react-flow__node .entity-node");

  expect(requests.length).toBeGreaterThan(0);
  const first = new URL(requests[0]!);
  expect(first.searchParams.get("model")).toBe("hm-payments");
  expect(first.searchParams.get("resourceGroup")).toBe("rg-demo");
  await expect(page.locator(".react-flow__node")).toHaveCount(paymentsHealthModel.entities.length);
});

const QUICK_SEND_COLOURS: Readonly<Record<string, string>> = {
  Healthy: "rgb(76, 154, 42)",
  Degraded: "rgb(194, 106, 0)",
  Unhealthy: "rgb(197, 15, 24)",
  Unknown: "rgb(138, 136, 134)",
  Deleted: "rgb(134, 97, 197)",
};

async function openReportForm(page: Page): Promise<void> {
  await bootTopology(page);
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();
  await expect(page.getByTestId("entity-panel")).toBeVisible();
}

test("quick-send offers one button per health state in its own colour", async ({ page }) => {
  await openReportForm(page);
  const buttons = page.locator(`[data-testid="quick-send"] button`);
  await expect(buttons).toHaveCount(healthModel.reportOptions.healthStates.length);

  for (const [state, colour] of Object.entries(QUICK_SEND_COLOURS)) {
    const button = page.locator(`[data-testid="quick-send-${state}"]`);
    await expect(button).toHaveText(state);
    const background = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background, `${state} quick-send background`).toBe(colour);
  }
});

test("a quick-send click posts its state with the form's current value, expiry and reason", async ({
  page,
}) => {
  await openReportForm(page);
  await page.selectOption("#report-value", { label: "0.5" });
  await page.selectOption("#report-expiry", { label: "15" });
  await page.selectOption("#report-reason", { label: "Maintenance window" });

  const postRequest = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/entities/svc-a/health-reports" && req.method() === "POST",
  );
  await page.getByTestId("quick-send-Unhealthy").click();

  expect((await postRequest).postDataJSON()).toEqual({
    signalName: "web-ui-health-report",
    healthState: "Unhealthy",
    value: 0.5,
    expiresInMinutes: 15,
    reasonPreset: "maintenance",
  });
  await expect(page.getByTestId("report-id")).toHaveText(reportResponse.reportId);
});

test("quick-send obeys the custom reason validation", async ({ page }) => {
  await openReportForm(page);
  let postCount = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/health-reports")) postCount += 1;
  });

  await page.selectOption("#report-reason", { label: "Custom reason" });
  await page.getByTestId("quick-send-Healthy").click();

  await expect(page.locator("#report-custom-reason")).toHaveAttribute("aria-invalid", "true");
  await page.waitForTimeout(200);
  expect(postCount).toBe(0);
});

test("the refresh button issues exactly one health-model request", async ({ page }) => {
  await bootTopology(page);
  let requests = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/health-model") requests += 1;
  });
  await page.getByTestId("refresh-now").click();
  await page.waitForTimeout(300);
  expect(requests).toBe(1);
});

test("an in-flight refresh shows the indicator and keeps the topology rendered", async ({ page }) => {
  await bootTopology(page);
  let release: (() => void) | null = null;
  await page.route("**/api/health-model*", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(healthModel),
    });
  });

  await page.getByTestId("refresh-now").click();
  await expect(page.getByTestId("refresh-indicator")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(healthModel.entities.length);
  await expect(page.locator("#topology.topology--empty")).toHaveCount(0);

  release?.();
  await expect(page.getByTestId("refresh-indicator")).toBeHidden();
});

test("auto-refresh offers Off, 1 min and 5 min and defaults to Off", async ({ page }) => {
  await bootTopology(page);
  const picker = page.getByTestId("auto-refresh");
  const labels = await picker.locator("option").allTextContents();
  expect(labels.map((label) => label.trim())).toEqual(["Off", "Every 1 min", "Every 5 min"]);
  await expect(picker).toHaveValue("0");
});

test("an accepted report counts down from 10 and then refreshes the model", async ({ page }) => {
  await page.clock.install();
  await openReportForm(page);

  let reloads = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/health-model") reloads += 1;
  });

  await page.getByTestId("quick-send-Degraded").click();
  await expect(page.getByTestId("report-id")).toHaveText(reportResponse.reportId);
  await expect(page.getByTestId("refresh-countdown")).toHaveText("10");

  await page.clock.runFor("00:03");
  await expect(page.getByTestId("refresh-countdown")).toHaveText("7");
  expect(reloads, "no reload before the countdown ends").toBe(0);

  await page.clock.runFor("00:07");
  await expect(page.getByTestId("refresh-countdown")).toBeHidden();
  await expect.poll(() => reloads).toBe(1);
});

test("auto-refresh reloads once a minute when on and never when off", async ({ page }) => {
  await page.clock.install();
  await installStubs(page, { healthModelFails: false });
  await page.goto("/");
  await expect(page.getByTestId("auto-refresh")).toBeVisible();

  let reloads = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/health-model") reloads += 1;
  });

  await page.clock.fastForward("05:00");
  expect(reloads, "Off must not reload").toBe(0);

  await page.getByTestId("auto-refresh").selectOption("60000");
  await page.clock.fastForward("01:00");
  await expect.poll(() => reloads).toBe(1);
});

test("auto-refresh survives a failed load and keeps firing from the error state", async ({ page }) => {
  await page.clock.install();
  let failing = false;
  let reloads = 0;
  await installStubs(page, { healthModelFails: false });
  await page.route("**/api/health-model*", async (route) => {
    reloads += 1;
    if (failing) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "sdk_unavailable", message: "down", retryable: true, operationId: "op-1" },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(healthModel),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("auto-refresh")).toBeVisible();
  await page.getByTestId("auto-refresh").selectOption("60000");

  failing = true;
  await page.clock.fastForward("01:00");
  await expect(page.getByTestId("status-error")).toBeVisible();

  await expect(page.getByTestId("refresh-now")).toBeVisible();
  await expect(page.getByTestId("auto-refresh")).toHaveValue("60000");

  const before = reloads;
  await page.clock.fastForward("01:00");
  await expect.poll(() => reloads).toBeGreaterThan(before);
});

test("switching models does not leave the previous model on screen while loading", async ({ page }) => {
  await installStubs(page, {
    healthModelFails: false,
    modelsByName: { "hm-demo": healthModel, "hm-payments": paymentsHealthModel },
  });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await expect(page.getByTestId("model-name")).toHaveText(healthModel.model.name);

  let release: (() => void) | null = null;
  await page.route("**/api/health-model*", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(paymentsHealthModel),
    });
  });

  await page.getByTestId("model-picker").selectOption("rg-demo/hm-payments");
  await expect(page.getByTestId("refresh-indicator")).toBeVisible();
  await expect(page.getByTestId("model-name")).not.toHaveText(healthModel.model.name);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  release?.();
  await expect(page.getByTestId("model-name")).toHaveText(paymentsHealthModel.model.name);
  await expect(page.locator(".react-flow__node")).toHaveCount(paymentsHealthModel.entities.length);
});

test("an unrecognised health state does not unmount the app", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const exotic = JSON.parse(JSON.stringify(healthModel)) as typeof healthModel;
  (exotic.entities[0] as { healthState: string }).healthState = "Rebooting";
  (exotic.reportOptions as { healthStates: string[] }).healthStates = [
    ...healthModel.reportOptions.healthStates,
    "Rebooting",
  ];

  await installStubs(page, { healthModelFails: false, model: exotic });
  await page.goto("/");
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.locator(`.react-flow__node[data-id="svc-a"] .entity-node`).click();

  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(`[data-testid="quick-send"] button`)).toHaveCount(
    exotic.reportOptions.healthStates.length,
  );
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});
