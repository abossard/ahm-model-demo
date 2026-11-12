import { describe, expect, it } from "vitest";
import { momentFromSearch, timelineFromSearch, timelineParams } from "./timelineUrl";

const FROM = Date.parse("2026-11-10T10:00:00Z");
const TO = Date.parse("2026-11-10T12:00:00Z");

describe("timelineFromSearch", () => {
  it.each([
    { name: "no timeline", search: "?model=m", expected: { open: false, view: null, follow: false, span: null, fullscreen: false, at: null } },
    { name: "timeline=0", search: "?timeline=0&from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z", expected: { open: false, view: null, follow: false, span: null, fullscreen: false, at: null } },
    { name: "open without a window", search: "?timeline=1", expected: { open: true, view: null, follow: false, span: null, fullscreen: false, at: null } },
    { name: "an ISO window", search: "?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z", expected: { open: true, view: { t0: FROM, t1: TO }, follow: false, span: null, fullscreen: false, at: null } },
    { name: "an epoch window", search: `?timeline=1&from=${FROM}&to=${TO}`, expected: { open: true, view: { t0: FROM, t1: TO }, follow: false, span: null, fullscreen: false, at: null } },
    { name: "a reversed window", search: "?timeline=1&from=2026-11-10T12:00:00Z&to=2026-11-10T10:00:00Z", expected: { open: true, view: null, follow: false, span: null, fullscreen: false, at: null } },
    { name: "a window under a minute", search: "?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-10T10:00:30Z", expected: { open: true, view: null, follow: false, span: null, fullscreen: false, at: null } },
    { name: "a window that is no time", search: "?timeline=1&from=soon&to=later", expected: { open: true, view: null, follow: false, span: null, fullscreen: false, at: null } },
    { name: "half a window", search: "?timeline=1&from=2026-11-10T10:00:00Z", expected: { open: true, view: null, follow: false, span: null, fullscreen: false, at: null } },
  ])("reads $name", ({ search, expected }) => {
    expect(timelineFromSearch(search)).toEqual(expected);
  });
});

describe("timelineParams", () => {
  it.each([
    { name: "closed", open: false, view: { t0: FROM, t1: TO }, expected: {} },
    { name: "open without a window", open: true, view: null, expected: { timeline: "1" } },
    { name: "open with one", open: true, view: { t0: FROM + 0.4, t1: TO }, expected: { timeline: "1", from: "2026-11-10T10:00:00.000Z", to: "2026-11-10T12:00:00.000Z" } },
  ])("writes $name", ({ open, view, expected }) => {
    expect(timelineParams(open, view)).toEqual(expected);
  });

  it.each([
    { name: "a live window is its length, not its edges", view: { t0: FROM, t1: TO }, follow: true, expected: { timeline: "1", live: "1", span: "7200000" } },
    { name: "a live link without a window is just open", view: null, follow: true, expected: { timeline: "1" } },
  ])("writes $name", ({ view, follow, expected }) => {
    expect(timelineParams(true, view, follow)).toEqual(expected);
  });

  it("a live link reads back as a following window of that length", () => {
    const text = new URLSearchParams(timelineParams(true, { t0: FROM, t1: TO }, true)).toString();

    expect(timelineFromSearch(`?${text}`)).toEqual({ open: true, view: null, follow: true, span: 7_200_000, fullscreen: false, at: null });
    expect(timelineFromSearch("?timeline=1&live=1&span=5")).toMatchObject({ follow: true, span: null });
    expect(timelineFromSearch("?timeline=1&span=7200000")).toMatchObject({ follow: false, span: null, fullscreen: false });
  });

  it.each([
    { name: "a window", view: { t0: FROM, t1: TO }, follow: false, expected: { timeline: "1", from: "2026-11-10T10:00:00.000Z", to: "2026-11-10T12:00:00.000Z", fullscreen: "1" } },
    { name: "a live window", view: { t0: FROM, t1: TO }, follow: true, expected: { timeline: "1", live: "1", span: "7200000", fullscreen: "1" } },
    { name: "no window", view: null, follow: false, expected: { timeline: "1", fullscreen: "1" } },
  ])("writes full screen with $name, and reads it back", ({ view, follow, expected }) => {
    const params = timelineParams(true, view, follow, true);

    expect(params).toEqual(expected);
    expect(timelineFromSearch(`?${new URLSearchParams(params).toString()}`).fullscreen).toBe(true);
  });

  it.each([
    { name: "closed, full screen is not written", open: false, fullscreen: true, expected: {} },
    { name: "open, full screen off is not written", open: true, fullscreen: false, expected: { timeline: "1" } },
  ])("$name", ({ open, fullscreen, expected }) => {
    expect(timelineParams(open, null, false, fullscreen)).toEqual(expected);
  });

  it("reads full screen only when the timeline is open", () => {
    expect(timelineFromSearch("?timeline=1&fullscreen=1").fullscreen).toBe(true);
    expect(timelineFromSearch("?timeline=1&fullscreen=0").fullscreen).toBe(false);
    expect(timelineFromSearch("?fullscreen=1").fullscreen).toBe(false);
  });

  it("what it writes it reads back", () => {
    const text = new URLSearchParams(timelineParams(true, { t0: FROM, t1: TO })).toString();

    expect(timelineFromSearch(`?${text}`)).toEqual({ open: true, view: { t0: FROM, t1: TO }, follow: false, span: null, fullscreen: false, at: null });
  });
});

