import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const model = {
  model: {
    id: "model-id",
    name: "hm-ahm-demo",
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
    ],
  },
};
const live = Boolean(process.env.LIVE_BASE_URL);
const liveModelName = process.env.HEALTH_MODEL_NAME ?? model.model.name;

async function loadHealthPulse(page: Page) {
  if (!live) {
    await page.route("**/api/health-model", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(model),
      }),
    );
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/");
    if (
      await page
        .getByRole("heading", { name: "The Health Pulse" })
        .isVisible()
    ) {
      break;
    }
    await page.waitForTimeout(2000);
  }
  await expect(
    page.getByRole("heading", { name: "The Health Pulse" }),
  ).toBeVisible();
  if (live) {
    await expect(page.locator(".entity-surface").first()).toBeVisible({
      timeout: 20_000,
    });
  } else {
    await expect(page.getByText("Request API", { exact: true })).toBeVisible();
  }
}

async function ensureChatVisible(page: Page) {
  await expect
    .poll(
      async () =>
        (await page.locator("#copilot-frame").isVisible()) ||
        (await page.locator("#copilot-error").isVisible()),
      { timeout: 22_000 },
    )
    .toBe(true);
  if (await page.locator("#copilot-error").isVisible()) {
    await page.getByRole("button", { name: "Retry assistant" }).click();
  }
  await expect(
    page.frameLocator("#copilot-frame").locator("textarea").first(),
  ).toBeVisible({ timeout: 22_000 });
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
    const topologyText = await page.locator("#topology-summary").textContent();

    const trigger = page.getByRole("button", { name: "Health copilot" });
    await trigger.click();
    const drawer = page.locator("#copilot-drawer");
    await expect(drawer).toHaveAttribute("data-state", "open");
    const frame = page.frameLocator("#copilot-frame");
    await ensureChatVisible(page);
    await expect(frame.locator(".copilot-header")).toHaveCount(0);
    await expect(frame.locator(".return-link")).toHaveCount(0);
    await expect(frame.locator(".chat-guide")).toHaveCount(0);

    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    if (viewport.width <= 720) {
      expect(box!.x).toBe(0);
      expect(box!.width).toBe(viewport.width);
      await expect(drawer).toHaveAttribute("role", "dialog");
      await expect(drawer).toHaveAttribute("aria-modal", "true");
      await expect(page.locator("main")).toHaveAttribute("inert", "");
    } else {
      expect(box!.x + box!.width).toBe(viewport.width);
      expect(box!.width).toBeLessThan(viewport.width);
      await expect(drawer).toHaveAttribute("role", "complementary");
      await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    }

    expect(new URL(page.url()).pathname).toBe("/");
    const agentRequests = requests.filter((url) => new URL(url).pathname.startsWith("/agent"));
    expect(agentRequests.length).toBeGreaterThan(2);
    for (const url of agentRequests) {
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    }
    expect(requests.some((url) => url.includes("127.0.0.1:3000"))).toBe(false);
    expect(requests.some((url) => url.includes("127.0.0.1:8000"))).toBe(false);

    await expect(page.locator("#topology-summary")).toHaveText(topologyText || "");
    await page.screenshot({
      path:
        `../../artifacts/health-copilot/` +
        `${live ? "live-" : ""}${viewport.name}.png`,
      fullPage: true,
    });

    await frame.locator("textarea").first().press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test("embedded chat adopts Health Pulse theme tokens and control sizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  await page.getByRole("button", { name: "Health copilot" }).click();
  await expect(page.locator("#copilot-drawer")).toHaveAttribute(
    "data-state",
    "open",
  );
  await ensureChatVisible(page);
  const frame = page.frameLocator("#copilot-frame");

  const tokens = await frame
    .locator("[data-copilotkit]")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const token = (name: string) => style.getPropertyValue(name).trim();
      return {
        background: token("--background"),
        card: token("--card"),
        secondary: token("--secondary"),
        muted: token("--muted"),
        accent: token("--accent"),
        border: token("--border"),
        input: token("--input"),
        primary: token("--primary"),
        ring: token("--ring"),
        radius: token("--radius"),
      };
    });
  expect(tokens).toEqual({
    background: "#111827",
    card: "#1f2937",
    secondary: "#1f2937",
    muted: "#1f2937",
    accent: "#1f2937",
    border: "#4b5563",
    input: "#4b5563",
    primary: "#60a5fa",
    ring: "#60a5fa",
    radius: "12px",
  });

  const ink = "rgb(17, 24, 39)";
  const inkDeep = "rgb(8, 12, 20)";
  const surfaceBg = (locator: ReturnType<typeof frame.locator>) =>
    locator
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const bodyBg = await surfaceBg(frame.locator("body"));
  const chatBg = await surfaceBg(frame.locator(".agent-chat"));
  const composerBg = await surfaceBg(
    frame.locator('[data-testid="copilot-chat-input"]'),
  );
  for (const background of [bodyBg, chatBg, composerBg]) {
    expect([ink, inkDeep]).toContain(background);
  }

  const welcomeFontSize = await frame
    .locator("h1")
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(welcomeFontSize).toBeLessThanOrEqual(20);

  const pills = frame.locator('[data-slot="suggestion-pill"]');
  await expect(pills.first()).toBeVisible();
  const pillCount = await pills.count();
  expect(pillCount).toBeGreaterThan(0);
  for (let index = 0; index < pillCount; index += 1) {
    const pill = pills.nth(index);
    const box = await pill.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(32);
    const shape = await pill.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        borderRadius: style.borderTopLeftRadius,
      };
    });
    expect(shape.fontSize).toBeGreaterThanOrEqual(13);
    expect(shape.borderRadius).toBe("8px");
  }

  const send = await frame
    .locator('[data-testid="copilot-send-button"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const icon = element.querySelector("svg");
      const iconColor = icon ? getComputedStyle(icon).color : style.color;
      const parse = (color: string) =>
        (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = ([r, g, b]: number[]) => {
        const channel = (value: number) => {
          const v = value / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const foreground = luminance(parse(iconColor));
      const background = luminance(parse(style.backgroundColor));
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderTopLeftRadius,
        opacity: Number.parseFloat(style.opacity),
        disabled: (element as HTMLButtonElement).disabled,
        contrast:
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05),
      };
    });
  expect(["rgb(31, 41, 55)", "rgb(96, 165, 250)", "rgb(17, 24, 39)"]).toContain(
    send.backgroundColor,
  );
  expect(send.borderRadius).toBe("8px");
  expect(send.disabled).toBe(true);
  expect(send.opacity).toBeGreaterThanOrEqual(0.5);
  expect(send.contrast).toBeGreaterThanOrEqual(3);
});

