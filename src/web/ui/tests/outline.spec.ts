import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import { MODEL_QUERY } from "./workspaceHelpers";
import { SESSION_ID, explainEvents, installWorkspace, sessionSummary, taskOf } from "./workspaceStub";
import { openView } from "./views";
import { denseModel } from "./denseModel";
import { calmModel, denseIncidentModel, incidentModel } from "./viewModels";
import { contrastOf, incidentExplain, stubEntityDetails, underServedPolicy } from "./viewSupport";
import type { HealthModel } from "../src/model/types";

test.use({ viewport: { width: 1440, height: 900 } });

async function show(page: Page, model: HealthModel = incidentModel(), query = ""): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await stubEntityDetails(page, model);
  await openView(page, "outline", query === "" ? "/" : `/?${query}`);
  await expect(page.getByTestId("outline-view")).toBeVisible();
  await page.getByTestId("outline-row").first().waitFor();
}

const rows = (page: Page): Locator => page.getByTestId("outline-row");
const entityRow = (page: Page, name: string): Locator => page.locator(`[data-testid="outline-row"][data-kind="entity"][data-entity="${name}"]`);
const focusedKey = (page: Page): Promise<string> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["key"] ?? "");
const names = (page: Page): Promise<string[]> => page.getByTestId("outline-name").allTextContents();

/** The first row to reach with the keyboard, as a viewer does: Tab into the tree. */
async function tabIntoTree(page: Page): Promise<void> {
  await page.getByTestId("search-open").focus();
  for (let step = 0; step < 30 && (await focusedKey(page)) === ""; step += 1) await page.keyboard.press("Tab");
}

const INCIDENT_ROWS = [
  "Health Pulse",
  "Run agent tasks",
  "Session Store",
  "Session Storage",
  "Agent Runtime",
  "Foundry Hosted Agent",
  "AI Inference",
  "App Hosting",
  "Discovered Application Topology",
  "Azure Platform Context",
  "Send Health Reports",
  "View Health Model",
  "Application Insights topology",
  "contosodemo",
  "stcontosodemo00001",
];

const CALM_ROWS = ["Health Pulse", "Discovered Application Topology", "Azure Platform Context", "Run agent tasks", "Send Health Reports", "View Health Model", "Application Insights topology", "contosodemo", "stcontosodemo00001"];

