import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SUBSCRIPTION_A, healthModel, installStubs, modelCatalog } from "./fixture";
import {
  HELD_REVIEW,
  MODEL_QUERY,
  SESSION_WITH_TASK,
  boot,
  node,
  openDiffTask,
  openForm,
  openWorkspace,
  workspace,
} from "./workspaceHelpers";
import {
  OTHER_USERS_TASK,
  REFUSALS,
  SESSION_ID,
  activity,
  DESIGN_TARGET,
  at,
  designDiff,
  designEvents,
  errorEnvelope,
  installWorkspace,
  explainEvents,
  explainResult,
  longDiff,
  reviewDiff,
  reviewEvents,
  reviewResult,
  sessionSummary,
  taskOf,
  type StubScript,
  type WorkspaceOptions,
} from "./workspaceStub";

test.describe("the workspace pane", () => {
  test("starts collapsed, opens from the top bar, resizes and collapses again", async ({ page }) => {
    await boot(page);
    const toggle = page.getByTestId("workspace-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-controls", "session-workspace");
    await expect(workspace(page)).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("session-list-empty")).toBeVisible();

    const handle = page.getByTestId("workspace-resize");
    await expect(handle).toHaveAttribute("role", "separator");
    const before = Number(await handle.getAttribute("aria-valuenow"));
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", String(before + 16 + 64));
    expect((await workspace(page).boundingBox())?.width).toBeCloseTo(before + 80, 0);
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "320");

    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("resizes by dragging the separator", async ({ page }) => {
    await boot(page);
    await openWorkspace(page);
    const handle = page.getByTestId("workspace-resize");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 164, box.y + 200, { steps: 6 });
    await page.mouse.up();
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(560);
  });

  test("is a full screen sheet with a close button on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await boot(page);
    await openWorkspace(page);
    const box = (await workspace(page).boundingBox())!;
    expect(box.width).toBe(390);
    expect(box.height).toBeGreaterThanOrEqual(790);
    await expect(page.getByTestId("workspace-resize")).toBeHidden();
    await page.getByTestId("workspace-close").click();
    await expect(workspace(page)).toBeHidden();
  });
});

test.describe("Sessions", () => {
  test("lists the Sessions with their Task counts", async ({ page }) => {
    await boot(page, { sessions: [sessionSummary({ taskCount: 2, lastTaskAt: at(60) }), sessionSummary({ id: "s-2", title: "Payments design" })] });
    await openWorkspace(page);
    await expect(page.getByTestId(`session-open-${SESSION_ID}`)).toContainText("Queue review");
    await expect(page.getByTestId(`session-open-${SESSION_ID}`)).toContainText("0 Tasks");
    await expect(page.getByTestId("session-open-s-2")).toContainText("Payments design");
  });

  test("creates a Session and opens it on the form", async ({ page }) => {
    const stub = await boot(page);
    await openWorkspace(page);
    await page.getByTestId("session-title").fill("Queue review");
    await page.getByTestId("new-session").click();

    await expect(page.getByTestId("session-view")).toBeVisible();
    await expect(page.getByTestId("session-title-heading")).toHaveText("Queue review");
    await expect(page.getByTestId("task-form")).toBeVisible();
    expect(stub.sessions[0]?.title).toBe("Queue review");
    await expect(page).toHaveURL(/session=s-1/);

    await page.getByTestId("session-back").click();
    await expect(page.getByTestId("session-open-s-1")).toBeVisible();
    await expect(page).not.toHaveURL(/session=/);
  });

  test("shows a Session list that cannot load and retries", async ({ page }) => {
    await boot(page, { listFails: true });
    await openWorkspace(page);
    await expect(page.getByTestId("session-list-error")).toContainText("The Session store is unavailable.");
    await expect(page.getByTestId("session-list-retry")).toBeVisible();
  });

  test("shows a Session link that points nowhere", async ({ page }) => {
    await boot(page, {}, `/?${MODEL_QUERY}&session=gone`);
    await expect(page.getByTestId("session-error")).toContainText("The Session does not exist.");
    await page.getByTestId("session-back").click();
    await expect(page.getByTestId("session-list-view")).toBeVisible();
  });
});

