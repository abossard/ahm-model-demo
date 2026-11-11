import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { installStubs } from "./fixture";
import { MODEL_QUERY } from "./workspaceHelpers";
import { SESSION_ID, explainEvents, explainResult, installWorkspace, sessionSummary, taskOf } from "./workspaceStub";
import { SUBSCRIPTION_A } from "./fixture";
import { openView } from "./views";
import { calmModel, denseIncidentModel, incidentModel } from "./viewModels";
import type { HealthModel } from "../src/model/types";
import type { ViewId } from "../src/model/views";

test.use({ viewport: { width: 1440, height: 900 } });

async function show(page: Page, view: ViewId, model: HealthModel = incidentModel(), query = ""): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await openView(page, view, query === "" ? "/" : `/?${query}`);
}

const causeNode = (page: Page, name: string): Locator => page.locator(`[data-testid="cause-node"][data-entity="${name}"]`);
const chip = (page: Page, id: string): Locator => page.locator(`[data-testid="cause-chip"][data-chip="${id}"]`);
const cell = (page: Page, name: string): Locator => page.locator(`[data-testid="coverage-cell"][data-entity="${name}"]`);

test.describe("Cause path", () => {
  test("is the view a model opens in, and numbers the chain from the failing signal to the root", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, model: incidentModel() });
    await page.goto("/");
    await expect(page.getByTestId("cause-view")).toBeVisible();
    await expect(page.getByTestId("view-tab-cause")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("cause-node")).toHaveCount(6);
    for (const [name, step] of [["session-storage", 1], ["system-session-store", 2], ["flow-run-agent-tasks", 3], ["hm-contosodemo", 4]] as const) {
      await expect(causeNode(page, name)).toHaveAttribute("data-step", String(step));
    }
    // The failing leaf is a large card with its failing signal; the degraded sibling off the chain is not numbered.
    await expect(causeNode(page, "session-storage")).toHaveAttribute("data-kind", "hero");
    await expect(causeNode(page, "session-storage")).toContainText("Availability");
    await expect(causeNode(page, "session-storage")).toContainText("91.4");
    await expect(causeNode(page, "hosted-agent")).not.toHaveAttribute("data-step", /.+/);
    await expect(page.getByTestId("cause-summary")).toContainText("6 entities need attention");
  });

  test("folds everything else into chips whose names state the count and the states", async ({ page }) => {
    await show(page, "cause");
    await expect(page.getByTestId("cause-chip")).toHaveCount(4);
    await expect(chip(page, "flow-run-agent-tasks|healthy")).toHaveAttribute("aria-label", /4 healthy entities are folded under Run agent tasks \(4 Healthy\)/);
    await expect(chip(page, "hm-contosodemo|not-in-rollup")).toContainText("+1 not in rollup");
    await expect(chip(page, "#unconnected")).toContainText("+3 not connected");
  });

  test("opens a chip in place by mouse and closes it by keyboard, keeping the chip where it was on screen", async ({ page }) => {
    await show(page, "cause");
    const target = chip(page, "flow-run-agent-tasks|healthy");
    await expect(target).toBeVisible();
    const before = (await target.boundingBox())!;
    await target.click();
    await expect(target).toHaveAttribute("aria-expanded", "true");
    await expect(causeNode(page, "system-ai-inference")).toBeVisible();
    await expect(causeNode(page, "system-app-hosting")).toBeVisible();
    await page.waitForTimeout(250);
    const after = (await target.boundingBox())!;
    expect(Math.abs(after.x + after.width / 2 - (before.x + before.width / 2))).toBeLessThan(4);
    expect(Math.abs(after.y + after.height / 2 - (before.y + before.height / 2))).toBeLessThan(4);

    await target.focus();
    await page.keyboard.press("Enter");
    await expect(target).toHaveAttribute("aria-expanded", "false");
    await expect(causeNode(page, "system-ai-inference")).toHaveCount(0);
    await target.focus();
    await page.keyboard.press(" ");
    await expect(target).toHaveAttribute("aria-expanded", "true");
  });

  test("shows a model with nothing wrong as the root, a calm notice and chips, and Show everything leaves for the card graph", async ({ page }) => {
    await show(page, "cause", calmModel());
    await expect(page.getByTestId("cause-calm")).toHaveText("Nothing is degraded or unhealthy.");
    await expect(page.getByTestId("cause-node")).toHaveCount(1);
    await expect(chip(page, "hm-contosodemo|healthy")).toContainText("+12 healthy");
    await expect(page.getByTestId("focus-cause")).toHaveCount(0);
    await page.getByTestId("show-everything").click();
    await expect(page).toHaveURL(/view=zoom/);
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    expect(await page.locator(".react-flow__node .entity-node").count()).toBe(17);
  });

  test("keeps 81 entities readable: the parts that need attention, with the rest one click away", async ({ page }) => {
    await show(page, "cause", denseIncidentModel());
    await expect(causeNode(page, "root")).toBeVisible();
    const nodes = await page.getByTestId("cause-node").count();
    expect(nodes).toBeGreaterThan(15);
    expect(nodes).toBeLessThan(40);
    expect(await page.getByTestId("cause-chip").count()).toBeGreaterThan(5);
    // Two leaves fail; the chain follows the worse way up (every step Unhealthy), the other failing leaf stays a large card.
    await expect(causeNode(page, "res-func-nightly")).toHaveAttribute("data-step", "1");
    await expect(causeNode(page, "root")).toHaveAttribute("data-step", "4");
    await expect(causeNode(page, "res-sql-orders")).toHaveAttribute("data-kind", "hero");
    await expect(causeNode(page, "res-sql-orders")).not.toHaveAttribute("data-step", /.+/);
  });

  test("Focus cause fits the chain", async ({ page }) => {
    await show(page, "cause", denseIncidentModel());
    await page.getByTestId("focus-cause").click();
    for (const name of ["res-func-nightly", "sys-batch-jobs", "flow-admin-reporting", "root"]) await expect(causeNode(page, name)).toBeInViewport();
    await expect(causeNode(page, "res-func-nightly")).toHaveAttribute("data-highlighted", "true");
  });

  test("opens the entity details from a card by pointer and keyboard", async ({ page }) => {
    await show(page, "cause");
    await causeNode(page, "session-storage").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await causeNode(page, "hosted-agent").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("entity-name")).toHaveText("Foundry Hosted Agent");
  });

  test("search brings an entity that sits behind a chip into view by opening the chips in front of it", async ({ page }) => {
    await show(page, "cause", calmModel());
    await expect(causeNode(page, "container-app")).toHaveCount(0);
    await page.getByTestId("search-open").click();
    await page.getByTestId("search-input").fill("Web Container App");
    await page.keyboard.press("Enter");
    await expect(causeNode(page, "container-app")).toBeVisible();
    await expect(causeNode(page, "container-app")).toBeInViewport();
    await expect(causeNode(page, "container-app")).toHaveAttribute("data-highlighted", "true");
  });

  test("the Health filter narrows what is drawn before anything folds: unselected states leave no chip", async ({ page }) => {
    await show(page, "cause");
    await page.getByTestId("health-filter-toggle").click();
    await page.getByRole("checkbox", { name: "Healthy", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="cause-chip"][data-kind="healthy"]')).toHaveCount(0);
    await expect(page.getByTestId("cause-node")).toHaveCount(6);
  });

  test("marks an open Explain result's chain, numbered from its last entity", async ({ page }) => {
    await installStubs(page, { healthModelFails: false });
    await installWorkspace(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" }, result: explainResult() }), script: { events: explainEvents(), outcome: { status: "done", result: explainResult() } } }],
    });
    await openView(page, "cause", `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    for (const [name, step] of [["svc-a", 1], ["svc-b", 2], ["svc-c", 3]] as const) await expect(causeNode(page, name)).toHaveAttribute("data-step", String(step));
    await expect(causeNode(page, "svc-d")).not.toHaveAttribute("data-step", /.+/);
    // Closing the result gives the numbering back to the chain the view finds itself: from the failing leaf, svc-c.
    await page.getByTestId("task-back").click();
    await expect(causeNode(page, "svc-c")).toHaveAttribute("data-step", "1");
  });
});

test.describe("Coverage", () => {
  test("draws every entity as a cell, a separate band for the parts not connected to the root", async ({ page }) => {
    await show(page, "coverage");
    await expect(page.getByTestId("coverage-cell")).toHaveCount(17);
    await expect(page.locator("svg.coverage")).toContainText("NOT CONNECTED TO THE ROOT");
    await expect(cell(page, "discover-app-insights")).toHaveAttribute("data-state", "Unknown");
  });

  test("selecting a cell opens the entity panel and shows arcs to the other parents", async ({ page }) => {
    await show(page, "coverage");
    await expect(page.getByTestId("coverage-arc")).toHaveCount(0);
    await cell(page, "system-app-hosting").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    const parents = await page.getByTestId("coverage-arc").evaluateAll((arcs) => arcs.map((arc) => arc.getAttribute("data-parent")));
    expect(parents.sort()).toEqual(["flow-send-health-reports", "flow-view-health-model"]);
  });

  test("double-click zooms into a part with a breadcrumb back; Escape zooms out", async ({ page }) => {
    await show(page, "coverage");
    await cell(page, "flow-run-agent-tasks").dblclick();
    await expect(page.getByTestId("coverage-trail")).toHaveCount(2);
    expect(await page.getByTestId("coverage-cell").count()).toBeLessThan(17);
    await expect(cell(page, "hm-contosodemo")).toHaveCount(0);
    await page.getByTestId("coverage-zoom-out").click();
    await expect(page.getByTestId("coverage-cell")).toHaveCount(17);
    await cell(page, "flow-run-agent-tasks").focus();
    await page.keyboard.press("Shift+Enter");
    await expect(cell(page, "hm-contosodemo")).toHaveCount(0);
    // Escape goes out one level at a time: to the root's part (the model without what is not connected), then the whole.
    await cell(page, "flow-run-agent-tasks").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("coverage-cell")).toHaveCount(14);
    await cell(page, "hm-contosodemo").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("coverage-cell")).toHaveCount(17);
  });

  test("moves by structure with the arrow keys and selects with Enter", async ({ page }) => {
    await show(page, "coverage");
    const focused = (): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-entity") ?? null);
    await cell(page, "hm-contosodemo").focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe("platform-context");
    await page.keyboard.press("ArrowRight");
    expect(await focused()).toBe("discovered-app-topology");
    await page.keyboard.press("End");
    expect(await focused()).toBe("flow-view-health-model");
    await page.keyboard.press("ArrowUp");
    expect(await focused()).toBe("hm-contosodemo");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("entity-details")).toBeVisible();
  });

  test("keeps 81 entities legible at 1360 px: a column per leaf with its state glyph and mostly a name", async ({ page }) => {
    await show(page, "coverage", denseIncidentModel());
    await expect(page.getByTestId("coverage-cell")).toHaveCount(81);
    await expect(page.locator("svg.coverage")).toHaveAttribute("data-density", "glyphs");
    const widths = await page.getByTestId("coverage-cell").evaluateAll((cells) => cells.map((element) => element.getBoundingClientRect().width));
    expect(Math.min(...widths)).toBeGreaterThan(14);
    const named = await page.locator("svg.coverage .coverage-cell__label").count();
    expect(named).toBeGreaterThan(60);
  });

  test("marks the chain of an Explain result", async ({ page }) => {
    await installStubs(page, { healthModelFails: false });
    await installWorkspace(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" }, result: explainResult() }), script: { events: explainEvents(), outcome: { status: "done", result: explainResult() } } }],
    });
    await openView(page, "coverage", `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    for (const [name, step] of [["svc-a", 1], ["svc-b", 2], ["svc-c", 3]] as const) await expect(cell(page, name)).toHaveAttribute("data-step", String(step));
  });
});

