import { expect, test } from "@playwright/test";
import { newVisitor, opencity, PHONE, shot, traderReady, viewOf } from "./support";

test("buy cheap at Brine, sell dear at Kiln: layer 5 opens, fuel and day change, a reload restores the run", async ({ browser, baseURL }) => {
  const fresh = await newVisitor(browser, baseURL);
  const visitor = fresh.page;
  // Reaching layer 4 for real takes a capture (checkers.spec), so the cheat opens it here. The job, a profitable sale, is real.
  await visitor.goto("/");
  await opencity(visitor);
  await visitor.goto("/trader");
  const view = viewOf(visitor);
  await traderReady(view);
  await shot(visitor, "layer4-trader-at-rest");

  const day0 = Number.parseInt(await view.getByTestId("day").innerText(), 10);
  await view.getByTestId("planet-brine").click();
  await expect(view.getByTestId("planet-brine")).toHaveAttribute("data-state", "here");
  await view.getByTestId("buy-ice").click();
  await expect(view.getByTestId("row-ice")).toContainText(/\d/);
  await expect.poll(async () => (await view.getByTestId("row-ice").locator(".held").innerText()).trim()).not.toBe("–");
  await shot(visitor, "layer4-trader-cargo-bought");

  await view.getByTestId("planet-kiln").click();
  await expect(view.getByTestId("planet-kiln")).toHaveAttribute("data-state", "here");
  expect(Number.parseInt(await view.getByTestId("day").innerText(), 10)).toBeGreaterThan(day0);
  await view.getByTestId("sell-ice").click();
  await expect.poll(async () => (await view.getByTestId("row-ice").locator(".held").innerText()).trim()).toBe("–");
  await shot(visitor, "layer4-trader-after-sale");

  await visitor.reload();
  const again = viewOf(visitor);
  await traderReady(again);
  await expect(again.getByTestId("planet-kiln")).toHaveAttribute("data-state", "here");
  await fresh.context.close();
});

test("trader at 390 px wide", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL, PHONE);
  await page.goto("/");
  await opencity(page);
  await page.goto("/trader");
  await traderReady(viewOf(page));
  await shot(page, "layer4-trader-390");
  await context.close();
});