test.describe("starting Tasks", () => {
  const sessions = (): WorkspaceOptions => ({ sessions: [sessionSummary()] });

  test("a Review streams its Activity timeline, then opens its result", async ({ page }) => {
    const stub = await boot(page, { ...sessions(), scripts: { review: HELD_REVIEW } });
    await openForm(page);
    await expect(page.getByTestId("task-type-review")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("task-target")).toHaveValue("hm-demo (rg-demo)");
    await page.getByTestId("task-instruction-input").fill("Look at the queue first.");
    await page.getByTestId("task-submit").click();

    expect(stub.posts).toEqual([
      {
        sessionId: SESSION_ID,
        body: { type: "review", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A }, instruction: "Look at the queue first." },
      },
    ]);
    await expect(page.getByTestId("task-title")).toHaveText("Review #1");
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("timeline-event-6")).toBeVisible();
    await expect(page.getByTestId("timeline-event-7")).toHaveCount(0);
    await expect(page.getByTestId("timeline-live")).toBeVisible();
    await expect(page).toHaveURL(/session=s-demo&task=1/);

    // A dropped connection: the browser reconnects by itself and says which event it saw last.
    stub.dropStreams(1);
    await expect.poll(() => stub.eventRequests.map((request) => request.lastEventId)).toContain("6");
    await expect(page.getByTestId("timeline-live")).toBeVisible();

    stub.release(1);
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("diff-result")).toBeVisible();
    await expect(page.getByTestId("task-tab-result")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("task-tab-timeline").click();
    await expect(page.getByTestId("timeline-event-10")).toBeVisible();
    // Nothing was shown twice: the replay of a reconnect starts after the last event seen.
    await expect(page.locator("[data-testid^=timeline-event-]")).toHaveCount(10);
  });

  test("the way back from a Task started on the form leads to the Task list, not the form", async ({ page }) => {
    await boot(page, sessions());
    await openForm(page);
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("task-title")).toHaveText("Review #1");

    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("task-list")).toBeVisible();
    await expect(page.getByTestId("task-row-1")).toBeVisible();
    await expect(page.getByTestId("task-form")).toHaveCount(0);
  });

  test("the form refuses a second Task while one runs", async ({ page }) => {
    await boot(page, { sessions: [sessionSummary({ taskCount: 1 })], tasks: [{ task: taskOf(1, { status: "running" }), script: OTHER_USERS_TASK }] });
    await openForm(page);
    await expect(page.getByTestId("task-submit")).toBeDisabled();
    await expect(page.getByTestId("task-hint")).toContainText("A Task is running in this Session");
    await page.getByTestId("show-running-task").click();
    await expect(page.getByTestId("task-title")).toHaveText("Review #1");
    await expect(page.getByTestId("workspace-running")).toBeVisible();
  });

  test("a start that loses the race shows the 409 and offers the running Task", async ({ page }) => {
    const stub = await boot(page, sessions());
    stub.conflictWith = OTHER_USERS_TASK;
    await openForm(page);
    await page.getByTestId("task-submit").click();

    const message = page.getByTestId("task-start-error");
    await expect(message).toHaveAttribute("data-code", "task_running");
    await expect(message).toContainText("A Task is already running");
    await page.getByTestId("open-running-task").click();
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "running");
  });

  test("an Explain needs a selected entity and then starts on it", async ({ page }) => {
    const stub = await boot(page, sessions());
    await openForm(page);
    await page.getByTestId("task-type-explain").click();
    await expect(page.getByTestId("task-submit")).toBeDisabled();
    await expect(page.getByTestId("task-form")).toContainText("Select an entity in the graph to explain it.");

    await node(page, "topology", "svc-c").click();
    await expect(page.getByTestId("entity-panel")).toBeVisible();
    await expect(page.getByTestId("task-entity")).toHaveValue("Service C");
    await expect(page.getByTestId("task-submit")).toBeEnabled();
    await page.getByTestId("task-submit").click();
    expect(stub.posts[0]?.body).toEqual({
      type: "explain",
      target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" },
      instruction: "",
    });
  });

  test("Explain this entity opens the workspace on a prefilled form", async ({ page }) => {
    await boot(page, sessions());
    await node(page, "topology", "svc-c").click();
    await page.getByTestId("explain-entity").click();
    await expect(workspace(page)).toBeVisible();
    await page.getByTestId(`session-open-${SESSION_ID}`).click();
    await expect(page.getByTestId("task-type-explain")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("task-entity")).toHaveValue("Service C");
  });

  test("a Design targets the design model and checks the repository", async ({ page }) => {
    const stub = await boot(page, sessions());
    await openForm(page);
    await page.getByTestId("task-type-design").click();
    await expect(page.getByTestId("task-target")).toHaveValue("hm-demo-design (rg-demo)");
    await expect(page.getByTestId("task-workload")).toHaveValue("rg-demo");

    await page.getByTestId("task-repository").fill("https://example.com/owner/repo");
    await expect(page.getByTestId("task-form")).toContainText("Enter a public repository as https://github.com/owner/repository.");
    await expect(page.getByTestId("task-submit")).toBeDisabled();

    await page.getByTestId("task-repository").fill("https://github.com/contoso/orders");
    await page.getByTestId("task-submit").click();
    expect(stub.posts[0]?.body).toEqual({
      type: "design",
      target: { name: "hm-demo-design", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A },
      workload: { resourceGroup: "rg-demo", repositoryUrl: "https://github.com/contoso/orders" },
      instruction: "",
    });
    await expect(page.getByTestId("task-title")).toHaveText("Design #1");
    await expect(page.getByTestId("diff-result")).toBeVisible();
  });

  test("the instruction stops at 2000 characters and counts them", async ({ page }) => {
    await boot(page, sessions());
    await openForm(page);
    await page.getByTestId("task-instruction-input").fill("x".repeat(2100));
    await expect(page.getByTestId("task-form")).toContainText("2000 of 2000 characters");
  });

  test("a failed Task shows its reason and can be started again", async ({ page }) => {
    await boot(page, {
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [
        {
          task: taskOf(1, { status: "failed", error: { code: "agent_timeout", message: "The agent did not answer in time." } }),
          script: { events: reviewEvents(4), outcome: { status: "failed", error: { code: "agent_timeout", message: "The agent did not answer in time." } } },
        },
      ],
    }, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("task-failed")).toContainText("The agent did not answer in time.");
    await expect(page.getByTestId("timeline-event-4")).toBeVisible();
    await page.getByTestId("task-retry").click();
    await expect(page.getByTestId("task-form")).toBeVisible();
  });
});

