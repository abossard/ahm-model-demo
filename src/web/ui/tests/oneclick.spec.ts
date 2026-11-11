import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";
import { SUBSCRIPTION_A } from "./fixture";
import { MODEL_QUERY, boot, node, openWorkspace, workspace } from "./workspaceHelpers";
import {
  OTHER_USERS_TASK,
  REFUSALS,
  SESSION_ID,
  TARGET,
  defaultScript,
  reviewDiff,
  reviewEvents,
  reviewResult,
  sessionSummary,
  taskOf,
  type StubScript,
  type WorkspaceOptions,
} from "./workspaceStub";

// One click starts a Task: the Session it needs is found or made, the Task runs with its Activity timeline in view,
// and the result opens by itself. Everything here runs on the stubbed API, which keeps the Sessions it was asked for.

const HELD_EXPLAIN: StubScript = { ...defaultScript("explain"), hold: 3 };
const TITLE = /^Why is Service C Unhealthy\? \(\d{1,2} \w{3} \d{2}:\d{2}\)$/;
// While it runs the question names no state; the answer names it.
const EXPLAIN_TITLE = /^Why is Service C (Unhealthy|in this state)\?$/;
const CHAIN = ["svc-c", "svc-b", "svc-a"];
const now = (): string => new Date().toISOString();

async function pick(page: Page, name = "svc-c"): Promise<void> {
  await node(page, "topology", name).click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
}

const runningElsewhere = (): WorkspaceOptions => ({
  sessions: [sessionSummary({ id: "s-other", title: "Other work", taskCount: 1, lastTaskAt: now() })],
  tasks: [{ task: taskOf(1, { sessionId: "s-other", status: "running", createdAt: now() }), script: OTHER_USERS_TASK }],
});

