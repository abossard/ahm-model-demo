import { describe, expect, it } from "vitest";
import { STATUS_LABEL, TASK_KIND, agoWords, formatUpdated, howSure, lookedAt, momentWords, plural, proposedCount, showingMoment, stateHeading, whyQuestion } from "./wording";
import type { HealthState } from "./types";

describe("whyQuestion", () => {
  it.each<{ state: HealthState | null; subject: string | null; expected: string }>([
    { state: "Healthy", subject: null, expected: "Why is this Healthy?" },
    { state: "Degraded", subject: null, expected: "Why is this Degraded?" },
    { state: "Unhealthy", subject: null, expected: "Why is this Unhealthy?" },
    { state: "Unknown", subject: null, expected: "Why is the state unknown?" },
    { state: "Deleted", subject: null, expected: "What happened to this?" },
    { state: null, subject: null, expected: "Why is it in this state?" },
    { state: "Healthy", subject: "Session Storage", expected: "Why is Session Storage Healthy?" },
    { state: "Unhealthy", subject: "Service C", expected: "Why is Service C Unhealthy?" },
    { state: "Unknown", subject: "Session Storage", expected: "Why is the state of Session Storage unknown?" },
    { state: "Deleted", subject: "Service E", expected: "What happened to Service E?" },
    { state: null, subject: "Service C", expected: "Why is Service C in this state?" },
  ])("asks $expected for $state and $subject", ({ state, subject, expected }) => {
    expect(whyQuestion(state, subject)).toBe(expected);
  });
});

describe("the question about a past moment", () => {
  it.each<{ state: HealthState | null; subject: string | null; expected: string }>([
    { state: "Healthy", subject: null, expected: "Why was this Healthy at 23:40?" },
    { state: "Degraded", subject: null, expected: "Why was this Degraded at 23:40?" },
    { state: "Unhealthy", subject: null, expected: "Why was this Unhealthy at 23:40?" },
    { state: "Unknown", subject: null, expected: "Why was the state unknown at 23:40?" },
    { state: "Deleted", subject: null, expected: "What happened to this before 23:40?" },
    { state: null, subject: null, expected: "Why was it in this state at 23:40?" },
    { state: "Unhealthy", subject: "Service C", expected: "Why was Service C Unhealthy at 23:40?" },
    { state: "Unknown", subject: "Session Storage", expected: "Why was the state of Session Storage unknown at 23:40?" },
    { state: "Deleted", subject: "Service E", expected: "What happened to Service E before 23:40?" },
    { state: null, subject: "Service C", expected: "Why was Service C in this state at 23:40?" },
  ])("asks $expected for $state and $subject", ({ state, subject, expected }) => {
    expect(whyQuestion(state, subject, "23:40")).toBe(expected);
  });

  const at = Date.parse("2026-11-11T23:40:10Z");
  it.each([
    { name: "the clock alone on the same day", now: "2026-11-11T23:59:00Z", zone: "UTC", expected: "23:40" },
    { name: "the day with it on the next day", now: "2026-11-12T01:50:00Z", zone: "UTC", expected: "11 Nov 23:40" },
    { name: "the day of the viewer, not of UTC", now: "2026-11-12T01:50:00Z", zone: "Europe/Zurich", expected: "00:40" },
    { name: "a day of one digit", now: "2026-11-01T12:00:00Z", zone: "UTC", expected: "11 Nov 23:40" },
  ])("names a moment by $name", ({ now, zone, expected }) => {
    expect(momentWords(at, Date.parse(now), zone)).toBe(expected);
  });

  it("names the day when nothing says which day it is read on", () => {
    expect(momentWords(at, null, "UTC")).toBe("11 Nov 23:40");
  });

  it.each([
    { name: "seconds", ms: 40_000, expected: "under a minute ago" },
    { name: "a time ahead", ms: -5_000, expected: "under a minute ago" },
    { name: "minutes", ms: 12 * 60_000 + 30_000, expected: "12 min ago" },
    { name: "a whole hour", ms: 3_600_000, expected: "1 h ago" },
    { name: "hours and minutes", ms: 2 * 3_600_000 + 10 * 60_000, expected: "2 h 10 min ago" },
    { name: "a whole day", ms: 24 * 3_600_000, expected: "1 day ago" },
    { name: "days and hours", ms: (3 * 24 + 4) * 3_600_000 + 59 * 60_000, expected: "3 days 4 h ago" },
  ])("says how long ago $name were", ({ ms, expected }) => {
    expect(agoWords(ms)).toBe(expected);
  });

  it("says which moment the page shows", () => {
    expect(showingMoment(at, Date.parse("2026-11-12T01:50:10Z"), "UTC")).toBe("Showing 11 Nov 23:40:10, 2 h 10 min ago");
  });

  it.each([
    { at: null, expected: "Current state" },
    { at: "11 Nov 23:40", expected: "State at 11 Nov 23:40" },
  ])("heads the state an answer found with $expected", ({ at: when, expected }) => {
    expect(stateHeading(when)).toBe(expected);
  });
});

