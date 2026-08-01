import { expect, test } from "@playwright/test";
import { installStubs } from "./fixture";

test("AC9 — copilot chat is a same-origin /agent iframe that loads without CSP violations", async ({
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
  await page.getByTestId("chat-toggle").click();

  const frame = page.getByTestId("chat-frame");
  await expect(frame).toBeVisible();

  const src = await frame.getAttribute("src");
  expect(src).toBe("/agent?embed=1");
  const resolved = new URL(src ?? "", page.url());
  expect(resolved.origin).toBe(new URL(page.url()).origin);
  expect(resolved.pathname).toBe("/agent");

  const handle = await frame.elementHandle();
  await expect
    .poll(async () =>
      handle?.evaluate(
        (el) => (el as HTMLIFrameElement).contentDocument?.readyState ?? null,
      ),
    )
    .toBe("complete");

  const bodyText = await handle?.evaluate(
    (el) => (el as HTMLIFrameElement).contentDocument?.body?.textContent ?? "",
  );
  expect(bodyText).toContain("copilot ready");

  const violations = await page.evaluate(
    () => (window as unknown as { __viol: string[] }).__viol,
  );
  expect(violations).toEqual([]);
  expect(cspErrors).toEqual([]);
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