test.describe("Semantic zoom", () => {
  const level = (page: Page): Locator => page.locator(".react-flow__node .entity-node[data-lod]");

  async function zoomOutTo(page: Page, wanted: string): Promise<void> {
    const pane = (await page.locator(".react-flow__pane").boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    for (let step = 0; step < 30 && (await page.locator(`.entity-node[data-lod="${wanted}"]`).count()) === 0; step += 1) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(80);
    }
  }

  test("opens a small model as cards and shows a mini-map coloured by state", async ({ page }) => {
    await show(page, "zoom");
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    await expect(level(page)).toHaveCount(0);
    await expect(page.locator(".react-flow__minimap")).toBeVisible();
    expect(await page.locator(".react-flow__minimap-svg title").textContent()).toMatch(/coloured by its health state/);
  });

  test("zooming out turns cards into name pills, then dots, and back into cards", async ({ page }) => {
    await show(page, "zoom");
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    await zoomOutTo(page, "pill");
    await expect(page.locator('.entity-node[data-lod="pill"][data-entity="session-storage"]')).toContainText("Session Storage");
    await zoomOutTo(page, "dot");
    await expect(page.locator('.entity-node[data-lod="dot"]').first()).toBeVisible();
    await expect(page.locator('.entity-node[data-lod="dot"][data-entity="session-storage"]')).toHaveAttribute("aria-label", /Session Storage \(Unhealthy/);
    const pane = (await page.locator(".react-flow__pane").boundingBox())!;
    for (let step = 0; step < 30 && (await level(page).count()) > 0; step += 1) {
      await page.mouse.wheel(0, -160);
      await page.waitForTimeout(80);
    }
    await expect(level(page)).toHaveCount(0);
    expect(pane.width).toBeGreaterThan(0);
  });

  test("a pill and a dot open the entity details by pointer and keyboard", async ({ page }) => {
    await show(page, "zoom");
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    await zoomOutTo(page, "pill");
    await page.locator('.entity-node[data-lod="pill"][data-entity="session-storage"]').click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await zoomOutTo(page, "dot");
    await page.locator('.entity-node[data-lod="dot"][data-entity="hosted-agent"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("entity-name")).toHaveText("Foundry Hosted Agent");
  });

  test("opens a large model zoomed out to see all of it, and keeps lines a constant width on screen", async ({ page }) => {
    await show(page, "zoom", denseIncidentModel());
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    await expect(level(page).first()).toBeVisible();
    const levels = await level(page).evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-lod")))]);
    expect(levels.every((name) => name === "dot" || name === "speck" || name === "pill")).toBe(true);
    expect(await page.locator(".react-flow__edge-path").first().evaluate((path) => getComputedStyle(path).vectorEffect)).toBe("non-scaling-stroke");
    expect(await page.locator(".react-flow__node").count()).toBe(81);
  });
});

test.describe("the view switch", () => {
  test("keeps the view in the address and for this viewer, and a link's view wins", async ({ page }) => {
    await show(page, "cause");
    await page.getByTestId("view-tab-coverage").click();
    await expect(page.getByTestId("coverage-view")).toBeVisible();
    await expect(page).toHaveURL(/view=coverage/);
    await page.reload();
    await expect(page.getByTestId("coverage-view")).toBeVisible();
    await expect(page.getByTestId("view-tab-coverage")).toHaveAttribute("aria-selected", "true");

    // Another visit without a view opens the one chosen last; a link that names one opens that one.
    await page.goto("/");
    await expect(page.getByTestId("coverage-view")).toBeVisible();
    await page.goto("/?view=zoom");
    await expect(page.locator(".react-flow__node .entity-node").first()).toBeVisible();
    await expect(page).toHaveURL(/view=zoom/);
  });

  test("choosing the default view leaves the address bar without a view", async ({ page }) => {
    await show(page, "coverage");
    await page.getByTestId("view-tab-cause").click();
    await expect(page.getByTestId("cause-view")).toBeVisible();
    await expect(page).not.toHaveURL(/view=/);
  });

  test("collapses to a dropdown on a narrow screen", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await show(page, "cause");
    await expect(page.getByTestId("view-select")).toBeVisible();
    await expect(page.getByTestId("view-switch")).toBeHidden();
    await page.getByTestId("view-select").selectOption("coverage");
    await expect(page.getByTestId("coverage-view")).toBeVisible();
  });

  test("shows only the card graph's controls in the card graph", async ({ page }) => {
    await show(page, "zoom");
    await expect(page.getByTestId("layout-picker")).toBeVisible();
    await page.getByTestId("view-tab-cause").click();
    await expect(page.getByTestId("layout-picker")).toHaveCount(0);
    await expect(page.getByTestId("edge-style-picker")).toHaveCount(0);
  });
});

const CSP_SPEC = readFileSync(fileURLToPath(new URL("./graph-ux.spec.ts", import.meta.url)), "utf8");
function servedPolicy(): string {
  const declaration = /const SERVED_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/.exec(CSP_SPEC);
  if (!declaration) throw new Error("SERVED_CSP is no longer a plain string expression in graph-ux.spec.ts");
  return [...declaration[1]!.matchAll(/"([^"]*)"/g)].map((piece) => piece[1]).join("");
}

test.describe("under the Content-Security-Policy the web app sends", () => {
  for (const view of ["cause", "coverage"] as const) {
    test(`${view} raises no violation, in light and dark`, async ({ page, baseURL }) => {
      const violations: string[] = [];
      page.on("console", (message) => {
        if (/content security policy/i.test(message.text())) violations.push(message.text());
      });
      page.on("pageerror", (error) => violations.push(error.message));
      const origin = new URL(baseURL!).origin;
      await page.route((url) => url.origin === origin && !url.pathname.startsWith("/api/"), async (route) => {
        const response = await route.fetch();
        const headers = response.headers();
        if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = servedPolicy();
        await route.fulfill({ response, headers });
      });
      await show(page, view);
      await expect(page.getByTestId(view === "cause" ? "cause-view" : "coverage-view")).toBeVisible();
      await page.getByTestId("theme-toggle").click();
      await page.waitForTimeout(300);
      expect(violations).toEqual([]);
    });
  }
});

interface Pair {
  readonly color: string;
  readonly background: string;
}

/** The ratio between an element's text colour and the colour behind it, from what the browser computed. */
async function contrastOf(locator: Locator): Promise<number> {
  const pair: Pair = await locator.evaluate((element) => {
    const behind = (start: Element): string => {
      for (let current: Element | null = start; current; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
      }
      return "rgb(255, 255, 255)";
    };
    return { color: getComputedStyle(element).color, background: behind(element) };
  });
  const channels = (text: string): number[] => (/\(([^)]+)\)/.exec(text)?.[1] ?? "").split(",").slice(0, 3).map((part) => Number(part));
  const luminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.map((value) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(channels(pair.color)), luminance(channels(pair.background))].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

test.describe("light and dark", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`cards, chips and cells read at AA in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await show(page, "cause");
      await expect(page.getByTestId("cause-node").first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const name of ["session-storage", "hosted-agent"]) {
        const card = causeNode(page, name);
        expect(await contrastOf(card.locator(".cause-node__name")), `${name} name`).toBeGreaterThanOrEqual(4.5);
        expect(await contrastOf(card.locator(".cause-node__row-value").first()), `${name} value`).toBeGreaterThanOrEqual(4.5);
        expect(await contrastOf(card.locator(".entity-node__pill-word")), `${name} state word`).toBeGreaterThanOrEqual(4.5);
      }
      expect(await contrastOf(page.getByTestId("cause-chip").first()), "chip").toBeGreaterThanOrEqual(4.5);
      await page.getByTestId("view-tab-coverage").click();
      await expect(page.getByTestId("coverage-cell").first()).toBeVisible();
      expect(await contrastOf(page.locator("svg.coverage .coverage-cell__label").first()), "cell label").toBeGreaterThanOrEqual(4.5);
    });
  }
});
