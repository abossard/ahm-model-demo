import { expect, type Page } from "@playwright/test";
import type { Capture } from "../capture";
import { coreDesignTarget, coreHistory, coreModel, coreTarget, coreUrl } from "./replay";
import { installExampleTopic, topic } from "./scenario";

export async function workspace(page: Page, capture: Capture): Promise<void> {
  const { stub, asOf } = await installExampleTopic(page, coreModel, coreHistory, coreTarget);
  await page.goto(coreUrl + "&view=zoom");
  const pane = page.getByTestId("session-workspace");
  const menu = page.getByTestId("task-menu");
  await expect(page.getByTestId("topology").locator(".react-flow__node").first()).toBeVisible();
  await menu.click();
  await page.getByTestId("menu-tour").click();
  const tour = page.getByTestId("assistant-tour");
  const title = tour.getByTestId("tour-stop-title");
  await expect(title).toHaveText("Meet your model");
  const diagram = tour.frameLocator('iframe[title="Interactive health model diagram"]').getByTestId("health-model-diagram");
  await expect(diagram.getByRole("button").first()).toBeVisible();
  await capture.step("ask-tour", title);
  await tour.getByRole("button", { name: "Trace a dependency" }).click();
  await expect(page.locator(".react-flow__edge-path[data-show-me-highlight]")).toBeInViewport();
  await capture.step("ask-branch", title);
  await tour.getByRole("button", { name: "End tour" }).click();

  await page.getByTestId("workspace-toggle").click();
  await page.getByTestId(`session-open-${topic}`).click();
  await page.getByTestId("task-open-1").click();
  const answer = page.getByTestId("explain-result");
  await expect(answer).toBeVisible();
  const shareLink = page.url();
  await expect(page).toHaveURL(/[?&]session=core-incident&task=1/);
  await capture.clip("follow-evidence", async () => {
    await capture.step("explain", page.getByTestId("result-heading"));
    const show = pane.locator('[data-show-me-handle="timeline"]').first();
    await show.click();
    const lane = page.locator('#timeline-panel [data-show-me-highlight][data-focused="true"]').first();
    await expect(lane).toBeInViewport();
    await expect(page.getByTestId("moment-bar")).toBeVisible();
    expect(Date.parse(new URL(page.url()).searchParams.get("at")!)).toBe(Date.parse(asOf));
    await capture.step("show-evidence", page.getByTestId("moment-shown"));
    await answer.getByRole("button", { name: "Find the web app on the graph" }).click();
    await expect(page.locator('.react-flow__node[data-id="container-app"][data-show-me-highlight]')).toBeInViewport();
    await capture.step("answer-choices", answer.getByRole("group", { name: "Where next?" }).getByRole("button").last());
  }, "apng");
  await page.getByTestId("task-tab-timeline").click();
  await page.getByTestId("timeline-details-2").click();
  await capture.step("activity", page.getByTestId("timeline-popover-2").getByText("Technical details", { exact: true }));
  await page.keyboard.press("Escape");
  await page.goto(shareLink);
  await expect(page.getByTestId("explain-result")).toBeVisible();
  await page.getByTestId("task-back").click();
  await capture.step("topic", page.getByTestId("session-title-heading"), { shot: pane });

  await menu.click();
  await page.getByTestId("menu-review").click();
  await expect(page.getByTestId("diff-result")).toBeVisible();
  await page.getByTestId("change-expand-c1").click();
  await expect(page.getByTestId("change-details-c1")).toBeVisible();
  await capture.step("review", page.getByTestId("change-details-c1").getByText("Session blob storage", { exact: true }), { shot: pane });
  await capture.clip("approve-change", async () => {
    await page.getByTestId("change-select-c1").click();
    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("compare-view")).toBeVisible();
    await expect(page.getByTestId("graph-proposed").locator('.entity-node[data-entity="session-storage"]')).toHaveAttribute("data-badge", "changed");
    await capture.step("compare", page.getByTestId("compare-title"));
    await page.getByTestId("apply-button").click();
    const dialog = page.getByTestId("apply-dialog");
    await expect(dialog).toContainText(coreTarget.name);
    await capture.step("approve", dialog.getByRole("heading"), { shot: dialog });
    await page.getByTestId("apply-confirm").click();
    const receipt = page.getByTestId("apply-result");
    await expect(receipt).toHaveAttribute("data-outcome", "applied");
    expect(stub.applies.at(-1)?.changeIds).toEqual(["c1"]);
    await capture.step("apply-receipt", receipt, { shot: pane });
  });

  await page.getByTestId("compare-exit").click();
  await menu.click();
  await page.getByTestId("menu-design").click();
  await expect(page.getByTestId("task-target")).toHaveValue(`${coreDesignTarget.name} (${coreTarget.resourceGroup})`);
  await page.getByTestId("task-repository").fill("https://github.com/abossard/ahm-model-demo");
  await capture.step("design-workload", page.getByTestId("task-type-description"), { shot: pane });
  await page.getByTestId("workspace-close").click();
  await page.getByRole("link", { name: "Create new health model" }).click();
  const builder = page.frameLocator('iframe[title="Health model builder"]');
  await expect(builder.getByRole("heading", { name: "Select Azure resources" })).toBeVisible();
}
