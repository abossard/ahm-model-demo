import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";
import {
  HELD_REVIEW,
  MODEL_QUERY,
  SESSION_WITH_TASK,
  boot,
  node,
  openDiffTask,
  openForm,
} from "./workspaceHelpers";
import {
  OTHER_USERS_TASK,
  SESSION_ID,
  at,
  errorEnvelope,
  explainEvents,
  explainResult,
  reviewDiff,
  reviewEvents,
  reviewResult,
  sessionSummary,
  taskOf,
  type WorkspaceOptions,
} from "./workspaceStub";
import { SUBSCRIPTION_A } from "./fixture";

// Light and dark screenshots of the Session workspace. They are evidence for review, not assertions of pixels.
const evidenceDir = resolve("../../../.playwright-mcp/workspace");
const THEMES = ["light", "dark"] as const;

async function shot(page: Page, name: string, theme: string): Promise<void> {
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(evidenceDir, `${name}-${theme}.png`) });
}

const explained = (): WorkspaceOptions => ({
  sessions: [sessionSummary({ taskCount: 1 })],
  tasks: [
    {
      task: taskOf(1, {
        type: "explain",
        target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" },
        result: explainResult(),
        createdAt: at(0),
      }),
      script: { events: explainEvents(), outcome: { status: "done", result: explainResult() } },
    },
  ],
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    });

    test("a running Task in the workspace", async ({ page }) => {
      await boot(page, { sessions: [sessionSummary()], scripts: { review: HELD_REVIEW } });
      await openForm(page);
      await page.getByTestId("task-instruction-input").fill("Look at the queue first.");
      await page.getByTestId("task-submit").click();
      await expect(page.getByTestId("timeline-event-6")).toBeVisible();
      await shot(page, "running-task", theme);
    });

    test("the New task form and the Session list", async ({ page }) => {
      await boot(page, { sessions: [sessionSummary({ taskCount: 3, lastTaskAt: at(500) }), sessionSummary({ id: "s-2", title: "Payments design", taskCount: 1 })] });
      await page.getByTestId("workspace-toggle").click();
      await expect(page.getByTestId("session-list")).toBeVisible();
      await shot(page, "session-list", theme);
      await page.getByTestId(`session-open-${SESSION_ID}`).click();
      await page.getByTestId("session-tab-new").click();
      await shot(page, "task-form", theme);
    });

    test("an Explain result with the chain highlighted", async ({ page }) => {
      await boot(page, explained(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
      await expect(page.getByTestId("explain-result")).toBeVisible();
      await expect(node(page, "topology", "svc-b")).toHaveAttribute("data-chain", "true");
      await shot(page, "explain-chain", theme);
    });

    test("the diff list with a selection", async ({ page }) => {
      await openDiffTask(page, SESSION_WITH_TASK());
      await page.getByTestId("change-select-c3").click();
      await page.getByTestId("change-expand-c1").click();
      await shot(page, "diff-list", theme);
    });

    test("compare mode", async ({ page }) => {
      await openDiffTask(page, SESSION_WITH_TASK());
      await page.getByTestId("change-select-c3").click();
      await page.getByTestId("compare-toggle").click();
      await expect(page.getByTestId("graph-proposed")).toBeVisible();
      await shot(page, "compare", theme);
    });

    test("the Apply confirmation", async ({ page }) => {
      await openDiffTask(page, SESSION_WITH_TASK());
      await page.getByTestId("change-select-c3").click();
      await page.getByTestId("apply-button").click();
      await expect(page.getByTestId("apply-dialog")).toBeVisible();
      await shot(page, "apply-dialog", theme);
    });

    test("an Apply outcome", async ({ page }) => {
      await openDiffTask(page, SESSION_WITH_TASK());
      await page.getByTestId("change-select-c3").click();
      await page.getByTestId("apply-button").click();
      await page.getByTestId("apply-confirm").click();
      await expect(page.getByTestId("apply-result")).toBeVisible();
      await shot(page, "apply-result", theme);
    });
  });
}

