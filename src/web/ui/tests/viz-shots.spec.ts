import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { openCompare } from "./compareHelpers";
import { installStubs } from "./fixture";
import { MODEL_QUERY, SESSION_WITH_TASK } from "./workspaceHelpers";
import { SESSION_ID, catalogWithDesign, installWorkspace } from "./workspaceStub";
import { openView } from "./views";
import { calmModel, denseIncidentModel, incidentModel } from "./viewModels";
import type { HealthModel } from "../src/model/types";
import type { ViewId } from "../src/model/views";

// Screenshots of every view on every fixture, in light and dark, for looking at. Off unless VIZ_SHOTS is set:
//   VIZ_SHOTS=1 npx playwright test tests/viz-shots.spec.ts
const OUT = fileURLToPath(new URL("../../../../.playwright-mcp/viz-app/", import.meta.url));
const READY: Readonly<Record<string, string>> = { cause: "cause-view", zoom: "topology", coverage: "coverage-view", swimlanes: "swimlanes-view", tidy: "tidy-view", outline: "outline-view" };

test.skip(!process.env["VIZ_SHOTS"], "set VIZ_SHOTS=1 to take the screenshots");
test.use({ viewport: { width: 1440, height: 900 } });

const MODELS: readonly (readonly [string, () => HealthModel])[] = [
  ["incident", incidentModel],
  ["dense", denseIncidentModel],
  ["healthy", calmModel],
];
const VIEWS = (process.env["VIZ_VIEWS"] ?? "cause,zoom,coverage").split(",") as readonly ViewId[];

for (const theme of ["light", "dark"] as const) {
  for (const view of VIEWS) {
    for (const [scenario, model] of MODELS) {
      test(`${view} ${scenario} ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await installStubs(page, { healthModelFails: false, model: model() });
        await openView(page, view);
        await page.getByTestId(READY[view] ?? "topology").waitFor();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${OUT}${view}-${scenario}-${theme}.png` });
        if (view === "zoom" && scenario === "incident") {
          // The same model zoomed out until its cards are name pills, then dots.
          const pane = (await page.locator(".react-flow__pane").boundingBox())!;
          await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
          for (const wanted of ["pill", "dot"]) {
            for (let step = 0; step < 30 && (await page.locator(`.entity-node[data-lod="${wanted}"]`).count()) === 0; step += 1) {
              await page.mouse.wheel(0, 120);
              await page.waitForTimeout(80);
            }
            await page.waitForTimeout(500);
            await page.screenshot({ path: `${OUT}zoom-incident-${wanted}s-${theme}.png` });
          }
        }
      });
    }
  }
  for (const view of ["swimlanes", "tidy", "cause", "zoom", "outline", "coverage"] as const) {
    test(`compare ${view} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openCompare(page, view);
      // Close the workspace so the two sides, or the one drawing, have the width a viewer has.
      await page.getByTestId("workspace-close").click();
      await page.waitForTimeout(1400);
      await page.screenshot({ path: `${OUT}compare-${view}-${theme}.png` });
    });
  }
  test(`compare diff ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign });
    await installWorkspace(page, SESSION_WITH_TASK());
    await openView(page, "zoom", `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await page.getByTestId("diff-result").waitFor();
    await page.getByTestId("compare-toggle").click();
    await page.getByTestId("compare-view").waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}compare-diff-${theme}.png` });
  });
}