test.describe("one click on Explain this entity", () => {
  test("starts the Explain, shows its timeline while it runs and opens the explanation by itself", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await page.getByTestId("explain-entity").click();

    // No other click: the Session is made, the Task runs and its Activity timeline is in view.
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("timeline-live")).toBeVisible();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await expect(page.getByTestId("task-waiting")).toContainText("This usually takes about a minute.");
    await expect(page.getByTestId("session-title-heading")).toHaveText(TITLE);
    expect(stub.posts).toHaveLength(1);
    expect(stub.posts[0]?.body).toEqual({ type: "explain", target: { ...TARGET, entity: "svc-c" }, instruction: "" });
    expect(stub.sessions).toHaveLength(1);

    stub.release(1, "s-1");
    // The explanation is what the user sees: summary, state, cause chain, and the chain is marked on the graph.
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("result-heading")).toContainText("Service B's queue is past its threshold");
    await expect(page.getByTestId("explain-state")).toContainText("Unhealthy");
    await expect(page.getByTestId("explain-chain").getByRole("listitem")).toHaveCount(3);
    for (const name of CHAIN) await expect(node(page, "topology", name)).toHaveAttribute("data-chain", "true");
    await expect(page.getByTestId("result-heading")).toHaveText(/^Service C is unhealthy because/);
    await expect(page.getByTestId("result-heading")).toBeFocused();
    await expect(page.getByTestId("timeline-log")).toContainText("Answer ready. Service C is unhealthy because");
  });

  test("the Session and the Task are real: listed, with every tool call in the timeline, and still there after a reload", async ({ page }) => {
    const stub = await boot(page);
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("explain-result")).toBeVisible();

    // The Session list holds the Session the click made, with its Task.
    await page.getByTestId("task-back").click();
    await page.getByTestId("session-back").click();
    await expect(page.getByTestId("session-open-s-1")).toContainText("Why is Service C Unhealthy?");
    await expect(page.getByTestId("session-open-s-1")).toContainText("1 question");
    expect(stub.emptySessions()).toEqual([]);

    // The full Activity timeline of the Task, tool calls included.
    await page.getByTestId("session-open-s-1").click();
    await page.getByTestId("task-open-1").click();
    await page.getByTestId("task-tab-timeline").click();
    await expect(page.locator("[data-testid^=timeline-event-]")).toHaveCount(4);
    await expect(page.getByTestId("timeline-event-2")).toHaveAttribute("data-kind", "tool_call");
    await expect(page.getByTestId("timeline-event-3")).toHaveAttribute("data-kind", "tool_result");
    await expect(page.getByTestId("timeline-event-4")).toHaveAttribute("data-kind", "result");
    expect(new URL(page.url()).searchParams.get("session")).toBe("s-1");
    expect(new URL(page.url()).searchParams.get("task")).toBe("1");

    // The address is a link to the same Task.
    await page.reload();
    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("session-title-heading")).toHaveText(TITLE);
    for (const name of CHAIN) await expect(node(page, "topology", name)).toHaveAttribute("data-chain", "true");
  });

  test("answers the click at once: the button is busy and the workspace says what it is doing", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    const release = stub.holdStarts();
    const button = page.getByTestId("explain-entity");
    await button.click();

    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button).toHaveText("Asking the assistant");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("launch-starting")).toContainText("Asking the assistant: Why is Service C Unhealthy?");
    await expect(page.getByTestId("launch-log")).toHaveText("Asking the assistant: Why is Service C Unhealthy?");
    // A second click while it starts starts nothing more.
    await button.click({ force: true });
    expect(stub.posts).toHaveLength(1);

    release();
    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    await expect(button).toHaveText("Show what the assistant is doing");
    await expect(page.getByTestId("launch-starting")).toHaveCount(0);
  });

  test("goes into the open Session when it has no running Task, and makes no new Session", async ({ page }) => {
    const options: WorkspaceOptions = {
      sessions: [sessionSummary({ taskCount: 1, lastTaskAt: "2026-11-10T10:01:00Z" })],
      tasks: [{ task: taskOf(1), script: { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: reviewDiff() } } }],
    };
    const stub = await boot(page, options, `/?${MODEL_QUERY}&session=${SESSION_ID}`);
    await expect(page.getByTestId("task-list")).toBeVisible();
    await pick(page);
    await page.getByTestId("explain-entity").click();

    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    expect(stub.posts.map((post) => post.sessionId)).toEqual([SESSION_ID]);
    expect(stub.sessions).toHaveLength(1);
    // The way back leads to the Task list of that Session, where both Tasks are.
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("task-row-1")).toBeVisible();
    await expect(page.getByTestId("task-row-2")).toBeVisible();
  });

  test("works on a model that is not the catalog default", async ({ page }) => {
    const stub = await boot(page, {}, `/?model=hm-payments&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`);
    await expect(page.getByTestId("model-name")).not.toHaveText("Health Pulse");
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("explain-result")).toBeVisible();
    expect(stub.posts[0]?.body.target).toEqual({ name: "hm-payments", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" });
  });

  test("starts from the keyboard and moves focus to the Task, then to the result", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await page.getByTestId("explain-entity").focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    await expect(page.getByTestId("task-title")).toBeFocused();
    stub.release(1, "s-1");
    await expect(page.getByTestId("result-heading")).toBeFocused();
  });

  test("leaves focus where the user put it while the Task runs", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await page.getByTestId("model-picker-search").focus();

    stub.release(1, "s-1");
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("model-picker-search")).toBeFocused();
  });

  test("with the workspace closed, a toast says the result is ready and shows it", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
    await expect(page.getByTestId("workspace-running")).toBeVisible();

    stub.release(1, "s-1");
    await expect(page.getByTestId("task-toast")).toContainText("Explanation ready");
    await expect(page.getByTestId("workspace-finished")).toBeVisible();
    await expect(page.getByTestId("workspace-toggle")).toHaveAttribute("aria-label", "History, an answer is ready");
    await page.getByTestId("task-toast-show").click();
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("workspace-finished")).toHaveCount(0);
  });

  test("a Task the user left while it ran is still followed, and its end is told", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await page.getByTestId("task-back").click();
    await page.getByTestId("session-back").click();
    await expect(page.getByTestId("session-list")).toBeVisible();

    // Nobody follows its stream now, so the app is asked for it every few seconds.
    stub.release(1, "s-1");
    await expect(page.getByTestId("task-toast")).toContainText("Explanation ready", { timeout: 20_000 });
    await page.getByTestId("task-toast-show").click();
    await expect(page.getByTestId("explain-result")).toBeVisible();
  });

  test("while the Explain runs, the button opens it, and the instruction link is gone", async ({ page }) => {
    await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("task-list")).toBeVisible();
    await expect(page.getByTestId("explain-add-instruction")).toHaveCount(0);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
  });
});