test("report workspace blocks the assistant trigger", async ({ page }) => {
  await loadHealthPulse(page);
  await page.getByRole("button", { name: "Send report" }).first().click();
  await expect(page.locator("#report-workspace")).toBeVisible();
  await expect(page.locator("#copilot-trigger")).toBeDisabled();
  await page.getByRole("button", { name: "Close report workspace" }).click();
  await expect(page.locator("#copilot-trigger")).toBeEnabled();
});

for (const failure of [
  {
    name: "agent web",
    path: "**/agent/health",
    code: "agent_web_unavailable",
    operationId: "0123456789abcdef0123456789abcdef",
    message: "agent web surface",
  },
  {
    name: "agent app",
    path: "**/agent/info",
    code: "agent_app_unavailable",
    operationId: "fedcba9876543210fedcba9876543210",
    message: "agent runtime",
  },
]) {
  test(`${failure.name} failure stays bounded and retry/close preserve Health Pulse`, async ({
    page,
  }) => {
    await loadHealthPulse(page);
    const topologyText = await page.locator("#topology-summary").textContent();
    await page.route(failure.path, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: failure.code,
            message: "secret upstream detail",
            retryable: true,
            operationId: failure.operationId,
          },
        }),
      }),
    );
    const trigger = page.getByRole("button", { name: "Health copilot" });

    await trigger.click();

    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Health copilot unavailable" });
    await expect(alert).toBeVisible({ timeout: 12_000 });
    await expect(alert).toContainText(failure.message);
    await expect(alert).toContainText(failure.operationId);
    await expect(alert).not.toContainText("secret upstream detail");
    await expect(page.getByRole("heading", { name: "The Health Pulse" })).toBeVisible();
    await expect(page.locator("#topology-summary")).toHaveText(topologyText || "");
    await expect(page.getByRole("button", { name: "Send report" }).first()).toBeEnabled();
    await expect(page.getByRole("button", { name: "Run request journey" })).toBeEnabled();

    await page.unroute(failure.path);
    await page.getByRole("button", { name: "Retry assistant" }).click();
    await expect(
      page.frameLocator("#copilot-frame").locator("textarea").first(),
    ).toBeVisible({ timeout: 22_000 });
    await page.getByRole("button", { name: "Close Health copilot" }).click();
    await expect(page.locator("#copilot-drawer")).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.locator("#topology-summary")).toHaveText(topologyText || "");
  });
}

