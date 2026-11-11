import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openCompare } from "./compareHelpers";
import { designDiff } from "./workspaceStub";
import type { ViewId } from "../src/model/views";

/**
 * Compare is the selected view drawing both sides of a diff: twice, on a shared arrangement, for
 * Semantic zoom, Tidy arrange and Swimlanes; once, over everything either side has, for Cause path,
 * Outline and Coverage. The diff is the one `diffViewModel()` describes on the incident model: Report
 * Queue and Pager Webhook added, Web Container App and AI Inference changed (App Hosting is touched
 * by the new relationship), Discovered Application Topology removed.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const SPLIT = ["zoom", "tidy", "swimlanes"] as const satisfies readonly ViewId[];
const MERGED = ["cause", "outline", "coverage"] as const satisfies readonly ViewId[];

/** One entity as the view draws it, inside `scope`. */
const THING: Readonly<Record<(typeof SPLIT)[number] | (typeof MERGED)[number], (name: string) => string>> = {
  zoom: (name) => `.entity-node[data-entity="${name}"]`,
  tidy: (name) => `[data-testid="tidy-tile"][data-entity="${name}"]`,
  swimlanes: (name) => `[data-testid="swim-card"][data-entity="${name}"]`,
  cause: (name) => `[data-testid="cause-node"][data-entity="${name}"]`,
  outline: (name) => `[data-testid="outline-row"][data-kind="entity"][data-entity="${name}"]`,
  coverage: (name) => `[data-testid="coverage-cell"][data-entity="${name}"]`,
};

const thing = (page: Page, view: keyof typeof THING, side: string, name: string): Locator => page.getByTestId(`compare-side-${side}`).locator(THING[view](name));

/** Where React Flow put a node, in the flow's own coordinates, so two sides with their own zoom compare. */
async function flowPosition(page: Page, side: string, name: string): Promise<{ x: number; y: number }> {
  return page
    .getByTestId(`compare-side-${side}`)
    .locator(`.react-flow__node[data-id="${name}"]`)
    .evaluate((item) => {
      const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((item as HTMLElement).style.transform);
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    });
}