test.describe("Explain results", () => {
  const explained = (): WorkspaceOptions => ({
    sessions: [sessionSummary({ taskCount: 1 })],
    tasks: [
      {
        task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" }, result: explainResult() }),
        script: { events: explainEvents(), outcome: { status: "done", result: explainResult() } },
      },
    ],
  });

  test("marks the whole chain on the graph while the result is open", async ({ page }) => {
    await boot(page, explained(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("explain-state")).toContainText("Unhealthy");
    for (const name of ["svc-c", "svc-b", "svc-a"]) await expect(node(page, "topology", name)).toHaveAttribute("data-chain", "true");
    await expect(node(page, "topology", "svc-d")).not.toHaveAttribute("data-chain", "true");

    await page.getByTestId("explain-step-focus-1").click();
    await expect(node(page, "topology", "svc-b")).toHaveAttribute("data-highlighted", "true");

    await page.getByTestId("task-back").click();
    await expect(node(page, "topology", "svc-c")).not.toHaveAttribute("data-chain", "true");
  });

  test("keeps the chain marked and the view where it was while the model reloads with new states", async ({ page }) => {
    await boot(page, explained(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    for (const name of ["svc-c", "svc-b", "svc-a"]) await expect(node(page, "topology", name)).toHaveAttribute("data-chain", "true");
    const viewport = (): Promise<string> => page.locator(".react-flow__viewport").first().evaluate((element) => getComputedStyle(element).transform);
    const before = await viewport();

    const recovered = { ...healthModel, observedAt: "2026-07-30T16:30:00Z", entities: healthModel.entities.map((item) => (item.name === "svc-c" ? { ...item, healthState: "Healthy" as const } : item)) };
    await page.route("**/api/health-model*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(recovered) }));
    await page.getByTestId("refresh-now").click();

    await expect(page.getByTestId("model-observed")).toContainText("2026-07-30T16:30:00Z");
    await expect(node(page, "topology", "svc-c")).toHaveAttribute("aria-label", /Healthy/);
    for (const name of ["svc-c", "svc-b", "svc-a"]) await expect(node(page, "topology", name)).toHaveAttribute("data-chain", "true");
    await expect(page.getByTestId("explain-chain").getByRole("listitem")).toHaveCount(3);
    expect(await viewport()).toBe(before);
  });

  test("on a phone, showing a step puts the sheet away and shows the entity", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await boot(page, explained(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await page.getByTestId("explain-step-focus-1").click();
    await expect(workspace(page)).toBeHidden();
    await expect(node(page, "topology", "svc-b")).toHaveAttribute("data-highlighted", "true");
    await expect(node(page, "topology", "svc-b")).toBeInViewport();
  });

  test("says so when the result traces no cause", async ({ page }) => {
    const options = explained();
    const empty = { ...explainResult(), causes: [] };
    await boot(page, {
      ...options,
      tasks: [{ task: { ...options.tasks![0]!.task, result: empty }, script: { events: explainEvents(), outcome: { status: "done", result: empty } } }],
    }, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-no-causes")).toBeVisible();
  });

  test("offers the target model when it is not on screen", async ({ page }) => {
    await boot(page, explained(), `/?model=hm-payments&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("explain-off-screen")).toBeVisible();
    await expect(page.getByTestId("explain-step-focus-0")).toBeDisabled();
    await page.getByTestId("explain-open-target").click();
    await expect(page.getByTestId("explain-off-screen")).toHaveCount(0);
    await expect(page).toHaveURL(/model=hm-demo/);
  });
});

test.describe("Health model diffs", () => {
  test("selecting a change adds what it needs and says so", async ({ page }) => {
    await openDiffTask(page);
    await expect(page.getByTestId("diff-summary")).toContainText("Add the queue consumer");
    await expect(page.getByTestId("selection-count")).toHaveText("0 of 5 selected");
    await expect(page.getByTestId("apply-button")).toBeDisabled();
    await expect(page.getByTestId("apply-blocked")).toHaveText("Select the changes to apply.");

    await page.getByTestId("change-select-c3").click();
    await expect(page.getByTestId("selection-count")).toHaveText("1 of 5 selected");
    await expect(page.getByTestId("apply-button")).toHaveText("Apply 3 changes");
    await expect(page.getByTestId("apply-added")).toContainText("sd-queue-depth, r5");

    await page.getByTestId("change-select-c1").click();
    await expect(page.getByTestId("apply-button")).toHaveText("Apply 4 changes");
    await page.getByTestId("clear-selection").click();
    await expect(page.getByTestId("selection-count")).toHaveText("0 of 5 selected");
    await page.getByTestId("select-all").click();
    await expect(page.getByTestId("selection-count")).toHaveText("5 of 5 selected");
    await expect(page.getByTestId("apply-button")).toHaveText("Apply 5 changes");
    await expect(page.getByTestId("apply-added")).toHaveCount(0);
  });

  test("lists findings by severity and selects the changes of one", async ({ page }) => {
    await openDiffTask(page);
    const severities = await page.getByTestId("findings").locator("li").evaluateAll((items) => items.map((item) => item.getAttribute("data-severity")));
    expect(severities).toEqual(["high", "medium", "low"]);
    await page.getByTestId("finding-select-0").click();
    await expect(page.getByTestId("selection-count")).toHaveText("1 of 5 selected");
    await expect(page.getByTestId("change-select-c3")).toBeChecked();
  });

  test("groups changes by entity, shows details and verification", async ({ page }) => {
    await openDiffTask(page);
    await expect(page.getByTestId("change-group-svc-g")).toContainText("Service G");
    await expect(page.getByTestId("change-op-c3")).toHaveText("Add");
    await expect(page.getByTestId("change-op-c5")).toHaveText("Remove");
    await expect(page.getByTestId("change-needs-c3")).toContainText("Applies with: sd-queue-depth, r5");

    await page.getByTestId("change-expand-c1").click();
    await expect(page.getByTestId("change-details-c1")).toContainText("properties.displayName");
    await expect(page.getByTestId("change-details-c1")).toContainText("Service A (edge)");

    await page.getByTestId("verification-c3-failing").click();
    await expect(page.getByTestId("verification-popover-c3-failing")).toContainText("The query returned no rows.");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("verification-popover-c3-failing")).toHaveCount(0);
    await expect(page.getByTestId("verification-summary")).toContainText("1 verified, 1 failing");
  });

  test("the group checkbox selects every change of the entity", async ({ page }) => {
    await openDiffTask(page);
    await page.getByTestId("change-group-svc-g").getByRole("checkbox").click();
    await expect(page.getByTestId("selection-count")).toHaveText("3 of 5 selected");
  });

  test("Apply stays off, with the reason, when the app says the diff cannot be applied", async ({ page }) => {
    const options = SESSION_WITH_TASK();
    await openDiffTask(page, {
      ...options,
      tasks: [{ ...options.tasks![0]!, script: { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: reviewDiff({ appliable: false }) } } }],
    });
    await page.getByTestId("select-all").click();
    await expect(page.getByTestId("apply-button")).toBeDisabled();
    await expect(page.getByTestId("apply-blocked")).toHaveText("This Health model diff cannot be applied.");
  });

  test("a diff with no changes says so", async ({ page }) => {
    const options = SESSION_WITH_TASK();
    await openDiffTask(page, {
      ...options,
      tasks: [{ ...options.tasks![0]!, script: { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: reviewDiff({ changes: [], findings: [], verification: [], summary: "Nothing to change." }) } } }],
    });
    await expect(page.getByTestId("change-list-empty")).toBeVisible();
  });
});

test.describe("comparing the Base model and the Proposed model", () => {
  test("draws both graphs with badges on the side the change exists on", async ({ page }) => {
    await openDiffTask(page);
    await page.getByTestId("compare-toggle").click();

    await expect(page.getByTestId("compare-view")).toBeVisible();
    await expect(page.getByTestId("graph-base")).toContainText("Base model");
    await expect(page.getByTestId("graph-proposed")).toContainText("Proposed model");
    await expect(page.getByTestId("topology")).toHaveCount(0);

    await expect(node(page, "graph-base", "svc-f")).toHaveAttribute("data-badge", "removed");
    await expect(node(page, "graph-base", "svc-g")).toHaveCount(0);
    await expect(node(page, "graph-base", "svc-a")).toHaveAttribute("data-badge", "changed");
    await expect(node(page, "graph-proposed", "svc-g")).toHaveAttribute("data-badge", "added");
    await expect(node(page, "graph-proposed", "svc-f")).toHaveCount(0);
    await expect(node(page, "graph-proposed", "svc-a")).toHaveAttribute("data-badge", "changed");
    await expect(page.getByTestId("graph-proposed").locator(".react-flow__edge")).toHaveCount(5);
    await expect(page.getByTestId("graph-base").locator(".react-flow__edge")).toHaveCount(4);
    await expect(page.getByTestId("compare-count-added")).toHaveText("1 entities added");

    await page.getByTestId("compare-exit").click();
    await expect(page.getByTestId("topology")).toBeVisible();
    await expect(page.getByTestId("compare-toggle")).not.toBeChecked();
  });

  test("arranges both graphs on what either side draws, so an entity keeps its place across them", async ({ page }) => {
    await openDiffTask(page);
    await page.getByTestId("compare-toggle").click();
    await expect(node(page, "graph-proposed", "svc-g")).toHaveAttribute("data-badge", "added");
    await page.waitForTimeout(900);

    const across = async (graph: string, name: string): Promise<number> =>
      page
        .getByTestId(graph)
        .locator(`.react-flow__node[data-id="${name}"]`)
        .evaluate((item) => Number(/translate\((-?[\d.]+)px/.exec((item as HTMLElement).style.transform)?.[1]));

    for (const name of ["svc-b", "svc-d"]) {
      expect(await across("graph-base", name), name).toBe(await across("graph-proposed", name));
    }
  });

  test("a node selects its changes and a change marks its nodes", async ({ page }) => {
    await openDiffTask(page);
    await page.getByTestId("compare-toggle").click();

    await node(page, "graph-proposed", "svc-g").click();
    await expect(page.getByTestId("selection-count")).toHaveText("3 of 5 selected");
    await expect(page.getByTestId("change-select-c2")).toBeChecked();
    await expect(node(page, "graph-proposed", "svc-g")).toHaveAttribute("data-marked", "true");
    // The panel stays shut: while comparing, a click means "these changes".
    await expect(page.getByTestId("entity-panel")).toHaveCount(0);

    await node(page, "graph-proposed", "svc-g").click();
    await expect(page.getByTestId("selection-count")).toHaveText("0 of 5 selected");

    await page.getByTestId("change-select-c5").click();
    await expect(node(page, "graph-base", "svc-f")).toHaveAttribute("data-marked", "true");
    await expect(node(page, "graph-base", "svc-a")).not.toHaveAttribute("data-marked", "true");
  });

  test("stacks the two graphs on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openDiffTask(page);
    await page.getByTestId("workspace-close").click();
    await page.getByTestId("workspace-toggle").click();
    await page.getByTestId("compare-toggle").click();
    await page.getByTestId("workspace-close").click();
    const base = (await page.getByTestId("graph-base").boundingBox())!;
    const proposed = (await page.getByTestId("graph-proposed").boundingBox())!;
    expect(proposed.y).toBeGreaterThanOrEqual(base.y + base.height - 1);
    expect(Math.abs(proposed.x - base.x)).toBeLessThan(2);
    // Neither graph is squeezed: each canvas is tall enough to read.
    expect(base.height).toBeGreaterThanOrEqual(320);
    expect(proposed.height).toBeGreaterThanOrEqual(320);
  });
});

test.describe("Apply", () => {
  async function selectAndApply(page: Page, id = "c3"): Promise<void> {
    await page.getByTestId(`change-select-${id}`).click();
    await page.getByTestId("apply-button").click();
  }

  test("asks first, names the target model and says there is no undo", async ({ page }) => {
    const stub = await openDiffTask(page);
    await selectAndApply(page);
    const dialog = page.getByTestId("apply-dialog");
    await expect(dialog).toContainText("Apply to hm-demo?");
    await expect(page.getByTestId("apply-dialog-target")).toHaveText("hm-demo (rg-demo)");
    await expect(dialog).toContainText("cannot be undone");
    await expect(dialog).toContainText("sd-queue-depth (needed by a selected change)");
    await page.getByTestId("apply-cancel").click();
    await expect(dialog).toHaveCount(0);
    expect(stub.applies).toEqual([]);
  });

  test("writes the expanded selection, shows the outcome and reloads the diff and the model", async ({ page }) => {
    const stub = await openDiffTask(page);
    const reloaded = page.waitForRequest((request) => /\/api\/health-model\?/.test(request.url()) && request.method() === "GET");
    await selectAndApply(page);
    await page.getByTestId("apply-confirm").click();

    const result = page.getByTestId("apply-result");
    await expect(result).toHaveAttribute("data-outcome", "applied");
    await expect(result).toContainText("3 changes written to hm-demo");
    expect(stub.applies).toEqual([{ sessionId: SESSION_ID, seq: 1, changeIds: ["c3"] }]);
    await reloaded;
    // The diff came back with the outcome in its history, and its changes are marked written.
    await expect(page.getByTestId("change-applied-c3")).toBeVisible();
    await expect(page.getByTestId("change-select-c3")).toBeDisabled();
    await expect(page.getByTestId("earlier-applies")).toContainText("Earlier Apply outcomes (1)");
  });

  test("reports a partial outcome and where it stopped", async ({ page }) => {
    const stub = await openDiffTask(page);
    stub.applyReplies.push({
      status: 200,
      body: { outcome: "partial", written: ["c2"], failed: { changeId: "c3", code: "write_failed", message: "The service rejected the entity." }, expanded: ["c2", "c3", "c4"] },
    });
    await selectAndApply(page);
    await page.getByTestId("apply-confirm").click();
    const result = page.getByTestId("apply-result");
    await expect(result).toHaveAttribute("data-outcome", "partial");
    await expect(result).toContainText("1 of 3 changes written to hm-demo");
    await expect(result).toContainText("Apply stopped at svc-g: The service rejected the entity.");
  });

  test("a second Apply of the same selection finds the model changed and offers a new Review", async ({ page }) => {
    await openDiffTask(page);
    await page.getByTestId("change-select-c1").click();
    await page.getByTestId("apply-button").click();
    await page.getByTestId("apply-confirm").click();
    await expect(page.getByTestId("apply-result")).toHaveAttribute("data-outcome", "applied");

    await page.getByTestId("change-select-c5").click();
    await page.getByTestId("apply-button").click();
    await page.getByTestId("apply-confirm").click();
    await expect(page.getByTestId("apply-result")).toHaveAttribute("data-outcome", "base_changed");
    await page.getByTestId("apply-new-review").click();
    await expect(page.getByTestId("task-form")).toBeVisible();
    await expect(page.getByTestId("task-type-review")).toHaveAttribute("aria-selected", "true");
  });

  test("a 403 says the signed-in user lacks the Azure role to write to the target model", async ({ page }) => {
    const stub = await openDiffTask(page);
    stub.applyReplies.push({ status: 403, body: errorEnvelope("forbidden", "This app is not allowed to do that on the selected Health Model.") });
    await selectAndApply(page);
    await page.getByTestId("apply-confirm").click();
    const result = page.getByTestId("apply-result");
    await expect(result).toHaveAttribute("data-outcome", "forbidden");
    await expect(result).toContainText("You cannot Apply here");
    await expect(result).toContainText("Your account has no Azure role that lets you write to hm-demo");
    await expect(result).toContainText("nothing was applied");
  });
});

test.describe("deep links", () => {
  test("a link opens the Session and the Task, and the address follows the workspace", async ({ page }) => {
    await boot(page, SESSION_WITH_TASK(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveText("Review #1");
    await expect(page.getByTestId("diff-result")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("task")).toBe("1");

    await page.getByTestId("task-back").click();
    await expect(page).toHaveURL(new RegExp(`session=${SESSION_ID}$`));
    await expect(page.getByTestId("task-open-1")).toBeVisible();
    await page.getByTestId("task-open-1").click();
    await expect(page).toHaveURL(/task=1/);
  });

  test("a model switch keeps the Session and Task in the address", async ({ page }) => {
    await boot(page, SESSION_WITH_TASK(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await page.getByTestId("model-picker-search").click();
    await page.getByTestId(`model-picker-option-${SUBSCRIPTION_A}/rg-demo/hm-payments`).click();
    await expect(page).toHaveURL(/model=hm-payments/);
    expect(new URL(page.url()).searchParams.get("session")).toBe(SESSION_ID);
    expect(new URL(page.url()).searchParams.get("task")).toBe("1");
  });
});

test.describe("the Activity timeline", () => {
  const long = (count: number): StubScript => ({
    events: Array.from({ length: count }, (_, index) => ({ seq: index + 1, ts: at(index), kind: "status" as const, summary: `Step ${index + 1}`, payload: {} })),
    outcome: { status: "done", result: reviewResult(), diff: reviewDiff() },
  });

  test("windows a long timeline and keeps the newest step in view", async ({ page }) => {
    await boot(page, { sessions: [sessionSummary({ taskCount: 1 })], tasks: [{ task: taskOf(1, { result: reviewResult() }), script: long(400) }] }, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await page.getByTestId("task-tab-timeline").click();
    await expect(page.getByTestId("timeline-event-400")).toBeVisible();
    const drawn = await page.getByTestId("timeline-scroller").locator("[data-testid^=timeline-event-]").count();
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(60);
    const pinned = await page.getByTestId("timeline-scroller").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
    expect(pinned).toBeLessThan(4);

    await page.getByTestId("timeline-scroller").evaluate((element) => (element.scrollTop = 0));
    await expect(page.getByTestId("timeline-event-1")).toBeVisible();
    await expect(page.getByTestId("timeline-event-400")).toHaveCount(0);
  });

  test("a reader who scrolled back keeps their place, and is offered the result and the newest step", async ({ page }) => {
    const stub = await boot(page, { sessions: [sessionSummary()], scripts: { review: { ...long(300), hold: 150 } } });
    await openForm(page);
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("timeline-event-150")).toBeVisible();
    await page.getByTestId("timeline-scroller").evaluate((element) => (element.scrollTop = 0));
    await expect(page.getByTestId("timeline-event-1")).toBeVisible();

    stub.release(1);
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
    // Still reading: the timeline stays, and so does the place in it.
    await expect(page.getByTestId("task-result-ready")).toBeVisible();
    await expect(page.getByTestId("timeline-event-1")).toBeVisible();
    await expect(page.getByTestId("timeline-jump")).toBeVisible();
    await page.getByTestId("timeline-jump").click();
    await expect(page.getByTestId("timeline-event-300")).toBeVisible();

    await page.getByTestId("task-show-result").click();
    await expect(page.getByTestId("diff-result")).toBeVisible();
    await expect(page.getByTestId("task-result-ready")).toHaveCount(0);
  });

  test("announces status changes and the result, and never a tool call", async ({ page }) => {
    const stub = await boot(page, { sessions: [sessionSummary()], scripts: { review: HELD_REVIEW } });
    await openForm(page);
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("timeline-event-6")).toBeVisible();
    const log = page.getByTestId("timeline-log");
    await expect(log).toHaveAttribute("aria-live", "polite");
    await expect(log).toContainText("Task started");
    await expect(log).not.toContainText("Inspect hm-demo");

    stub.release(1);
    await expect(page.getByTestId("task-status")).toHaveAttribute("data-status", "done");
    // The result opens in place of the timeline, and the announcements go on.
    await expect(page.getByTestId("diff-result")).toBeVisible();
    await expect(log).toContainText("Result ready");
    await expect(log).toContainText("The Task finished. Its result is ready.");
    await expect(log).not.toContainText("submit_result");
  });

  test("a running Task shows the live stream and the steps so far", async ({ page }) => {
    await boot(page, { sessions: [sessionSummary({ taskCount: 1 })], tasks: [{ task: taskOf(1, { status: "running" }), script: OTHER_USERS_TASK }] }, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("timeline-live")).toBeVisible();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    await expect(page.getByTestId("timeline-scroller")).toHaveAttribute("role", "list");
    await expect(page.getByTestId("timeline-event-3")).toHaveAttribute("aria-posinset", "3");
  });
});

test.describe("states", () => {
  test("a Task that cannot be opened shows the error and retries", async ({ page }) => {
    await boot(page, { sessions: [sessionSummary()] }, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=9`);
    await expect(page.getByTestId("task-error")).toContainText("The Task does not exist.");
  });

  test("a diff that cannot be built shows the error and loads on retry", async ({ page }) => {
    const options = SESSION_WITH_TASK();
    const stub = await boot(page, options, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("diff-result")).toBeVisible();
    stub.diffFailures = 1;
    await page.getByTestId("task-back").click();
    await page.getByTestId("task-open-1").click();
    await expect(page.getByTestId("diff-error")).toContainText("The Health model diff could not be built.");
    await page.getByTestId("diff-error").getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("diff-result")).toBeVisible();
  });

  test("an empty Session offers its first Task", async ({ page }) => {
    await boot(page, { sessions: [sessionSummary()] });
    await openWorkspace(page);
    await page.getByTestId(`session-open-${SESSION_ID}`).click();
    await expect(page.getByTestId("task-list-empty")).toContainText("This Session has no Tasks yet.");
    await page.getByTestId("task-list-new").click();
    await expect(page.getByTestId("task-form")).toBeVisible();
  });
});

test("the workspace passes a keyboard walk: toggle, session, tab, form, submit", async ({ page }) => {
  const stub = await boot(page, { sessions: [sessionSummary()] });
  await page.getByTestId("workspace-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(workspace(page)).toBeVisible();
  await page.getByTestId(`session-open-${SESSION_ID}`).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("session-view")).toBeVisible();
  await page.getByTestId("session-tab-tasks").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("session-tab-new")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("session-tab-new")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("task-submit").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-title")).toHaveText("Review #1");
  expect(stub.posts).toHaveLength(1);
});

test.describe("long lists are windowed", () => {
  async function scrolledToEnd(list: Locator): Promise<void> {
    await list.evaluate((element) => (element.scrollTop = element.scrollHeight));
  }

  test("the Session list", async ({ page }) => {
    const sessions = Array.from({ length: 500 }, (_, index) => sessionSummary({ id: `s-${index + 1}`, title: `Session ${index + 1}` }));
    await boot(page, { sessions });
    await openWorkspace(page);
    const rows = page.getByTestId("session-list").getByRole("listitem");
    await expect(page.getByTestId("session-row-s-1")).toHaveAttribute("aria-setsize", "500");
    expect(await rows.count()).toBeLessThan(40);
    await scrolledToEnd(page.getByTestId("session-list"));
    await expect(page.getByTestId("session-row-s-500")).toBeVisible();
    await expect(page.getByTestId("session-row-s-1")).toHaveCount(0);
    expect(await rows.count()).toBeLessThan(40);
  });

  test("the Task list, newest first", async ({ page }) => {
    const script: StubScript = { events: [], outcome: { status: "done", result: reviewResult(), diff: reviewDiff() } };
    const tasks = Array.from({ length: 300 }, (_, index) => ({ task: taskOf(index + 1), script }));
    await boot(page, { sessions: [sessionSummary({ taskCount: 300 })], tasks });
    await openWorkspace(page);
    await page.getByTestId(`session-open-${SESSION_ID}`).click();
    const list = page.getByTestId("task-list");
    await expect(page.getByTestId("task-row-300")).toBeVisible();
    await expect(page.getByTestId("task-row-300")).toHaveAttribute("aria-posinset", "1");
    expect(await list.getByRole("listitem").count()).toBeLessThan(40);
    await scrolledToEnd(list);
    await expect(page.getByTestId("task-row-1")).toBeVisible();
    await expect(page.getByTestId("task-row-300")).toHaveCount(0);
  });

  test("the change list", async ({ page }) => {
    const options = SESSION_WITH_TASK();
    await openDiffTask(page, {
      ...options,
      tasks: [{ ...options.tasks![0]!, script: { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: longDiff(400) } } }],
    });
    const list = page.getByTestId("change-list");
    expect(await list.getByRole("listitem").count()).toBeLessThan(60);
    await page.getByTestId("select-all").click();
    await expect(page.getByTestId("selection-count")).toHaveText("400 of 400 selected");
    await expect(page.getByTestId("apply-button")).toHaveText("Apply 400 changes");
    await scrolledToEnd(list);
    await expect(page.getByTestId("change-c400")).toBeVisible();
    await expect(page.getByTestId("change-select-c400")).toBeChecked();
    expect(await list.getByRole("listitem").count()).toBeLessThan(60);
  });
});

test.describe("what the app refuses and what fails", () => {
  const sessions = (): WorkspaceOptions => ({ sessions: [sessionSummary()] });

  test.describe("starting a Task", () => {
    test("a busy app offers to try again, and the second start goes through", async ({ page }) => {
      const stub = await boot(page, sessions());
      stub.startRefusals.push(REFUSALS.agentsBusy);
      await openForm(page);
      await page.getByTestId("task-submit").click();

      const message = page.getByTestId("task-start-error");
      await expect(message).toHaveAttribute("data-code", "agents_busy");
      await expect(message).toContainText("All agents are busy");
      await expect(message).toContainText("Try again in a few minutes.");
      await page.getByTestId("task-start-retry").click();
      await expect(page.getByTestId("task-title")).toHaveText("Review #1");
      expect(stub.posts).toHaveLength(2);
    });

    test("a full Session offers a new Session", async ({ page }) => {
      const stub = await boot(page, sessions());
      stub.startRefusals.push(REFUSALS.taskLimit);
      await openForm(page);
      await page.getByTestId("task-submit").click();

      const message = page.getByTestId("task-start-error");
      await expect(message).toHaveAttribute("data-code", "task_limit");
      await expect(message).toContainText("This Session is full");
      await expect(page.getByTestId("task-start-retry")).toHaveCount(0);
      await page.getByTestId("task-start-new-session").click();
      await expect(page.getByTestId("session-list-view")).toBeVisible();
    });

    test("a request that is too large says what to shorten and offers no retry", async ({ page }) => {
      const stub = await boot(page, sessions());
      stub.startRefusals.push(REFUSALS.payloadTooLarge);
      await openForm(page);
      await page.getByTestId("task-submit").click();

      const message = page.getByTestId("task-start-error");
      await expect(message).toHaveAttribute("data-code", "payload_too_large");
      await expect(message).toContainText("Shorten the Task instruction");
      await expect(page.getByTestId("task-start-retry")).toHaveCount(0);
      await expect(page.getByTestId("task-start-new-session")).toHaveCount(0);
    });
  });

  test.describe("creating a Session", () => {
    test("a full app says so, keeps the title and offers no retry", async ({ page }) => {
      const stub = await boot(page);
      stub.sessionRefusals.push(REFUSALS.sessionLimit);
      await openWorkspace(page);
      await page.getByTestId("session-title").fill("Queue review");
      await page.getByTestId("new-session").click();

      const message = page.getByTestId("session-create-error");
      await expect(message).toContainText("The app has no room for another Session");
      await expect(page.getByTestId("session-create-retry")).toHaveCount(0);
      await expect(page.getByTestId("session-title")).toHaveValue("Queue review");
    });

    test("an unavailable store offers to try again with the same title", async ({ page }) => {
      const stub = await boot(page);
      stub.sessionRefusals.push({ status: 503, code: "sessions_unavailable", message: "Sessions are temporarily unavailable.", retryable: true });
      await openWorkspace(page);
      await page.getByTestId("session-title").fill("Queue review");
      await page.getByTestId("new-session").click();
      await expect(page.getByTestId("session-create-error")).toContainText("Sessions are temporarily unavailable.");

      await page.getByTestId("session-create-retry").click();
      await expect(page.getByTestId("session-title-heading")).toHaveText("Queue review");
    });
  });

  test("a Task the app interrupted says why and can be started again", async ({ page }) => {
    const error = { code: "interrupted", message: "The web app stopped while the task was running." };
    await boot(
      page,
      {
        sessions: [sessionSummary({ taskCount: 1 })],
        tasks: [{ task: taskOf(1, { status: "failed", error }), script: { events: reviewEvents(4), outcome: { status: "failed", error } } }],
      },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    const failed = page.getByTestId("task-failed");
    await expect(failed).toHaveAttribute("data-code", "interrupted");
    await expect(failed).toContainText("The Task was interrupted");
    await expect(failed).toContainText("Start it again");
    await page.getByTestId("task-retry").click();
    await expect(page.getByTestId("task-form")).toBeVisible();
  });

  test.describe("the live Activity timeline", () => {
    const running = (): WorkspaceOptions => ({
      sessions: [sessionSummary({ taskCount: 1 })],
      tasks: [{ task: taskOf(1, { status: "running" }), script: OTHER_USERS_TASK }],
    });

    for (const { refusal, title, text } of [
      { refusal: REFUSALS.tooManySubscribers, title: "Too many viewers", text: "Reconnect in a moment." },
      { refusal: REFUSALS.invalidLastEventId, title: "The timeline could not resume", text: "replay it from the start" },
    ]) {
      test(`${refusal.code} is explained and the timeline reconnects once the app accepts it`, async ({ page }) => {
        const stub = await boot(page, running());
        stub.streamRefusal = refusal;
        await openWorkspace(page);
        await page.getByTestId(`session-open-${SESSION_ID}`).click();
        await page.getByTestId("task-open-1").click();

        const message = page.getByTestId("timeline-error");
        await expect(message).toHaveAttribute("data-code", refusal.code);
        await expect(message).toContainText(title);
        await expect(message).toContainText(text);
        await expect(page.getByTestId("timeline-live")).toHaveCount(0);

        stub.streamRefusal = null;
        await page.getByTestId("timeline-reconnect").click();
        await expect(page.getByTestId("timeline-error")).toHaveCount(0);
        await expect(page.getByTestId("timeline-live")).toBeVisible();
        await expect(page.getByTestId("timeline-event-3")).toBeVisible();
      });
    }
  });
});

test.describe("what the deployed app returned that the fixtures never had", () => {
  test("Sessions are listed newest first whatever order the app sends", async ({ page }) => {
    await boot(page, {
      sessions: [
        sessionSummary({ id: "s-old", title: "Old", createdAt: "2026-11-10T23:28:51.676994Z", lastTaskAt: "2026-11-11T00:14:59.002324Z", taskCount: 3 }),
        sessionSummary({ id: "s-newest", title: "Newest", createdAt: "2026-11-11T00:23:23.461249Z" }),
        sessionSummary({ id: "s-mid", title: "Middle", createdAt: "2026-11-10T23:40:00.000000Z", lastTaskAt: "2026-11-11T00:20:00.500000Z", taskCount: 1 }),
      ],
    });
    await openWorkspace(page);
    const ids = await page.getByTestId("session-list").getByRole("listitem").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(ids).toEqual(["session-row-s-newest", "session-row-s-mid", "session-row-s-old"]);
  });

  test("a Review that proposes nothing shows its findings and Verification and offers nothing to Apply", async ({ page }) => {
    const long = "The Azure resource metric signals are pointed at a container app resource ID that does not exist in the resource group, so those signals are stuck in Unknown and cannot support the current model.";
    const findings = [
      { severity: "high", entity: "svc-a", text: long, changeIds: [] },
      { severity: "medium", entity: "svc-a", text: `${long} Resource Health is not supported for this type.`, changeIds: [] },
      { severity: "low", entity: "svc-a", text: long, changeIds: [] },
    ] as const;
    const verification = [
      { entity: "svc-a", signal: "cpu-percentage", status: "failing", query: "Microsoft.App/containerApps CpuPercentage Average", value: null, error: "The configured resource ID could not be queried because the resource was not found." },
      { entity: "svc-a", signal: "failed-requests", status: "verified", query: "AppRequests | summarize countif(Success == false)", value: "1", error: null },
    ] as const;
    const options = SESSION_WITH_TASK();
    await openDiffTask(page, {
      ...options,
      tasks: [
        {
          ...options.tasks![0]!,
          script: {
            events: reviewEvents(),
            outcome: { status: "done", result: reviewResult(), diff: reviewDiff({ changes: [], findings: [...findings], verification: [...verification], summary: long }) },
          },
        },
      ],
    });

    await expect(page.getByTestId("change-list-empty")).toBeVisible();
    for (const hidden of ["selection-bar", "compare-toggle", "apply-button", "select-all"]) {
      await expect(page.getByTestId(hidden)).toHaveCount(0);
    }

    // Nothing between the findings and the pane clips them behind a scroll of its own.
    const clipped = await page.getByTestId("findings").evaluate((list) => {
      for (let element = list.parentElement; element && element.getAttribute("role") !== "tabpanel"; element = element.parentElement) {
        const overflow = getComputedStyle(element).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1) return true;
      }
      return false;
    });
    expect(clipped).toBe(false);
    await expect(page.getByTestId("finding-2")).toBeVisible();

    await page.getByTestId("verification-rows").getByRole("button", { name: /Verification details \(2\)/ }).click();
    await expect(page.getByTestId("verification-rows")).toContainText("cpu-percentage");
    await expect(page.getByTestId("verification-rows")).toContainText("the resource was not found.");
    await expect(page.getByTestId("verification-rows")).toContainText("Query: AppRequests");
  });

  test("a Review of another model says so and opens it", async ({ page }) => {
    const other = { name: "hm-payments", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A };
    const options = SESSION_WITH_TASK();
    await openDiffTask(page, {
      ...options,
      tasks: [{ task: taskOf(1, { target: other, result: reviewResult() }), script: options.tasks![0]!.script }],
    });
    await expect(page.getByTestId("diff-off-screen")).toContainText("This Review task ran on hm-payments, which is not the model on screen.");
    await page.getByTestId("diff-open-target").click();
    await expect(page.getByTestId("model-picker-selected")).toContainText("hm-payments");
    await expect(page.getByTestId("diff-off-screen")).toHaveCount(0);
  });

  test("a Design compares its proposal with an empty Base model and says it is not the model on screen", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    page.on("pageerror", (error) => errors.push(String(error)));
    const diff = designDiff();
    const result = { kind: "diff", summary: diff.summary, changes: [], verification: [], findings: [] } as const;
    await boot(
      page,
      {
        sessions: [sessionSummary({ taskCount: 1 })],
        tasks: [{ task: taskOf(1, { type: "design", target: DESIGN_TARGET, result }), script: { events: designEvents(), outcome: { status: "done", result, diff } } }],
      },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    await expect(page.getByTestId("diff-off-screen")).toContainText("This Design task ran on hm-demo-design");
    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("compare-view")).toBeVisible();
    await expect(page.locator('[data-testid="graph-empty"][data-graph="graph-base"]')).toHaveText("The Base model has no entities.");
    await expect(page.locator('[data-testid="graph-empty"][data-graph="graph-proposed"]')).toHaveCount(0);
    await expect(node(page, "graph-proposed", "web")).toBeVisible();
    await expect(page.getByTestId("compare-count-added")).toHaveText("2 entities added");
    expect(errors).toEqual([]);
  });

  test("a Design without a design model in the catalog has no target to start", async ({ page }) => {
    await installStubs(page, { healthModelFails: false, catalog: modelCatalog, model: healthModel });
    const stub = await installWorkspace(page, { sessions: [sessionSummary()] });
    await page.goto("/");
    await page.waitForSelector(".react-flow__node .entity-node");
    await openForm(page);
    await page.getByTestId("task-type-design").click();

    await expect(page.getByTestId("task-target")).toHaveValue("No design model");
    await expect(page.getByTestId("task-form")).toContainText("This deployment has no design model, so Design is unavailable.");
    await expect(page.getByTestId("task-submit")).toBeDisabled();
    expect(stub.posts).toEqual([]);
  });

  test("a long tool call summary keeps what tells it from the next one", async ({ page }) => {
    const a = "Inspect health model hm-contosodemo (entity container-app)";
    const b = "Inspect health model hm-contosodemo (entity container-app, walk Causes)";
    const options = SESSION_WITH_TASK();
    await boot(
      page,
      {
        ...options,
        tasks: [
          {
            ...options.tasks![0]!,
            script: { events: [activity(1, "tool_call", a), activity(2, "tool_call", b)], outcome: { status: "done", result: reviewResult(), diff: reviewDiff() } },
          },
        ],
      },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    await page.getByTestId("task-tab-timeline").click();
    const shown = await page.getByTestId("timeline-event-2").evaluate((row) => {
      const title = row.querySelector("span[title]") as HTMLElement;
      return { clipped: title.scrollHeight > title.clientHeight + 1, row: row.getBoundingClientRect().height, text: title.textContent };
    });
    expect(shown).toEqual({ clipped: false, row: 36, text: b });
  });
});

test("opening the workspace fits the graph into the space that is left", async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(900);
  await openWorkspace(page);
  await page.waitForTimeout(900);

  const outside = await page.evaluate(() => {
    const canvas = (document.querySelector(".react-flow") as HTMLElement).getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node")]
      .map((item) => ({ id: item.getAttribute("data-id"), box: item.getBoundingClientRect() }))
      .filter(({ box }) => box.left < canvas.left - 1 || box.right > canvas.right + 1 || box.top < canvas.top - 1 || box.bottom > canvas.bottom + 1)
      .map(({ id }) => id);
  });

  expect(outside).toEqual([]);
});
