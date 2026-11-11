import { describe, expect, it } from "vitest";
import { LEVEL_FLOORS, LEVEL_HEIGHT, SEMANTIC_FIT_AT, SEMANTIC_MIN_ZOOM, fitFloor, zoomLevel, type ZoomLevel } from "./zoomLevels";

describe("zoomLevel", () => {
  it.each([
    [undefined, "card"],
    [2, "card"],
    [1, "card"],
    [0.5, "card"],
    [0.4999999, "card"],
    [0.495, "card"],
    [0.494, "pill"],
    [0.3, "pill"],
    [0.28, "pill"],
    [0.279, "dot"],
    [0.15, "dot"],
    [0.149, "speck"],
    [SEMANTIC_MIN_ZOOM, "speck"],
  ] as readonly (readonly [number | undefined, ZoomLevel])[])("draws a card at zoom %s as a %s", (zoom, expected) => {
    expect(zoomLevel(zoom)).toBe(expected);
  });

  it("keeps the floors in descending order and the sizes ahead of the layout's rows", () => {
    expect(LEVEL_FLOORS.card).toBeGreaterThan(LEVEL_FLOORS.pill);
    expect(LEVEL_FLOORS.pill).toBeGreaterThan(LEVEL_FLOORS.dot);
    expect(SEMANTIC_MIN_ZOOM).toBeLessThan(LEVEL_FLOORS.dot);
    for (const height of Object.values(LEVEL_HEIGHT)) expect(height).toBeGreaterThan(30);
  });
});

describe("fitFloor", () => {
  it.each([
    [1, 0.5],
    [17, 0.5],
    [SEMANTIC_FIT_AT, 0.5],
    [SEMANTIC_FIT_AT + 1, SEMANTIC_MIN_ZOOM],
    [300, SEMANTIC_MIN_ZOOM],
  ])("lets a model of %s entities open as far out as %s", (entities, expected) => {
    expect(fitFloor(entities)).toBe(expected);
  });
});
