import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { healthModel, installStubs, liveShapeModel, wideHealthModel } from "./fixture";
import { denseModel } from "./denseModel";
import { portViolations } from "./portOrder";
import type { HealthModel } from "../src/model/types";

// The lines of a card leave and arrive at points ordered like the cards at their other ends, so none
// of them cross each other where they meet the card: in every layout, style and connection policy.

const MODELS: readonly (readonly [string, HealthModel])[] = [
  ["the fixture model", healthModel],
  ["a root with eight children", wideHealthModel],
  ["the live model", liveShapeModel],
  ["a dense model", denseModel(6, 14, 20)],
];

const STATIC_LAYOUTS = ["dagre-tb", "dagre-bt", "dagre-lr", "dagre-rl", "elk-layered", "elk-radial", "d3-force"] as const;
const STYLES = ["smooth", "rounded", "right-angle"] as const;
const POLICIES = ["with-layout", "free", "lr", "rl", "tb", "bt"] as const;

async function open(page: Page, model: HealthModel): Promise<void> {
  await installStubs(page, { healthModelFails: false, model });
  await page.goto("/?view=zoom");
  await page.waitForSelector(".react-flow__node .entity-node");
  await page.waitForTimeout(500);
}

async function choose(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).selectOption(value);
  await page.waitForTimeout(450);
}

function relationshipsOf(model: HealthModel): { id: string; from: string; to: string }[] {
  return model.relationships.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName }));
}

for (const [name, model] of MODELS) {
  test(`edge ports follow the order of the cards they connect to: ${name}, in every layout`, async ({ page }) => {
    test.setTimeout(240_000);
    await open(page, model);
    const edges = relationshipsOf(model);

    for (const layout of STATIC_LAYOUTS) {
      await choose(page, "layout-picker", layout);
      for (const policy of ["with-layout", "free"] as const) {
        await choose(page, "connection-policy-picker", policy);
        expect(await portViolations(page, edges), `${layout}, ${policy}`).toEqual([]);
      }
    }
  });

  test(`edge ports follow the order of the cards they connect to: ${name}, in every style and policy`, async ({ page }) => {
    test.setTimeout(240_000);
    await open(page, model);
    const edges = relationshipsOf(model);

    for (const layout of ["dagre-tb", "dagre-lr"] as const) {
      await choose(page, "layout-picker", layout);
      for (const style of STYLES) {
        await choose(page, "edge-style-picker", style);
        for (const policy of POLICIES) {
          await choose(page, "connection-policy-picker", policy);
          expect(await portViolations(page, edges), `${layout}, ${style}, ${policy}`).toEqual([]);
        }
      }
    }
  });
}

test("edge ports keep their order when the graph is zoomed out to name pills and dots", async ({ page }) => {
  const model = wideHealthModel;
  await open(page, model);
  const edges = relationshipsOf(model);
  const pane = (await page.locator(".react-flow__pane").boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);

  const seen = new Set<string>();
  for (const level of ["card", "pill", "dot"]) {
    const target = level === "card" ? 0.5 : level === "pill" ? 0.3 : 0.2;
    for (let step = 0; step < 40; step += 1) {
      const zoom = await page.evaluate(() => Number(/scale\((-?[\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1] ?? 1));
      if (zoom <= target + 0.01) break;
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(250);
    const shown = (await page.getByTestId("topology").locator(".entity-node").first().getAttribute("data-lod")) ?? "card";
    seen.add(shown);
    expect(await portViolations(page, edges), `at the ${shown} level`).toEqual([]);
  }
  expect([...seen].sort()).toEqual(expect.arrayContaining(["dot", "pill"]));
});
