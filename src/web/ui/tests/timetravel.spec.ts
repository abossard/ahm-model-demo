import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { buildFixture, type TimelineFixture } from "../src/model/timelineFixture";
import { HOUR, MINUTE } from "../src/model/timelineScale";
import type { HealthModel } from "../src/model/types";
import { VIEW_IDS, type ViewId } from "../src/model/views";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import { instrument, measure, report } from "./framePerf";
import { installTimeline, modelOf, stubbedHistory } from "./timelineStub";
import { openView } from "./views";
import { SESSION_WITH_TASK, node } from "./workspaceHelpers";
import { catalogWithDesign, defaultScript, explainResult, installWorkspace, type WorkspaceOptions, type WorkspaceStub } from "./workspaceStub";

// One selected moment drives the page: the graph views, the strip of the selected entity, the top bar, the question and
// the assistant. The stubbed model is the one of tests/fixture.ts with a simulated history (tests/timelineStub.ts): in
// it Service B, and Service A above it, were Degraded or Unhealthy from 6 to 4.5 hours ago and are again since 95
// minutes ago, and nothing was wrong 12 hours ago. The live model says Service A is Healthy and Service B Degraded.

// The canvas is drawn on the GPU, as on a real screen: the frame times of a software renderer say nothing about one.
test.use({ launchOptions: { args: ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])] } });

const SHOTS = process.env.TIMETRAVEL_SHOTS ?? "";
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const MODEL = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;
const INCIDENT_HOURS = 5.25;
const QUIET_HOURS = 12;
const TROUBLED = /^(Degraded|Unhealthy)$/;

/** How each view draws an entity, and where it says its state. */
const NODE: Readonly<Record<ViewId, string>> = {
  swimlanes: '[data-testid="swim-card"]',
  tidy: '[data-testid="tidy-tile"]',
  cause: '[data-testid="cause-node"]',
  zoom: ".entity-node",
  outline: '[data-testid="outline-row"]',
  coverage: '[data-testid="coverage-cell"]',
};

async function stateIn(page: Page, view: ViewId, name: string): Promise<string | null> {
  const drawn = page.locator(`${NODE[view]}[data-entity="${name}"]`).first();
  if ((await drawn.count()) === 0) return null;
  // The card graph names the state in the card's label: "Service A (Healthy)".
  if (view === "zoom") return /\((\w+)/.exec((await drawn.getAttribute("aria-label")) ?? "")?.[1] ?? null;
  return drawn.getAttribute("data-state");
}

const row = (page: Page, name: string): Locator => page.locator(`[data-testid="tl-label-entity"][data-row="${name}"]`).first();
const bar = (page: Page): Locator => page.getByTestId("moment-bar");
const stripState = (page: Page): Locator => page.getByTestId("entity-details").getByTestId("health-badge");
const modelState = (page: Page): Locator => page.getByTestId("status-bar").getByTestId("health-badge");

async function open(page: Page, view: ViewId, fixture: TimelineFixture = stubbedHistory(NOW), model?: HealthModel, search = "&timeline=1"): Promise<void> {
  await installStubs(page, { healthModelFails: false, ...(model ? { model } : {}) });
  await installTimeline(page, fixture);
  await page.goto(`/?${MODEL}&view=${view}${search}`);
  await expect(page.locator(NODE[view]).first()).toBeVisible();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await expect(page.getByTestId("tl-busy")).toHaveCount(0);
}

/** Where on the plot an instant so many hours ago is, while the window is the last 24 hours. */
async function pointAt(page: Page, hoursAgo: number, y = 110): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("tl-canvas").boundingBox();
  if (!box) throw new Error("no plot");
  return { x: box.x + box.width * (1 - hoursAgo / 24), y: box.y + y };
}

/** Selects the moment so many hours ago, with a click on the plot, and waits for what the page reads for it. */
async function selectMoment(page: Page, hoursAgo: number): Promise<void> {
  const { x, y } = await pointAt(page, hoursAgo);
  await page.mouse.click(x, y);
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId("tl-busy")).toHaveCount(0);
}

/** The moment the address names, once it rests. */
async function momentInAddress(page: Page): Promise<number> {
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).not.toBeNull();
  return Date.parse(new URL(page.url()).searchParams.get("at") ?? "");
}

