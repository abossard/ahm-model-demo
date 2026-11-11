import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SUBSCRIPTION_A, installStubs } from "./fixture";
import {
  SESSION_ID,
  at,
  catalogWithDesign,
  defaultScript,
  installWorkspace,
  reviewDiff,
  reviewEvents,
  reviewResult,
  sessionSummary,
  taskOf,
  type StubScript,
  type WorkspaceOptions,
  type WorkspaceStub,
} from "./workspaceStub";

export const MODEL_QUERY = `model=hm-demo&resourceGroup=rg-demo&subscription=${SUBSCRIPTION_A}`;
export const HELD_REVIEW: StubScript = { ...defaultScript("review"), hold: 6 };

export async function boot(page: Page, options: WorkspaceOptions = {}, path = "/"): Promise<WorkspaceStub> {
  await installStubs(page, { healthModelFails: false, catalog: catalogWithDesign });
  const stub = await installWorkspace(page, options);
  await page.goto(path);
  await page.waitForSelector(".react-flow__node .entity-node");
  return stub;
}

export const workspace = (page: Page): Locator => page.getByTestId("session-workspace");

export async function openWorkspace(page: Page): Promise<void> {
  await page.getByTestId("workspace-toggle").click();
  await expect(workspace(page)).toBeVisible();
}

/** Opens the workspace, the Session and its form. */
export async function openForm(page: Page): Promise<void> {
  await openWorkspace(page);
  await page.getByTestId(`session-open-${SESSION_ID}`).click();
  await page.getByTestId("session-tab-new").click();
  await expect(page.getByTestId("task-form")).toBeVisible();
}

export const SESSION_WITH_TASK = (): WorkspaceOptions => ({
  sessions: [sessionSummary({ taskCount: 1, lastTaskAt: at(40) })],
  tasks: [
    {
      task: taskOf(1, { result: reviewResult() }),
      script: { events: reviewEvents(), outcome: { status: "done", result: reviewResult(), diff: reviewDiff() } },
    },
  ],
});

export async function openDiffTask(page: Page, options: WorkspaceOptions = SESSION_WITH_TASK()): Promise<WorkspaceStub> {
  const stub = await boot(page, options, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
  await expect(page.getByTestId("diff-result")).toBeVisible();
  return stub;
}

export function node(page: Page, graph: string, name: string): Locator {
  return page.getByTestId(graph).locator(`.entity-node[data-entity="${name}"]`);
}

