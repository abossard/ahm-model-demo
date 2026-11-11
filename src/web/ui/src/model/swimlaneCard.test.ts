// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CHIP_ROW, HEADER_MIN, HEADER_PAD, MAX_SIGNAL_ROWS, MAX_WIDTH, MIN_WIDTH, ROWS_PAD_BOTTOM, ROWS_PAD_TOP, SIGNAL_ROW, SUMMARY_ROW, foldWidth, measureCard, pillOf } from "./swimlaneCard";
import { textWidth } from "./textMetrics";
import type { Entity, EntitySignal, HealthState } from "./types";

const signal = (name: string, healthState: HealthState, value: EntitySignal["value"] = 1): EntitySignal => ({ name, displayName: name, kind: "metric", healthState, value, reportedAt: null, writable: false });

function entity(patch: Partial<Entity> = {}): Entity {
  return { name: "e", displayName: "Entity", healthState: "Healthy", impact: "Standard", canvasPosition: null, discoveredBy: null, parents: [], children: [], unlinked: false, latestEvaluationAt: null, latestTransitionAt: null, signals: [], report: { eligible: true, signalName: null }, ...patch };
}

describe("measureCard", () => {
  it("is the minimum size for a short name and nothing to list", () => {
    const spec = measureCard(entity(), "all");
    expect(spec.width).toBe(MIN_WIDTH);
    expect(spec.height).toBe(HEADER_MIN);
    expect(spec.nameLines).toEqual(["Entity"]);
    expect(spec.rows).toEqual([]);
    expect(spec.summary).toBeNull();
  });

  it("grows with the name up to a limit, then wraps it onto two lines and ends the second with an ellipsis if it must", () => {
    const wide = measureCard(entity({ displayName: "Foundry Hosted Agent" }), "all");
    expect(wide.width).toBeGreaterThan(MIN_WIDTH);
    expect(wide.nameLines).toHaveLength(1);
    const long = measureCard(entity({ displayName: "Discovered Application Topology of the Whole Contoso Shop Workload" }), "all");
    expect(long.width).toBe(MAX_WIDTH);
    expect(long.nameLines).toHaveLength(2);
    expect(long.nameLines[1]?.endsWith("…")).toBe(true);
    expect(long.height).toBeGreaterThan(HEADER_MIN);
  });

  it("falls back to the entity's name when it has no display name", () => {
    expect(measureCard(entity({ displayName: "", name: "81db2f7a" }), "all").nameLines).toEqual(["81db2f7a"]);
  });

  it.each([
    ["Limited impact", { impact: "Limited" }, ["Limited impact"]],
    ["Suppressed", { impact: "Suppressed" }, ["Suppressed"]],
    ["Standard", { impact: "Standard" }, []],
  ] as const)("shows a chip for %s", (_name, patch, words) => {
    const spec = measureCard(entity(patch), "all");
    expect(spec.chips.map((chip) => chip.word)).toEqual(words);
    expect(spec.headerHeight).toBe(words.length > 0 ? HEADER_PAD + 20 + CHIP_ROW + HEADER_PAD : HEADER_MIN);
  });

  it("puts a diff badge before the impact chip", () => {
    const spec = measureCard(entity({ impact: "Limited" }), "all", "changed");
    expect(spec.chips.map((chip) => [chip.kind, chip.word])).toEqual([["diff", "Changed"], ["impact", "Limited impact"]]);
  });

  describe("signal rows", () => {
    const signals = [signal("Ok one", "Healthy"), signal("Slow", "Degraded", 4.090909), signal("Down", "Unhealthy", 0), signal("Ok two", "Healthy"), signal("No data", "Unknown", null)];

    it.each([
      ["all", ["Down", "Slow", "No data", "Ok one", "Ok two"], null],
      ["problems", ["Down", "Slow", "No data"], "+2 healthy signals"],
      ["none", [], null],
    ] as const)("lists %s: the worst first, and says what it leaves out", (mode, names, summary) => {
      const spec = measureCard(entity({ signals }), mode);
      expect(spec.rows.map((row) => row.name)).toEqual(names);
      expect(spec.summary).toBe(summary);
      const region = names.length > 0 || summary !== null;
      expect(spec.height).toBe(HEADER_MIN + (region ? 1 + ROWS_PAD_TOP + names.length * SIGNAL_ROW + (summary ? SUMMARY_ROW : 0) + ROWS_PAD_BOTTOM : 0));
    });

    it("rounds a value to what a row can hold, and leaves an empty one empty", () => {
      const spec = measureCard(entity({ signals }), "all");
      expect(spec.rows.find((row) => row.name === "Slow")?.value).toBe("4.091");
      expect(spec.rows.find((row) => row.name === "No data")?.value).toBe("");
    });

    it("lists at most as many rows as it has room for and counts the rest", () => {
      const many = Array.from({ length: MAX_SIGNAL_ROWS + 3 }, (_unused, index) => signal(`S${index}`, "Healthy"));
      const spec = measureCard(entity({ signals: many }), "all");
      expect(spec.rows).toHaveLength(MAX_SIGNAL_ROWS);
      expect(spec.summary).toBe("+3 more");
    });

    it("is wide enough for its widest row", () => {
      const spec = measureCard(entity({ signals: [signal("A signal with quite a long display name indeed", "Healthy", 99.98)] }), "all");
      expect(spec.width).toBeGreaterThan(MIN_WIDTH);
    });
  });
});

describe("pillOf and foldWidth", () => {
  it.each([
    ["", null],
    ["   ", null],
  ] as const)("gives %j no pill", (label, expected) => {
    expect(pillOf(label)).toBe(expected);
  });

  it("measures a label with room around it and cuts one that would be too long to dodge", () => {
    const short = pillOf("serves");
    expect(short?.text).toBe("serves");
    expect(short?.width).toBe(Math.ceil(textWidth("serves", 10.5) + 14));
    const long = pillOf("supplements the model with everything that discovery finds in the workload");
    expect(long?.text.endsWith("…")).toBe(true);
    expect(long?.width).toBeLessThan(180);
  });

  it("has a minimum width for a chip", () => {
    expect(foldWidth("+2 healthy")).toBeGreaterThanOrEqual(112);
    expect(foldWidth("Hide 12 healthy")).toBeGreaterThanOrEqual(foldWidth("+2 healthy"));
  });
});
