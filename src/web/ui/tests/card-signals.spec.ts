import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { MINUTE } from "../src/model/timelineScale";
import { SUBSCRIPTION_A, showCardSignals } from "./fixture";
import { bootWith, stubbedHistory, type TimelineRequests } from "./timelineStub";

// The Signals toggle of the card graph: off, a card is its header; on, every signal row has a sparkline of the 6 hours
// before the selected moment, read through the timeline's loader in slots of 15 minutes, with the timeline open or not.

const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const MODEL = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;
/** The healthy line in each palette (`--healthy-dot`). */
const HEALTHY = { light: "rgb(59, 138, 31)", dark: "rgb(134, 239, 172)" } as const;

const toggle = (page: Page) => page.getByTestId("card-signals-toggle");
const rows = (page: Page) => page.locator(".entity-node__row");
const drawn = (page: Page) => page.locator('[data-testid="sparkline"]:not([data-empty])');
const sparkReads = (requests: TimelineRequests): URLSearchParams[] => requests.seen.filter((query) => query.get("include") === "signals" && query.get("resolution") === "900");

async function open(page: Page, search = ""): Promise<TimelineRequests> {
  const requests = await bootWith(page, stubbedHistory(NOW));
  await page.goto(`/?${MODEL}&view=zoom${search}`);
  await expect(page.locator(".entity-node").first()).toBeVisible();
  return requests;
}

test("Signals is off at first; on, every signal row has a sparkline read with the timeline closed, and the choice is kept", async ({ page }) => {
  const requests = await open(page);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(rows(page)).toHaveCount(0);
  expect(requests.seen).toHaveLength(0);

  await toggle(page).click();

  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator(".entity-node__row [data-testid='sparkline']")).toHaveCount(await rows(page).count());
  await expect(drawn(page).first()).toBeVisible();
  await expect(drawn(page).first().locator("path[data-level]").first()).toBeVisible();
  expect(sparkReads(requests).length).toBeGreaterThan(0);
  // The timeline is closed: no history of states is read for the sparklines.
  expect(requests.seen.filter((query) => (query.get("include") ?? "").includes("states"))).toHaveLength(0);

  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(drawn(page).first()).toBeVisible();

  await toggle(page).click();
  await expect(rows(page)).toHaveCount(0);
  await page.getByTestId("view-tab-swimlanes").click();
  await expect(toggle(page)).toHaveCount(0);
});

test("with the timeline open, the sparklines end at the selected moment", async ({ page }) => {
  await showCardSignals(page);
  await open(page, "&timeline=1");
  await expect(drawn(page).first()).toBeVisible();
  const now = await drawn(page).first().innerHTML();

  await page.goto(`/?${MODEL}&view=zoom&timeline=1&at=${new Date(NOW - 5 * 60 * MINUTE).toISOString()}`);
  await expect(page.getByTestId("moment-bar")).toBeVisible();
  await expect(drawn(page).first()).toBeVisible();
  await expect.poll(() => drawn(page).first().innerHTML()).not.toBe(now);
});

for (const theme of ["light", "dark"] as const) {
  test(`a healthy stretch of a sparkline is drawn in the healthy colour of the ${theme} palette`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await showCardSignals(page);
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const healthy = page.locator('[data-testid="sparkline"] path[data-level="1"]').first();
    await expect(healthy).toBeVisible();
    expect(await healthy.evaluate((path) => getComputedStyle(path).stroke)).toBe(HEALTHY[theme]);
  });
}
