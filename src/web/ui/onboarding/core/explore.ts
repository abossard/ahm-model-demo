import { expect, type Page } from "@playwright/test";
import type { ViewId } from "../../src/model/views";
import type { Capture } from "../capture";

const taskFlow = "flow-run-agent-tasks";

/** A visible control can precede its graph. Wait for the actual drawing before photographing it. */
async function showView(page: Page, view: ViewId) {
  const tab = page.getByTestId("view-tab-" + view);
  if (await tab.isVisible()) await tab.click();
  else await page.getByTestId("view-select").selectOption(view);
  await expect(page.locator("[data-graph-area]")).toHaveAttribute("data-view", view);
  const marks = {
    cause: '[data-testid="cause-node"]', swimlanes: '[data-testid="swim-card"]',
    tidy: '[data-testid="tidy-tile"]', zoom: '.react-flow__node .entity-node',
    outline: '[data-testid="outline-row"]', coverage: '[data-testid="coverage-cell"]',
  };
  const graph = page.locator("[data-graph-area]");
  await expect(graph.locator(marks[view]).first()).toBeVisible();
  if (view === "swimlanes" || view === "tidy" || view === "zoom") {
    await expect.poll(() => graph.locator(".react-flow__edge-path").evaluateAll(paths =>
      paths.some(path => (path as SVGPathElement).getTotalLength() > 0))).toBe(true);
  }
}

export async function explore(page: Page, capture: Capture): Promise<void> {
  const id = (key: string) => page.getByTestId(key);
  const graph = page.locator("[data-graph-area]");
  await expect(id("model-name")).toHaveText("hm-anboahmdemo");
  await expect(id("model-picker-selected")).toContainText("rg-anboahmdemo");
  await showView(page, "cause");
  const picker = id("model-picker-search");
  await picker.click();
  await picker.fill("rg-anboahmdemo");
  const catalog = page.getByRole("listbox").filter({ has: page.getByRole("option", { name: /hm-anboahmdemo/ }) });
  await capture.step("picker", catalog.getByRole("option", { name: /hm-anboahmdemo/ }).first(), { shot: catalog });
  await picker.press("Escape");

  const folds = id("cause-chip");
  const unknown = folds.filter({ hasText: /unknown/i }).first();
  if (await folds.count()) {
    const folded = await unknown.count() ? unknown : folds.first();
    await folded.click();
    await expect(folded).toHaveAttribute("aria-expanded", "true");
  }
  await capture.step("cause", id("cause-summary").getByRole("status"));
  await id("legend-toggle").click();
  await capture.step("legend", id("legend").getByRole("heading", { name: "Health flows up the lines" }), { shot: id("legend") });
  await id("legend-toggle").click();

  await capture.clip("view-gallery", async () => {
    await showView(page, "swimlanes");
    await id("swim-fit").click();
    await capture.step("swimlanes", id("view-tab-swimlanes"));
    await showView(page, "tidy");
    await id("tidy-fit").click();
    await capture.step("tidy", id("view-tab-tidy"));
    await showView(page, "zoom");
    await capture.step("zoom", id("view-tab-zoom"));
    await showView(page, "outline");
    await capture.step("outline", id("outline-summary"));
    await showView(page, "coverage");
    await capture.step("coverage", id("coverage-note"));
  });

  // Keyboard zoom keeps the pointer from opening the entity timeline on the first of a double-click.
  const flow = graph.locator(`[data-testid="coverage-cell"][data-entity="${taskFlow}"]`);
  await flow.focus();
  await page.keyboard.press("Shift+Enter");
  await expect(id("coverage-breadcrumb")).toContainText("Run a Task");
  await expect(graph.locator('[data-testid="coverage-cell"][data-entity="system-session-store"]')).toBeVisible();
  await capture.step("task-coverage", id("coverage-trail").last());
  await id("coverage-zoom-out").click();

  await showView(page, "tidy");
  const flowTile = graph.locator(`[data-testid="tidy-tile"][data-entity="${taskFlow}"]`);
  await flowTile.focus();
  await page.keyboard.press("m");
  await expect(id("graph-announcement")).toContainText("picked up");
  const slot = (await id("graph-announcement").innerText()).match(/Place (\d+) of (\d+)/);
  if (!slot || Number(slot[2]) < 2) throw new Error("Run a Task needs a sibling to demonstrate custom ordering.");
  await page.keyboard.press(slot[1] === slot[2] ? "ArrowLeft" : "ArrowRight");
  await page.keyboard.press("Enter");
  await expect(id("sort-key")).toHaveValue("custom");
  await capture.step("personal-order", id("graph-announcement"));
  await id("custom-order-reset").click();

  await showView(page, "zoom");
  const layout = id("layout-picker");
  const root = graph.locator('.react-flow__node[data-id="hm-anboahmdemo"]');
  const task = graph.locator(`.react-flow__node[data-id="${taskFlow}"]`);
  await capture.clip("arrange-core", async () => {
    await layout.selectOption("dagre-lr");
    // Check the painted orientation. The select changes before the layout worker responds.
    await expect.poll(async () => {
      const parent = await root.boundingBox();
      const child = await task.boundingBox();
      return parent && child && child.x > parent.x + parent.width;
    }).toBe(true);
    await id("edge-style-picker").selectOption("right-angle");
    await capture.step("left-to-right", id("graph-announcement"));
    const position = await task.getAttribute("style");
    await layout.selectOption("elk-radial");
    await expect(task).not.toHaveAttribute("style", position!);
    await capture.step("radial", id("graph-announcement"));
  });
  await layout.selectOption("dagre-tb");
  await id("edge-style-picker").selectOption("smooth");
  await id("health-filter-toggle").click();
  const popup = id("health-filter-popup");
  await popup.getByRole("radio", { name: "Gray dot" }).check();
  await popup.getByRole("checkbox", { name: "Healthy", exact: true }).uncheck();
  await capture.step("filters", popup.getByText("Show entities that are", { exact: true }));
  await popup.getByRole("checkbox", { name: "Healthy", exact: true }).check();
  await popup.getByRole("radio", { name: "Hide with their lines" }).check();
  await page.keyboard.press("Escape");

  await showView(page, "outline");
  const desktop = page.viewportSize()!;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await id("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(id("view-select")).toBeVisible();
    await capture.step("mobile", id("outline-summary"));
  } finally {
    await page.setViewportSize(desktop);
    if (await page.locator("html").getAttribute("data-theme") === "dark") await id("theme-toggle").click();
  }

  await showView(page, "zoom");
  await capture.clip("find-storage", async () => {
    if (await id("card-signals-toggle").getAttribute("aria-pressed") !== "true") await id("card-signals-toggle").click();
    await id("search-open").click();
    await id("search-input").fill("session-storage");
    const match = page.locator('[role="option"][id="entity:session-storage"]');
    await capture.step("search", match, { shot: id("search-overlay") });
    await match.click();
    await expect(id("tl-close")).toBeVisible();
    const focused = graph.locator('.react-flow__node[data-id="session-storage"] .entity-node');
    await expect(focused).toBeInViewport({ ratio: 0.8 });
    await expect(page.locator('[data-testid="tl-label-entity"][data-row="session-storage"][data-focused="true"]').first()).toBeVisible();
    await capture.step("storage-focus", focused.locator(".entity-node__name"));
  }, "apng");
}
