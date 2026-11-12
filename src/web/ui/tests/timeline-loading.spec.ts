import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DAY } from "../src/model/timelineScale";
import { topologyFixture, type TimelineFixture } from "../src/model/timelineFixture";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import { RULES, installTimeline, modelOf, type TimelineRequests } from "./timelineStub";

const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const WEEK = 7 * DAY;
const MODEL = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;
const SERVICES = ["svc-1", "svc-2", "svc-3", "svc-4", "svc-5"];

const signals = (names: readonly string[]) =>
  names.map((name) => ({ name, displayName: name, kind: "AzureResourceMetric", unit: "Percent", refreshInterval: "PT5M", rules: RULES }));

/** A root, five services under it, and one database that every service depends on: the same entity under five parents. */
function sharedFixture(): TimelineFixture {
  return topologyFixture(
    [
      { name: "shop", displayName: "Shop", parents: [], signals: [] },
      ...SERVICES.map((name) => ({ name, displayName: name, parents: ["shop"], signals: signals(["cpu", "errors"]) })),
      { name: "shared-db", displayName: "Shared database", parents: SERVICES, signals: signals(["cpu", "latency", "queue"]) },
    ],
    { now: NOW, days: 14 },
  );
}

async function boot(page: Page, fixture: TimelineFixture, delay?: () => number): Promise<TimelineRequests> {
  await installStubs(page, { healthModelFails: false, model: modelOf(fixture) });
  const requests = await installTimeline(page, fixture, undefined, delay);
  await page.goto(`/?${MODEL}&view=zoom`);
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  return requests;
}

const rowsOf = (page: Page, name: string) => page.locator(`[data-testid="tl-label-entity"][data-row="${name}"]`);
const isSignals = (query: URLSearchParams): boolean => (query.get("include") ?? "").includes("signals");
/** Long enough for a view to settle and its requests to be sent, short of the wait before the loader reads ahead. */
const quiet = (page: Page, ms = 1200): Promise<void> => page.waitForTimeout(ms);

/** How many requests asked for an entity's signals. */
const asksFor = (requests: TimelineRequests, name: string): number => requests.seen.filter((query) => isSignals(query) && query.getAll("entity").includes(name)).length;

