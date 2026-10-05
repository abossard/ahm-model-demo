import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

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
      { value: "custom", label: "Custom reason" },
    ],
  },
};

async function loadHealthPulse(page: Page) {
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
  await page.goto("/");
  await expect(page.getByTestId("model-name")).toBeVisible();
}

async function openAssistant(page: Page) {
  await page.getByTestId("chat-toggle").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible({ timeout: 22_000 });
  const frame = page.frameLocator('[data-testid="chat-frame"]');
  await expect
    .poll(
      async () => frame.locator("html").evaluate((node) => node.dataset.agentReady ?? ""),
      { timeout: 22_000 },
    )
    .toBe("true");
  return frame;
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function renderedContrast(
  locator: Locator,
  pseudo: string | null = null,
  property: "color" | "backgroundColor" | "outlineColor" = "color",
) {
  return locator.evaluate((element, { pseudo, property }) => {
    type Color = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const parse = (value: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (front: Color, back: Color): Color => [
      ...front.slice(0, 3).map((channel, i) => channel * front[3] + back[i]! * (1 - front[3])),
      1,
    ] as Color;
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    const styles = ancestors.map((node) => getComputedStyle(node));
    const style = getComputedStyle(element, pseudo);
    const color = parse(style[property]);
    if (pseudo) color[3] *= Number(style.opacity);
    const paint = (index: number, backdrop: Color, text: boolean): Color => {
      const current = styles[index]!;
      const background = index === styles.length - 1 && property !== "color"
        ? backdrop : over(parse(current.backgroundColor), backdrop);
      const painted = index + 1 < styles.length
        ? paint(index + 1, background, text)
        : text ? over(color, background) : background;
      return over([painted[0], painted[1], painted[2], Number(current.opacity)], backdrop);
    };
    const foreground = paint(0, [255, 255, 255, 1], true);
    const background = paint(0, [255, 255, 255, 1], false);
    const luminance = (rgb: Color) => rgb.slice(0, 3).reduce((sum, channel, i) => {
      const s = channel / 255;
      return sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
    }, 0);
    const light = luminance(foreground);
    const dark = luminance(background);
    return {
      color: style[property],
      foreground: foreground.slice(0, 3),
      background: background.slice(0, 3),
      opacity: styles.reduce((product, current) => product * Number(current.opacity), 1),
      ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
    };
  }, { pseudo, property });
}

for (const initialTheme of ["dark", "light"] as const) {
  test(`populated conversation contrast and retained draft from ${initialTheme}`, async ({ page }, testInfo) => {
    test.skip(Boolean(process.env.LIVE_BASE_URL), "Deterministic renderer check is local only.");
    await page.emulateMedia({ colorScheme: initialTheme });
    await page.setViewportSize({ width: 1440, height: 1100 });
    const reply = "The application is **Degraded**.\n\n- Inspect the `queue` signal.\n- Read the [health guidance](https://example.com/health).\n\n```text\nstatus: Degraded\n```";
    let finishRun!: () => void;
    const pendingRun = new Promise<void>((resolve) => { finishRun = resolve; });
    await page.route("**/agent/api/copilotkit/agent/default/run", async (route) => {
      const { threadId, runId } = route.request().postDataJSON() as { threadId: string; runId: string };
      await pendingRun;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: sse([
          { type: "RUN_STARTED", threadId, runId },
          { type: "TEXT_MESSAGE_START", messageId: "contrast-reply", role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: "contrast-reply", delta: reply },
          { type: "TEXT_MESSAGE_END", messageId: "contrast-reply" },
          { type: "RUN_FINISHED", threadId, runId, outcome: { type: "success" } },
        ]),
      });
    });
    await loadHealthPulse(page);
    const frame = await openAssistant(page);
    const input = frame.getByRole("textbox", { name: "Health copilot message input" });
    const send = frame.getByRole("button", { name: "Send message", exact: true });
    await expect(send).toBeDisabled();
    expect((await renderedContrast(send)).opacity).toBeLessThan(1);
    const placeholder = await renderedContrast(input, "::placeholder");
    console.log(JSON.stringify({ theme: initialTheme, surface: "visible empty placeholder", ...placeholder }));
    expect.soft(placeholder.ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath(`${initialTheme}-empty-input.png`) });
    await input.fill("Explain application health.");
    await expect(send).toBeEnabled();
    await send.click();
    const user = frame.locator(".copilotKitUserMessage");
    const assistant = frame.locator(".copilotKitAssistantMessage");
    await expect(user).toHaveText("Explain application health.");
    await expect(frame.getByTestId("copilot-chat")).toHaveAttribute("data-copilot-running", "true");
    await expect(send).toBeEnabled();
    await expect(send.locator("svg.lucide-square")).toBeVisible();
    const loading = await renderedContrast(user.locator(":scope > div").first());
    console.log(JSON.stringify({ theme: initialTheme, surface: "loading user bubble", ...loading }));
    expect.soft(loading.ratio).toBeGreaterThanOrEqual(4.5);
    expect(loading.opacity).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`${initialTheme}-loading.png`) });
    finishRun();
    await expect(assistant).toContainText("status: Degraded");
    await expect(frame.getByTestId("copilot-chat")).toHaveAttribute("data-copilot-running", "false");
    await expect(send).toBeDisabled();
    const disabled = await renderedContrast(send);
    expect(disabled.opacity).toBeLessThan(1);
    console.log(JSON.stringify({ theme: initialTheme, surface: "empty disabled send", ...disabled }));
    await input.fill("Unsent health question");
    await expect(send).toBeEnabled();
    const iframe = page.frames().find((candidate) => candidate.url().includes("/agent?embed=1"));
    const timeOrigin = await frame.locator("html").evaluate(() => performance.timeOrigin);
    let navigations = 0;
    page.on("framenavigated", (navigated) => {
      if (navigated === iframe) navigations += 1;
    });
    const opposite = initialTheme === "dark" ? "light" : "dark";
    for (const theme of [initialTheme, opposite, initialTheme]) {
      if (theme !== await frame.locator("html").getAttribute("data-theme")) {
        await page.getByTestId("theme-toggle").click();
      }
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(frame.locator("html")).toHaveClass(theme === "dark" ? "dark" : "");
      await expect(input).toHaveValue("Unsent health question");
      await expect(user).toHaveText("Explain application health.");
      await expect(assistant).toContainText("status: Degraded");
      await page.mouse.move(0, 0);
      await expect.poll(async () => (await renderedContrast(send, null, "backgroundColor")).ratio).toBeGreaterThanOrEqual(3);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-populated.png`) });
      const samples = [
        { name: "user bubble", locator: user.locator(":scope > div").first() },
        ...["p", '[data-streamdown="strong"]', "li", "a", "code"].map((selector) => ({
          name: `assistant ${selector}`,
          locator: assistant.locator(selector),
        })),
        { name: "assistant code text", locator: assistant.locator("pre code span span").filter({ hasText: "status: Degraded" }) },
        { name: "input value", locator: input },
        { name: "input placeholder", locator: input, pseudo: "::placeholder" },
      ];
      for (const sample of samples) {
        await expect(sample.locator.first()).toBeVisible();
        for (const node of await sample.locator.all()) {
          const colors = await renderedContrast(node, sample.pseudo ?? null);
          console.log(JSON.stringify({ theme, surface: sample.name, ...colors }));
          expect.soft(colors.ratio, `${theme} ${sample.name}`).toBeGreaterThanOrEqual(4.5);
          expect.soft(colors.opacity, `${theme} ${sample.name} ready opacity`).toBe(1);
        }
      }
      for (const [name, control] of [["input", input], ["send", send]] as const) {
        await input.press("Tab");
        await control.focus();
        expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await control.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
        await control.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
        const focus = await renderedContrast(control, null, "outlineColor");
        console.log(JSON.stringify({ theme, surface: `${name} focus indicator`, ...focus }));
        expect.soft(focus.ratio).toBeGreaterThanOrEqual(3);
      }
      const enabled = await renderedContrast(send);
      const button = await renderedContrast(send, null, "backgroundColor");
      console.log(JSON.stringify({ theme, surface: "enabled send icon", ...enabled }));
      console.log(JSON.stringify({ theme, surface: "enabled send control", ...button }));
      expect(enabled.opacity).toBe(1);
      expect(enabled.ratio).toBeGreaterThanOrEqual(3);
      expect(button.ratio).toBeGreaterThanOrEqual(3);
      expect(enabled.background).not.toEqual(disabled.background);
      const axe = await new AxeBuilder({ page }).include('[data-testid="chat-frame"]').analyze();
      console.log("AXE", JSON.stringify(axe.violations.map(({ id, impact }) => ({ id, impact }))));
      expect.soft(axe.violations.filter((violation) =>
        ["critical", "serious"].includes(violation.impact ?? ""),
      )).toEqual([]);
    }
    expect(navigations).toBe(0);
    expect(await frame.locator("html").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    console.log(JSON.stringify({ initialTheme, navigations, retainedDraft: await input.inputValue(), completedUserMessages: await user.count(), completedAssistantMessages: await assistant.count(), timeOriginUnchanged: true }));
  });
}

test("assistant page shows application-only scope and bounded report-approval starter", async ({
  page,
}) => {
  await page.goto("/agent");
  await expect(page.getByText("Application model scope only")).toBeVisible();
  await expect(
    page.getByTestId("copilot-suggestions").getByRole("button", {
      name: "Stage report with approval",
    }),
  ).toBeVisible();
});

test("starter prompts are visible on the assistant page", async ({ page }) => {
  await page.goto("/agent");
  const starters = page.getByTestId("copilot-suggestions").getByRole("button", {
    name: /Summarize application health|Explain the request journey|Inspect PostgreSQL health|Stage report with approval/,
  });
  await expect(starters).toHaveCount(4);
});

test("starter clicks send exactly one run and one user turn", async ({ page }) => {
  const scenarios = [
    {
      title: "Summarize application health",
      prefix: "Read the Health Model now.",
    },
    {
      title: "Explain the request journey",
      prefix: "Read the exact entity request-journey now.",
    },
    {
      title: "Inspect PostgreSQL health",
      prefix: "Read the exact entity postgres now.",
    },
    {
      title: "Stage report with approval",
      prefix: "Stage a health report and show every field for approval",
    },
  ] as const;

  for (const scenario of scenarios) {
    const runCalls: Array<{
      text: string;
      threadId: string;
      runId: string;
    }> = [];
    await page.unroute("**/agent/api/copilotkit/agent/default/run");
    await page.route("**/agent/api/copilotkit/agent/default/run", async (route) => {
      const body = route.request().postDataJSON() as {
        threadId?: string;
        runId?: string;
        messages?: Array<{ content?: string }>;
      };
      const content = body.messages?.[body.messages.length - 1]?.content;
      const text = typeof content === "string" ? content : "";
      const threadId = body.threadId ?? "thread-starter";
      const runId = body.runId ?? crypto.randomUUID();
      runCalls.push({ text, threadId, runId });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: sse([
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: `assistant-${runId}`,
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: `assistant-${runId}`,
            delta: "Acknowledged.",
          },
          {
            type: "TEXT_MESSAGE_END",
            messageId: `assistant-${runId}`,
          },
          {
            type: "RUN_FINISHED",
            threadId,
            runId,
            outcome: { type: "success" },
          },
        ]),
      });
    });

    await loadHealthPulse(page);
    const frame = await openAssistant(page);
    const starter = frame
      .getByTestId("copilot-suggestions")
      .getByRole("button", { name: scenario.title });
    await starter.click();

    await expect.poll(() => runCalls.length).toBe(1);
    expect(runCalls[0]?.text).toContain(scenario.prefix);
    await expect(frame.locator(".copilotKitUserMessage")).toHaveCount(1);
    await expect(frame.locator(".copilotKitUserMessage").first()).toContainText(
      scenario.prefix,
    );
  }
});

test("report approval cancel keeps backend ingest at zero while approve increments once", async ({
  page,
}) => {
  let ingestAttempts = 0;
  let approvedResumes = 0;
  let totalRunCalls = 0;
  await page.unroute("**/agent/api/copilotkit/agent/default/run");
  await page.route("**/agent/api/copilotkit/agent/default/run", async (route) => {
    totalRunCalls += 1;
    const body = route.request().postDataJSON() as {
      threadId?: string;
      runId?: string;
      resume?: Array<{ status?: string; payload?: { accepted?: boolean } }>;
    };
    const threadId = body.threadId ?? "thread-1";
    const runId = body.runId ?? crypto.randomUUID();
    if (!body.resume || body.resume.length === 0) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "RUN_FINISHED",
            threadId,
            runId,
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: "interrupt-report",
                  reason: "approval_required",
                  toolCallId: "toolcall-report",
                  metadata: {
                    agent_framework: {
                      function_call: {
                        name: "send_health_report",
                        arguments: {
                          entity_name: "api",
                          signal_name: "web-ui-health-report",
                          health_state: "Degraded",
                          value: 0.5,
                          reason_preset: "maintenance",
                          reason: "Maintenance window",
                          expires_in_minutes: 30,
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ]),
      });
      return;
    }

    const decision = body.resume[0];
    if (decision?.status === "resolved" && decision.payload?.accepted === true) {
      approvedResumes += 1;
    }
    if (decision?.status === "resolved" && decision.payload?.accepted === true) {
      ingestAttempts += 1;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "RUN_STARTED", threadId, runId },
        { type: "RUN_FINISHED", threadId, runId, outcome: { type: "success" } },
      ]),
    });
  });

  await loadHealthPulse(page);
  let frame = await openAssistant(page);
  await frame
    .getByTestId("copilot-suggestions")
    .getByRole("button", { name: "Stage report with approval" })
    .click();
  await expect(frame.getByRole("heading", { name: "Confirm health report" })).toBeVisible();
  await frame.getByRole("button", { name: "Cancel report" }).click();
  await expect(frame.getByRole("heading", { name: "Confirm health report" })).toHaveCount(0);
  expect(totalRunCalls).toBe(2);
  expect(ingestAttempts).toBe(0);

  await loadHealthPulse(page);
  frame = await openAssistant(page);
  await frame
    .getByTestId("copilot-suggestions")
    .getByRole("button", { name: "Stage report with approval" })
    .click();
  await expect(frame.getByRole("heading", { name: "Confirm health report" })).toBeVisible();
  await frame.getByRole("button", { name: "Approve report" }).click();
  await expect(frame.getByRole("heading", { name: "Confirm health report" })).toHaveCount(0);
  expect(approvedResumes).toBe(1);
  expect(totalRunCalls).toBe(4);
  expect(ingestAttempts).toBe(1);
});

test("assistant drawer remains usable at desktop, tablet and phone widths", async ({ page }) => {
  for (const [width, height] of [
    [1440, 900],
    [768, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await loadHealthPulse(page);
    const frame = await openAssistant(page);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(frame.locator("body")).toBeVisible();
  }
});