async function shotBoth(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test.describe("a selected moment shows the model as it was, in every view", () => {
  for (const view of VIEW_IDS) {
    test(`${view}: the view, the strip, the tree and the top bar show the states of then, and Back to now the states of now`, async ({ page }) => {
      await page.setViewportSize({ width: 1360, height: 900 });
      await open(page, view);
      await row(page, "svc-a").click();
      await expect(page.getByTestId("entity-details")).toBeVisible();

      // Now: the live model.
      await expect.poll(() => stateIn(page, view, "svc-a")).toBe("Healthy");
      await expect.poll(() => stateIn(page, view, "svc-b")).toBe("Degraded");
      await expect(stripState(page)).toHaveAttribute("data-state", "Healthy");
      await expect(page.getByTestId("explain-entity")).toHaveText("Why is this Healthy?");
      await expect(page.getByTestId("model-observed")).toContainText("Updated");
      await expect(bar(page)).toHaveCount(0);

      // In the incident: Service A, the root, was not Healthy. Every place that shows its state shows the same one.
      await selectMoment(page, INCIDENT_HOURS);
      await expect.poll(() => stateIn(page, view, "svc-a")).toMatch(TROUBLED);
      const then = (await stateIn(page, view, "svc-a")) as string;
      await expect.poll(() => stateIn(page, view, "svc-b")).toMatch(TROUBLED);
      await expect(stripState(page)).toHaveAttribute("data-state", then);
      await expect(modelState(page)).toHaveAttribute("data-state", then);
      await expect(row(page, "svc-a").getByTestId("tl-state-word")).toHaveAttribute("data-state", then);
      await expect(page.getByTestId("explain-entity")).toHaveText(new RegExp(`^Why was this ${then} at (\\d{1,2} \\w{3} )?\\d{2}:\\d{2}\\?$`));
      await expect(page.getByTestId("model-observed")).toContainText("As of");
      await expect(page.getByTestId("moment-shown")).toHaveText(/^Showing \d{1,2} \w{3} \d{2}:\d{2}:\d{2}, 5 h \d{1,2} min ago$/);
      // A health report is about now: there is none to send for a moment that has passed.
      await expect(page.getByTestId("report-open")).toHaveAttribute("aria-disabled", "true");
      await page.getByTestId("report-open").click({ force: true });
      await expect(page.getByTestId("report-dialog")).toHaveCount(0);

      // Twelve hours ago nothing was wrong: what the live model calls Degraded was Healthy.
      await selectMoment(page, QUIET_HOURS);
      await expect.poll(() => stateIn(page, view, "svc-a")).toBe("Healthy");
      // Cause path folds what is healthy behind a chip: there the card is gone, everywhere else it is Healthy.
      await expect.poll(() => stateIn(page, view, "svc-b")).toBe(view === "cause" ? null : "Healthy");
      await expect(stripState(page)).toHaveAttribute("data-state", "Healthy");
      await expect(page.getByTestId("explain-entity")).toHaveText(/^Why was this Healthy at /);

      await page.getByTestId("moment-now").click();
      await expect(bar(page)).toHaveCount(0);
      await expect.poll(() => stateIn(page, view, "svc-a")).toBe("Healthy");
      await expect.poll(() => stateIn(page, view, "svc-b")).toBe("Degraded");
      await expect(page.getByTestId("explain-entity")).toHaveText("Why is this Healthy?");
      await expect(page.getByTestId("model-observed")).toContainText("Updated");
      await expect(page.getByTestId("report-open")).not.toHaveAttribute("aria-disabled", "true");
    });
  }
});

test("the address names the moment: a reload shows the same moment, and Back to now is live again", async ({ page }) => {
  await open(page, "zoom");
  await expect(page.getByTestId("tl-live-toggle")).toHaveAttribute("aria-pressed", "true");

  await selectMoment(page, INCIDENT_HOURS);
  const at = await momentInAddress(page);
  expect(Math.abs(NOW - INCIDENT_HOURS * HOUR - at)).toBeLessThan(20 * MINUTE);
  const shown = (await page.getByTestId("moment-shown").innerText()).replace(/,.*$/, "");
  const then = await stateIn(page, "zoom", "svc-a");
  expect(then).toMatch(TROUBLED);
  // The window followed now until the moment was selected: the address keeps that, so a link returns to live too.
  expect(new URL(page.url()).searchParams.get("live")).toBe("1");

  await page.reload();
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId("moment-shown")).toContainText(shown);
  await expect.poll(() => stateIn(page, "zoom", "svc-a")).toBe(then);
  await expect(page.getByTestId("tl-asof")).toContainText("As of");
  expect(await momentInAddress(page)).toBe(at);

  await page.getByTestId("moment-now").click();
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(() => stateIn(page, "zoom", "svc-a")).toBe("Healthy");
  await expect(page.getByTestId("tl-asof")).toHaveText("Now");
  await expect(page.getByTestId("tl-live-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBeNull();
});

test("the indicator stays in a timeline that fills the window, and Escape returns to now after it has closed what was open", async ({ page }) => {
  await open(page, "zoom");
  await selectMoment(page, QUIET_HOURS);

  await page.getByTestId("tl-fullscreen").click();
  await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "true");
  await expect(bar(page)).toBeVisible();
  const panel = await page.getByTestId("timeline-panel").boundingBox();
  const indicator = await bar(page).boundingBox();
  expect((indicator?.y ?? 0) + (indicator?.height ?? 0)).toBeLessThanOrEqual((panel?.y ?? 0) + 1);

  // Escape leaves full screen first, and the moment stays.
  await page.getByTestId("moment-shown").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "false");
  await expect(bar(page)).toBeVisible();

  // Escape closes the search first, and the moment stays.
  await page.getByTestId("search-open").click();
  await expect(page.getByTestId("search-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  await expect(bar(page)).toBeVisible();

  // With nothing else to close, from anywhere on the page, Escape returns to now.
  await page.getByTestId("moment-shown").click();
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByTestId("tl-asof")).toHaveText("Now");
});

test("closing the timeline, where a moment is selected, returns the page to now", async ({ page }) => {
  await open(page, "zoom");
  await selectMoment(page, QUIET_HOURS);
  await expect.poll(() => stateIn(page, "zoom", "svc-b")).toBe("Healthy");

  await page.getByTestId("tl-close").click();

  await expect(bar(page)).toHaveCount(0);
  await expect.poll(() => stateIn(page, "zoom", "svc-b")).toBe("Degraded");
});

test.describe("the assistant at a past moment", () => {
  const UNKNOWN_THEN = { ...defaultScript("explain"), outcome: { status: "done" as const, result: { ...explainResult(), state: "Unknown" as const } } };

  /** The model, its history and the History of questions, served from memory; the card graph with the timeline open. */
  async function boot(page: Page, options: WorkspaceOptions = {}, search = ""): Promise<WorkspaceStub> {
    await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign });
    const stub = await installWorkspace(page, options);
    await installTimeline(page, stubbedHistory(NOW));
    await openView(page, "zoom", `/?${MODEL}&timeline=1${search}`);
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
    await expect(page.getByTestId("tl-busy")).toHaveCount(0);
    return stub;
  }

  async function bootAtMoment(page: Page, hoursAgo: number, options: WorkspaceOptions = {}): Promise<WorkspaceStub> {
    const stub = await boot(page, options);
    await node(page, "topology", "svc-c").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await selectMoment(page, hoursAgo);
    return stub;
  }

  test("a question asked at a past moment is about that moment: the app is told, History and the question name it, and so does the answer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const stub = await bootAtMoment(page, QUIET_HOURS, { scripts: { explain: UNKNOWN_THEN } });
    const at = await momentInAddress(page);
    // Service C has no signal of its own in the simulated history: twelve hours ago its state was unknown.
    await expect(page.getByTestId("explain-entity")).toHaveText(/^Why was the state unknown at (\d{1,2} \w{3} )?\d{2}:\d{2}\?$/);

    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("explain-result")).toBeVisible();

    // The app got the moment, and nothing else changed in what it is asked.
    expect(stub.posts).toHaveLength(1);
    const asked = stub.posts[0]?.body;
    expect(asked).toMatchObject({ type: "explain", target: { name: "hm-demo", entity: "svc-c" }, instruction: "" });
    expect(Math.abs(Date.parse(asked?.asOf ?? "") - at)).toBeLessThan(1000);
    // History and the question carry the moment, with its day: they are read on later days too.
    const day = /\d{1,2} \w{3} \d{2}:\d{2}/;
    expect(stub.sessions[0]?.title).toMatch(new RegExp(`^Why was the state of Service C unknown at ${day.source}\\? \\(${day.source}\\)$`));
    await expect(page.getByTestId("task-title")).toHaveText(new RegExp(`^Why was the state of Service C unknown at ${day.source}\\?$`));
    const moment = /at (\d{1,2} \w{3} \d{2}:\d{2})\?$/.exec(await page.getByTestId("task-title").innerText())?.[1] ?? "";
    // The answer says which moment it explains, and that now may differ.
    await expect(page.getByTestId("explain-state-label")).toHaveText(`State at ${moment}`);
    await expect(page.getByTestId("explain-moment")).toHaveText(`This answer is about ${moment}. The state now may differ.`);
    await expect(page.getByTestId("explain-state").getByTestId("health-badge")).toHaveAttribute("data-state", "Unknown");
    await shotBoth(page, "answer-at-a-past-moment");
    // The list of the topic's questions names it too.
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("task-row-1")).toContainText(`at ${moment}?`);

    // The same question about now names no moment.
    await page.getByTestId("moment-now").click();
    await expect(page.getByTestId("explain-entity")).toHaveText("Why is this Unhealthy?");
    await page.getByTestId("explain-entity").click();
    await expect.poll(() => stub.posts.length).toBe(2);
    expect(stub.posts[1]?.body).not.toHaveProperty("asOf");
  });

  test("a model check started at a past moment is about now, and the Ask menu and the form say so", async ({ page }) => {
    const stub = await bootAtMoment(page, QUIET_HOURS);

    await page.getByTestId("task-menu").click();
    await expect(page.getByTestId("menu-review")).toContainText("as it is now");
    await expect(page.getByTestId("menu-design")).toContainText("as it is now");
    await expect(page.getByTestId("menu-explain")).toHaveText(/^Why was the state of Service C unknown at /);
    await page.getByTestId("menu-design").click();
    await expect(page.getByTestId("task-about-now")).toHaveText("The page shows a past moment. This looks at the model as it is now.");
    await page.getByTestId("task-type-explain").click();
    await expect(page.getByTestId("task-about-now")).toHaveCount(0);
    await expect(page.getByTestId("task-moment")).toHaveValue(/^\d{1,2} \w{3} \d{2}:\d{2}$/);

    await page.getByTestId("task-menu").click();
    await page.getByTestId("menu-review").click();
    await expect(page.getByTestId("task-title")).toHaveText("Check hm-demo");

    expect(stub.posts).toHaveLength(1);
    expect(stub.posts[0]?.body).toEqual({ type: "review", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A }, instruction: "" });
    // The page still shows the moment: the check did not move it.
    await expect(bar(page)).toBeVisible();
  });

  test("a comparison is about the model now: opening one returns to now, and selecting a moment closes it", async ({ page }) => {
    await boot(page, SESSION_WITH_TASK(), "&session=s-demo&task=1");
    await expect(page.getByTestId("diff-result")).toBeVisible();
    await selectMoment(page, QUIET_HOURS);

    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("compare-view")).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByTestId("graph-announcement")).toHaveText("Back to now: a comparison is about the model now.");

    await selectMoment(page, QUIET_HOURS);
    await expect(page.getByTestId("compare-view")).toHaveCount(0);
    await expect(page.getByTestId("graph-announcement")).toHaveText("The comparison is closed: it is about the model now, and the page shows a past moment.");
    await expect.poll(() => stateIn(page, "zoom", "svc-b")).toBe("Healthy");
  });
});

