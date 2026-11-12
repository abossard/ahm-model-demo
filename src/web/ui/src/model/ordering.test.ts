import { describe, it, expect } from "vitest";
import { HEALTH_SORT_ORDER, SORT_CHOICES, orderChoices, orderEntities, orderPicked, orderWithinRanks, type SortKey } from "./ordering";
import { VIEW_IDS } from "./views";
import type { GraphLayout, NodeSize, Point } from "./layout";
import type { Entity, HealthState } from "./types";

function entity(
  name: string,
  healthState: HealthState,
  latestEvaluationAt: string | null,
): Entity {
  return {
    name,
    displayName: name,
    healthState,
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
  };
}

const ENTITIES: readonly Entity[] = [
  entity("delta", "Healthy", "2026-01-03T00:00:00Z"),
  entity("alpha", "Unhealthy", "2026-01-01T00:00:00Z"),
  entity("charlie", "Degraded", null),
  entity("bravo", "Unknown", "2026-01-02T00:00:00Z"),
];

const EXPECTED: Readonly<Record<SortKey, readonly string[]>> = {
  shortest: ["alpha", "bravo", "charlie", "delta"],
  custom: ["alpha", "bravo", "charlie", "delta"],
  name: ["alpha", "bravo", "charlie", "delta"],
  observed: ["delta", "bravo", "alpha", "charlie"],
  health: ["alpha", "charlie", "bravo", "delta"],
};

function names(items: readonly Entity[]): readonly string[] {
  return items.map((item) => item.name);
}

describe("orderEntities", () => {
  it.each(["name", "observed", "health"] as const)(
    "orders by %s and reverses exactly, keeping undated entities last",
    (key) => {
      const forward = names(orderEntities(ENTITIES, key, false));
      expect(forward).toEqual(EXPECTED[key]);
      expect(forward).not.toEqual(names(ENTITIES));

      const dated = EXPECTED[key].filter((name) => name !== "charlie" || key !== "observed");
      const reversed = names(orderEntities(ENTITIES, key, true));
      if (key === "observed") {
        expect(reversed).toEqual([...dated].reverse().concat("charlie"));
        expect(reversed.at(-1)).toBe("charlie");
      } else {
        expect(reversed).toEqual([...EXPECTED[key]].reverse());
      }
    },
  );

  it.each(["shortest", "custom"] as const)("lists entities by name for the %s arrangement, whichever way the toggle is", (key) => {
    expect(names(orderEntities(ENTITIES, key, true))).toEqual(EXPECTED[key]);
  });

  it("offers the shortest connections first", () => {
    expect(SORT_CHOICES.map((choice) => choice.key)).toEqual(["shortest", "name", "observed", "health", "custom"]);
    expect(SORT_CHOICES[0]?.label).toBe("Shortest connections");
    expect(SORT_CHOICES.at(-1)).toEqual({ key: "custom", label: "Custom" });
  });

  it("ranks health by severity, not alphabetically", () => {
    const states: readonly HealthState[] = ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"];
    const perState = states.map((state) => entity(state.toLowerCase(), state, null));

    expect(names(orderEntities(perState, "health", false))).toEqual([
      "unhealthy",
      "degraded",
      "unknown",
      "healthy",
      "deleted",
    ]);
    expect(HEALTH_SORT_ORDER).toEqual(["Unhealthy", "Degraded", "Unknown", "Healthy", "Deleted"]);
  });
});

const SIZE: NodeSize = { width: 240, height: 100 };
const SIZES: ReadonlyMap<string, NodeSize> = new Map(
  ENTITIES.map((item) => [item.name, SIZE] as const),
);

function layoutOf(entries: readonly (readonly [string, Point])[]): GraphLayout {
  return { positions: new Map(entries), width: 1200, height: 400 };
}

