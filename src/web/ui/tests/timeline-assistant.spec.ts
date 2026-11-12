import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { HOUR, MINUTE } from "../src/model/timelineScale";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import { installTimeline, stubbedHistory } from "./timelineStub";
import { openView } from "./views";
import { node, workspace } from "./workspaceHelpers";
import { catalogWithDesign, defaultScript, installWorkspace, type WorkspaceStub } from "./workspaceStub";

// What the user works on is what the strip above the tree is about, the strip, the tree, the graph and the question
// read one state at a selected moment, and the assistant's panel opens above a timeline that fills the window.
// The stubbed model is the one of tests/fixture.ts with a simulated history (tests/timelineStub.ts): Service A and
// Service B were Degraded or Unhealthy from 6 to 4.5 hours ago.

const SHOTS = process.env.TIMELINE_SHOTS ?? "";
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const MODEL = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;
const INCIDENT_HOURS = 5.25;
const HELD_EXPLAIN = { ...defaultScript("explain"), hold: 3 };
const NAMES: Readonly<Record<string, string>> = { "svc-a": "Service A", "svc-b": "Service B", "svc-c": "Service C", "svc-d": "Service D" };

test.use({ viewport: { width: 1360, height: 820 } });

async function boot(page: Page, options: Parameters<typeof installWorkspace>[1] = {}): Promise<WorkspaceStub> {
  await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign });
  const stub = await installWorkspace(page, options);
  await installTimeline(page, stubbedHistory(NOW));
  await openView(page, "zoom", `/?${MODEL}&timeline=1`);
  await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
  await expect(page.getByTestId("tl-label-entity").first()).toBeVisible();
  await expect(page.getByTestId("tl-busy")).toHaveCount(0);
  return stub;
}

const strip = (page: Page): Locator => page.getByTestId("entity-details");
const stripName = (page: Page): Locator => page.getByTestId("entity-name");
const labelRow = (page: Page, kind: "entity" | "signal", name: string): Locator => page.locator(`[data-testid="tl-label-${kind}"][data-row="${name}"]`).first();
const bar = (page: Page): Locator => page.getByTestId("moment-bar");