describe("formatUpdated", () => {
  it.each([
    { value: "2026-07-30T16:05:00Z", zone: "UTC", expected: "30 Jul 16:05:00" },
    { value: "2026-07-30T16:05:09Z", zone: "Europe/Zurich", expected: "30 Jul 18:05:09" },
    { value: "2026-11-11T00:00:00Z", zone: "UTC", expected: "11 Nov 00:00:00" },
    { value: "later", zone: "UTC", expected: "later" },
  ])("shows $value in $zone as $expected", ({ value, zone, expected }) => {
    expect(formatUpdated(value, zone)).toBe(expected);
  });
});

describe("howSure", () => {
  it.each([
    { confidence: "high" as const, label: "High", hint: "clear evidence" },
    { confidence: "medium" as const, label: "Medium", hint: "some evidence" },
    { confidence: "low" as const, label: "Low", hint: "first guess" },
  ])("words $confidence confidence as $label", ({ confidence, label, hint }) => {
    expect(howSure(confidence).label).toBe(label);
    expect(howSure(confidence).hint).toContain(hint);
  });
});

describe("lookedAt", () => {
  const to = "2026-11-11T14:05:00Z";
  const before = (minutes: number): string => new Date(Date.parse(to) - minutes * 60_000).toISOString();
  it.each([
    { name: "one minute", from: before(1), expected: "the last 1 minute (until 11 Nov 14:05)" },
    { name: "an hour", from: before(60), expected: "the last 60 minutes (until 11 Nov 14:05)" },
    { name: "three hours", from: before(180), expected: "the last 3 hours (until 11 Nov 14:05)" },
    { name: "one day", from: before(24 * 60), expected: "the last 24 hours (until 11 Nov 14:05)" },
    { name: "two days", from: before(2 * 24 * 60), expected: "the last 2 days (until 11 Nov 14:05)" },
    { name: "a week", from: before(7 * 24 * 60), expected: "the last 7 days (until 11 Nov 14:05)" },
  ])("says $name", ({ from, expected }) => {
    expect(lookedAt({ from, to }, "UTC")).toBe(expected);
  });

  it.each([
    { name: "dates that are not dates", window: { from: "then", to: "now" } },
    { name: "a window that ends before it starts", window: { from: "2026-11-11T14:05:00Z", to: "2026-11-11T13:05:00Z" } },
    { name: "an empty window", window: { from: "2026-11-11T14:05:00Z", to: "2026-11-11T14:05:00Z" } },
  ])("says nothing for $name", ({ window }) => {
    expect(lookedAt(window, "UTC")).toBeNull();
  });
});

describe("plain labels", () => {
  it.each([
    { count: 0, expected: "No changes proposed" },
    { count: 1, expected: "1 proposed change" },
    { count: 5, expected: "5 proposed changes" },
  ])("counts $count proposed changes", ({ count, expected }) => {
    expect(proposedCount(count)).toBe(expected);
  });

  it.each([
    { count: 1, expected: "1 question" },
    { count: 0, expected: "0 questions" },
    { count: 4, expected: "4 questions" },
  ])("counts $count questions", ({ count, expected }) => {
    expect(plural(count, "question")).toBe(expected);
  });

  it("names every Task type and status", () => {
    expect(Object.keys(TASK_KIND).sort()).toEqual(["design", "explain", "review"]);
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(["done", "failed", "queued", "running"]);
  });
});
