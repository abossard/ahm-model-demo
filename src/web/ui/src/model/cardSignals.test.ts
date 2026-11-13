import { describe, expect, it } from "vitest";
import { sparkline } from "./cardSignals";
import type { Point, SignalInfo } from "./timeline";
import { HOUR, MINUTE } from "./timelineScale";

const signal = (refreshInterval: string, degraded: number | null): SignalInfo => ({
  name: "cpu",
  displayName: "CPU",
  kind: "metric",
  unit: "%",
  refreshInterval,
  rules: { degraded: degraded === null ? null : { operator: "GreaterThan", threshold: degraded }, unhealthy: null, dynamic: false },
});

describe("sparkline", () => {
  it.each([
    {
      name: "a line that turns degraded is cut where it crosses the threshold, and the moment is marked in the colour it ends in",
      points: [[0, 50, 1], [2 * HOUR, 50, 1], [4 * HOUR, 90, 2]] as Point[],
      info: signal("PT1H", 70),
      span: { from: 0, to: 4 * HOUR },
      paths: [
        { level: 1, d: "M0 6.7L27 6.7L40.5 4.4" },
        { level: 2, d: "M40.5 4.4L54 2.1" },
      ],
      marker: { x: 54, y: 2.1, level: 2 },
    },
    {
      name: "a point before the window brings the line in at its left edge",
      points: [[-40 * MINUTE, 50, 1], [HOUR, 50, 1]] as Point[],
      info: signal("PT1H", null),
      span: { from: 0, to: 2 * HOUR },
      paths: [{ level: 1, d: "M-18 2.1L27 2.1" }],
      marker: { x: 54, y: 2.1, level: 1 },
    },
    {
      name: "a lone evaluation is a dot, and one that no longer holds at the moment leaves it unmarked",
      points: [[0, 50, 1]] as Point[],
      info: signal("PT5M", null),
      span: { from: 0, to: 4 * HOUR },
      paths: [{ level: 1, d: "M0 2.1h0" }],
      marker: null,
    },
    {
      name: "a window with no value is empty",
      points: [[-HOUR, 50, 1], [10 * MINUTE, null, 0]] as Point[],
      info: signal("PT5M", null),
      span: { from: HOUR, to: 4 * HOUR },
      paths: [],
      marker: null,
    },
  ])("$name", ({ points, info, span, paths, marker }) => {
    expect(sparkline(points, info, span)).toEqual({ paths, marker });
  });
});