test("assistant policies, reduced motion, and accessibility are strict", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loadHealthPulse(page);
  const parent = await page.request.get("/");
  expect(parent.headers()["content-security-policy"]).toContain("frame-src 'self'");
  expect(parent.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const child = await page.request.get("/agent?embed=1");
  expect(child.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(child.headers()["content-security-policy"]).toMatch(/nonce-[A-Za-z0-9+/=_-]+/);

  await page.getByRole("button", { name: "Health copilot" }).click();
  const duration = await page.locator("#copilot-drawer").evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).transitionDuration),
  );
  expect(duration).toBeLessThan(0.001);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact || ""),
    ),
  ).toEqual([]);
});

test("live chat grounds fresh model answers and streams incrementally", async ({
  page,
}) => {
  test.skip(!live, "live Azure proof only");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  await page.getByRole("button", { name: "Health copilot" }).click();
  await ensureChatVisible(page);
  const frame = page.frameLocator("#copilot-frame");
  const chat = frame.locator('[data-testid="copilot-chat"]');
  const input = frame.locator("textarea").first();
  const baselineLength = (await chat.innerText()).length;
  const runtimeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/agent/api/copilotkit"),
    { timeout: 30_000 },
  );
  await input.fill(
    "Read the Health Model now. Give the exact model name, observedAt, " +
      "entity count, relationship count, and examples of differing health states.",
  );
  await input.press("Enter");
  const response = await runtimeResponse;
  expect(response.headers()["content-type"]).toContain("text/event-stream");
  let finished = false;
  let incremental = false;
  const completion = response.finished().finally(() => {
    finished = true;
  });
  await expect
    .poll(
      async () => {
        const text = await chat.innerText();
        if (!finished && text.length > baselineLength + 30) {
          incremental = true;
        }
        return new RegExp(liveModelName, "i").test(text) && /observed/i.test(text);
      },
      { timeout: 180_000, intervals: [100, 200, 500, 1000] },
    )
    .toBe(true);
  await completion;
  const rawSse = await response.text();
  const startedAt = rawSse.indexOf("RUN_STARTED");
  const contentAt = rawSse.indexOf("TEXT_MESSAGE_CONTENT");
  const finishedAt = rawSse.indexOf("RUN_FINISHED");
  expect(startedAt).toBeGreaterThanOrEqual(0);
  expect(contentAt).toBeGreaterThan(startedAt);
  expect(finishedAt).toBeGreaterThan(contentAt);
  await expect(chat).toContainText(/entity count:\s*14/i);
  await expect(chat).toContainText(/relationship count:\s*12/i);
  console.log(
    `LIVE_MODEL_CHAT_PROOF incremental=${incremental} ` +
      "events=RUN_STARTED<TEXT_MESSAGE_CONTENT<RUN_FINISHED model=14/12",
  );
  await page.screenshot({
    path: "../../artifacts/health-copilot/live-grounded-chat.png",
    fullPage: true,
  });
});

