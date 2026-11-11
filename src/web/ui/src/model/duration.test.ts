import { describe, expect, it } from "vitest";
import { formatDuration, formatOffset, formatWhen, taskDuration } from "./duration";

describe("formatDuration", () => {
  it.each([
    [0, "under 1 s"],
    [999, "under 1 s"],
    [1000, "1 s"],
    [59_999, "59 s"],
    [60_000, "1 min 00 s"],
    [185_000, "3 min 05 s"],
    [3_599_000, "59 min 59 s"],
    [3_600_000, "1 h 00 min"],
    [7_380_000, "2 h 03 min"],
    [-5, "under 1 s"],
  ])("formats %d ms as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

describe("formatOffset", () => {
  it.each([
    [0, "+0:00"],
    [12_000, "+0:12"],
    [65_000, "+1:05"],
    [3_725_000, "+62:05"],
  ])("formats %d ms as %s", (milliseconds, expected) => {
    expect(formatOffset(milliseconds)).toBe(expected);
  });
});

describe("taskDuration", () => {
  const NOW = Date.parse("2026-11-10T10:10:00Z");
  it.each([
    { name: "a finished Task", task: { createdAt: "2026-11-10T10:00:00Z", finishedAt: "2026-11-10T10:03:05Z" }, expected: 185_000 },
    { name: "a running Task", task: { createdAt: "2026-11-10T10:08:00Z" }, expected: 120_000 },
    { name: "a start in the future", task: { createdAt: "2026-11-10T10:20:00Z" }, expected: 0 },
    { name: "a start that is not a date", task: { createdAt: "soon" }, expected: null },
    { name: "an end that is not a date", task: { createdAt: "2026-11-10T10:00:00Z", finishedAt: "later" }, expected: null },
  ])("measures $name", ({ task, expected }) => {
    expect(taskDuration(task, NOW)).toBe(expected);
  });
});

describe("formatWhen", () => {
  it.each([
    { name: "a date and time", value: "2026-11-10T10:03:05Z", expected: "10 Nov 2026, 10:03" },
    { name: "no date", value: null, expected: "never" },
    { name: "text that is not a date", value: "soon", expected: "soon" },
  ])("shows $name", ({ value, expected }) => {
    expect(formatWhen(value, "UTC")).toBe(expected);
  });
});
