import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SUBSCRIPTION_A } from "./fixture";
import { MODEL_QUERY, SESSION_WITH_TASK, boot, node, openWorkspace } from "./workspaceHelpers";
import {
  OTHER_USERS_TASK,
  REFUSALS,
  SESSION_ID,
  activity,
  defaultScript,
  explainEvents,
  explainResult,
  reviewEvents,
  sessionSummary,
  taskOf,
  type StubScript,
  type WorkspaceOptions,
} from "./workspaceStub";

// The interface speaks in the user's questions and answers. These words belong to the code, the API and the docs
// (GLOSSARY.md); a person using the app should never read them. The check reads what a person reads on the main
// flow, on screen and in names for assistive technology, and lists every place one of them shows up.
// What the stub or the assistant writes as data (entity names, summaries, step titles) is not under test here.
const JARGON: readonly { readonly word: string; readonly pattern: RegExp }[] = [
  { word: "Task #", pattern: /\bTask #\d/ },
  { word: "Task / Tasks", pattern: /\bTasks?\b/ },
  { word: "Session / Sessions", pattern: /\bSessions?\b/ },
  { word: "Activity timeline", pattern: /activity timeline/i },
  { word: "Health model diff", pattern: /health model diff/i },
  { word: "diff", pattern: /\bdiff\b/i },
  { word: "Base model / Proposed model", pattern: /\b(base|proposed) model\b/i },
  { word: "Verification", pattern: /\bverif(y|ied|ication)/i },
  { word: "Rollup", pattern: /\brollup\b/i },
  { word: "Instruction", pattern: /\binstruction\b/i },
  { word: "Workload", pattern: /\bWorkload\b/ },
  { word: "Observed", pattern: /\bobserved\b/i },
  { word: "tool names", pattern: /tool_call|tool_result|submit_result|load_skill|monitor_healthmodels/ },
  { word: "error codes", pattern: /\b(task_running|agents_busy|task_limit|session_limit|payload_too_large|too_many_subscribers|invalid_last_event_id|task_not_found|session_not_found|sessions_unavailable|base_changed|agent_failed|network_error|http_error|diff_unavailable)\b/ },
  { word: "an identifier with underscores", pattern: /\b[a-z]+_[a-z]+(_[a-z]+)*\b/ },
];

/** What a person reads: the text on screen, and the names, titles and hints assistive technology and tooltips give. */
async function language(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    // The line that carries the code and reference of an error is for whoever reports it, and says so.
    const quiet = (element: Element): boolean => element.closest("[data-testid=technical-details]") !== null;
    const shown = (element: Element): boolean => {
      const box = (element as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      const text = node.textContent?.trim();
      if (element && text && !quiet(element) && shown(element) && element.tagName !== "SCRIPT" && element.tagName !== "STYLE") found.push(text);
    }
    for (const element of Array.from(document.querySelectorAll("[aria-label],[title],[placeholder]"))) {
      if (quiet(element) || !shown(element)) continue;
      for (const name of ["aria-label", "title", "placeholder"]) {
        const value = element.getAttribute(name);
        if (value) found.push(value);
      }
    }
    return found;
  });
}

async function offenders(page: Page, state: string): Promise<string[]> {
  const texts = await language(page);
  return JARGON.flatMap(({ word, pattern }) =>
    texts.filter((text) => pattern.test(text)).map((text) => `${state}: "${word}" in "${text.slice(0, 120)}"`),
  );
}

const HELD_EXPLAIN: StubScript = { ...defaultScript("explain"), hold: 3 };
const now = (): string => new Date().toISOString();

async function pick(page: Page, name = "svc-c"): Promise<void> {
  await node(page, "topology", name).click();
  await expect(page.getByTestId("entity-details")).toBeVisible();
}