/** The graph of a simulated history with the signals of its entities on the cards, so their values at a moment are read and drawn. */
function graphWithSignals(fixture: TimelineFixture): HealthModel {
  const base = modelOf(fixture);
  return {
    ...base,
    entities: base.entities.map((entity, index) => ({
      ...entity,
      signals: (fixture.entities[index]?.signals ?? []).map((signal) => ({ name: signal.name, displayName: signal.displayName, kind: "metric", healthState: "Healthy" as const, value: 1, reportedAt: null, writable: false })),
    })),
  };
}

test.describe("dragging the moment across a busy day", () => {
  // 81 entities and 300 signals that are evaluated every five minutes, with two incidents in the last day in which twelve
  // resources flip between Degraded and Unhealthy: every few pixels of a drag change every card that has a signal.
  const DENSE = buildFixture({ now: NOW, flows: 5, componentsPerFlow: 3, resourcesPerComponent: 4, signalsPerResource: 5, days: 7 });

  for (const view of VIEW_IDS) {
    test(`${view}: the line keeps the frame rate and the graph follows it`, async ({ browser }) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        throw error;
      });
      await instrument(page);
      await page.addInitScript(() => {
        const w = window as unknown as { __long: number[] };
        w.__long = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__long.push(entry.duration);
        }).observe({ entryTypes: ["longtask"] });
      });
      expect(DENSE.entities.length).toBeGreaterThanOrEqual(81);
      expect(DENSE.signalCount).toBeGreaterThanOrEqual(300);
      await open(page, view, DENSE, graphWithSignals(DENSE));
      await selectMoment(page, 23);
      // Every signal of the model is read for the day of the moment, and for the day the drag ends in.
      await selectMoment(page, 1);
      await selectMoment(page, 23);
      await page.waitForTimeout(600);

      const from = await pointAt(page, 23);
      const to = await pointAt(page, 0.5);
      const states = (): Promise<string> => page.evaluate(() => [...document.querySelectorAll("[data-entity][data-state]")].map((item) => `${item.getAttribute("data-entity")}:${item.getAttribute("data-state")}`).join(","));
      const idle = await measure(page, () => page.waitForTimeout(1500));
      report(`time travel, ${view}, idle`, idle);
      await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0));
      const seen = new Set<string>();
      const STEPS = 240;
      const drag = await measure(page, async () => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        for (let step = 1; step <= STEPS; step += 1) {
          await page.mouse.move(from.x + ((to.x - from.x) * step) / STEPS, from.y);
          if (step % 24 === 0) seen.add(await states());
        }
        await page.mouse.up();
      });
      const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
      report(`time travel, ${view}, dragging the moment over 22.5 hours of 81 entities and 300 signals`, drag);
      console.log(`time travel, ${view}: long tasks n=${long.length} max=${Math.max(0, ...long).toFixed(0)}ms, pictures seen on the way=${seen.size}`);

      // The line is drawn every frame, whatever the graph costs: the frames of the plot stay inside a 60 Hz frame.
      expect(drag.draws).toBeGreaterThan(STEPS / 4);
      expect(drag.work95).toBeLessThanOrEqual(8);
      if (idle.p95 <= 16.7) expect(drag.p95).toBeLessThanOrEqual(16.7);
      // The graph follows while the moment moves, not only once it rests. Everything that follows the moment is drawn
      // in one commit a move; the canvas library of the view adds one or two of its own for the nodes it was handed.
      expect(drag.commits).toBeGreaterThan(5);
      expect(drag.commits).toBeLessThanOrEqual(drag.draws * 3 + 20);
      // The card graph draws 81 entities as dots, which name no state to read back here.
      if (view !== "zoom") expect(seen.size).toBeGreaterThan(1);
      // Where the drag ended is what the page shows.
      await expect(page.getByTestId("moment-shown")).toHaveText(/, \d{2} min ago$/);
      await context.close();
    });
  }
});

test("screenshots of a past moment in two views", async ({ page }) => {
  test.skip(!SHOTS, "set TIMETRAVEL_SHOTS to a folder to take them");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const view of ["swimlanes", "cause"] as const) {
    await open(page, view);
    await row(page, "svc-b").click();
    await selectMoment(page, INCIDENT_HOURS);
    await expect.poll(() => stateIn(page, view, "svc-b")).toMatch(TROUBLED);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(500);
    await shotBoth(page, `past-moment-${view}`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
