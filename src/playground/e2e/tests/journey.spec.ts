import { expect, test } from "@playwright/test";
import { helloReady, labReady, lobbyReady, newVisitor, openLayer, playUntilCapture, shot, traderReady, viewOf, VIEW_READY_MS } from "./support";

// Every job is the real one. The only shortcut of the whole suite lives in the other specs: opencity.
test("a new visitor earns every layer, from the briefing to a won hand", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  const rung = (n: number) => page.getByTestId(`rung-${n}`);

  const hello = await openLayer(page, "/briefing", helloReady);
  await hello.getByTestId("hello-ping").click();
  await expect(rung(2)).toHaveAttribute("data-state", "open");
  await page.getByTestId("offer-go").click();

  const lab = viewOf(page);
  await labReady(lab);
  for (const exhibit of ["call_tool", "read_resource", "log"]) await lab.getByTestId(`exhibit-${exhibit}`).click();
  await expect(rung(3)).toHaveAttribute("data-state", "open");
  await page.getByTestId("offer-go").click();

  const checkers = viewOf(page);
  await lobbyReady(checkers);
  await checkers.getByTestId("lobby-create-bot").click();
  await expect(checkers.getByTestId("turn")).toBeVisible({ timeout: VIEW_READY_MS });
  await playUntilCapture([checkers], 80, "white");
  await expect(rung(4)).toHaveAttribute("data-state", "open");
  await page.getByTestId("offer-go").click();

  const trader = viewOf(page);
  await traderReady(trader);
  await trader.getByTestId("planet-brine").click();
  await expect(trader.getByTestId("planet-brine")).toHaveAttribute("data-state", "here");
  await trader.getByTestId("buy-ice").click();
  await expect(trader.getByTestId("row-ice").locator(".held")).not.toHaveText("–");
  await trader.getByTestId("planet-kiln").click();
  await expect(trader.getByTestId("planet-kiln")).toHaveAttribute("data-state", "here");
  await trader.getByTestId("sell-ice").click();
  await expect(rung(5)).toHaveAttribute("data-state", "open");
  await page.getByTestId("offer-go").click();

  const table = viewOf(page);
  await table.getByTestId("lobby-create").click({ timeout: VIEW_READY_MS });
  await expect(table.getByTestId("chips")).toBeVisible({ timeout: VIEW_READY_MS });
  // The fake dealer is known, but a round can still be a push or a loss: play rounds until one is won.
  for (let round = 0; round < 6 && !(await page.getByText(/every layer/i).first().isVisible()); round += 1) {
    await expect(table.getByTestId("phase")).toHaveAttribute("data-phase", "waiting", { timeout: 30_000 });
    await table.getByTestId("bet-50").click();
    await expect.poll(async () => {
      const stand = table.getByTestId("act-stand");
      if (await stand.isVisible() && await stand.isEnabled()) await stand.click().catch(() => {});
      return table.getByTestId("phase").getAttribute("data-phase");
    }, { timeout: 60_000, intervals: [300] }).toBe("settled");
    await page.waitForTimeout(500);
  }
  await expect(page.getByText(/every layer/i).first()).toBeVisible();
  await shot(page, "career-complete", false, true);
  await context.close();
});
