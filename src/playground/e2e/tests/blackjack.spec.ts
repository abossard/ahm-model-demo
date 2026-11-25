import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { newVisitor, opencity, PHONE, shot, viewOf, VIEW_READY_MS, type Visitor } from "./support";

const BET = 50;

async function chips(view: FrameLocator): Promise<number> {
  return Number.parseInt((await view.getByTestId("chips").innerText()).replace(/,/g, ""), 10);
}

async function openTable(visitor: Visitor, path: string): Promise<FrameLocator> {
  await visitor.page.goto(path);
  const view = viewOf(visitor.page);
  await expect(view.getByTestId("lobby-create").or(view.getByTestId("phase"))).toBeVisible({ timeout: VIEW_READY_MS });
  return view;
}

async function unlocked(browser: Parameters<typeof newVisitor>[0], baseURL: string | undefined, size?: { width: number; height: number }): Promise<Visitor> {
  const visitor = await newVisitor(browser, baseURL, size);
  await visitor.page.goto("/");
  await opencity(visitor.page);
  return visitor;
}

async function phaseOf(view: FrameLocator): Promise<string | null> {
  return view.getByTestId("phase").getAttribute("data-phase");
}

// Stands whenever it is this player's turn, until the round is settled.
async function standUntilSettled(view: FrameLocator): Promise<void> {
  await expect.poll(async () => {
    const stand = view.getByTestId("act-stand");
    if (await stand.isVisible() && await stand.isEnabled()) await stand.click().catch(() => {});
    return phaseOf(view);
  }, { timeout: 60_000, intervals: [300] }).toBe("settled");
}

test("two players and a watcher share one table: bets, turns, the fake dealer, the result live", async ({ browser, baseURL }) => {
  const a = await unlocked(browser, baseURL);
  const b = await unlocked(browser, baseURL);
  const watcher = await unlocked(browser, baseURL);

  const viewA = await openTable(a, "/blackjack");
  await shot(a.page, "layer5-blackjack-lobby");
  await viewA.getByTestId("lobby-create").click();
  await expect(viewA.getByTestId("phase")).toBeVisible({ timeout: VIEW_READY_MS });
  await expect(a.page).toHaveURL(/\/blackjack\/[a-z0-9-]+$/);
  const tablePath = new URL(a.page.url()).pathname;
  await expect(viewA.getByTestId("chips")).toHaveText("1,000");

  // B and the watcher open the same table. B takes the second seat; the watcher only looks.
  const viewB = await openTable(b, tablePath);
  await viewB.getByTestId("sit").click();
  await expect(viewB.getByTestId("chips")).toHaveText("1,000");
  const viewW = await openTable(watcher, tablePath);
  await expect(viewW.getByTestId("to-lobby")).toBeVisible();
  await expect(viewA.getByTestId("seat-1")).not.toHaveAttribute("data-state", "empty");
  await shot(a.page, "layer5-blackjack-two-seated-player-a");
  await shot(b.page, "layer5-blackjack-two-seated-player-b");

  // Both bet inside the betting window.
  await Promise.all([viewA.getByTestId(`bet-${BET}`).click(), viewB.getByTestId(`bet-${BET}`).click()]);
  await expect(viewA.getByTestId("phase")).toHaveAttribute("data-phase", /shuffling|players/);
  await expect(viewW.getByTestId("phase")).toHaveAttribute("data-phase", /betting|shuffling|players/);
  await expect(viewA.getByTestId("dealer-log")).toContainText(/ordered/i, { timeout: 30_000 });
  await expect(viewA.getByTestId("phase")).toHaveAttribute("data-phase", "players", { timeout: 30_000 });
  await expect(viewA.getByTestId("dealer-cards").locator('[data-card="??"]')).toHaveCount(1);
  await expect(viewB.getByTestId("dealer-cards").locator('[data-card="??"]')).toHaveCount(1);
  await shot(a.page, "layer5-blackjack-mid-round-player-a");
  await shot(b.page, "layer5-blackjack-mid-round-player-b");

  await Promise.all([standUntilSettled(viewA), standUntilSettled(viewB), standUntilSettled(viewW).catch(() => {})]);
  await shot(a.page, "layer5-blackjack-settled-player-a", true, true);
  await shot(b.page, "layer5-blackjack-settled-player-b", true, true);
  await expect(viewA.getByTestId("phase")).toHaveAttribute("data-phase", "settled");
  await expect(viewB.getByTestId("phase")).toHaveAttribute("data-phase", "settled");
  await expect(viewW.getByTestId("phase")).toHaveAttribute("data-phase", "settled");
  await expect(viewA.getByTestId("dealer-cards").locator('[data-card="??"]')).toHaveCount(0);

  // The chips moved by the same amount on both screens: a win, a loss or a push of the 50 bet.
  const [chipsA, chipsB] = [await chips(viewA), await chips(viewB)];
  for (const value of [chipsA, chipsB]) expect([1000 - BET, 1000, 1000 + BET]).toContain(value);
  await shot(watcher.page, "layer5-blackjack-settled-watcher", true, true);
  for (const v of [a, b, watcher]) await v.context.close();
});

test("blackjack at 390 px wide", async ({ browser, baseURL }) => {
  const a = await unlocked(browser, baseURL, PHONE);
  const view = await openTable(a, "/blackjack");
  await view.getByTestId("lobby-create").click();
  await expect(view.getByTestId("phase")).toBeVisible({ timeout: VIEW_READY_MS });
  await shot(a.page, "layer5-blackjack-390");
  await a.context.close();
});

export type { Page };
