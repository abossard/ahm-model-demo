import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

const live = Boolean(process.env.LIVE_BASE_URL);
const liveModelName = process.env.HEALTH_MODEL_NAME ?? "hm-ahm-demo";

const model = {
  model: {
    id: "model-id",
    name: liveModelName,
    location: "northeurope",
    provisioningState: "Succeeded",
    healthState: "Degraded",
  },
  observedAt: "2026-07-27T20:00:00Z",
  entities: [
    {
      name: "api",
      displayName: "Request API",
      healthState: "Degraded",
      impact: "Standard",
      canvasPosition: { x: 100, y: 100 },
      discoveredBy: null,
      parents: [],
      children: [],
      unlinked: true,
      latestEvaluationAt: "2026-07-27T19:59:00Z",
      latestTransitionAt: null,
      signals: [],
      report: { eligible: true, signalName: "web-ui-health-report" },
    },
  ],
  relationships: [],
  reportOptions: {
    signalName: "web-ui-health-report",
    healthStates: ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"],
    values: [null, 0, 0.5, 1],
    expiries: [1, 5, 15, 30, 60, 120],
    reasonPresets: [
      { value: "demo-test", label: "Demo test" },
      { value: "maintenance", label: "Maintenance window" },
      { value: "custom", label: "Custom reason" },
    ],
  },
};

async function loadHealthPulse(page: Page) {
  if (!live) {
    await page.unroute(/\/api\/health-model(\?.*)?$/);
    await page.unroute("**/api/health-models");
    await page.route(/\/api\/health-model(\?.*)?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(model),
      }),
    );
    await page.route("**/api/health-models", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            {
              name: "hm-ahm-demo",
              resourceGroup: "rg-ahm-demo",
              location: "northeurope",
            },
          ],
          default: { resourceGroup: "rg-ahm-demo", name: "hm-ahm-demo" },
        }),
      }),
    );
  }
  await page.goto("/");
  await expect(page.getByTestId("model-name")).toBeVisible();
}

async function openAssistant(page: Page) {
  await page.getByTestId("chat-toggle").click();
  const panel = page.getByTestId("chat-panel");
  const frame = page.getByTestId("chat-frame");
  await expect(panel).toBeVisible({ timeout: 22_000 });
  await expect(frame).toBeVisible({ timeout: 22_000 });
  const embedded = page.frameLocator('[data-testid="chat-frame"]');
  await expect
    .poll(
      async () =>
        embedded.locator("html").evaluate((node) => node.dataset.agentReady ?? ""),
      { timeout: 22_000 },
    )
    .toBe("true");
}

async function expectSingleOperationId(alert: Locator, operationId: string): Promise<void> {
  const escaped = operationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`Operation\\s+${escaped}\\.`, "g");
  await expect
    .poll(async () => {
      const text = await alert.innerText();
      return (text.match(pattern) ?? []).length;
    })
    .toBe(1);
}