test.describe("views that draw Base and Proposed side by side", () => {
  for (const view of SPLIT) {
    test.describe(view, () => {
      test("draws each side with what it has, marked on the side the change exists on", async ({ page }) => {
        await openCompare(page, view);
        await expect(page.getByTestId("compare-view")).toHaveAttribute("data-mode", "split");
        await expect(page.getByTestId("compare-side-merged")).toHaveCount(0);

        await expect(thing(page, view, "base", "discovered-app-topology")).toHaveAttribute("data-badge", "removed");
        await expect(thing(page, view, "base", "report-queue")).toHaveCount(0);
        await expect(thing(page, view, "base", "pager-webhook")).toHaveCount(0);
        await expect(thing(page, view, "base", "container-app")).toHaveAttribute("data-badge", "changed");

        await expect(thing(page, view, "proposed", "report-queue")).toHaveAttribute("data-badge", "added");
        await expect(thing(page, view, "proposed", "pager-webhook")).toHaveAttribute("data-badge", "added");
        await expect(thing(page, view, "proposed", "discovered-app-topology")).toHaveCount(0);
        for (const name of ["container-app", "system-ai-inference", "system-app-hosting"]) {
          await expect(thing(page, view, "proposed", name)).toHaveAttribute("data-badge", "changed");
        }
        for (const mark of ["added", "changed", "removed"]) await expect(page.getByTestId(`legend-${mark}`)).toBeVisible();
      });

      test("puts an entity both sides have in the same place on both", async ({ page }) => {
        await openCompare(page, view);
        await expect(thing(page, view, "proposed", "report-queue")).toBeVisible();
        const names = ["hm-contosodemo", "system-app-hosting", "container-app", "session-storage", "system-ai-inference"];
        // The layout may settle a moment after the first paint: wait for the two sides to agree, or fail with both.
        await expect
          .poll(async () => {
            const places: string[] = [];
            for (const name of names) {
              const base = await flowPosition(page, "base", name);
              const proposed = await flowPosition(page, "proposed", name);
              places.push(base.x === proposed.x && base.y === proposed.y ? "same" : `${name}: base ${base.x},${base.y} proposed ${proposed.x},${proposed.y}`);
            }
            return places;
          })
          .toEqual(names.map(() => "same"));
      });

      test("a click on an entity ticks its changes, a ticked change marks its entity on both sides, a second click unticks", async ({ page }) => {
        await openCompare(page, view);
        await thing(page, view, "proposed", "report-queue").click();
        await expect(page.getByTestId("change-select-c1")).toBeChecked();
        await expect(page.getByTestId("change-select-c2")).toBeChecked();
        await expect(thing(page, view, "proposed", "report-queue")).toHaveAttribute("data-marked", "true");
        // The relationship names App Hosting too: it is marked on both sides.
        await expect(thing(page, view, "proposed", "system-app-hosting")).toHaveAttribute("data-marked", "true");
        await expect(thing(page, view, "base", "system-app-hosting")).toHaveAttribute("data-marked", "true");
        // While comparing a click means "these changes": the entity panel stays shut.
        await expect(page.getByTestId("entity-details")).toHaveCount(0);

        await thing(page, view, "proposed", "report-queue").click();
        await expect(page.getByTestId("change-select-c1")).not.toBeChecked();
        await expect(thing(page, view, "proposed", "report-queue")).not.toHaveAttribute("data-marked", "true");

        await page.getByTestId("change-select-c6").click();
        await expect(thing(page, view, "base", "discovered-app-topology")).toHaveAttribute("data-marked", "true");
        await expect(thing(page, view, "base", "container-app")).not.toHaveAttribute("data-marked", "true");
      });

      test("leaving Compare returns to the same view", async ({ page }) => {
        await openCompare(page, view);
        await page.getByTestId("compare-exit").click();
        await expect(page.getByTestId("compare-view")).toHaveCount(0);
        await expect(page.getByTestId(`view-tab-${view}`)).toHaveAttribute("aria-selected", "true");
        await expect(page.locator(THING[view]("session-storage")).first()).toBeVisible();
      });
    });
  }

  for (const view of ["tidy", "swimlanes"] as const) {
    test(`${view} says which side has no entities when a Design compares with an empty model`, async ({ page }) => {
      const errors: string[] = [];
      // The live stream of the model on screen is not stubbed here; a 404 for it is not what this test is about.
      page.on("console", (message) => message.type() === "error" && !message.location().url.includes("/api/health-model/stream") && errors.push(message.text()));
      page.on("pageerror", (error) => errors.push(String(error)));
      await openCompare(page, view, designDiff());
      await expect(page.getByTestId("compare-side-base")).toContainText("Model now: no entities.");
      await expect(page.getByTestId("compare-side-proposed")).not.toContainText("has no entities");
      await expect(thing(page, view, "proposed", "web")).toHaveAttribute("data-badge", "added");
      expect(errors).toEqual([]);
    });
  }
});

