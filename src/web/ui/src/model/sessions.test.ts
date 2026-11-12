import { describe, expect, it } from "vitest";
import {
  SESSION_TITLE_MAX,
  TASK_LIFETIME_MS,
  formatSessionTime,
  mayHoldRunningTask,
  orderSessions,
  planStart,
  runningIn,
  sessionTitle,
} from "./sessions";
import type { SessionSummary, TaskInput, TaskSummary } from "./types";

const session = (id: string, createdAt: string, lastTaskAt: string | null): SessionSummary => ({
  id,
  title: id,
  createdAt,
  taskCount: lastTaskAt === null ? 0 : 1,
  lastTaskAt,
});

describe("orderSessions", () => {
  it.each([
    {
      name: "the time of the last Task over the time of creation",
      sessions: [
        session("old", "2026-11-10T23:28:51.676994Z", "2026-11-11T00:14:59.002324Z"),
        session("new", "2026-11-11T00:23:23.461249Z", null),
        session("mid", "2026-11-10T23:30:00Z", "2026-11-11T00:20:00Z"),
      ],
      expected: ["new", "mid", "old"],
    },
    {
      name: "real timestamps with microseconds",
      sessions: [session("a", "2026-11-11T00:23:23.461249Z", "2026-11-11T00:23:39.722048Z"), session("b", "2026-11-11T00:23:23.461249Z", "2026-11-11T00:23:41.000001Z")],
      expected: ["b", "a"],
    },
    {
      name: "equal times in the order given",
      sessions: [session("x", "2026-11-11T00:00:00Z", null), session("y", "2026-11-11T00:00:00Z", null)],
      expected: ["x", "y"],
    },
    {
      name: "a time that is not a date last",
      sessions: [session("bad", "yesterday", null), session("ok", "2026-11-11T00:00:00Z", null)],
      expected: ["ok", "bad"],
    },
    { name: "no Sessions", sessions: [], expected: [] },
  ])("puts $name", ({ sessions, expected }) => {
    expect(orderSessions(sessions).map((item) => item.id)).toEqual(expected);
  });

  it("leaves the list it was given alone", () => {
    const given = [session("a", "2026-11-10T00:00:00Z", null), session("b", "2026-11-11T00:00:00Z", null)];
    orderSessions(given);
    expect(given.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

const TARGET = { name: "hm-demo", resourceGroup: "rg-demo", subscriptionId: "sub" };
const explain: TaskInput = { type: "explain", target: { ...TARGET, entity: "svc-storage" }, instruction: "" };
const review: TaskInput = { type: "review", target: TARGET, instruction: "" };
const design = (repositoryUrl?: string): TaskInput => ({
  type: "design",
  target: { ...TARGET, name: "hm-demo-design" },
  workload: { resourceGroup: "rg-demo", ...(repositoryUrl ? { repositoryUrl } : {}) },
  instruction: "",
});

describe("formatSessionTime", () => {
  it.each([
    { when: "2026-11-11T14:05:00Z", zone: "UTC", expected: "11 Nov 14:05" },
    { when: "2026-11-11T14:05:00Z", zone: "Europe/Zurich", expected: "11 Nov 15:05" },
    { when: "2026-03-05T00:07:00Z", zone: "UTC", expected: "5 Mar 00:07" },
    { when: "2026-12-31T23:59:30Z", zone: "UTC", expected: "31 Dec 23:59" },
  ])("shows $when in $zone as $expected", ({ when, zone, expected }) => {
    expect(formatSessionTime(new Date(when), zone)).toBe(expected);
  });
});

describe("sessionTitle", () => {
  const when = new Date("2026-11-11T14:05:00Z");
  it.each([
    { name: "an Explain of an Unhealthy entity", input: explain, label: "Session Storage", state: "Unhealthy" as const, expected: "Why is Session Storage Unhealthy? (11 Nov 14:05)" },
    { name: "an Explain of a Healthy entity", input: explain, label: "Session Storage", state: "Healthy" as const, expected: "Why is Session Storage Healthy? (11 Nov 14:05)" },
    { name: "an Explain of an Unknown entity", input: explain, label: "Session Storage", state: "Unknown" as const, expected: "Why is the state of Session Storage unknown? (11 Nov 14:05)" },
    { name: "an Explain without a state", input: explain, label: "Session Storage", state: null, expected: "Why is Session Storage in this state? (11 Nov 14:05)" },
    { name: "an Explain without a display name", input: explain, label: null, state: "Degraded" as const, expected: "Why is svc-storage Degraded? (11 Nov 14:05)" },
    { name: "an Explain about a past moment", input: { ...explain, asOf: "2026-11-10T23:40:00Z" }, label: "Session Storage", state: "Unhealthy" as const, expected: "Why was Session Storage Unhealthy at 10 Nov 23:40? (11 Nov 14:05)" },
    { name: "a Review", input: review, label: null, state: null, expected: "Check hm-demo (11 Nov 14:05)" },
    { name: "a Design by the resource group", input: design(), label: null, state: null, expected: "Design for rg-demo (11 Nov 14:05)" },
    { name: "a Design by the repository", input: design("https://github.com/contoso/orders.git"), label: null, state: null, expected: "Design for contoso/orders (11 Nov 14:05)" },
  ])("titles $name by what was asked and the minute it was asked", ({ input, label, state, expected }) => {
    expect(sessionTitle(input, label, state, when, "UTC")).toBe(expected);
  });

  it("stays within the app's limit by shortening the question, never the time", () => {
    const title = sessionTitle(explain, "x".repeat(500), "Unhealthy", when, "UTC");
    expect(title).toHaveLength(SESSION_TITLE_MAX);
    expect(title.endsWith("... (11 Nov 14:05)")).toBe(true);
  });
});

const task = (seq: number, status: TaskSummary["status"]): TaskSummary => ({
  id: String(seq),
  sessionId: "s1",
  seq,
  type: "review",
  target: TARGET,
  instruction: "",
  status,
  createdAt: "2026-11-11T14:00:00Z",
});

describe("planStart", () => {
  const elsewhere = { sessionId: "s9", seq: 4 };
  it.each([
    { name: "uses the open Session that has no Task", open: { id: "s1", tasks: [task(1, "done"), task(2, "failed")] }, other: null, expected: { kind: "use", sessionId: "s1" } },
    { name: "uses an open Session that has no Tasks", open: { id: "s1", tasks: [] }, other: null, expected: { kind: "use", sessionId: "s1" } },
    { name: "uses an open Session whose Tasks are not loaded yet", open: { id: "s1", tasks: null }, other: null, expected: { kind: "use", sessionId: "s1" } },
    { name: "is blocked by a Task running in the open Session", open: { id: "s1", tasks: [task(1, "done"), task(2, "running")] }, other: null, expected: { kind: "blocked", running: { sessionId: "s1", seq: 2 } } },
    { name: "counts a queued Task as running", open: { id: "s1", tasks: [task(1, "queued")] }, other: null, expected: { kind: "blocked", running: { sessionId: "s1", seq: 1 } } },
    { name: "is blocked by a Task running in another Session even when the open one is free", open: { id: "s1", tasks: [] }, other: elsewhere, expected: { kind: "blocked", running: elsewhere } },
    { name: "creates a Session when none is open", open: null, other: null, expected: { kind: "create" } },
    { name: "creates nothing when none is open and a Task runs elsewhere", open: null, other: elsewhere, expected: { kind: "blocked", running: elsewhere } },
    { name: "names the Task of the open Session before the one elsewhere", open: { id: "s1", tasks: [task(3, "running")] }, other: elsewhere, expected: { kind: "blocked", running: { sessionId: "s1", seq: 3 } } },
  ])("$name", ({ open, other, expected }) => {
    expect(planStart(open, other)).toEqual(expected);
  });
});

describe("runningIn", () => {
  it.each([
    { tasks: [task(1, "done")], expected: undefined },
    { tasks: [task(1, "done"), task(2, "running")], expected: 2 },
    { tasks: [], expected: undefined },
  ])("finds the unfinished Task of $tasks.length Tasks", ({ tasks, expected }) => {
    expect(runningIn(tasks)?.seq).toBe(expected);
  });
});

describe("mayHoldRunningTask", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
  const listed = (id: string, taskCount: number, lastTaskAt: string | null): SessionSummary => ({ id, title: id, createdAt: ago(600), taskCount, lastTaskAt });

  it.each([
    { name: "a Session that saw a Task a minute ago", sessions: [listed("a", 1, ago(1))], expected: ["a"] },
    { name: "a Session at the edge of what a Task can run", sessions: [listed("a", 1, ago(TASK_LIFETIME_MS / 60_000 - 0.1))], expected: ["a"] },
    { name: "no Session quiet for longer than a Task can run", sessions: [listed("a", 1, ago(TASK_LIFETIME_MS / 60_000 + 1))], expected: [] },
    { name: "no Session without Tasks", sessions: [listed("a", 0, null)], expected: [] },
    { name: "no Session whose time is not a date", sessions: [listed("a", 1, "later")], expected: [] },
    { name: "the newest first", sessions: [listed("old", 1, ago(9)), listed("new", 1, ago(2)), listed("mid", 1, ago(5))], expected: ["new", "mid", "old"] },
  ])("takes $name", ({ sessions, expected }) => {
    expect(mayHoldRunningTask(sessions, now).map((item) => item.id)).toEqual(expected);
  });

  it("asks about no more than five Sessions", () => {
    const many = Array.from({ length: 9 }, (_, index) => listed(`s${index}`, 1, ago(index + 1)));
    expect(mayHoldRunningTask(many, now)).toHaveLength(5);
  });
});