test.describe("Review and Design", () => {
  test("Review this model from the top bar starts at once in a Session made for it", async ({ page }) => {
    const stub = await boot(page);
    await page.getByTestId("task-menu").click();
    await page.getByTestId("menu-review").click();

    await expect(page.getByTestId("task-title")).toHaveText("Check hm-demo");
    await expect(page.getByTestId("diff-result")).toBeVisible();
    await expect(page.getByTestId("result-heading")).toHaveText("5 proposed changes");
    await expect(page.getByTestId("session-title-heading")).toHaveText(/^Check hm-demo \(\d{1,2} \w{3} \d{2}:\d{2}\)$/);
    expect(stub.posts[0]?.body).toEqual({ type: "review", target: TARGET, instruction: "" });
  });

  test("the top bar menu is reachable from the keyboard and says what needs an entity", async ({ page }) => {
    const stub = await boot(page);
    await page.getByTestId("task-menu").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("menu-explain")).toBeDisabled();
    await expect(page.getByTestId("menu-explain")).toContainText("Select an entity first");
    await page.keyboard.press("Escape");

    await pick(page);
    await page.getByTestId("task-menu").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("menu-explain")).toHaveText(/Why is Service C Unhealthy\?/);
    await page.getByTestId("menu-explain").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    expect(stub.posts).toHaveLength(1);
  });

  test("Review this model from the Session list", async ({ page }) => {
    const stub = await boot(page, { sessions: [sessionSummary()] });
    await openWorkspace(page);
    await page.getByTestId("start-review").click();
    await expect(page.getByTestId("task-title")).toHaveText("Check hm-demo");
    // The list had a Session of its own, and the click made another one rather than putting the Task in it.
    expect(stub.sessions).toHaveLength(2);
    expect(stub.posts[0]?.sessionId).toBe("s-2");
  });

  test("Design a model opens its form, and the Session is made when the form is sent", async ({ page }) => {
    const stub = await boot(page);
    await page.getByTestId("task-menu").click();
    await page.getByTestId("menu-design").click();

    await expect(page.getByTestId("new-task-view")).toBeVisible();
    await expect(page.getByTestId("task-type-design")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("task-target")).toHaveValue("hm-demo-design (rg-demo)");
    expect(stub.sessions).toHaveLength(0);

    await page.getByTestId("task-repository").fill("https://github.com/contoso/orders");
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("task-title")).toHaveText("Design for contoso/orders");
    await expect(page.getByTestId("diff-result")).toBeVisible();
    expect(stub.sessions).toHaveLength(1);
    await expect(page.getByTestId("session-title-heading")).toHaveText(/^Design for contoso\/orders \(\d{1,2} \w{3} \d{2}:\d{2}\)$/);
  });

  test("Design asks nothing before the form: going back from it makes no Session", async ({ page }) => {
    const stub = await boot(page);
    await page.getByTestId("task-menu").click();
    await page.getByTestId("menu-design").click();
    await page.getByTestId("session-back").click();
    await expect(page.getByTestId("session-list-view")).toBeVisible();
    expect(stub.sessions).toHaveLength(0);
  });
});

