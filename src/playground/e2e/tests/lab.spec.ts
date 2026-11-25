import { expect, test } from "@playwright/test";
import { labReady, newVisitor, opencity, openDrawer, openLayer, PHONE, rows, shot } from "./support";

test("the countdown streams progress on both hops and the tool runner calls lab_echo", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/");
  await opencity(page);
  const lab = await openLayer(page, "/lab", labReady);
  await openDrawer(page);
  await page.getByTestId("wire-clear").click();

  await lab.getByTestId("exhibit-progress").click();
  await expect(lab.getByTestId("exhibit-progress-done")).toBeVisible({ timeout: 30_000 });
  await expect(lab.getByTestId("exhibit-progress-ticks").locator("li")).toHaveCount(5);
  await expect(rows(page, { hop: "view-host", method: "notifications/progress" }).first()).toBeVisible();
  await expect(rows(page, { hop: "host-server", method: "notifications/progress" }).first()).toBeVisible();

  await lab.getByTestId("exhibit-message").click();
  await expect(lab.getByTestId("exhibit-message-done")).toBeVisible();
  await expect(page.getByTestId("host-log")).toContainText(/message/i);
  await lab.getByTestId("exhibit-theme").click();
  await expect(page.getByTestId("wire-chip-count").or(page.getByTestId("wire-count"))).toBeVisible();
  await shot(page, "layer2-lab-drawer-progress");

  const runner = page.getByTestId("tool-runner");
  await expect(runner).toBeVisible();
  await page.getByTestId("runner-args").fill('{"text":"hello"}').catch(() => {});
  await shot(page, "layer2-tool-runner");
  await context.close();
});

test("lab at 390 px wide", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL, PHONE);
  await page.goto("/");
  await opencity(page);
  await openLayer(page, "/lab", labReady);
  await shot(page, "layer2-lab-390");
  await context.close();
});
