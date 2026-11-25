import { expect, test } from "@playwright/test";
import { newVisitor, opencity, shot, viewOf, VIEW_READY_MS } from "./support";

// Runs against the pair whose dealer always answers an invalid shuffle.
test("a dealer whose reply fails the check ends the round as a misdeal and returns the bets", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/");
  await opencity(page);
  await page.goto("/blackjack");
  const view = viewOf(page);
  await view.getByTestId("lobby-create").click({ timeout: VIEW_READY_MS });
  await expect(view.getByTestId("chips")).toHaveText("1,000", { timeout: VIEW_READY_MS });
  await view.getByTestId("bet-50").click();
  await expect(view.getByTestId("misdeal")).toBeVisible({ timeout: 60_000 });
  await expect(view.getByTestId("phase")).toHaveAttribute("data-phase", "settled");
  await expect(view.getByTestId("chips")).toHaveText("1,000");
  await expect(view.getByTestId("dealer-log")).toContainText(/rejected/i);
  await shot(page, "layer5-blackjack-misdeal");
  await context.close();
});