async function shot(page: Page, name: string): Promise<void> {
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

test.describe("the strip follows what the user works on", () => {
  test("a click on a signal row, on an entity row, on a lane of the plot and a move of the keyboard focus each make its entity the one of the strip", async ({ page }) => {
    await boot(page);
    await page.getByTestId("tl-expand-all").click();
    await node(page, "topology", "svc-a").click();
    await expect(stripName(page)).toHaveText("Service A");

    // A signal row names the entity that has it.
    await labelRow(page, "signal", "svc-b").click();
    await expect(stripName(page)).toHaveText("Service B");
    await expect(labelRow(page, "entity", "svc-b")).toHaveAttribute("aria-selected", "true");
    await expect(labelRow(page, "entity", "svc-a")).toHaveAttribute("aria-selected", "false");

    await labelRow(page, "entity", "svc-c").click();
    await expect(stripName(page)).toHaveText("Service C");
    await expect(labelRow(page, "entity", "svc-c")).toHaveAttribute("aria-selected", "true");

    // A click on the lane of a signal, at a moment, is work on that signal's entity too: the first lane in view that is not Service C's.
    const plot = await page.getByTestId("tl-canvas").boundingBox();
    if (!plot) throw new Error("no plot");
    const lanes = await page.locator('[data-testid="tl-label-signal"]').evaluateAll((items) =>
      items.map((item) => ({ entity: item.getAttribute("data-row") ?? "", y: item.getBoundingClientRect().y, h: item.getBoundingClientRect().height })),
    );
    const lane = lanes.find((item) => item.entity !== "svc-c" && item.y > plot.y + 40 && item.y + item.h < plot.y + plot.height);
    if (!lane) throw new Error("no lane in view");
    await page.mouse.click(plot.x + plot.width / 2, lane.y + lane.h / 2);
    await expect(stripName(page)).toHaveText(NAMES[lane.entity] ?? /./);

    // The keyboard focus moves down one row at a time, and the strip goes with it.
    await labelRow(page, "entity", "svc-a").click();
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("ArrowDown");
      const id = await page.getByTestId("tl-stage").getAttribute("aria-activedescendant");
      const focused = await page.locator(`#${id}`).getAttribute("data-row");
      await expect(stripName(page)).toHaveText(NAMES[focused ?? ""] ?? /./);
    }
  });

  test("scrolling alone keeps the selected entity, and the strip says its row is out of view and brings it back", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 640 });
    await boot(page);
    await page.getByTestId("tl-expand-all").click();
    await labelRow(page, "entity", "svc-a").click();
    await expect(stripName(page)).toHaveText("Service A");
    await expect(page.getByTestId("entity-show-row")).toHaveCount(0);

    const box = await page.getByTestId("tl-labels-body").boundingBox();
    if (!box) throw new Error("no tree");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 4000);
    await expect(page.getByTestId("entity-show-row")).toBeVisible();
    await expect(stripName(page)).toHaveText("Service A");
    await expect(labelRow(page, "entity", "svc-a")).not.toBeInViewport();

    await page.getByTestId("entity-show-row").click();
    await expect(labelRow(page, "entity", "svc-a")).toBeInViewport();
    await expect(page.getByTestId("entity-show-row")).toHaveCount(0);
    await expect(stripName(page)).toHaveText("Service A");
  });

  test("the question names the entity of the strip, in full for a long name", async ({ page }) => {
    await boot(page);
    await node(page, "topology", "svc-c").click();
    await expect(page.getByTestId("explain-entity")).toHaveText("Why is Service C Unhealthy?");
    await expect(page.getByTestId("explain-entity")).toHaveAttribute("title", "Why is Service C Unhealthy?");
    await expect(page.getByTestId("explain-entity")).toHaveAccessibleName("Why is Service C Unhealthy?");
    await node(page, "topology", "svc-f").click();
    const long = "Why is Very Long Downstream Analytics And Reporting Service Name";
    await expect(page.getByTestId("explain-entity")).toHaveAttribute("title", new RegExp(`^${long}`));
    await expect(page.getByTestId("explain-entity")).toHaveAccessibleName(new RegExp(`^${long}`));
  });
});

test("at a moment where a signal is not healthy, the strip, the row, the graph card and the question read one state, and the Task is asked at that moment", async ({ page }) => {
  const stub = await boot(page);
  // The moment first, then the entity: a click on the plot also picks the entity of the lane it lands on.
  const plot = await page.getByTestId("tl-canvas").boundingBox();
  if (!plot) throw new Error("no plot");
  await page.mouse.click(plot.x + plot.width * (1 - INCIDENT_HOURS / 24), plot.y + 110);
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId("tl-busy")).toHaveCount(0);
  await page.getByTestId("tl-expand-all").click();
  await labelRow(page, "entity", "svc-b").click();
  await expect(stripName(page)).toHaveText("Service B");

  const signal = labelRow(page, "signal", "svc-b").getByTestId("tl-state-word");
  await expect(signal).toHaveAttribute("data-state", /^(Degraded|Unhealthy)$/);
  const entity = (await strip(page).getByTestId("health-badge").getAttribute("data-state")) as string;
  expect(entity).toMatch(/^(Degraded|Unhealthy)$/);
  await expect(labelRow(page, "entity", "svc-b").getByTestId("tl-state-word")).toHaveAttribute("data-state", entity);
  await expect(node(page, "topology", "svc-b")).toHaveAttribute("aria-label", new RegExp(`\\(${entity}`));
  await expect(page.getByTestId("explain-entity")).toHaveText(new RegExp(`^Why was Service B ${entity} at (\\d{1,2} \\w{3} )?\\d{2}:\\d{2}\\?$`));

  await page.getByTestId("explain-entity").click();
  await expect.poll(() => stub.posts.length).toBe(1);
  const asked = stub.posts[0]?.body;
  expect(asked).toMatchObject({ type: "explain", target: { name: "hm-demo", entity: "svc-b" } });
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).not.toBeNull();
  const at = Date.parse(new URL(page.url()).searchParams.get("at") ?? "");
  expect(Math.abs(Date.parse(asked?.asOf ?? "") - at)).toBeLessThan(1000);
  expect(Math.abs(at - (NOW - INCIDENT_HOURS * HOUR))).toBeLessThan(20 * MINUTE);
});

