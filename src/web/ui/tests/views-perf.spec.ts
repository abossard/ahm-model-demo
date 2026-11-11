import { test } from "@playwright/test";
import { installStubs } from "./fixture";
import { openView } from "./views";
import { denseIncidentModel } from "./viewModels";

// How long a click takes to reach a painted frame on the 81-entity model: layout plus render. Timing notes, not
// assertions (a bound flakes on a loaded machine). Off unless VIZ_PERF is set:
//   VIZ_PERF=1 npx playwright test tests/views-perf.spec.ts --reporter=list
test.skip(!process.env["VIZ_PERF"], "set VIZ_PERF=1 to measure");
test.use({ viewport: { width: 1440, height: 900 } });

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

async function toFrame(page: import("@playwright/test").Page, selector: string): Promise<number> {
  return page.evaluate(async (target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (!element) throw new Error(`no ${target}`);
    const start = performance.now();
    element.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, selector);
}

test("switching views and opening chips on 81 entities", async ({ page }) => {
  await installStubs(page, { healthModelFails: false, model: denseIncidentModel() });
  await openView(page, "cause");
  await page.getByTestId("cause-view").waitFor();
  await page.waitForTimeout(1500);
  const samples: Record<string, number[]> = { "cause to coverage": [], "coverage to cause": [], "cause to semantic zoom": [], "semantic zoom to cause": [], "open chip": [], "close chip": [] };
  for (let round = 0; round < 5; round += 1) {
    samples["cause to coverage"]!.push(await toFrame(page, '[data-testid="view-tab-coverage"]'));
    await page.waitForTimeout(400);
    samples["coverage to cause"]!.push(await toFrame(page, '[data-testid="view-tab-cause"]'));
    await page.waitForTimeout(900);
    samples["open chip"]!.push(await toFrame(page, '[data-testid="cause-chip"]:not([data-open])'));
    await page.waitForTimeout(500);
    samples["close chip"]!.push(await toFrame(page, '[data-testid="cause-chip"][data-open="true"]'));
    await page.waitForTimeout(500);
    samples["cause to semantic zoom"]!.push(await toFrame(page, '[data-testid="view-tab-zoom"]'));
    await page.waitForTimeout(1500);
    samples["semantic zoom to cause"]!.push(await toFrame(page, '[data-testid="view-tab-cause"]'));
    await page.waitForTimeout(900);
  }
  for (const [name, values] of Object.entries(samples)) console.log(`PERF ${name}: median ${median(values).toFixed(1)} ms of ${values.map((value) => value.toFixed(0)).join(", ")}`);
});
