// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clipText, textWidth, wrapText } from "./textMetrics";

describe("textWidth", () => {
  it.each([
    ["", 12, 400, 0],
    ["iiii", 10, 400, 4 * 0.222 * 10 * 1.1],
    ["WW", 10, 400, 2 * 0.944 * 10 * 1.1],
    ["Aa", 20, 600, (0.722 + 0.556) * 20 * 1.1],
    ["é", 10, 400, 0.62 * 10 * 1.1],
    ["日本", 10, 400, 2 * 1.0 * 10 * 1.1],
  ] as const)("%j at %d px, weight %d, is %f px", (text, size, weight, expected) => {
    expect(textWidth(text, size, weight)).toBeCloseTo(expected, 6);
  });

  it("is wider at 600 than at 400 for text with letters whose bold form is wider, and never narrower for a name", () => {
    expect(textWidth("Foundry Hosted Agent", 12.5, 600)).toBeGreaterThan(textWidth("Foundry Hosted Agent", 12.5, 400));
  });
});

describe("clipText", () => {
  it.each([
    ["short", 200, "short"],
    ["Discovered Application Topology", 80, null],
    ["Discovered Application Topology", 150, null],
  ] as const)("cuts %j to at most %d px", (text, maxWidth, expected) => {
    const clipped = clipText(text, maxWidth, { size: 11 });
    if (expected !== null) expect(clipped).toBe(expected);
    else {
      expect(clipped.endsWith("…")).toBe(true);
      expect(textWidth(clipped, 11)).toBeLessThanOrEqual(maxWidth);
      expect(text.startsWith(clipped.slice(0, -1))).toBe(true);
    }
  });
});

describe("wrapText", () => {
  const style = { size: 12.5, weight: 600 } as const;
  it.each([
    ["Run agent tasks", 400, 2, ["Run agent tasks"], false],
    ["Run agent tasks", 80, 2, ["Run agent", "tasks"], false],
    ["Run agent tasks", 45, 3, ["Run", "agent", "tasks"], false],
    ["Discovered Application Topology Of Everything", 90, 2, null, true],
    ["", 100, 2, [], false],
  ] as const)("%j in %d px and %d lines", (text, width, lines, expected, clipped) => {
    const wrapped = wrapText(text, width, style, lines);
    if (expected) expect(wrapped.lines).toEqual(expected);
    expect(wrapped.clipped).toBe(clipped);
    expect(wrapped.lines.length).toBeLessThanOrEqual(lines);
    for (const line of wrapped.lines) expect(textWidth(line, 12.5, 600)).toBeLessThanOrEqual(width + 1e-9);
  });

  it("breaks a word that is longer than the line, so no line overflows", () => {
    const wrapped = wrapText("81db2f7a-697d-c4ed-5d5f-251344a971fe", 70, style, 3);
    expect(wrapped.lines.length).toBeGreaterThan(1);
    for (const line of wrapped.lines) expect(textWidth(line, 12.5, 600)).toBeLessThanOrEqual(70 + 1e-9);
  });
});