test.describe("what the assistant is doing, from every place the user may be", () => {
  /** A question that runs, and the panel closed: the button now says it can show it. */
  async function running(page: Page): Promise<WorkspaceStub> {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await node(page, "topology", "svc-c").click();
    await expect(stripName(page)).toHaveText("Service C");
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    return stub;
  }

  const button = (page: Page): Locator => page.getByTestId("explain-entity");

  test("docked: Show what the assistant is doing opens the steps of the running question", async ({ page }) => {
    await running(page);
    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
    await expect(button(page)).toHaveText("Show what the assistant is doing");

    await button(page).click();

    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("task-title")).toBeVisible();
    await expect(page.getByTestId("timeline-live")).toBeVisible();
  });

  test("docked: it also leads back from the list of questions to the running one", async ({ page }) => {
    await running(page);
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("task-list")).toBeVisible();

    await button(page).click();

    await expect(page.getByTestId("timeline-live")).toBeVisible();
  });

  test("full screen: the panel opens above the timeline with the steps, takes the focus, and Escape closes it and hands the focus back", async ({ page }) => {
    await running(page);
    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
    await page.getByTestId("tl-fullscreen").click();
    await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "true");
    await expect(button(page)).toHaveText("Show what the assistant is doing");

    await button(page).click();

    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("timeline-live")).toBeVisible();
    // It is above the timeline, not behind it or under what covers it: what is at its centre is the panel itself.
    const box = await workspace(page).boundingBox();
    if (!box) throw new Error("no panel");
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#session-workspace") !== null, { x: box.x + box.width / 2, y: box.y + 120 })).toBe(true);
    await expect(workspace(page)).not.toHaveAttribute("inert", "");
    await expect(page.getByTestId("task-title")).toBeFocused();
    await shot(page, "fullscreen-assistant");
    await page.getByTestId("task-title").focus();

    // The timeline is still there and still reached by the keyboard: it follows the panel in the order of the page.
    await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "true");
    await page.keyboard.press("Escape");
    await expect(workspace(page)).toBeHidden();
    await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "true");
    await expect(button(page)).toBeFocused();
    // The next Escape leaves full screen, as it did.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "false");
  });

  test("full screen: a question that starts there opens the panel on top, and the notice of its end opens the result there", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await node(page, "topology", "svc-c").click();
    await page.getByTestId("tl-fullscreen").click();
    await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "true");

    await button(page).click();
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await expect(page.getByTestId("task-title")).toBeFocused();
    const box = await workspace(page).boundingBox();
    if (!box) throw new Error("no panel");
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#session-workspace") !== null, { x: box.x + box.width / 2, y: box.y + 120 })).toBe(true);

    // Closed, the question runs on, and its end is a toast above the timeline whose action opens the result in the panel.
    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
    stub.release(1, "s-1");
    await expect(page.getByTestId("task-toast")).toContainText("Explanation ready");
    await page.getByTestId("task-toast-show").click();
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("timeline-panel")).toHaveAttribute("data-fullscreen", "true");
    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
    // Focus is back in the timeline, not lost to the page.
    await expect(page.getByTestId("timeline-panel")).toContainText("Service C");
    expect(await page.evaluate(() => document.activeElement?.closest("#timeline-panel") !== null)).toBe(true);
  });

  test("full screen: the History button of the top bar opens the panel on top too", async ({ page }) => {
    await boot(page);
    await page.getByTestId("tl-fullscreen").click();
    await page.getByTestId("workspace-toggle").click();
    await expect(workspace(page)).toBeVisible();
    const box = await workspace(page).boundingBox();
    if (!box) throw new Error("no panel");
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#session-workspace") !== null, { x: box.x + box.width / 2, y: box.y + 60 })).toBe(true);
    await expect(page.getByTestId("tl-fullscreen")).toBeVisible();
  });
});