test.describe("when the start cannot go ahead", () => {
  test("a Task of the user runs in another Session: it is named, nothing is made, and Open it opens it", async ({ page }) => {
    const stub = await boot(page, runningElsewhere());
    await pick(page);
    await page.getByTestId("explain-entity").click();

    const message = page.getByTestId("task-start-error");
    await expect(message).toHaveAttribute("data-code", "task_running");
    await expect(message).toContainText("The assistant is already working on something");
    expect(stub.posts).toEqual([]);
    expect(stub.sessions).toHaveLength(1);
    expect(stub.emptySessions()).toEqual([]);

    await page.getByTestId("open-running-task").click();
    await expect(page.getByTestId("session-title-heading")).toHaveText("Other work");
    await expect(page.getByTestId("task-title")).toHaveText("Check hm-demo");
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "running");
  });

  test("a second click while a Task runs in the open Session posts nothing and offers to show it", async ({ page }) => {
    const stub = await boot(
      page,
      { sessions: [sessionSummary({ taskCount: 1, lastTaskAt: now() })], tasks: [{ task: taskOf(1, { status: "running", createdAt: now() }), script: OTHER_USERS_TASK }] },
      `/?${MODEL_QUERY}&session=${SESSION_ID}`,
    );
    await expect(page.getByTestId("task-list")).toBeVisible();
    await pick(page);
    await page.getByTestId("explain-entity").click();

    const message = page.getByTestId("task-start-error");
    await expect(message).toContainText("The assistant is already working on something");
    await expect(page.getByTestId("open-running-task")).toBeVisible();
    expect(stub.posts).toEqual([]);
    await page.getByTestId("open-running-task").click();
    await expect(page.getByTestId("task-title")).toHaveText("Check hm-demo");
    await expect(page.getByTestId("task-start-error")).toHaveCount(0);
  });

  test("agents_busy keeps the intention and the Session, and Try again starts in that Session", async ({ page }) => {
    // The timeline that the first pick opens shares the column with the graph: a taller window keeps the next card in reach.
    await page.setViewportSize({ width: 1280, height: 1000 });
    const stub = await boot(page);
    stub.startRefusals.push(REFUSALS.agentsBusy);
    await pick(page);
    await page.getByTestId("explain-entity").click();

    const message = page.getByTestId("task-start-error");
    await expect(message).toHaveAttribute("data-code", "agents_busy");
    await expect(message).toContainText("The assistant is busy");
    await expect(message).toContainText("is saved in History as");
    await expect(page.getByTestId("session-title-heading")).toHaveText(TITLE);
    expect(stub.emptySessions()).toHaveLength(1);
    await expect(page.getByTestId("explain-entity")).toHaveText("Why is this Unhealthy?");

    // Another entity is selected by then, and the Explain still asks about the one that was clicked.
    await node(page, "topology", "svc-a").click();
    await page.getByTestId("task-start-retry").click();
    await expect(page.getByTestId("task-title")).toHaveText(EXPLAIN_TITLE);
    expect(stub.posts.map((post) => post.sessionId)).toEqual(["s-1", "s-1"]);
    expect(stub.posts[1]?.body.target.entity).toBe("svc-c");
    expect(stub.sessions).toHaveLength(1);
    expect(stub.emptySessions()).toEqual([]);
  });

  test("a Session the app cannot make says so, makes no Task and offers the list", async ({ page }) => {
    const stub = await boot(page);
    stub.sessionRefusals.push(REFUSALS.sessionLimit);
    await pick(page);
    await page.getByTestId("explain-entity").click();

    await expect(page.getByTestId("task-start-error")).toContainText("No room for another topic");
    await expect(page.getByTestId("launch-view")).toBeVisible();
    expect(stub.posts).toEqual([]);
    await page.getByTestId("task-start-sessions").click();
    await expect(page.getByTestId("session-list-view")).toBeVisible();
  });

  test("a sign-in that ended is named and offers to sign in again", async ({ page }) => {
    const stub = await boot(page);
    stub.sessionRefusals.push({ status: 401, code: "unauthenticated", message: "Sign in.", retryable: false });
    await pick(page);
    await page.getByTestId("explain-entity").click();

    await expect(page.getByTestId("task-start-error")).toContainText("You are signed out");
    await expect(page.getByTestId("task-start-sign-in")).toBeVisible();
    expect(stub.posts).toEqual([]);
  });

  test("dismissing the notice leaves the workspace as it was and the button ready", async ({ page }) => {
    const stub = await boot(page);
    stub.sessionRefusals.push(REFUSALS.sessionLimit);
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await page.getByTestId("launch-dismiss").click();
    await expect(page.getByTestId("task-start-error")).toHaveCount(0);
    await expect(page.getByTestId("explain-entity")).toBeEnabled();
  });
});

