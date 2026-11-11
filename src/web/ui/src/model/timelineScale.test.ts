import { describe, expect, it } from "vitest";
import {
  DAY,
  HOUR,
  MINUTE,
  MIN_SPAN,
  brushView,
  clampView,
  cursorStep,
  formatClock,
  formatDay,
  formatInstant,
  makeScale,
  padView,
  panBy,
  presetOf,
  presetView,
  sameView,
  tickStep,
  timeTicks,
  zoomAt,
} from "./timelineScale";

const BOUNDS = { lo: 0, hi: 30 * DAY };

describe("clampView", () => {
  it.each([
    { name: "inside stays", view: { t0: DAY, t1: 2 * DAY }, expected: { t0: DAY, t1: 2 * DAY } },
    { name: "past the end slides back", view: { t0: 29.5 * DAY, t1: 31 * DAY }, expected: { t0: 28.5 * DAY, t1: 30 * DAY } },
    { name: "before the start slides forward", view: { t0: -DAY, t1: DAY }, expected: { t0: 0, t1: 2 * DAY } },
    { name: "narrower than a minute is widened", view: { t0: DAY, t1: DAY + 10 }, expected: { t0: DAY, t1: DAY + MIN_SPAN } },
    { name: "wider than the bounds is the bounds", view: { t0: -DAY, t1: 40 * DAY }, expected: { t0: 0, t1: 30 * DAY } },
  ])("a window $name", ({ view, expected }) => {
    expect(clampView(view, BOUNDS)).toEqual(expected);
  });
});

describe("zoomAt", () => {
  const view = { t0: 10 * DAY, t1: 11 * DAY };

  it.each([0, 0.25, 0.5, 1])("keeps the instant at %d of the width where it was when zooming in or out", (fraction) => {
    const anchor = view.t0 + fraction * (view.t1 - view.t0);
    for (const factor of [0.5, 2, 0.1]) {
      const next = zoomAt(view, anchor, factor, BOUNDS);

      expect((anchor - next.t0) / (next.t1 - next.t0)).toBeCloseTo(fraction, 6);
      expect(next.t1 - next.t0).toBeCloseTo((view.t1 - view.t0) * factor, 3);
    }
  });

  it.each([
    { name: "never narrower than a minute", factor: 1e-9, span: MIN_SPAN },
    { name: "never wider than the bounds", factor: 1e9, span: 30 * DAY },
  ])("zoom is $name", ({ factor, span }) => {
    const next = zoomAt(view, view.t0 + DAY / 2, factor, BOUNDS);

    expect(next.t1 - next.t0).toBe(span);
  });
});

describe("panBy and brushView", () => {
  it.each([
    { name: "moves", dt: HOUR, expected: { t0: 10 * DAY + HOUR, t1: 11 * DAY + HOUR } },
    { name: "stops at the newest instant", dt: 100 * DAY, expected: { t0: 29 * DAY, t1: 30 * DAY } },
    { name: "stops at the oldest instant", dt: -100 * DAY, expected: { t0: 0, t1: DAY } },
  ])("panning $name", ({ dt, expected }) => {
    expect(panBy({ t0: 10 * DAY, t1: 11 * DAY }, dt, BOUNDS)).toEqual(expected);
  });

  it.each([
    { name: "either order", a: 5 * DAY + HOUR, b: 5 * DAY, expected: { t0: 5 * DAY, t1: 5 * DAY + HOUR } },
    { name: "a click is a minute", a: 5 * DAY, b: 5 * DAY, expected: { t0: 5 * DAY - 30_000, t1: 5 * DAY + 30_000 } },
  ])("a brush with $name", ({ a, b, expected }) => {
    expect(brushView(a, b, BOUNDS)).toEqual(expected);
  });

  it("padView adds a quarter either side", () => {
    expect(padView(10 * DAY, 10 * DAY + 4 * HOUR, BOUNDS)).toEqual({ t0: 10 * DAY - HOUR, t1: 10 * DAY + 5 * HOUR });
  });
});