for (const viewport of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-768", width: 768, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
]) {
  test(`exact-origin assistant surface at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await loadHealthPulse(page);

    const opener = page.getByTestId("chat-toggle");
    await openAssistant(page);
    const panel = page.getByTestId("chat-panel");
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    if (viewport.width <= 720) {
      expect(box!.x).toBe(0);
      expect(Math.round(box!.width)).toBe(viewport.width);
    }

    const frame = page.getByTestId("chat-frame");
    const embedded = page.frameLocator('[data-testid="chat-frame"]');
    const src = await frame.getAttribute("src");
    expect(src).toBe("/agent?embed=1");
    const agentRequests = requests.filter((url) => new URL(url).pathname.startsWith("/agent"));
    expect(agentRequests.length).toBeGreaterThan(0);
    for (const url of agentRequests) {
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    }

    await page.evaluate(() => {
      (window as unknown as { __agentCloseCount?: number }).__agentCloseCount = 0;
      window.addEventListener("message", (event) => {
        if (event.data?.type === "health-agent-close") {
          (window as unknown as { __agentCloseCount?: number }).__agentCloseCount =
            ((window as unknown as { __agentCloseCount?: number }).__agentCloseCount ?? 0) + 1;
        }
      });
    });
    const textInput = embedded.getByRole("textbox", {
      name: "Health copilot message input",
    });
    await textInput.focus();
    await textInput.press("Escape");
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __agentCloseCount?: number }).__agentCloseCount ?? 0),
      )
      .toBe(1);
  });
}

test("duplicate iframe close messages keep chat closed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  const opener = page.getByTestId("chat-toggle");
  await openAssistant(page);
  const frame = page.frameLocator('[data-testid="chat-frame"]');
  await frame.locator("html").evaluate((element, parentOrigin) => {
    element.ownerDocument.defaultView?.parent.postMessage(
      { type: "health-agent-close", version: 1 },
      parentOrigin,
    );
    element.ownerDocument.defaultView?.parent.postMessage(
      { type: "health-agent-close", version: 1 },
      parentOrigin,
    );
  }, new URL(page.url()).origin);

  await expect(page.getByTestId("chat-panel")).toBeHidden();
  await expect(opener).toBeFocused();
  await page.waitForTimeout(120);
  await expect(page.getByTestId("chat-panel")).toBeHidden();
});

for (const viewport of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
]) {
  test(`parent Escape closes chat and restores opener at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loadHealthPulse(page);
    const opener = page.getByTestId("chat-toggle");
    await openAssistant(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-panel")).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

test("embedded chat adopts dark and light theme tokens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  await openAssistant(page);
  const frame = page.frameLocator('[data-testid="chat-frame"]');
  const copilot = frame.locator("[data-copilotkit]").first();
  await expect(copilot).toBeVisible();
  const readRootTheme = async () =>
    frame.locator("html").evaluate((element) => element.dataset.theme ?? "");
  const darkRoot = await readRootTheme();

  await page.getByTestId("theme-toggle").click();
  await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  const lightRoot = await readRootTheme();
  expect(lightRoot).not.toBe(darkRoot);
});

for (const failure of [
  {
    name: "agent app 503",
    retryable: true,
    operationId: "op-503",
    message: "The assistant is temporarily unavailable. Retry to reconnect.",
    expected: "temporarily unavailable",
    retryVisible: true,
  },
  {
    name: "agent app 400",
    retryable: false,
    operationId: "op-400",
    message: "The assistant requires configuration before it can run.",
    expected: "requires configuration",
    retryVisible: false,
  },
]) {
  test(`${failure.name} is surfaced with bounded details and retry control`, async ({ page }) => {
    await loadHealthPulse(page);
    const parentOrigin = new URL(page.url()).origin;
    await openAssistant(page);
    const frame = page.frameLocator('[data-testid="chat-frame"]');
    await frame.locator("html").evaluate((element, data) => {
      element.ownerDocument.defaultView?.parent.postMessage(
        {
          type: "health-agent-error",
          version: 1,
          component: "agent-app",
          retryable: data.retryable,
          operationId: data.operationId,
          message: data.message,
        },
        data.parentOrigin,
      );
    }, { ...failure, parentOrigin });

    const alert = page.getByTestId("chat-error");
    await expect(alert).toBeVisible({ timeout: 22_000 });
    await expect(alert).toContainText(failure.expected);
    await expectSingleOperationId(alert, failure.operationId);
    if (failure.retryVisible) {
      await expect(page.getByRole("button", { name: "Retry assistant" })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "Retry assistant" })).toHaveCount(0);
    }
  });
}

test("nonretryable runtime response flows from iframe run request to parent configuration guidance", async ({
  page,
}) => {
  let runCalls = 0;
  await page.route("**/agent/api/copilotkit/agent/default/run", async (route) => {
    runCalls += 1;
    const body = route.request().postDataJSON() as {
      threadId?: string;
      runId?: string;
    };
    const threadId = body.threadId ?? "thread-config";
    const runId = body.runId ?? "run-config";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId })}\n\n` +
        `data: ${JSON.stringify({
          type: "RUN_ERROR",
          threadId,
          runId,
          code: "agent_runtime_unconfigured",
          message:
            "The assistant requires configuration before it can run. Operation op-probe-config.",
        })}\n\n`,
    });
  });

  await loadHealthPulse(page);
  await openAssistant(page);
  const frame = page.frameLocator('[data-testid="chat-frame"]');
  const input = frame.locator("textarea").first();
  await input.fill("Summarize current health.");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => runCalls).toBeGreaterThan(0);

  const alert = page.getByTestId("chat-error");
  await expect(alert).toBeVisible({ timeout: 22_000 });
  await expect(alert).toContainText("requires configuration");
  await expectSingleOperationId(alert, "op-probe-config");
  await expect(alert).not.toContainText("Operation Operation.");
  await expect(page.getByRole("button", { name: "Retry assistant" })).toHaveCount(0);
  await expect(page.getByTestId("chat-frame")).toBeVisible();
});

test("assistant policies, reduced motion, and accessibility are strict", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loadHealthPulse(page);
  const parent = await page.request.get("/");
  expect(parent.headers()["content-security-policy"]).toContain("frame-src 'self'");
  expect(parent.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const child = await page.request.get("/agent?embed=1");
  expect(child.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");

  await openAssistant(page);
  const frame = page.frameLocator('[data-testid="chat-frame"]');
  await expect(
    frame.getByRole("textbox", { name: "Health copilot message input" }),
  ).toBeVisible();
  const duration = await page
    .getByTestId("chat-panel")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration || "0"));
  expect(duration).toBeLessThanOrEqual(0.01);
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact || ""),
  );
  expect(severe).toEqual([]);
  const namedControls = results.violations.filter((violation) =>
    ["landmark-unique", "button-name"].includes(violation.id),
  );
  expect(namedControls).toEqual([]);
});
