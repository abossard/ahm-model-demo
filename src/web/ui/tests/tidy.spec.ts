import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import { MODEL_QUERY, openWorkspace } from "./workspaceHelpers";
import { SESSION_ID, explainEvents, installWorkspace, sessionSummary, taskOf } from "./workspaceStub";
import { openView } from "./views";
import { calmModel, denseIncidentModel, incidentModel } from "./viewModels";
import { contrastOf, incidentExplain, stubEntityDetails, underServedPolicy } from "./viewSupport";
import type { HealthModel } from "../src/model/types";

test.use({ viewport: { width: 1440, height: 900 } });

async function show(page: Page, model: HealthModel = incidentModel(), query = ""): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await stubEntityDetails(page, model);
  await openView(page, "tidy", query === "" ? "/" : `/?${query}`);
  await expect(page.getByTestId("tidy-view")).toBeVisible();
  await page.getByTestId("tidy-tile").first().waitFor();
  // The first fit lands at once; give React Flow a frame to apply it.
  await page.waitForTimeout(300);
}

/** A pick opens the timeline, which takes room from the graph and has it fit that room: open it first, so that only the pick is under test. */
async function openTimeline(page: Page): Promise<void> {
  await page.getByTestId("timeline-toggle").click();
  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await page.waitForTimeout(900);
}

const tile = (page: Page, name: string): Locator => page.locator(`[data-testid="tidy-tile"][data-entity="${name}"]`);

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where React Flow put every node in layout space, so the viewport's zoom and pan do not skew it. */
async function flowRects(page: Page): Promise<Record<string, Rect>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".react-flow__node")].map((node) => {
        const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform);
        return [node.dataset["id"] ?? "", { x: Number(match?.[1]), y: Number(match?.[2]), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }];
      }),
    ),
  );
}

async function viewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform);
    return { x: Number(match?.[1]), y: Number(match?.[2]), zoom: Number(match?.[3]) };
  });
}

/** Names of the entities a line passes through, other than its own two: sampled along the drawn path. */
async function linesThroughTiles(page: Page, model: HealthModel, rects: Record<string, Rect>): Promise<string[]> {
  const pairs = model.relationships.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName }));
  return page.evaluate(
    ({ pairs, rects }) => {
      const found: string[] = [];
      for (const { id, from, to } of pairs) {
        const path = document.querySelector<SVGPathElement>(`[data-testid="rf__edge-${id}"] .react-flow__edge-path`);
        if (!path) {
          found.push(`${id} is not drawn`);
          continue;
        }
        const length = path.getTotalLength();
        for (let at = 0; at <= length; at += 3) {
          const point = path.getPointAtLength(at);
          for (const [name, rect] of Object.entries(rects)) {
            if (name === from || name === to) continue;
            if (point.x > rect.x + 1 && point.x < rect.x + rect.width - 1 && point.y > rect.y + 1 && point.y < rect.y + rect.height - 1) found.push(`${id} through ${name}`);
          }
        }
      }
      return [...new Set(found)];
    },
    { pairs, rects },
  );
}

