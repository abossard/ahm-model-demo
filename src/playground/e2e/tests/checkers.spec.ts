import { expect, test } from "@playwright/test";
import { lobbyReady, newVisitor, opencity, playFirstMove, playUntilCapture, shot, viewOf, VIEW_READY_MS } from "./support";

test("two visitors share a board: a move by one appears for the other without a reload", async ({ browser, baseURL }) => {
  const a = await newVisitor(browser, baseURL);
  const b = await newVisitor(browser, baseURL);
  await a.page.goto("/");
  await opencity(a.page);
  await b.page.goto("/");
  await opencity(b.page);

  await a.page.goto("/checkers");
  const viewA = viewOf(a.page);
  await lobbyReady(viewA);
  await shot(a.page, "layer3-checkers-lobby");
  await viewA.getByTestId("lobby-create").click();
  await expect(viewA.getByTestId("status")).toBeVisible({ timeout: VIEW_READY_MS });
  await expect(a.page).toHaveURL(/\/checkers\/[a-z0-9-]+$/);
  await shot(a.page, "layer3-checkers-waiting");

  // B opens the invite link and takes the open seat.
  await b.page.goto(new URL(a.page.url()).pathname);
  const viewB = viewOf(b.page);
  await expect(viewB.getByTestId("turn")).toBeVisible({ timeout: VIEW_READY_MS });
  await expect(viewA.getByTestId("turn")).toHaveAttribute("data-turn", /black|white/);
  await expect(viewA.getByTestId("status")).not.toContainText(/waiting/i);

  // The side to move plays; the other side sees the move count change.
  const [mover, other, moverPage, otherPage] =
    (await viewA.getByTestId("turn").getAttribute("data-mine")) === "true"
      ? [viewA, viewB, a.page, b.page] : [viewB, viewA, b.page, a.page];
  await expect(other.locator(".ck-count")).toContainText("0 moves");
  await playFirstMove(mover);
  await expect(other.locator(".ck-count")).toContainText("1 move played", { timeout: 15_000 });
  await expect(other.getByTestId("turn")).toHaveAttribute("data-mine", "true");
  await shot(otherPage, "layer3-checkers-player-b-after-move");
  await shot(moverPage, "layer3-checkers-player-a-after-move");

  // Play on until a piece is taken: the capture opens layer 4 for the mover.
  await playUntilCapture([viewA, viewB]);
  await expect.poll(async () =>
    (await a.page.getByTestId("rung-4").getAttribute("data-state")) === "open"
    || (await b.page.getByTestId("rung-4").getAttribute("data-state")) === "open", { timeout: 20_000 }).toBe(true);
  await shot(a.page, "layer3-checkers-after-capture");
  await a.context.close();
  await b.context.close();
});

test("against the house a capture opens layer 4 and the offer", async ({ browser, baseURL }) => {
  const { context, page } = await newVisitor(browser, baseURL);
  await page.goto("/");
  await opencity(page);
  await page.goto("/checkers");
  const view = viewOf(page);
  await lobbyReady(view);
  await view.getByTestId("lobby-create-bot").click();
  await expect(view.getByTestId("turn")).toBeVisible({ timeout: VIEW_READY_MS });
  await shot(page, "layer3-checkers-vs-house-start");
  await playUntilCapture([view], 80, "white");
  await expect(page.getByTestId("rung-4")).toHaveAttribute("data-state", "open");
  await shot(page, "layer3-checkers-vs-house-capture");
  await context.close();
});