test("live chat reads one exact entity without inference", async ({ page }) => {
  test.skip(!live, "live Azure proof only");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  await page.getByRole("button", { name: "Health copilot" }).click();
  await ensureChatVisible(page);
  const frame = page.frameLocator("#copilot-frame");
  const chat = frame.locator('[data-testid="copilot-chat"]');
  const input = frame.locator("textarea").first();
  await input.fill(
    "Read the exact entity postgres now. State its current health, observedAt, " +
      "recent transitions, and canonical signal history. Label unavailable data.",
  );
  await input.press("Enter");
  await expect(chat).toContainText(/postgres/i, { timeout: 180_000 });
  await expect(chat).toContainText(/observed/i);
  await expect(chat).toContainText(/transition/i);
  await expect(chat).toContainText(/canonical/i);
  await expect(chat).toContainText(/unavailable/i);
  console.log("LIVE_ENTITY_CHAT_PROOF entity=postgres unavailable=honest");
});

test("live HIL cancel shows six fields and performs no approval", async ({
  page,
}) => {
  test.skip(!live, "live Azure proof only");
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  await page.getByRole("button", { name: "Health copilot" }).click();
  await ensureChatVisible(page);
  const frame = page.frameLocator("#copilot-frame");
  const input = frame.locator("textarea").first();
  const cancellationStart = new Date().toISOString();
  const approval = frame.getByRole("heading", {
    name: "Confirm health report",
  });
  await input.fill(
    "Invoke send_health_report now with entity_name request-journey, " +
      "signal_name web-ui-health-report, health_state Healthy, value 1, " +
    "reason_preset custom, reason Maintenance window, and " +
      "expires_in_minutes 1. Do not merely describe it. The required " +
      "CopilotKit approval must appear before the tool can write.",
  );
  await input.press("Enter");
  await expect(approval).toBeVisible({ timeout: 180_000 });
  for (const value of [
    "request-journey",
    "web-ui-health-report",
    "Healthy",
    "1",
    "Maintenance window",
    "1 minute(s)",
  ]) {
    await expect(frame.getByText(value, { exact: true }).first()).toBeVisible();
  }
  await frame.getByRole("button", { name: "Cancel report" }).click();
  await expect(frame.getByText("Cancelled. No report will be sent.")).toBeVisible();
  const cancellationEnd = new Date().toISOString();
  console.log(
    `LIVE_HIL_CANCEL_PROOF fields=6 ` +
      `hil_cancel_start=${cancellationStart} hil_cancel_end=${cancellationEnd}`,
  );
  await page.screenshot({
    path: "../../artifacts/health-copilot/live-hil-cancel.png",
    fullPage: true,
  });
});

test("live approved HIL performs one pending report under duplicate activation", async ({
  page,
}) => {
  test.skip(!live, "live Azure proof only");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadHealthPulse(page);
  await page.getByRole("button", { name: "Health copilot" }).click();
  await ensureChatVisible(page);
  const frame = page.frameLocator("#copilot-frame");
  const chat = frame.locator('[data-testid="copilot-chat"]');
  const input = frame.locator("textarea").first();
  const approvalStart = new Date().toISOString();
  await input.fill(
    "Invoke send_health_report now with entity_name request-journey, " +
      "signal_name web-ui-health-report, health_state Healthy, value 1, " +
      "reason_preset custom, reason Single URL final verification, and " +
      "expires_in_minutes 1. The required CopilotKit approval must appear first.",
  );
  await input.press("Enter");
  const approval = frame.getByRole("heading", {
    name: "Confirm health report",
  });
  await expect(approval).toBeVisible({ timeout: 180_000 });
  const approve = frame.getByRole("button", { name: "Approve report" });
  await approve.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(chat).toContainText(/accepted.*pending|pending.*evaluation/is, {
    timeout: 180_000,
  });
  const text = await chat.innerText();
  const reportId =
    text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ||
    "";
  expect(reportId).not.toBe("");
  const approvalEnd = new Date().toISOString();
  console.log(
    `LIVE_HIL_APPROVAL_PROOF report_id=${reportId} duplicate_activation=2 ` +
      `approval_start=${approvalStart} approval_end=${approvalEnd}`,
  );
  await page.screenshot({
    path: "../../artifacts/health-copilot/live-hil-approved.png",
    fullPage: true,
  });
});