test.describe("on a phone", () => {
  test("one click ends on the explanation in the sheet, which fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await boot(page);
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("explain-result")).toBeVisible();
    const fits = await workspace(page).evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(fits).toBe(true);
    await page.getByTestId("explain-step-focus-1").click();
    await expect(workspace(page)).toBeHidden();
    await expect(node(page, "topology", "svc-b")).toHaveAttribute("data-highlighted", "true");
  });
});

// Evidence for review: the flow in both themes and on a phone. Not assertions of pixels.
const evidenceDir = resolve("../../../.playwright-mcp/ux");

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) });
}

for (const theme of ["light", "dark"] as const) {
  test(`evidence of the one click flow, ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    await shot(page, `after-1-entity-panel-${theme}`);
    const release = stub.holdStarts();
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("launch-starting")).toBeVisible();
    await shot(page, `after-2-starting-${theme}`);
    release();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await shot(page, `after-3-running-${theme}`);
    stub.release(1, "s-1");
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await shot(page, `after-4-result-${theme}`);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`evidence of the refusal and the notification, ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const stub = await boot(page, runningElsewhere());
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("task-start-error")).toBeVisible();
    await shot(page, `after-5-task-running-${theme}`);
    await page.getByTestId("open-running-task").click();
    await expect(page.getByTestId("task-title")).toBeVisible();
    await page.getByTestId("workspace-close").click();
    stub.release(1, "s-other");
    await expect(page.getByTestId("task-toast")).toBeVisible();
    await shot(page, `after-6-toast-${theme}`);
  });
}

test("evidence of the Session list, the Design form, a busy app and a failed Task", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const stub = await boot(page, {
    sessions: [sessionSummary({ taskCount: 1, lastTaskAt: "2026-11-10T10:01:00Z" }), sessionSummary({ id: "s-old", title: "Explain Session Storage, 10 Nov 09:12", taskCount: 2, lastTaskAt: "2026-11-10T09:20:00Z" })],
    tasks: [{ task: taskOf(1), script: { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: reviewDiff() } } }],
  });
  await openWorkspace(page);
  await shot(page, "after-10-session-list-light");
  await page.getByTestId("start-design").click();
  await expect(page.getByTestId("new-task-view")).toBeVisible();
  await shot(page, "after-11-design-form-light");
  await page.getByTestId("session-back").click();
  stub.startRefusals.push(REFUSALS.agentsBusy);
  await page.getByTestId("start-review").click();
  await expect(page.getByTestId("task-start-error")).toBeVisible();
  await shot(page, "after-12-agents-busy-light");
});

test("evidence of the flow on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
  await pick(page);
  await shot(page, "after-7-phone-panel-light");
  await page.getByTestId("explain-entity").click();
  await expect(page.getByTestId("timeline-event-3")).toBeVisible();
  await shot(page, "after-8-phone-running-light");
  stub.release(1, "s-1");
  await expect(page.getByTestId("explain-result")).toBeVisible();
  await shot(page, "after-9-phone-result-light");
});