test.describe("the interface speaks in questions and answers", () => {
  test("the model, an entity and the History list read in plain words", async ({ page }) => {
    // The timeline that a pick opens shares the column with the graph: a taller window keeps the next card in reach.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await boot(page, { sessions: [sessionSummary({ title: "Why is Service C Unhealthy? (10 Nov 10:00)", taskCount: 1, lastTaskAt: now() })] });
    const found = await offenders(page, "the model");
    await pick(page);
    found.push(...(await offenders(page, "an entity")));
    await pick(page, "svc-a");
    await page.getByTestId("report-open").click();
    await expect(page.getByTestId("report-submit")).toBeVisible();
    found.push(...(await offenders(page, "an entity with its history and the report form")));
    await page.getByTestId("report-close").click();
    await expect(page.getByTestId("report-submit")).toHaveCount(0);
    await page.getByTestId("task-menu").click();
    await expect(page.getByTestId("menu-explain")).toBeVisible();
    found.push(...(await offenders(page, "the Ask menu")));
    await page.keyboard.press("Escape");
    await openWorkspace(page);
    found.push(...(await offenders(page, "History")));
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("a question while it runs, and its answer", async ({ page }) => {
    const stub = await boot(page, { scripts: { explain: HELD_EXPLAIN } });
    await pick(page);
    const found: string[] = [];
    const release = stub.holdStarts();
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("launch-starting")).toBeVisible();
    found.push(...(await offenders(page, "asking")));
    release();
    await expect(page.getByTestId("timeline-event-3")).toBeVisible();
    found.push(...(await offenders(page, "the assistant at work")));
    // Steps read as what the assistant does; the tool and its arguments are one click away.
    await expect(page.getByTestId("timeline-event-1")).toContainText("The assistant started working");
    await expect(page.getByTestId("timeline-event-2")).toContainText("Reading the health model hm-demo, starting at svc-c");
    await expect(page.getByTestId("timeline-event-3")).toContainText("Read the health model hm-demo, starting at svc-c");
    await page.getByTestId("timeline-details-2").click();
    await expect(page.getByTestId("timeline-popover-2")).toContainText("Technical details");
    await expect(page.getByTestId("timeline-popover-2")).toContainText("Tool: monitor_healthmodels_inspect");
    await expect(page.getByTestId("timeline-popover-2")).toContainText("Arguments:");
    await page.keyboard.press("Escape");
    stub.release(1, "s-1");
    await expect(page.getByTestId("explain-result")).toBeVisible();
    found.push(...(await offenders(page, "the answer")));
    await page.getByTestId("task-tab-timeline").click();
    found.push(...(await offenders(page, "what the assistant did")));
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("the model check, its proposed changes, the Apply question and the comparison", async ({ page }) => {
    await boot(page, SESSION_WITH_TASK(), `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`);
    await expect(page.getByTestId("diff-result")).toBeVisible();
    const found = await offenders(page, "proposed changes");
    await page.getByTestId("change-select-c3").click();
    await page.getByTestId("change-expand-c3").click();
    found.push(...(await offenders(page, "a change opened")));
    await page.getByTestId("apply-button").click();
    await expect(page.getByTestId("apply-dialog")).toBeVisible();
    found.push(...(await offenders(page, "the Apply question")));
    await page.getByTestId("apply-confirm").click();
    await expect(page.getByTestId("apply-result")).toBeVisible();
    found.push(...(await offenders(page, "the Apply result")));
    await page.getByTestId("compare-toggle").click();
    await expect(page.getByTestId("compare-view")).toBeVisible();
    found.push(...(await offenders(page, "the comparison")));
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("what goes wrong is told in plain words, with the code kept to a small last line", async ({ page }) => {
    const stub = await boot(page);
    const found: string[] = [];

    stub.startRefusals.push(REFUSALS.agentsBusy);
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("task-start-error")).toBeVisible();
    found.push(...(await offenders(page, "the assistant is busy")));
    await expect(page.getByTestId("technical-details")).toContainText("agents_busy");

    await page.getByTestId("launch-dismiss").click();
    stub.sessionRefusals.push(REFUSALS.sessionLimit);
    await page.getByTestId("session-back").click();
    await page.getByTestId("task-menu").click();
    await page.getByTestId("menu-review").click();
    await expect(page.getByTestId("task-start-error")).toBeVisible();
    found.push(...(await offenders(page, "no room for a topic")));
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("a question that is already running, and one that failed", async ({ page }) => {
    const running: WorkspaceOptions = {
      sessions: [sessionSummary({ id: "s-other", title: "Check hm-demo (10 Nov 10:00)", taskCount: 1, lastTaskAt: now() })],
      tasks: [{ task: taskOf(1, { sessionId: "s-other", status: "running", createdAt: now() }), script: OTHER_USERS_TASK }],
    };
    await boot(page, running);
    await pick(page);
    await page.getByTestId("explain-entity").click();
    await expect(page.getByTestId("task-start-error")).toBeVisible();
    const found = await offenders(page, "already running");
    await page.getByTestId("open-running-task").click();
    await expect(page.getByTestId("task-title")).toBeVisible();
    found.push(...(await offenders(page, "the running question")));
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("a question that did not finish", async ({ page }) => {
    const error = { code: "interrupted", message: "The web app stopped while the task was running." };
    await boot(
      page,
      {
        sessions: [sessionSummary({ taskCount: 1 })],
        tasks: [{ task: taskOf(1, { status: "failed", error }), script: { events: reviewEvents(4), outcome: { status: "failed", error } } }],
      },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    await expect(page.getByTestId("task-failed")).toBeVisible();
    const found = await offenders(page, "a question that did not finish");
    await expect(page.getByTestId("task-failed").getByTestId("technical-details")).toContainText("interrupted");
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("the Design form and the way to ask without an entity", async ({ page }) => {
    await boot(page);
    await page.getByTestId("task-menu").click();
    await page.getByTestId("menu-design").click();
    await expect(page.getByTestId("new-task-view")).toBeVisible();
    const found = await offenders(page, "the Design form");
    await page.getByTestId("task-type-explain").click();
    found.push(...(await offenders(page, "the question form")));
    await page.getByTestId("task-type-review").click();
    found.push(...(await offenders(page, "the model check form")));
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("the entity panel says why in the state the entity has", async ({ page }) => {
    await boot(page);
    // svc-a is Healthy, svc-b Degraded, svc-c Unhealthy, svc-d Unknown in the fixtures.
    for (const [name, question] of [
      ["svc-a", "Why is this Healthy?"],
      ["svc-b", "Why is this Degraded?"],
      ["svc-c", "Why is this Unhealthy?"],
      ["svc-d", "Why is the state unknown?"],
    ] as const) {
      await pick(page, name);
      await expect(page.getByTestId("explain-entity")).toHaveText(question);
    }
  });

  test("how sure the assistant is and what it looked at show when it said, and not otherwise", async ({ page }) => {
    const target = { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" };
    const result = { ...explainResult(), confidence: "medium" as const, window: { from: "2026-11-10T11:05:00Z", to: "2026-11-10T14:05:00Z" } };
    await boot(
      page,
      { sessions: [sessionSummary({ taskCount: 1 })], tasks: [{ task: taskOf(1, { type: "explain", target, result }), script: { events: explainEvents(), outcome: { status: "done", result } } }] },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("explain-confidence")).toContainText("How sure");
    await expect(page.getByTestId("explain-confidence")).toContainText("Medium");
    await expect(page.getByTestId("explain-confidence")).toContainText("Check the steps before you rely on it.");
    await expect(page.getByTestId("explain-window")).toHaveText(/^Looked at: the last 3 hours \(until \d{1,2} \w{3} \d{2}:\d{2}\)$/);
    expect(await offenders(page, "how sure and what it looked at"), "words of the code on screen").toEqual([]);

  });

  test("an answer that says neither how sure it is nor what it looked at shows neither", async ({ page }) => {
    const target = { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" };
    const result = explainResult();
    await boot(
      page,
      { sessions: [sessionSummary({ taskCount: 1 })], tasks: [{ task: taskOf(1, { type: "explain", target, result }), script: { events: explainEvents(), outcome: { status: "done", result } } }] },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    await expect(page.getByTestId("explain-result")).toBeVisible();
    await expect(page.getByTestId("explain-confidence")).toHaveCount(0);
    await expect(page.getByTestId("explain-window")).toHaveCount(0);
  });

  test("what went wrong with a rejected answer, and the tries while the service is busy, show in plain words", async ({ page }) => {
    const error = {
      code: "invalid_result",
      message: "The assistant's answer was rejected.",
      problems: ["changes[0]: the name is missing", "changes[1]: the kind is not known", "changes[2]: no reason", "changes[3]: no reason", "changes[4]: no reason", "changes[5]: no reason", "changes[6]: no reason"],
    };
    const events = [
      activity(1, "status", "Agent started"),
      activity(2, "status", "The assistant is busy, trying again", { attempt: 2, of: 5, waitSeconds: 20 }),
      activity(3, "tool_call", "Submit result (diff, 3 changes)", { name: "submit_result" }),
      activity(4, "tool_result", "Submit result (diff, 3 changes): rejected (7 problems)", { name: "submit_result", ok: false, problems: error.problems }),
      activity(5, "error", "The assistant's answer was rejected.", { code: "invalid_result", problems: error.problems }),
    ];
    await boot(
      page,
      { sessions: [sessionSummary({ taskCount: 1 })], tasks: [{ task: taskOf(1, { status: "failed", error }), script: { events, outcome: { status: "failed", error } } }] },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    const failed = page.getByTestId("task-failed");
    await expect(failed).toContainText("What was wrong with its last answer:");
    await expect(failed.getByTestId("task-problems").getByRole("listitem")).toHaveCount(6);
    await expect(failed.getByTestId("task-problems")).toContainText("and 2 more");
    await expect(failed.getByTestId("technical-details")).toContainText("invalid_result");
    const found = await offenders(page, "a rejected answer");
    // A question that did not finish has no answer to open, so its steps are what the panel shows.
    await expect(page.getByTestId("timeline-event-2")).toContainText("The assistant is busy, trying again (try 2 of 5, next try in 20 s)");
    await expect(page.getByTestId("timeline-event-4")).toContainText("The proposed changes were not accepted (7 problems)");
    await page.getByTestId("timeline-details-4").click();
    await expect(page.getByTestId("timeline-popover-4")).toContainText("changes[6]: no reason");
    expect(found, "words of the code on screen").toEqual([]);
  });

  test("the first sentence of the assistant's text is the answer, and identifiers are quiet", async ({ page }) => {
    const text =
      "Session Storage is Unknown because both signals are Unknown and the model does not use Resource Health (`resourceHealth.enabled = Disabled`). The attached resource ID /subscriptions/0000/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1 is not queryable.";
    const result = { ...explainResult(), summary: text };
    await boot(
      page,
      {
        sessions: [sessionSummary({ taskCount: 1 })],
        tasks: [
          {
            task: taskOf(1, { type: "explain", target: { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: SUBSCRIPTION_A, entity: "svc-c" }, result }),
            script: { events: explainEvents(), outcome: { status: "done", result } },
          },
        ],
      },
      `/?${MODEL_QUERY}&session=${SESSION_ID}&task=1`,
    );
    await expect(page.getByTestId("result-heading")).toHaveText(/^Session Storage is Unknown because both signals are Unknown.*Disabled\)\.$/);
    await expect(page.getByTestId("explain-summary")).toContainText("The attached resource ID");
    // The setting and the resource path sit in monospace, apart from the sentence around them.
    await expect(page.getByTestId("result-heading").locator("code")).toHaveText("resourceHealth.enabled = Disabled");
    await expect(page.getByTestId("explain-summary").locator("code")).toHaveCount(1);
  });
});
