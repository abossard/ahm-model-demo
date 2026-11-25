import { expect, test } from "@playwright/test";
import { helloReady, newVisitor, opencity, openDrawer, openLayer, rows, shot, viewOf, VIEW_READY_MS } from "./support";

// PLAYGROUND_URL=https://<host fqdn> npx playwright test -c playwright.deployed.config.ts
test("healthz is ok on the host", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.ok()).toBe(true);
  expect((await response.json()).ok).toBe(true);
});

test("the hello flow shows both hops in the drawer", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  const hello = await openLayer(page, "/briefing", helloReady);
  await openDrawer(page);
  await hello.getByTestId("hello-ping").click();
  await expect(page.getByTestId("unlock-band")).toBeVisible();
  await expect(rows(page, { hop: "view-host", tool: "hello_ping" }).first()).toBeVisible();
  await expect(rows(page, { hop: "host-server", tool: "hello_ping" }).first()).toBeVisible();
  await shot(page, "deployed-hello");
  await context.close();
});

test("one blackjack round with the real model ends settled", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/");
  await opencity(page);
  await page.goto("/blackjack");
  const view = viewOf(page);
  await view.getByTestId("lobby-create").click({ timeout: VIEW_READY_MS });
  await expect(view.getByTestId("chips")).toBeVisible({ timeout: VIEW_READY_MS });
  await view.getByTestId("bet-50").click();
  await expect.poll(async () => {
    const stand = view.getByTestId("act-stand");
    if (await stand.isVisible() && await stand.isEnabled()) await stand.click().catch(() => {});
    return view.getByTestId("phase").getAttribute("data-phase");
  }, { timeout: 60_000, intervals: [500] }).toBe("settled");
  await shot(page, "deployed-blackjack-settled");
  await context.close();
});
