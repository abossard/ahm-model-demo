import { expect, test } from "@playwright/test";
import { installStubs } from "./fixture";

test("AC9 — copilot chat is a same-origin /agent iframe that hydrates and signals readiness", async ({
  page,
}) => {
  const cspErrors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy/i.test(text) || /securitypolicyviolation/i.test(text)) {
      cspErrors.push(text);
    }
  });
  await page.addInitScript(() => {
    (window as unknown as { __viol: string[] }).__viol = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __viol: string[] }).__viol.push(event.violatedDirective);
    });
  });

  await installStubs(page, { healthModelFails: false });
  await page.goto("/");
  const opener = page.getByTestId("chat-toggle");
  await opener.click();

  const frame = page.getByTestId("chat-frame");
  await expect(frame).toBeVisible();

  const src = await frame.getAttribute("src");
  expect(src).toBe("/agent?embed=1");
  const resolved = new URL(src ?? "", page.url());
  expect(resolved.origin).toBe(new URL(page.url()).origin);
  expect(resolved.pathname).toBe("/agent");

  const embedded = page.frameLocator('[data-testid="chat-frame"]');
  await expect
    .poll(
      async () =>
        embedded.locator("html").evaluate((node) => node.dataset.agentReady ?? ""),
      { timeout: 22_000 },
    )
    .toBe("true");
  await expect(embedded.locator("textarea").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(frame).toBeHidden();
  await expect(opener).toBeFocused();

  const violations = await page.evaluate(
    () => (window as unknown as { __viol: string[] }).__viol,
  );
  expect(violations).toEqual([]);
  expect(cspErrors).toEqual([]);
});

test("nonretryable runtime errors surface configuration guidance without retry", async ({
  page,
}) => {
  await installStubs(page, { healthModelFails: false });
  await page.route("**/agent/api/copilotkit/agent/default/run", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "agent_runtime_unconfigured",
          message: "The assistant requires configuration before it can run.",
          retryable: false,
          operationId: "op-config",
        },
      }),
    });
  });
  await page.goto("/");
  await page.getByTestId("chat-toggle").click();
  const frame = page.frameLocator('[data-testid="chat-frame"]');
  await expect
    .poll(
      async () =>
        frame.locator("html").evaluate((node) => node.dataset.agentReady ?? ""),
      { timeout: 22_000 },
    )
    .toBe("true");
  const input = frame.locator("textarea").first();
  await input.fill("Summarize current health.");
  await input.press("Enter");

  const alert = page.getByTestId("chat-error");
  await expect(alert).toBeVisible({ timeout: 22_000 });
  await expect(alert).toContainText("requires configuration");
  await expect(alert).toContainText("Operation op-config.");
  await expect(page.getByRole("button", { name: "Retry assistant" })).toHaveCount(0);
});

test("AC9 — the parent CSP blocks a cross-origin chat frame", async ({ page }) => {
  await installStubs(page, { healthModelFails: false });
  await page.goto("/");

  const blocked = await page.evaluate(async () => {
    return await new Promise<boolean>((resolve) => {
      const handler = (event: SecurityPolicyViolationEvent) => {
        if (event.violatedDirective.startsWith("frame-src")) {
          document.removeEventListener("securitypolicyviolation", handler);
          resolve(true);
        }
      };
      document.addEventListener("securitypolicyviolation", handler);
      const frame = document.createElement("iframe");
      frame.src = "http://127.0.0.1:8100/agent";
      document.body.appendChild(frame);
      setTimeout(() => resolve(false), 3000);
    });
  });

  expect(blocked).toBe(true);
});