describe("the selected moment in the address", () => {
  const NOW = Date.parse("2026-11-12T01:50:00Z");
  const AT = Date.parse("2026-11-11T23:40:00Z");

  it.each([
    { name: "an ISO moment", search: "?timeline=1&at=2026-11-11T23:40:00.000Z", expected: AT },
    { name: "an epoch moment", search: `?timeline=1&at=${AT}`, expected: AT },
    { name: "a moment alone", search: "?at=2026-11-11T23:40:00Z", expected: AT },
    { name: "now itself", search: "?at=2026-11-12T01:50:00Z", expected: NOW },
    { name: "the oldest the service keeps", search: "?at=2026-10-13T01:50:00Z", expected: NOW - 30 * 24 * 3_600_000 },
    { name: "no moment", search: "?timeline=1", expected: null },
    { name: "a moment in the future", search: "?at=2026-11-12T01:50:01Z", expected: null },
    { name: "a moment older than the service keeps", search: "?at=2026-10-13T01:49:59Z", expected: null },
    { name: "a moment that is no time", search: "?at=yesterday", expected: null },
    { name: "an empty moment", search: "?at=", expected: null },
  ])("reads $name", ({ search, expected }) => {
    expect(momentFromSearch(search, NOW)).toBe(expected);
    expect(timelineFromSearch(search, NOW).at).toBe(expected);
  });

  it.each([
    { name: "a moment opens the timeline it is selected in", search: "?at=2026-11-11T23:40:00Z", open: true },
    { name: "a moment the page cannot show opens nothing", search: "?at=2020-01-01T00:00:00Z", open: false },
  ])("$name", ({ search, open }) => {
    expect(timelineFromSearch(search, NOW).open).toBe(open);
  });

  it.each([
    { name: "with a window", view: { t0: FROM, t1: TO }, follow: false, fullscreen: false, expected: { timeline: "1", from: "2026-11-10T10:00:00.000Z", to: "2026-11-10T12:00:00.000Z", at: "2026-11-11T23:40:00.000Z" } },
    { name: "with a window that followed now", view: { t0: FROM, t1: TO }, follow: true, fullscreen: false, expected: { timeline: "1", live: "1", span: "7200000", at: "2026-11-11T23:40:00.000Z" } },
    { name: "in full screen", view: null, follow: false, fullscreen: true, expected: { timeline: "1", fullscreen: "1", at: "2026-11-11T23:40:00.000Z" } },
  ])("writes the moment $name, and reads it back", ({ view, follow, fullscreen, expected }) => {
    const params = timelineParams(true, view, follow, fullscreen, AT + 0.4);

    expect(params).toEqual(expected);
    expect(timelineFromSearch(`?${new URLSearchParams(params).toString()}`, NOW)).toMatchObject({ open: true, at: AT, follow, fullscreen });
  });

  it("a closed timeline has no moment to write", () => {
    expect(timelineParams(false, null, false, false, AT)).toEqual({});
  });
});