test.describe("Tidy arrange", () => {
  test("draws every entity as one tile of one size, with a parent centred over its only child", async ({ page }) => {
    await show(page);
    await expect(page.getByTestId("tidy-tile")).toHaveCount(17);
    const rects = await flowRects(page);
    for (const rect of Object.values(rects)) expect([rect.width, rect.height]).toEqual([216, 76]);
    const centre = (name: string): number => rects[name]!.x + rects[name]!.width / 2;
    expect(centre("system-session-store")).toBeCloseTo(centre("session-storage"), 0);
    expect(rects["hm-contosodemo"]!.y).toBeLessThan(rects["flow-run-agent-tasks"]!.y);
    expect(rects["flow-run-agent-tasks"]!.y).toBeLessThan(rects["system-session-store"]!.y);
    await expect(tile(page, "session-storage")).toHaveAttribute("data-state", "Unhealthy");
    await expect(tile(page, "session-storage")).toContainText("Session Storage");
  });

  test.describe("lines", () => {
    for (const [name, model] of [["incident", incidentModel()], ["dense", denseIncidentModel()]] as const) {
      test(`run through no tile in the ${name} model, and every relationship has one`, async ({ page }) => {
        await show(page, model);
        if (name === "dense") await page.getByTestId("tidy-fold-all").click();
        await page.waitForTimeout(400);
        await expect(page.locator(".react-flow__edge")).toHaveCount(name === "dense" ? model.relationships.length + (await page.getByTestId("tidy-fold").count()) : model.relationships.length);
        expect(await linesThroughTiles(page, model, await flowRects(page))).toEqual([]);
      });
    }

    test("carry the relationship's label as a pill clear of every tile", async ({ page }) => {
      await show(page);
      const pills = page.locator(".react-flow__edge-textbg");
      expect(await pills.count()).toBeGreaterThan(10);
      const rects = await flowRects(page);
      const overlaps = await page.evaluate((nodes) => {
        const found: string[] = [];
        for (const pill of document.querySelectorAll<SVGRectElement>(".react-flow__edge-textbg")) {
          const x = Number(pill.getAttribute("x"));
          const y = Number(pill.getAttribute("y"));
          const width = Number(pill.getAttribute("width"));
          const height = Number(pill.getAttribute("height"));
          for (const [name, rect] of Object.entries(nodes)) if (x < rect.x + rect.width && rect.x < x + width && y < rect.y + rect.height && rect.y < y + height) found.push(name);
        }
        return found;
      }, rects);
      expect(overlaps).toEqual([]);
    });

    test("meet a child at spread points when it has several parents", async ({ page }) => {
      const model = incidentModel();
      await show(page, model);
      const ids = model.relationships.filter((item) => item.childEntityName === "system-app-hosting").map((item) => item.name);
      expect(ids.length).toBeGreaterThan(1);
      const ends = await page.evaluate((names) => names.map((id) => {
        const path = document.querySelector<SVGPathElement>(`[data-testid="rf__edge-${id}"] .react-flow__edge-path`)!;
        const end = path.getPointAtLength(path.getTotalLength());
        return { x: end.x, y: end.y };
      }), ids);
      const rect = (await flowRects(page))["system-app-hosting"]!;
      for (const end of ends) expect(end.y).toBeCloseTo(rect.y, 0);
      expect(new Set(ends.map((end) => Math.round(end.x))).size).toBe(ends.length);
    });
  });

  test("frames the part that is not connected to the root, and says so", async ({ page }) => {
    await show(page);
    const shelf = page.getByTestId("tidy-shelf");
    await expect(shelf).toHaveCount(1);
    await expect(shelf).toContainText("Not connected to the root");
    const frame = (await shelf.boundingBox())!;
    const inside = async (name: string): Promise<boolean> => {
      const box = (await tile(page, name).boundingBox())!;
      return box.x >= frame.x && box.y >= frame.y && box.x + box.width <= frame.x + frame.width && box.y + box.height <= frame.y + frame.height;
    };
    expect(await inside("discover-app-insights")).toBe(true);
    expect(await inside("hm-contosodemo")).toBe(false);
  });

  test("draws a dot grid behind the tiles", async ({ page }) => {
    await show(page);
    await expect(page.locator(".react-flow__background pattern circle, .react-flow__background pattern path").first()).toBeAttached();
  });

  test("opens the entity panel on a click, and rings the selected tile", async ({ page }) => {
    await show(page);
    await tile(page, "session-storage").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await expect(page.getByTestId("entity-name")).toHaveText("Session Storage");
    await expect(tile(page, "session-storage")).toHaveAttribute("data-selected", "true");
    await expect(tile(page, "session-storage")).toHaveAttribute("aria-current", "true");
  });

  test("does not move anything when a tile is selected", async ({ page }) => {
    await show(page);
    await openTimeline(page);
    const before = await flowRects(page);
    const zoom = await viewport(page);
    await tile(page, "hosted-agent").click();
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await page.waitForTimeout(600);
    expect(await flowRects(page)).toEqual(before);
    expect((await viewport(page)).zoom).toBeCloseTo(zoom.zoom, 5);
  });

  test("lists the tiles in rank order, so Tab and Enter reach and open each one", async ({ page }) => {
    await show(page);
    const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="tidy-tile"]')].map((element) => ({ name: element.dataset["entity"], y: Math.round(element.getBoundingClientRect().top), x: element.getBoundingClientRect().left })));
    const sorted = [...order].sort((a, b) => a.y - b.y || a.x - b.x).map((item) => item.name);
    // Rows are rank rows: within a row, order by x; rows follow each other from the top.
    const rowsInOrder = order.every((item, index) => index === 0 || item.y >= order[index - 1]!.y - 1);
    expect(rowsInOrder).toBe(true);
    expect(order.map((item) => item.name)).toEqual(sorted);

    await tile(page, order[0]!.name!).focus();
    const visited: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("Tab");
      visited.push(await page.evaluate(() => (document.activeElement as HTMLElement).dataset["entity"] ?? (document.activeElement as HTMLElement).dataset["testid"] ?? ""));
    }
    const expected = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="tidy-tile"], [data-testid="tidy-collapse"], [data-testid="tidy-fold"]')].slice(1, 7).map((element) => element.dataset["entity"] ?? element.dataset["testid"] ?? ""));
    expect(visited).toEqual(expected);

    await tile(page, "session-storage").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await expect(page.getByTestId("entity-name")).toHaveText("Session Storage");
  });

  test("brings a tile into view when keyboard focus reaches one that is off screen", async ({ page }) => {
    await show(page, denseIncidentModel());
    const target = tile(page, "res-func-nightly");
    await expect(target).toBeAttached();
    // Opens on the first problem; the far corner of the model is not on screen.
    const far = tile(page, "res-law-core");
    await far.focus();
    await page.waitForTimeout(900);
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const box = (await far.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.y).toBeGreaterThanOrEqual(pane.y);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
    expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);
    expect(await page.evaluate(() => document.querySelector(".react-flow")!.scrollLeft)).toBe(0);
  });

  test("brings a search result into view, and shows it as a tile even when it was folded into a count", async ({ page }) => {
    await show(page, denseIncidentModel());
    const leaf = ((await page.locator('[data-testid="tidy-fold"]:not([data-open])').first().getAttribute("title")) ?? "").split(", ")[0]!;
    await expect(tile(page, leaf)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("search-input").fill(leaf.replace(/^res-/, ""));
    await page.keyboard.press("Enter");
    await expect(tile(page, leaf)).toHaveAttribute("data-highlighted", "true");
    await page.waitForTimeout(1000);
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const box = (await tile(page, leaf).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
    expect(box.y).toBeGreaterThanOrEqual(pane.y);
    expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);
  });

  test("does not move the graph under a click on a tile that is half off the screen", async ({ page }) => {
    await show(page, denseIncidentModel());
    await openTimeline(page);
    const edge = tile(page, "res-func-nightly");
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const box = (await edge.boundingBox())!;
    // Drag the graph until the tile's left 100 px are outside the pane.
    const [startX, startY] = [pane.x + pane.width - 30, pane.y + 60];
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + (pane.x - 100 - box.x), startY, { steps: 6 });
    await page.mouse.up();
    const clipped = (await edge.boundingBox())!;
    expect(clipped.x).toBeLessThan(pane.x);
    const before = await viewport(page);
    await page.mouse.click(pane.x + 40, clipped.y + 30);
    await page.waitForTimeout(800);
    expect(await viewport(page)).toEqual(before);
    await expect(page.getByTestId("entity-details")).toBeVisible();
    await expect(edge).toHaveAttribute("data-selected", "true");
  });

  test("marks an open Explain result's chain, numbered from its last entity", async ({ page }) => {
    const model = incidentModel();
    await installStubs(page, { healthModelFails: false, model });
    await stubEntityDetails(page, model);
    await installWorkspace(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "hm-contosodemo" }, result: incidentExplain() }), script: { events: explainEvents(), outcome: { status: "done", result: incidentExplain() } } }],
    });
    await openView(page, "tidy", `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    for (const [name, step] of [["session-storage", 1], ["system-session-store", 2], ["flow-run-agent-tasks", 3], ["hm-contosodemo", 4]] as const) {
      await expect(tile(page, name)).toHaveAttribute("data-step", String(step));
      await expect(tile(page, name)).toHaveAttribute("aria-label", new RegExp(`step ${step} of the chain`));
    }
    await expect(tile(page, "hosted-agent")).not.toHaveAttribute("data-step", /.+/);
    await expect(page.getByTestId("tidy-step")).toHaveCount(4);
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("tidy-step")).toHaveCount(0);
  });

  test("follows the Health filter: hides the states that are not selected, or draws them faint", async ({ page }) => {
    await show(page);
    await page.getByTestId("health-filter-toggle").click();
    await page.getByRole("checkbox", { name: "Healthy", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="tidy-tile"][data-state="Healthy"]')).toHaveCount(0);
    await expect(page.getByTestId("tidy-tile")).toHaveCount(10);

    await page.getByTestId("health-filter-toggle").click();
    await page.getByRole("radio", { name: "Gray dot" }).check();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tidy-tile")).toHaveCount(17);
    await expect(page.locator('[data-testid="tidy-tile"][data-dimmed="true"]')).toHaveCount(7);
  });

  test("shares the collapse state with the card graph: a collapsed tile hides what is below it and says how many", async ({ page }) => {
    await show(page);
    const toggle = page.locator('[data-testid="tidy-collapse"][aria-label="Collapse Run agent tasks"]');
    await toggle.click();
    await expect(tile(page, "system-session-store")).toHaveCount(0);
    await expect(page.locator('[data-testid="tidy-collapse"][aria-label^="Expand Run agent tasks, "]')).toBeVisible();
    await expect(page.getByTestId("graph-announcement")).toContainText("Run agent tasks collapsed");
    await page.getByTestId("view-tab-zoom").click();
    await expect(page.locator('.entity-node[data-entity="flow-run-agent-tasks"] [data-testid="collapse-toggle"]')).toHaveAttribute("aria-expanded", "false");
  });

  test("shows a model with nothing wrong as every entity, without folds", async ({ page }) => {
    await show(page, calmModel());
    await expect(page.getByTestId("tidy-tile")).toHaveCount(17);
    await expect(page.getByTestId("tidy-fold")).toHaveCount(0);
    await expect(page.getByTestId("tidy-fit")).toBeVisible();
  });

  test("fits the whole model on open and again when the side panel changes the room", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, model: incidentModel() });
    await installWorkspace(page, {});
    await openView(page, "tidy");
    await page.getByTestId("tidy-tile").first().waitFor();
    await page.waitForTimeout(500);
    const inside = async (): Promise<void> => {
      const pane = (await page.locator(".react-flow").boundingBox())!;
      for (const box of await page.getByTestId("tidy-tile").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as Rect))) {
        expect(box.x).toBeGreaterThanOrEqual(pane.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(pane.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
      }
    };
    await inside();
    const before = await viewport(page);
    await openWorkspace(page);
    await page.waitForTimeout(1000);
    await inside();
    expect((await viewport(page)).zoom).toBeLessThan(before.zoom);
  });

  test("moves at once, not by animation, when the viewer prefers reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await show(page, denseIncidentModel());
    await page.getByTestId("tidy-fit").click();
    await page.waitForTimeout(80);
    const soon = await viewport(page);
    await page.waitForTimeout(900);
    expect(await viewport(page)).toEqual(soon);
  });

  test.describe("on a model with 81 entities", () => {
    test("opens on the first problem and folds healthy leaves into count tiles; Fit shows all of it", async ({ page }) => {
      await show(page, denseIncidentModel());
      const folds = await page.getByTestId("tidy-fold").count();
      expect(folds).toBeGreaterThan(5);
      const tiles = await page.getByTestId("tidy-tile").count();
      expect(tiles).toBeLessThan(81 - folds);

      // Opened on a failing leaf and its parent, at a size that reads.
      const opened = await viewport(page);
      expect(opened.zoom).toBeGreaterThan(0.6);
      const pane = (await page.locator(".react-flow").boundingBox())!;
      const problem = (await page.locator('[data-entity="res-sql-orders"], [data-entity="res-func-nightly"]').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as Rect))).filter((box) => box.x >= pane.x && box.x + box.width <= pane.x + pane.width && box.y >= pane.y && box.y + box.height <= pane.y + pane.height);
      expect(problem.length).toBeGreaterThan(0);

      await page.getByTestId("tidy-fit").click();
      await page.waitForTimeout(900);
      const fitted = await viewport(page);
      expect(fitted.zoom).toBeLessThan(opened.zoom / 2);
      const rects = await flowRects(page);
      const width = Math.max(...Object.values(rects).map((rect) => rect.x + rect.width)) - Math.min(...Object.values(rects).map((rect) => rect.x));
      console.log(`TIDY dense folded: ${Object.keys(rects).length} nodes, ${Math.round(width)} px wide, fits at zoom ${fitted.zoom.toFixed(2)}`);
      expect(width).toBeLessThan(10_000);

      await page.getByTestId("tidy-problem").click();
      await page.waitForTimeout(900);
      expect((await viewport(page)).zoom).toBeGreaterThan(0.6);
    });

    test("opens a count tile in place, and folds it again with its chip", async ({ page }) => {
      await show(page, denseIncidentModel());
      const fold = page.locator('[data-testid="tidy-fold"]:not([data-open])').first();
      const parent = (await fold.getAttribute("data-fold"))!;
      await expect(fold).toHaveAttribute("aria-label", /healthy entities under .* are folded: .*\. Show them/);
      // Focus brings the tile on screen; Enter opens it.
      await fold.focus();
      await page.keyboard.press("Enter");
      const chip = page.locator(`[data-testid="tidy-fold"][data-fold="${parent}"]`);
      await expect(chip).toHaveAttribute("data-open", "true");
      await expect(chip).toContainText(/Fold \d+ healthy/);
      await chip.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(`[data-testid="tidy-fold"][data-fold="${parent}"]`)).not.toHaveAttribute("data-open", "true");
    });

    test("shows every healthy leaf on request: 81 tiles and no fold left closed", async ({ page }) => {
      await show(page, denseIncidentModel());
      await page.getByTestId("tidy-fold-all").click();
      await expect(page.getByTestId("tidy-tile")).toHaveCount(81);
      await expect(page.locator('[data-testid="tidy-fold"]:not([data-open])')).toHaveCount(0);
      await expect(page.getByTestId("tidy-fold-all")).toHaveText("Fold healthy leaves");
    });

    test("keeps the selected entity a tile even when it is a folded leaf", async ({ page }) => {
      await show(page, denseIncidentModel());
      const fold = page.locator('[data-testid="tidy-fold"]:not([data-open])').first();
      const leaf = ((await fold.getAttribute("title")) ?? "").split(", ")[0]!;
      await expect(tile(page, leaf)).toHaveCount(0);
      await page.getByTestId("tidy-fold-all").click();
      await tile(page, leaf).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("entity-details")).toBeVisible();
      await page.getByTestId("tidy-fold-all").click();
      await expect(tile(page, leaf)).toHaveCount(1);
      await expect(tile(page, leaf)).toHaveAttribute("data-selected", "true");
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`reads at AA in ${theme}: names, quiet text and chips against their tiles`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await show(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const name of ["session-storage", "hosted-agent", "container-app", "discovered-app-topology"]) {
        const card = tile(page, name);
        expect(await contrastOf(card.locator("span").nth(1)), `${name} name`).toBeGreaterThanOrEqual(4.5);
      }
      expect(await contrastOf(tile(page, "system-session-store").getByTestId("tidy-impact")), "impact chip").toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(tile(page, "system-session-store").getByText("rolls up", { exact: true })), "quiet text").toBeGreaterThanOrEqual(4.5);
    });
  }

  test("raises no Content-Security-Policy violation, in both themes, with folds, collapse and selection in play", async ({ page, baseURL }) => {
    const violations = await underServedPolicy(page, new URL(baseURL!).origin);
    await show(page, denseIncidentModel());
    await page.locator('[data-testid="tidy-tile"][data-state="Unhealthy"][data-entity^="res-"]').first().click();
    await page.locator('[data-testid="tidy-fold"]').first().focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="tidy-collapse"][aria-label="Collapse Batch jobs"]').focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("theme-toggle").click();
    await page.waitForTimeout(400);
    expect(violations).toEqual([]);
  });
});