describe("orderWithinRanks", () => {
  it("reorders same-rank nodes along the rank axis and reverses exactly", () => {
    const layout = layoutOf([
      ["delta", { x: 0, y: 0 }],
      ["alpha", { x: 288, y: 0 }],
      ["charlie", { x: 576, y: 0 }],
      ["bravo", { x: 864, y: 0 }],
    ]);

    const forward = orderWithinRanks(layout, EXPECTED.name, "x", SIZES);
    const byX = [...forward.positions.entries()]
      .sort((a, b) => a[1].x - b[1].x)
      .map(([name]) => name);
    expect(byX).toEqual(["alpha", "bravo", "charlie", "delta"]);

    const reversed = orderWithinRanks(layout, [...EXPECTED.name].reverse(), "x", SIZES);
    const reversedByX = [...reversed.positions.entries()]
      .sort((a, b) => a[1].x - b[1].x)
      .map(([name]) => name);
    expect(reversedByX).toEqual(["delta", "charlie", "bravo", "alpha"]);

    for (const point of forward.positions.values()) expect(point.y).toBe(0);
  });

  it("never overlaps nodes of differing size on the y axis", () => {
    const layout = layoutOf([
      ["delta", { x: 0, y: 0 }],
      ["alpha", { x: 0, y: 140 }],
      ["charlie", { x: 0, y: 200 }],
    ]);
    const sizes = new Map<string, NodeSize>([
      ["delta", { width: 240, height: 120 }],
      ["alpha", { width: 240, height: 40 }],
      ["charlie", { width: 240, height: 200 }],
    ]);

    const ordered = orderWithinRanks(layout, ["charlie", "delta", "alpha"], "y", sizes);
    const rows = [...ordered.positions.entries()].sort((a, b) => a[1].y - b[1].y);

    expect(rows.map(([name]) => name)).toEqual(["charlie", "delta", "alpha"]);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (!previous || !current) continue;
      const previousBottom = previous[1].y + (sizes.get(previous[0])?.height ?? 0);
      expect(current[1].y).toBeGreaterThanOrEqual(previousBottom);
    }
  });

  it("leaves layouts without shared ranks untouched", () => {
    const layout = layoutOf([
      ["delta", { x: 10, y: 20 }],
      ["alpha", { x: 90, y: 60 }],
    ]);

    const ordered = orderWithinRanks(layout, ["alpha", "delta"], null, SIZES);
    expect(ordered.positions.get("delta")).toEqual({ x: 10, y: 20 });
    expect(ordered.positions.get("alpha")).toEqual({ x: 90, y: 60 });
  });
});

describe("the Order control in each view", () => {
  it.each([
    ["swimlanes", "shortest"],
    ["tidy", "shortest"],
    ["cause", "shortest"],
    ["outline", "health"],
    ["coverage", "name"],
  ] as const)("%s offers its own order, %s, and Custom", (view, own) => {
    expect(orderChoices(view, "shortest").choices.map((choice) => choice.key)).toEqual([...new Set([own, "custom"])].sort((left, right) => SORT_CHOICES.findIndex((choice) => choice.key === left) - SORT_CHOICES.findIndex((choice) => choice.key === right)));
    expect(orderChoices(view, "name").value).toBe(own);
    expect(orderChoices(view, "custom").value).toBe("custom");
    expect(orderChoices(view, "name").reversible).toBe(false);
  });

  it("the card graph offers every order, and turns round the ones that sort", () => {
    expect(orderChoices("zoom", "health")).toEqual({ choices: SORT_CHOICES, value: "health", reversible: true });
    expect(orderChoices("zoom", "shortest").reversible).toBe(false);
    expect(orderChoices("zoom", "custom").reversible).toBe(false);
  });

  it("offers Custom in every view, under the same word", () => {
    for (const view of VIEW_IDS) expect(orderChoices(view, "shortest").choices.find((choice) => choice.key === "custom")?.label).toBe("Custom");
  });

  it.each([
    ["the card graph sets what is picked", "zoom", "shortest", "health", "health"],
    ["any view enters Custom", "outline", "name", "custom", "custom"],
    ["another view leaving Custom gives every view its own order back", "outline", "custom", "health", "shortest"],
    ["another view picking its own order leaves the card graph's order alone", "coverage", "observed", "name", "observed"],
  ] as const)("%s", (_name, view, sortKey, picked, expected) => {
    expect(orderPicked(view, sortKey, picked)).toBe(expected);
  });
});