test.describe("Outline", () => {
  test("lists one row per entity, worst first at every level, with the root first and healthy subtrees closed", async ({ page }) => {
    await show(page);
    expect(await names(page)).toEqual(INCIDENT_ROWS);
    await expect(page.getByTestId("outline-summary")).toContainText("15 rows, 10 entities need attention");
    for (const name of ["system-ai-inference", "system-app-hosting", "flow-send-health-reports"]) await expect(entityRow(page, name)).toHaveAttribute("aria-expanded", "false");
    await expect(entityRow(page, "system-session-store")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("outline-below").first()).toContainText("below, all healthy");
    // Each row says its state, the impact where there is one, and the counts of its signals by state.
    await expect(entityRow(page, "session-storage")).toContainText("Unhealthy");
    await expect(entityRow(page, "system-session-store").getByTestId("outline-impact")).toHaveText(/Limited impact/);
    await expect(entityRow(page, "session-storage").getByTestId("outline-counts")).toContainText("1");
  });

  test("names the failing signals inline with their value and state, and nothing else about history", async ({ page }) => {
    await show(page);
    const failing = entityRow(page, "session-storage").getByTestId("outline-signals");
    await expect(failing).toContainText("Availability");
    await expect(failing).toContainText("91.4");
    await expect(failing.locator('[data-state="Unhealthy"]')).toHaveCount(1);
    await expect(entityRow(page, "container-app").getByTestId("outline-signals")).toHaveCount(0);
    await expect(page.locator("svg polyline, canvas")).toHaveCount(0);
  });

  test("is a tree to a screen reader: levels, positions, sizes, and open state", async ({ page }) => {
    await show(page);
    const tree = page.getByRole("tree", { name: "Health model outline" });
    await expect(tree).toBeVisible();
    const items = await tree.getByRole("treeitem").evaluateAll((elements) => elements.map((element) => [element.getAttribute("aria-level"), element.getAttribute("aria-posinset"), element.getAttribute("aria-setsize"), element.getAttribute("aria-expanded")]));
    expect(items).toHaveLength(15);
    expect(items[0]).toEqual(["1", "1", "2", "true"]);
    expect(items[3]).toEqual(["4", "1", "1", null]);
    await expect(entityRow(page, "session-storage")).toHaveAttribute("aria-label", /Session Storage, Unhealthy, 2 signals, Availability 91.4, Unhealthy/);
    await expect(entityRow(page, "system-ai-inference")).toHaveAttribute("aria-label", /1 below, all healthy/);
  });

  test("expands every row on request, with the second parent's rows as references, and goes back to the default", async ({ page }) => {
    await show(page);
    await page.getByTestId("outline-expand-all").click();
    await expect(page.getByTestId("outline-summary")).toContainText("19 rows, 10 entities need attention, 2 also under another parent");
    await expect(page.locator('[data-kind="also"]')).toHaveCount(2);
    await expect(page.locator('[data-kind="also"]').first()).toContainText("also under Run agent tasks");
    await expect(page.locator('[data-kind="entity"][data-entity="system-app-hosting"]')).toHaveCount(1);
    await page.getByTestId("outline-collapse-healthy").click();
    await expect(page.getByTestId("outline-summary")).toContainText("15 rows");
    await expect(page.locator('[data-kind="also"]')).toHaveCount(0);
  });

  test("opens a closed row from its chevron, and not from a click on the row", async ({ page }) => {
    await show(page);
    const row = entityRow(page, "system-ai-inference");
    await row.locator(".fui-TreeItemLayout__expandIcon").click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(entityRow(page, "foundry-account")).toBeVisible();
    await expect(page.getByTestId("entity-details")).toHaveCount(0);
    await expect(page.getByTestId("graph-announcement")).toContainText("AI Inference expanded");
    await row.locator(".fui-TreeItemLayout__expandIcon").click();
    await expect(row).toHaveAttribute("aria-expanded", "false");
  });

  test("opens the entity panel from a click, shows the last change on the selected row only", async ({ page }) => {
    await show(page);
    await expect(page.getByTestId("outline-last-change")).toHaveCount(0);
    await entityRow(page, "session-storage").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await expect(entityRow(page, "session-storage")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("outline-last-change")).toHaveCount(1);
    await expect(entityRow(page, "session-storage").getByTestId("outline-last-change")).toContainText(/Last change .*2026/);
    await expect(entityRow(page, "hosted-agent")).toHaveAttribute("aria-selected", "false");
  });

  test.describe("by keyboard", () => {
    test("Tab finds one row, the arrows, Home and End move between rows, and the others stay out of the tab order", async ({ page }) => {
      await show(page);
      await tabIntoTree(page);
      expect(await focusedKey(page)).toBe("hm-contosodemo");
      expect(await rows(page).evaluateAll((elements) => elements.filter((element) => element.getAttribute("tabindex") === "0").length)).toBe(1);

      await page.keyboard.press("ArrowDown");
      expect(await focusedKey(page)).toBe("flow-run-agent-tasks");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      expect(await focusedKey(page)).toBe("session-storage");
      await page.keyboard.press("ArrowUp");
      expect(await focusedKey(page)).toBe("system-session-store");
      await page.keyboard.press("End");
      expect(await focusedKey(page)).toBe((await rows(page).last().getAttribute("data-key"))!);
      await page.keyboard.press("Home");
      expect(await focusedKey(page)).toBe("hm-contosodemo");
      expect(await rows(page).evaluateAll((elements) => elements.filter((element) => element.getAttribute("tabindex") === "0").map((element) => (element as HTMLElement).dataset["key"]))).toEqual(["hm-contosodemo"]);
      // Tab leaves the tree and Shift+Tab comes back to the row that was last on.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Tab");
      expect(await focusedKey(page)).toBe("");
      await page.keyboard.press("Shift+Tab");
      expect(await focusedKey(page)).toBe("flow-run-agent-tasks");
    });

    test("Right opens a closed row and then goes in, Left goes out and then closes, Enter and Space open the entity", async ({ page }) => {
      await show(page);
      await entityRow(page, "system-ai-inference").focus();
      await page.keyboard.press("ArrowRight");
      await expect(entityRow(page, "system-ai-inference")).toHaveAttribute("aria-expanded", "true");
      expect(await focusedKey(page)).toBe("system-ai-inference");
      await page.keyboard.press("ArrowRight");
      expect(await focusedKey(page)).toBe("foundry-account");
      await page.keyboard.press("ArrowLeft");
      expect(await focusedKey(page)).toBe("system-ai-inference");
      await page.keyboard.press("ArrowLeft");
      await expect(entityRow(page, "system-ai-inference")).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("ArrowLeft");
      expect(await focusedKey(page)).toBe("flow-run-agent-tasks");

      await page.keyboard.press("Enter");
      await expect(page.getByTestId("entity-details")).toBeVisible();
      await expect(page.getByTestId("entity-name")).toHaveText("Run agent tasks");
      await entityRow(page, "hosted-agent").focus();
      await page.keyboard.press(" ");
      await expect(page.getByTestId("entity-name")).toHaveText("Foundry Hosted Agent");
    });

    test("typing a letter or a few finds the next row that starts with them", async ({ page }) => {
      await show(page);
      await tabIntoTree(page);
      await page.keyboard.press("f");
      expect(await focusedKey(page)).toBe("hosted-agent");
      // Letters typed together narrow the match; a pause starts a new one.
      await page.keyboard.press("o");
      expect(await focusedKey(page)).toBe("hosted-agent");
      await page.waitForTimeout(1000);
      await page.keyboard.press("a");
      expect(await focusedKey(page)).toBe("system-ai-inference");
      await page.waitForTimeout(1000);
      for (const letter of "dis") await page.keyboard.press(letter);
      expect(await focusedKey(page)).toBe("discovered-app-topology");
    });

    test("following a reference row goes to the full row and opens the entity", async ({ page }) => {
      await show(page);
      await page.getByTestId("outline-expand-all").click();
      const reference = page.locator('[data-kind="also"]').first();
      await reference.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("entity-name")).toHaveText("App Hosting");
      expect(await focusedKey(page)).toBe("system-app-hosting");
    });
  });

  test("marks an open Explain result's chain with numbers, and opens the rows that hide it", async ({ page }) => {
    const model = incidentModel();
    await installStubs(page, { healthModelFails: false, model });
    await stubEntityDetails(page, model);
    await installWorkspace(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "hm-contosodemo" }, result: incidentExplain() }), script: { events: explainEvents(), outcome: { status: "done", result: incidentExplain() } } }],
    });
    await openView(page, "outline", `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    for (const [name, step] of [["session-storage", 1], ["system-session-store", 2], ["flow-run-agent-tasks", 3], ["hm-contosodemo", 4]] as const) {
      await expect(entityRow(page, name)).toHaveAttribute("data-step", String(step));
      await expect(entityRow(page, name).getByTestId("outline-step")).toHaveText(String(step));
    }
    await expect(page.getByTestId("outline-step")).toHaveCount(4);
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("outline-step")).toHaveCount(0);
  });

  test("brings a search result into view, opening the closed rows above it", async ({ page }) => {
    await show(page);
    await expect(entityRow(page, "container-app")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("search-input").fill("Web Container App");
    await page.keyboard.press("Enter");
    await expect(entityRow(page, "container-app")).toBeVisible();
    await expect(entityRow(page, "container-app")).toHaveAttribute("data-highlighted", "true");
    await expect(entityRow(page, "system-app-hosting")).toHaveAttribute("aria-expanded", "true");
  });

  test("follows the Health filter: hides the states that are not selected, or draws them faint", async ({ page }) => {
    await show(page);
    await page.getByTestId("health-filter-toggle").click();
    await page.getByRole("checkbox", { name: "Healthy", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="outline-row"][data-state="Healthy"]')).toHaveCount(0);
    expect(await names(page)).toEqual(["Health Pulse", "Run agent tasks", "Session Store", "Session Storage", "Agent Runtime", "Foundry Hosted Agent", "Discovered Application Topology", "Application Insights topology", "contosodemo", "stcontosodemo00001"]);

    await page.getByTestId("health-filter-toggle").click();
    await page.getByRole("radio", { name: "Gray dot" }).check();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="outline-row"][data-dimmed="true"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="outline-row"][data-state="Healthy"]:not([data-dimmed])')).toHaveCount(0);
  });

  test("shows the ribbon: a mark in the colour of every stretch of rows, and where the viewer is", async ({ page }) => {
    await show(page);
    await expect(page.getByTestId("outline-ribbon")).toBeVisible();
    const states = await page.getByTestId("outline-mark").evaluateAll((marks) => marks.map((mark) => mark.getAttribute("data-state")));
    expect(states).toEqual(["Degraded", "Unhealthy", "Degraded", "Healthy", "Unknown", "Healthy", "Unknown"]);
    await expect(page.getByTestId("outline-window")).toBeVisible();
  });

  test.describe("a long outline", () => {
    for (const [count, model] of [[81, denseIncidentModel()], [300, denseModel(7, 300, 420)]] as const) {
      test(`draws only the rows on screen for ${count} entities, reaches the last by End, and the ribbon jumps`, async ({ page }) => {
        await show(page, model);
        const started = Date.now();
        await page.getByTestId("outline-expand-all").click();
        await expect(page.getByTestId("outline-summary")).toContainText(/\d+ rows/);
        const painted = await page.evaluate(() => new Promise<number>((resolve) => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))); }));
        const total = Number(/(\d+) rows/.exec((await page.getByTestId("outline-summary").textContent())!)![1]);
        const drawn = await page.getByRole("treeitem").count();
        console.log(`OUTLINE ${count} entities: ${total} rows, ${drawn} in the DOM, expand all to idle ${Date.now() - started} ms, next frame ${painted.toFixed(0)} ms`);
        expect(total).toBeGreaterThanOrEqual(count);
        expect(drawn).toBeLessThan(60);
        expect(await page.getByTestId("outline-scroller").evaluate((element) => element.scrollHeight)).toBeGreaterThan(total * 36 - 1);

        // Scroll through the list and time the frames.
        const frames = await page.getByTestId("outline-scroller").evaluate(async (element) => {
          const times: number[] = [];
          for (let step = 0; step < 40; step += 1) {
            const start = performance.now();
            element.scrollTop += 600;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            times.push(performance.now() - start);
          }
          return times;
        });
        console.log(`OUTLINE ${count} entities: scrolling, median ${[...frames].sort((a, b) => a - b)[20]!.toFixed(1)} ms per 600 px step, worst ${Math.max(...frames).toFixed(1)} ms`);

        await tabIntoTree(page);
        await page.keyboard.press("End");
        const last = await focusedKey(page);
        const box = (await page.locator(`[data-key="${last}"]`).boundingBox())!;
        const pane = (await page.getByTestId("outline-scroller").boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
        await page.keyboard.press("Home");
        expect(await page.getByTestId("outline-scroller").evaluate((element) => element.scrollTop)).toBe(0);

        const ribbon = (await page.getByTestId("outline-ribbon").boundingBox())!;
        await page.mouse.click(ribbon.x + ribbon.width / 2, ribbon.y + ribbon.height * 0.75);
        const scrolled = await page.getByTestId("outline-scroller").evaluate((element) => element.scrollTop / (element.scrollHeight - element.clientHeight));
        expect(scrolled).toBeGreaterThan(0.55);
        expect(scrolled).toBeLessThan(0.9);
        const window = (await page.getByTestId("outline-window").boundingBox())!;
        expect(window.y).toBeGreaterThan(ribbon.y + ribbon.height * 0.4);
      });
    }
  });

  test("shows a model with nothing wrong with the root open and the healthy rest closed", async ({ page }) => {
    await show(page, calmModel());
    expect(await names(page)).toEqual(CALM_ROWS);
    await expect(entityRow(page, "hm-contosodemo")).toHaveAttribute("aria-expanded", "true");
    await expect(entityRow(page, "flow-run-agent-tasks")).toHaveAttribute("aria-expanded", "false");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`reads at AA in ${theme}: names, counts, quiet text and chips`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await show(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const name of ["session-storage", "hosted-agent", "container-app", "system-ai-inference"]) {
        const row = page.locator(`[data-testid="outline-row"][data-entity="${name}"]`);
        if ((await row.count()) === 0) continue;
        expect(await contrastOf(row.getByTestId("outline-name")), `${name} name`).toBeGreaterThanOrEqual(4.5);
      }
      expect(await contrastOf(entityRow(page, "system-ai-inference").getByTestId("outline-below")), "below").toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(entityRow(page, "system-session-store").getByTestId("outline-impact")), "impact chip").toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(entityRow(page, "session-storage").getByTestId("outline-signals").locator("b")), "failing signal").toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(entityRow(page, "session-storage").getByTestId("outline-counts")), "counts").toBeGreaterThanOrEqual(4.5);
      await page.getByTestId("outline-expand-all").click();
      expect(await contrastOf(page.getByTestId("outline-also").first()), "also under").toBeGreaterThanOrEqual(4.5);
    });
  }

  test("fits a narrow screen: no sideways scroll of the page, the rows still readable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await show(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(entityRow(page, "session-storage")).toBeVisible();
    await expect(page.getByTestId("outline-ribbon")).toBeVisible();
  });

  test("raises no Content-Security-Policy violation, in both themes, while rows open, close and are selected", async ({ page, baseURL }) => {
    const violations = await underServedPolicy(page, new URL(baseURL!).origin);
    await show(page, denseIncidentModel());
    await page.getByTestId("outline-expand-all").click();
    await rows(page).nth(2).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.getByTestId("outline-collapse-healthy").click();
    await page.getByTestId("theme-toggle").click();
    await page.waitForTimeout(400);
    expect(violations).toEqual([]);
  });
});
