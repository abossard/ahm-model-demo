import { expect, test } from "@playwright/test";
import { helloReady, labReady, newVisitor, opencity, openLayer, PHONE, shot, viewOf } from "./support";

test("home shows the ladder with one open rung, at both widths", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/");
  await expect(page.getByTestId("rung-1")).toHaveAttribute("data-state", "open");
  for (const n of [2, 3, 4, 5]) await expect(page.getByTestId(`rung-${n}`)).toHaveAttribute("data-state", "locked");
  await expect(page.getByTestId("wire-chip")).toBeVisible();
  await shot(page, "home-1440");
  await page.setViewportSize(PHONE);
  await shot(page, "home-390");
  await context.close();
});

test("a new visitor climbs from the briefing to the lab to checkers", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  const hello = await openLayer(page, "/briefing", helloReady);
  await expect(page.getByTestId("job")).toBeVisible();
  await shot(page, "layer1-briefing-at-rest");

  await hello.getByTestId("hello-ping").click();
  await expect(hello.getByTestId("hello-count")).toHaveText("1");
  await expect(page.getByTestId("unlock-band")).toBeVisible();
  await shot(page, "layer1-unlock-band");
  await expect(page.getByTestId("rung-2")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("rung-3")).toHaveAttribute("data-state", "locked");
  await expect(page.getByTestId("offer")).toBeVisible();
  await expect(page.getByTestId("offer-stay")).toBeVisible();
  await shot(page, "layer1-offer");

  await page.getByTestId("offer-go").click();
  await expect(page).toHaveURL(/\/lab$/);
  const lab = viewOf(page);
  await labReady(lab);
  await shot(page, "layer2-lab-at-rest");
  for (const exhibit of ["call_tool", "read_resource", "log"]) {
    await lab.getByTestId(`exhibit-${exhibit}`).click();
    await expect(lab.getByTestId(`exhibit-${exhibit}-done`)).toBeVisible();
  }
  await expect(page.getByTestId("rung-3")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("offer")).toBeVisible();
  await shot(page, "layer2-lab-three-tried");
  await page.getByTestId("offer-go").click();
  await expect(page).toHaveURL(/\/checkers$/);
  await context.close();
});

test("opencity opens every layer, and a reload keeps them", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/");
  await opencity(page);
  for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`rung-${n}`)).toHaveAttribute("data-state", "open");
  await shot(page, "home-all-open-1440");
  await page.reload();
  await expect(page.getByTestId("rung-5")).toHaveAttribute("data-state", "open");
  await context.close();
});

test("a deep link to a locked layer lands on the ladder", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/blackjack");
  await expect(page.getByTestId("ladder")).toBeVisible();
  await expect(page.getByTestId("view-frame")).toHaveCount(0);
  await shot(page, "locked-deep-link");
  await context.close();
});
