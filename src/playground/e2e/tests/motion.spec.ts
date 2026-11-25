import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { lobbyReady, opencity, playUntilCapture, SCREENSHOTS, viewOf, VIEW_READY_MS } from "./support";

// Counts the View Transitions that run in the page and in its frames, and how many the browser skipped.
const COUNT_TRANSITIONS = () => {
  const w = window as unknown as { __vt: { ran: number; skipped: number } };
  w.__vt = { ran: 0, skipped: 0 };
  const start = document.startViewTransition?.bind(document);
  if (!start) return;
  document.startViewTransition = ((update: () => void) => {
    const t = start(update);
    w.__vt.ran += 1;
    t.ready.catch(() => { w.__vt.skipped += 1; });
    return t;
  }) as typeof document.startViewTransition;
};

const transitions = (page: Page) =>
  page.frames().filter((f) => f !== page.mainFrame()).reduce(async (sum, f) =>
    (await sum) + ((await f.evaluate(() => (window as unknown as { __vt?: { ran: number } }).__vt?.ran ?? 0)) as number), Promise.resolve(0));

// The one spec with motion on. Records a video of a checkers game and a blackjack round for a look.
// It needs real Chrome: the headless shell of Playwright's Chromium crashes the renderer on a View Transition in the blackjack View.
// Run it with `PLAYGROUND_E2E_MOTION=1 npm run e2e -- motion`.
test.skip(!process.env.PLAYGROUND_E2E_MOTION, "motion check: set PLAYGROUND_E2E_MOTION=1 (needs Google Chrome)");
test.use({ channel: "chrome" });
test("moves animate through View Transitions: checkers pieces and blackjack cards", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}), viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference",
    recordVideo: { dir: join(SCREENSHOTS, ".video"), size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  await page.addInitScript(COUNT_TRANSITIONS);
  await page.goto("/");
  await opencity(page);

  await page.goto("/checkers");
  const checkers = viewOf(page);
  await lobbyReady(checkers);
  await checkers.getByTestId("lobby-create-bot").click();
  await expect(checkers.getByTestId("turn")).toBeVisible({ timeout: VIEW_READY_MS });
  await page.waitForTimeout(800);
  const before = await transitions(page);
  await playUntilCapture([checkers], 80, "white");
  await page.waitForTimeout(1200);
  expect(await transitions(page)).toBeGreaterThan(before);

  await page.goto("/blackjack");
  const table = viewOf(page);
  await expect(table.getByTestId("lobby-create")).toBeVisible({ timeout: VIEW_READY_MS });
  await table.getByTestId("lobby-create").click();
  await expect(table.getByTestId("phase")).toBeVisible({ timeout: VIEW_READY_MS });
  await page.waitForTimeout(800);
  await table.getByTestId("bet-50").click();
  await expect(table.getByTestId("phase")).toHaveAttribute("data-phase", "players", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await table.getByTestId("act-stand").click();
  await expect(table.getByTestId("phase")).toHaveAttribute("data-phase", "settled", { timeout: 60_000 });
  await page.waitForTimeout(1500);

  const skipped = await Promise.all(page.frames().filter((f) => f !== page.mainFrame())
    .map((f) => f.evaluate(() => (window as unknown as { __vt?: { skipped: number } }).__vt?.skipped ?? 0)));
  expect(skipped.reduce((a, b) => a + b, 0)).toBe(0);
  const video = page.video();
  await context.close();
  await video?.saveAs(join(SCREENSHOTS, "motion-checkers-blackjack.webm"));
});