test.describe("views that draw both sides once", () => {
  for (const view of MERGED) {
    test.describe(view, () => {
      test("draws everything either side has, each added, changed or removed entity with its mark", async ({ page }) => {
        await openCompare(page, view);
        await expect(page.getByTestId("compare-view")).toHaveAttribute("data-mode", "merged");
        await expect(page.getByTestId("compare-side-merged")).toBeVisible();
        await expect(page.getByTestId("compare-side-base")).toHaveCount(0);
        await expect(page.getByTestId("compare-side-proposed")).toHaveCount(0);

        for (const [name, mark] of [
          ["report-queue", "added"],
          ["pager-webhook", "added"],
          ["container-app", "changed"],
          ["system-ai-inference", "changed"],
          ["discovered-app-topology", "removed"],
        ] as const) {
          await expect(thing(page, view, "merged", name), name).toHaveAttribute("data-badge", mark);
        }
        for (const mark of ["added", "changed", "removed"]) await expect(page.getByTestId(`legend-${mark}`)).toBeVisible();
      });

      test("a click on an entity ticks its changes, a ticked change marks its entity, a second click unticks", async ({ page }) => {
        await openCompare(page, view);
        await thing(page, view, "merged", "report-queue").click();
        await expect(page.getByTestId("change-select-c1")).toBeChecked();
        await expect(thing(page, view, "merged", "report-queue")).toHaveAttribute("data-marked", "true");
        await expect(page.getByTestId("entity-details")).toHaveCount(0);

        await thing(page, view, "merged", "report-queue").click();
        await expect(page.getByTestId("change-select-c1")).not.toBeChecked();
        await expect(thing(page, view, "merged", "report-queue")).not.toHaveAttribute("data-marked", "true");

        await page.getByTestId("change-select-c5").click();
        await expect(thing(page, view, "merged", "system-ai-inference")).toHaveAttribute("data-marked", "true");
        await expect(thing(page, view, "merged", "container-app")).not.toHaveAttribute("data-marked", "true");
      });

      test("leaving Compare returns to the same view", async ({ page }) => {
        await openCompare(page, view);
        await page.getByTestId("compare-exit").click();
        await expect(page.getByTestId("compare-view")).toHaveCount(0);
        await expect(page.getByTestId(`view-tab-${view}`)).toHaveAttribute("aria-selected", "true");
      });
    });
  }

  test("Cause path draws what the diff touches with the way up to the root, and folds the healthy rest into chips", async ({ page }) => {
    await openCompare(page, "cause");
    await expect(page.getByTestId("cause-compare")).toContainText("6 entities are added, changed or removed");
    await expect(page.getByTestId("cause-calm")).toHaveCount(0);
    // A healthy part the diff leaves alone is not drawn: it sits behind a chip.
    await expect(thing(page, "cause", "merged", "foundry-account")).toHaveCount(0);
    await expect(page.getByTestId("cause-chip").first()).toContainText("healthy");
    // A changed part is at least a card, with its mark, and its path to the root is drawn.
    await expect(thing(page, "cause", "merged", "container-app")).toHaveAttribute("data-kind", "card");
    await expect(thing(page, "cause", "merged", "system-app-hosting")).toBeVisible();
    await expect(thing(page, "cause", "merged", "hm-contosodemo")).toBeVisible();
    // What was failing before still is: the diff is no reason to hide it.
    await expect(thing(page, "cause", "merged", "session-storage")).toHaveAttribute("data-state", "Unhealthy");
  });

  test("Outline shows the removed entity struck through and opens the rows above every changed one", async ({ page }) => {
    await openCompare(page, "outline");
    const removed = thing(page, "outline", "merged", "discovered-app-topology");
    await expect(removed.getByTestId("outline-badge")).toHaveText(/Removed/);
    await expect(removed.getByTestId("outline-name")).toHaveCSS("text-decoration-line", "line-through");
    await expect(thing(page, "outline", "merged", "report-queue").getByTestId("outline-badge")).toHaveText(/Added/);
    await expect(thing(page, "outline", "merged", "container-app")).toBeVisible();
  });

  test("Coverage draws a cell once with its mark, and the keyboard ticks the changes of the focused cell", async ({ page }) => {
    await openCompare(page, "coverage");
    await expect(thing(page, "coverage", "merged", "report-queue").getByTestId("coverage-badge")).toHaveAttribute("data-badge", "added");
    await expect(thing(page, "coverage", "merged", "discovered-app-topology").getByTestId("coverage-badge")).toHaveAttribute("data-badge", "removed");
    await thing(page, "coverage", "merged", "container-app").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("change-select-c4")).toBeChecked();
    await expect(thing(page, "coverage", "merged", "container-app")).toHaveAttribute("data-marked", "true");
  });
});

test.describe("the view switch while comparing", () => {
  test("stays enabled, and changing the view keeps Compare on and shows the other view's way of drawing it", async ({ page }) => {
    await openCompare(page, "zoom");
    await expect(page.getByTestId("compare-view")).toHaveAttribute("data-mode", "split");
    for (const view of ["coverage", "swimlanes", "cause", "tidy", "outline", "zoom"] as const) {
      const tab = page.getByTestId(`view-tab-${view}`);
      await expect(tab).toBeEnabled();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("compare-toggle")).toBeChecked();
      await expect(page.getByTestId("compare-view")).toHaveAttribute("data-mode", MERGED.includes(view as (typeof MERGED)[number]) ? "merged" : "split");
      await expect(page.locator(`[data-testid^="compare-side-"]`).first()).toBeVisible();
    }
    await expect(page).toHaveURL(/session=/);
  });

  test("keeps the ticked changes when the view changes", async ({ page }) => {
    await openCompare(page, "tidy");
    await thing(page, "tidy", "proposed", "report-queue").click();
    await expect(page.getByTestId("change-select-c1")).toBeChecked();
    await page.getByTestId("view-tab-coverage").click();
    await expect(page.getByTestId("change-select-c1")).toBeChecked();
    await expect(thing(page, "coverage", "merged", "report-queue")).toHaveAttribute("data-marked", "true");
  });
});

test.describe("Compare in the selected view, on a phone", () => {
  for (const [view, side, least] of [["tidy", "base", 300], ["outline", "merged", 200]] as const) {
    test(`${view} is not squeezed away`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await openCompare(page, view);
      await page.getByTestId("workspace-close").click();
      const box = (await page.getByTestId(`compare-side-${side}`).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(least);
    });
  }
});