test("an entity under five parents is asked for once, and every one of its rows draws what was read", async ({ page }) => {
  const requests = await boot(page, sharedFixture());

  // Every row of the tree is open: the database has a row, with its three lanes, under each of the five services.
  await page.getByTestId("tl-expand-all").click();
  await page.getByTestId("tl-fullscreen").click();
  await expect(rowsOf(page, "shared-db").first()).toBeVisible();
  await quiet(page);
  await page.getByTestId("tl-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await quiet(page);

  expect(asksFor(requests, "shared-db")).toBe(1);
  const asked = requests.seen.filter(isSignals).flatMap((query) => query.getAll("entity"));
  expect(asked.sort()).toEqual([...new Set(asked)].sort());
});

test("a scripted session asks for each tile once: open, three entities, zoom in, pan, zoom out, back, the whole history", async ({ page }) => {
  const requests = await boot(page, sharedFixture());
  const steps: { step: string; overview: number; signals: number; kb: number }[] = [];
  const mark = async (step: string): Promise<void> => {
    await quiet(page);
    steps.push({
      step,
      overview: requests.seen.filter((query) => !isSignals(query)).length,
      signals: requests.seen.filter(isSignals).length,
      kb: Math.round(requests.bytes.reduce((sum, size) => sum + size, 0) / 1024),
    });
  };
  const added = (step: string): number => {
    const at = steps.findIndex((item) => item.step === step);
    return (steps[at]?.signals ?? 0) - (steps[at - 1]?.signals ?? 0);
  };
  await mark("open");

  for (const name of ["svc-1", "svc-2", "svc-3"]) await rowsOf(page, name).first().getByTestId("tl-expand").click();
  await mark("expand three entities");

  // The same database under two of them: two rows, one entity.
  await rowsOf(page, "shared-db").nth(0).getByTestId("tl-expand").click();
  await rowsOf(page, "shared-db").nth(1).getByTestId("tl-expand").click();
  await mark("open the shared entity under two parents");

  await page.getByTestId("tl-preset-6h").click();
  await mark("zoom in");

  const box = await page.getByTestId("tl-canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + 200, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 200 + box.width / 2, box.y + 60, { steps: 8 });
  await page.mouse.up();
  await mark("pan");

  await page.getByTestId("tl-preset-7d").click();
  await mark("zoom out");

  await page.getByTestId("tl-preset-24h").click();
  await mark("back to the first window");

  await page.getByTestId("tl-preset-all").click();
  await mark("the whole history");

  for (const item of steps) console.log(`timeline requests after "${item.step}": ${item.overview} overview + ${item.signals} signals, ${item.kb} kB in all`);
  expect(steps[0]).toMatchObject({ overview: 1, signals: 0 });
  expect(steps.at(-1)?.overview).toBe(1);
  expect([added("expand three entities"), added("open the shared entity under two parents")]).toEqual([1, 1]);
  expect([added("zoom in"), added("pan"), added("back to the first window")]).toEqual([0, 0, 0]);
  expect(added("zoom out")).toBe(1);
  expect(added("the whole history")).toBeLessThanOrEqual(3);
});

test("a reload paints from the browser's cache and asks only for the tiles that are still open", async ({ page }) => {
  let slow = 0;
  const requests = await boot(page, sharedFixture(), () => slow);
  for (const name of ["svc-1", "svc-2"]) await rowsOf(page, name).first().getByTestId("tl-expand").click();
  await page.getByTestId("tl-preset-7d").click();
  await quiet(page, 2500);
  const before = requests.seen.length;
  const openWeek = Math.floor(Date.now() / WEEK) * WEEK;
  const openDay = Math.floor(Date.now() / DAY) * DAY;
  expect(requests.seen.some((query) => Date.parse(query.get("from") ?? "") < openWeek)).toBe(true);

  slow = 3000;
  await page.reload();

  // The tree and its states are there while the app has not answered yet.
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible({ timeout: 2500 });
  await expect(page.getByTestId("tl-stale")).toBeVisible();
  await expect(page.getByTestId("tl-stale")).toBeHidden({ timeout: 8000 });
  for (const name of ["svc-1", "svc-2"]) await rowsOf(page, name).first().getByTestId("tl-expand").click();
  await page.getByTestId("tl-preset-7d").click();
  await quiet(page, 4500);

  const after = requests.seen.slice(before);
  const kb = (sizes: readonly number[]): number => Math.round(sizes.reduce((sum, size) => sum + size, 0) / 1024);
  console.log(`timeline requests of a visit (two entities, a week): ${before} requests, ${kb(requests.bytes.slice(0, before))} kB; of the same visit after a reload: ${after.length} requests, ${kb(requests.bytes.slice(before))} kB`);
  const from = (query: URLSearchParams): number => Date.parse(query.get("from") ?? "");
  expect(after.filter((query) => !isSignals(query)).map(from)).toEqual([openWeek]);
  expect(after.filter(isSignals).length).toBeGreaterThan(0);
  expect(after.filter(isSignals).filter((query) => from(query) < openDay).map((query) => query.toString())).toEqual([]);
});

test("a model of 60 entities shows its whole history after a handful of requests, each for one week", async ({ page }) => {
  const fixture = topologyFixture(
    Array.from({ length: 60 }, (_unused, index) => ({ name: `e${index}`, displayName: `Entity ${index}`, parents: index === 0 ? [] : [`e${Math.floor((index - 1) / 6)}`], signals: signals(["cpu"]) })),
    { now: NOW, days: 30 },
  );
  const requests = await boot(page, fixture);
  await quiet(page, 2500);

  const overview = requests.seen.filter((query) => !isSignals(query));
  const spans = overview.map((query) => [Date.parse(query.get("from") ?? ""), Date.parse(query.get("to") ?? "")] as const).sort((a, b) => a[0] - b[0]);
  expect(overview.length).toBeGreaterThanOrEqual(5);
  expect(overview.length).toBeLessThanOrEqual(6);
  expect(spans.every(([from, to]) => to - from === WEEK)).toBe(true);
  expect(spans.every(([from], index) => index === 0 || from === spans[index - 1]?.[1])).toBe(true);
  expect(spans[0]?.[0]).toBeLessThanOrEqual(Date.now() - 29 * DAY);
  expect(spans.at(-1)?.[1]).toBeGreaterThan(Date.now());
  expect(overview.every((query) => query.getAll("entity").length === 0)).toBe(true);
  await expect(page.getByTestId("tl-busy")).toHaveCount(0);
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
});
