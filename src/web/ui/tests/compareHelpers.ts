import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installStubs } from "./fixture";
import { openView } from "./views";
import { diffViewModel, incidentModel } from "./viewModels";
import { MODEL_QUERY } from "./workspaceHelpers";
import { SESSION_ID, at, catalogWithDesign, installWorkspace, reviewEvents, sessionSummary, taskOf } from "./workspaceStub";
import type { DiffView, TaskResult } from "../src/model/types";
import type { ViewId } from "../src/model/views";

function resultOf(diff: DiffView): TaskResult {
  return {
    kind: "diff",
    summary: diff.summary,
    changes: diff.changes.map(({ id, op, kind, name, after, reason }) => ({ id, op, kind, name, after, reason })),
    verification: diff.verification,
    findings: diff.findings,
  };
}

/** Opens a Review whose diff is `diff` (the one of `diffViewModel()` on the incident model) in one view, with Compare on. */
export async function openCompare(page: Page, view: ViewId, diff: DiffView = diffViewModel()): Promise<void> {
  await installStubs(page, { healthModelFails: false, model: incidentModel(), catalog: catalogWithDesign });
  const result = resultOf(diff);
  await installWorkspace(page, {
    sessions: [sessionSummary({ taskCount: 1, lastTaskAt: at(40) })],
    tasks: [{ task: taskOf(1, { result }), script: { events: reviewEvents(), outcome: { status: "done", result, diff } } }],
  });
  await openView(page, view, `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
  await expect(page.getByTestId("diff-result")).toBeVisible();
  await page.getByTestId("compare-toggle").click();
  await expect(page.getByTestId("compare-view")).toBeVisible();
}