test("a phone shows the workspace as a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await boot(page, { sessions: [sessionSummary()], scripts: { review: HELD_REVIEW } });
  await openForm(page);
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("timeline-event-6")).toBeVisible();
  await shot(page, "phone-running-task", "light");
});

test.describe("more states, light theme", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  });

  const done = { events: reviewEvents(), outcome: { status: "done" as const, result: reviewResult(), diff: reviewDiff() } };

  test("the Task list with a running, a done and a failed Task", async ({ page }) => {
    await boot(page, {
      sessions: [sessionSummary({ taskCount: 3 })],
      tasks: [
        { task: taskOf(1, { createdAt: at(0), finishedAt: at(95) }), script: done },
        { task: taskOf(2, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" }, status: "failed", error: { code: "agent_timeout", message: "The agent did not answer in time." }, createdAt: at(100), finishedAt: at(400) }), script: { events: reviewEvents(4), outcome: { status: "failed", error: { code: "agent_timeout", message: "The agent did not answer in time." } } } },
        { task: taskOf(3, { status: "running", createdAt: new Date(Date.now() - 72_000).toISOString() }), script: OTHER_USERS_TASK },
      ],
    });
    await page.getByTestId("workspace-toggle").click();
    await page.getByTestId(`session-open-${SESSION_ID}`).click();
    await expect(page.getByTestId("task-row-3")).toBeVisible();
    await shot(page, "task-list", "light");
  });

  test("a Design form with a repository that is not on GitHub, and a start that lost the race", async ({ page }) => {
    const stub = await boot(page, { sessions: [sessionSummary()] });
    await openForm(page);
    await page.getByTestId("task-type-design").click();
    await page.getByTestId("task-repository").fill("https://example.com/owner/repo");
    await shot(page, "design-form-error", "light");
    await page.getByTestId("task-repository").fill("");
    await page.getByTestId("task-type-review").click();
    stub.conflictWith = OTHER_USERS_TASK;
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("task-start-error")).toBeVisible();
    await shot(page, "task-running-409", "light");
  });

  test("a failed Task", async ({ page }) => {
    await boot(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { status: "failed", error: { code: "agent_timeout", message: "The agent did not answer in time." }, instruction: "Check the order queue." }), script: { events: reviewEvents(4), outcome: { status: "failed", error: { code: "agent_timeout", message: "The agent did not answer in time." } } } }],
    }, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("task-failed")).toBeVisible();
    await shot(page, "task-failed", "light");
  });

  test("a partial Apply and a refused Apply", async ({ page }) => {
    const stub = await openDiffTask(page, SESSION_WITH_TASK());
    stub.applyReplies.push(
      { status: 200, body: { outcome: "partial", written: ["c2"], failed: { changeId: "c3", code: "write_failed", message: "The service rejected the entity." }, expanded: ["c2", "c3", "c4"] } },
      { status: 409, body: errorEnvelope("base_changed", "The live model changed.") },
    );
    await page.getByTestId("change-select-c3").click();
    await page.getByTestId("apply-button").click();
    await page.getByTestId("apply-confirm").click();
    await expect(page.getByTestId("apply-result")).toHaveAttribute("data-outcome", "partial");
    await shot(page, "apply-partial", "light");
    await page.getByTestId("change-select-c1").click();
    await page.getByTestId("apply-button").click();
    await page.getByTestId("apply-confirm").click();
    await expect(page.getByTestId("apply-result")).toHaveAttribute("data-outcome", "base_changed");
    await shot(page, "apply-base-changed", "light");
  });

  test("the phone: diff result and compare", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDiffTask(page, SESSION_WITH_TASK());
    await page.getByTestId("change-select-c3").click();
    await shot(page, "phone-diff", "light");
    await page.getByTestId("compare-toggle").click();
    await page.getByTestId("workspace-close").click();
    await expect(page.getByTestId("graph-proposed")).toBeVisible();
    await shot(page, "phone-compare", "light");
  });
});
