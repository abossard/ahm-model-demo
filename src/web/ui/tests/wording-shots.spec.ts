import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";
import { MODEL_QUERY, SESSION_WITH_TASK, boot, node, openWorkspace } from "./workspaceHelpers";
import { REFUSALS, SESSION_ID, defaultScript, sessionSummary, type StubScript } from "./workspaceStub";

// Evidence for review of the wording: the same screens before and after the pass. Run with WORDING_PHASE=before against a
// build from before it to take the first set. Not assertions of pixels.
const phase = process.env["WORDING_PHASE"] ?? "after";
const evidenceDir = resolve("../../../.playwright-mcp/ux");
const HELD_EXPLAIN: StubScript = { ...defaultScript("explain"), hold: 3 };

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(evidenceDir, `wording-${phase}-${name}.png`) });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
});

test("the entity panel, History, the Ask menu and a refusal", async ({ page }) => {
  const stub = await boot(page, { sessions: [sessionSummary({ title: "Why is Service C Unhealthy? (10 Nov 10:00)", taskCount: 1, lastTaskAt: "2026-11-10T10:01:00Z" })] });
  await node(page, "topology", "svc-c").click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
  await shot(page, "1-entity-panel");
  await page.getByTestId("task-menu").click();
  await expect(page.getByTestId("menu-review")).toBeVisible();
  await shot(page, "2-ask-menu");
  await page.keyboard.press("Escape");
  await openWorkspace(page);
  await shot(page, "3-history");
  stub.startRefusals.push(REFUSALS.agentsBusy);
  await page.getByTestId("explain-entity").click();
  await expect(page.getByTestId("task-start-error")).toBeVisible();
  await shot(page, "4-busy");
});

test("a running question and its answer", async ({ page }) => {
  const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
  await node(page, "topology", "svc-c").click();
  await page.getByTestId("explain-entity").click();
  await expect(page.getByTestId("timeline-event-3")).toBeVisible();
  await shot(page, "5-running");
  stub.release(1, "s-1");
  await expect(page.getByTestId("explain-result")).toBeVisible();
  await shot(page, "6-answer");
  await page.getByTestId("task-tab-timeline").click();
  await shot(page, "7-what-the-assistant-did");
});

test("the proposed changes and the Apply confirmation", async ({ page }) => {
  await boot(page, SESSION_WITH_TASK(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
  await expect(page.getByTestId("diff-result")).toBeVisible();
  await page.getByTestId("change-select-c3").click();
  await page.getByTestId("change-expand-c1").click();
  await shot(page, "8-proposed-changes");
  await page.getByTestId("apply-button").click();
  await expect(page.getByTestId("apply-dialog")).toBeVisible();
  await shot(page, "9-apply-confirmation");
});
