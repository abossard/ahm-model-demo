import { expect, test } from "@playwright/test";
import { helloReady, newVisitor, openDrawer, openLayer, PHONE, rows, shot } from "./support";

test("one ping shows four paired rows on two hops, with a trace and an expandable message", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  const hello = await openLayer(page, "/briefing", helloReady);
  await openDrawer(page);
  await page.getByTestId("wire-clear").click();

  await hello.getByTestId("hello-ping").click();
  await expect(hello.getByTestId("hello-count")).toHaveText("1");

  const pingRows = rows(page, { tool: "hello_ping" });
  await expect(pingRows).toHaveCount(4);
  const sequence = await pingRows.evaluateAll((all) =>
    all.map((row) => `${(row as HTMLElement).dataset.hop}:${(row as HTMLElement).dataset.kind}`));
  // The request goes down the hops in order. The two replies may be filed in either order: the server's feed is its own stream.
  expect(sequence.slice(0, 2)).toEqual(["view-host:request", "host-server:request"]);
  expect(sequence.slice(2).sort()).toEqual(["host-server:response", "view-host:response"]);

  const methods = await pingRows.evaluateAll((all) => all.map((row) => (row as HTMLElement).dataset.method));
  expect(new Set(methods)).toEqual(new Set(["tools/call"]));

  // Request and response of a hop are paired: selecting the request offers its reply.
  await pingRows.first().click();
  await expect(page.getByTestId("wire-detail")).toBeVisible();
  await expect(page.getByTestId("wire-detail")).toContainText("hello_ping");
  await expect(page.getByTestId("wire-jump-partner")).toBeVisible();
  await expect(page.getByTestId("unlock-band")).toBeHidden({ timeout: 10_000 });
  await shot(page, "wire-drawer-message-open");

  await page.getByTestId("wire-jump-partner").click();
  await expect(page.getByTestId("wire-detail")).toContainText("pings");
  await context.close();
});

test("filters, pause and clear work", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  const hello = await openLayer(page, "/briefing", helloReady);
  await openDrawer(page);
  await hello.getByTestId("hello-ping").click();
  await expect(rows(page, { tool: "hello_ping" })).toHaveCount(4);

  await page.getByTestId("wire-filter-hop").selectOption("host-server");
  await expect(rows(page, { hop: "view-host" })).toHaveCount(0);
  await expect(rows(page, { hop: "host-server" }).first()).toBeVisible();
  await page.getByTestId("wire-filter-hop").selectOption("all");

  const total = await rows(page).count();
  await page.getByTestId("wire-filter-text").fill("hello_ping");
  await expect.poll(() => rows(page).count()).toBeGreaterThanOrEqual(4);
  await expect.poll(() => rows(page).count()).toBeLessThan(total);
  await page.getByTestId("wire-filter-text").fill("");

  await page.getByTestId("wire-pause").click();
  const before = await rows(page).count();
  await hello.getByTestId("hello-ping").click();
  await expect(hello.getByTestId("hello-count")).toHaveText("2");
  await page.waitForTimeout(500);
  expect(await rows(page).count()).toBe(before);
  await page.getByTestId("wire-pause").click();
  await expect.poll(() => rows(page).count()).toBeGreaterThan(before);

  await page.getByTestId("wire-clear").click();
  await expect(rows(page)).toHaveCount(0);
  await context.close();
});

test("the console has a [wire] line for each message", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  const lines: string[] = [];
  page.on("console", (message) => { if (message.text().startsWith("[wire]")) lines.push(message.text()); });
  const hello = await openLayer(page, "/briefing", helloReady);
  await hello.getByTestId("hello-ping").click();
  await expect(hello.getByTestId("hello-count")).toHaveText("1");
  await expect.poll(() => lines.filter((line) => line.includes("hello_ping")).length).toBeGreaterThanOrEqual(4);
  await context.close();
});

test("the drawer is a sheet on a phone", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL, PHONE);
  const hello = await openLayer(page, "/briefing", helloReady);
  await hello.getByTestId("hello-ping").click();
  await openDrawer(page);
  await expect(rows(page, { tool: "hello_ping" })).toHaveCount(4);
  await shot(page, "wire-drawer-390");
  await context.close();
});