describe("presets", () => {
  const bounds = { lo: 20 * DAY, hi: 30 * DAY };

  it.each([
    ["1h", HOUR],
    ["6h", 6 * HOUR],
    ["24h", DAY],
    ["7d", 7 * DAY],
    ["all", 10 * DAY],
  ] as const)("%s spans its length and ends now", (id, span) => {
    const view = presetView(id, bounds);

    expect(view.t1).toBe(bounds.hi);
    expect(view.t1 - view.t0).toBe(span);
    expect(presetOf(view, bounds)).toBe(id);
  });

  it("a window that is no preset names none", () => {
    expect(presetOf({ t0: 25 * DAY, t1: 26 * DAY }, bounds)).toBeNull();
    expect(presetOf({ t0: bounds.hi - 3 * HOUR, t1: bounds.hi }, bounds)).toBeNull();
  });

  it("a history shorter than the preset shows all of it", () => {
    expect(presetView("7d", { lo: 29 * DAY, hi: 30 * DAY })).toEqual({ t0: 29 * DAY, t1: 30 * DAY });
  });
});

describe("scale", () => {
  it("maps time to pixels and back", () => {
    const scale = makeScale({ t0: 1000, t1: 3000 }, 400);

    expect(scale.x(1000)).toBe(0);
    expect(scale.x(3000)).toBe(400);
    expect(scale.x(2000)).toBe(200);
    expect(scale.t(100)).toBe(1500);
    expect(scale.pxPerMs).toBe(0.2);
  });

  it.each([
    [{ t0: 0, t1: 10 }, { t0: 0, t1: 10 }, true],
    [{ t0: 0, t1: 10 }, { t0: 1, t1: 10 }, true],
    [{ t0: 0, t1: 10 }, { t0: 2, t1: 10 }, false],
  ])("compares %j and %j as the same: %s", (a, b, same) => {
    expect(sameView(a, b)).toBe(same);
  });
});

describe("ticks", () => {
  it.each([
    { span: HOUR, width: 800, step: 10 * MINUTE },
    { span: DAY, width: 800, step: 3 * HOUR },
    { span: 7 * DAY, width: 800, step: DAY },
    { span: 30 * DAY, width: 800, step: 7 * DAY },
    { span: 5 * MINUTE, width: 800, step: 30_000 },
  ])("a $span ms window $width px wide steps by $step ms", ({ span, width, step }) => {
    expect(tickStep(span, width, 80)).toBe(step);
  });

  it("falls on local clock boundaries in the zone it is given", () => {
    const view = { t0: Date.UTC(2026, 10, 10, 10, 7), t1: Date.UTC(2026, 10, 10, 12, 0) };

    const ticks = timeTicks(view, 600, 90, -120);

    expect(ticks.map((tick) => tick.label)).toEqual(["12:30", "13:00", "13:30", "14:00"]);
    expect(ticks.every((tick) => tick.t >= view.t0 && tick.t <= view.t1)).toBe(true);
  });

  it("labels a local midnight with the day and marks it major", () => {
    const view = { t0: Date.UTC(2026, 10, 10, 20, 0), t1: Date.UTC(2026, 10, 11, 4, 0) };

    const ticks = timeTicks(view, 900, 80, 0);

    expect(ticks.filter((tick) => tick.major).map((tick) => tick.label)).toEqual(["Nov 11"]);
  });

  it.each([
    [Date.UTC(2026, 10, 10, 9, 5, 7), 0, false, "09:05"],
    [Date.UTC(2026, 10, 10, 9, 5, 7), 0, true, "09:05:07"],
    [Date.UTC(2026, 10, 10, 23, 30), -60, false, "00:30"],
    [Date.UTC(2026, 10, 10, 1, 30), 300, false, "20:30"],
  ])("formats %d at offset %d (seconds %s) as %s", (t, offset, seconds, expected) => {
    expect(formatClock(t, offset, seconds)).toBe(expected);
  });

  it("formats a day and an instant", () => {
    const t = Date.UTC(2026, 10, 10, 9, 5, 7);

    expect(formatDay(t, 0)).toBe("Nov 10");
    expect(formatInstant(t, 0)).toBe("Nov 10 09:05:07");
  });

  it.each([
    [DAY, false, 144_000],
    [DAY, true, 1_440_000],
    [HOUR, false, 6000],
    [MINUTE, false, 1000],
  ])("a cursor step in a %d ms window (fast %s) is %d ms", (span, fast, expected) => {
    expect(cursorStep(span, fast)).toBe(expected);
  });
});
