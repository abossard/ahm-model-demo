import { describe, it, expect } from "vitest";
import { attachmentPoint, pickSides, sidesFor, type Rect } from "./edgeRouting";
import { LAYOUT_ENGINES } from "./layout";
import { buildEdges } from "../components/Topology";
import type { FloatingEdgeData } from "../components/FloatingEdge";
import { healthModel } from "../../tests/fixture";

function card(x: number, y: number): Rect {
  return { x, y, width: 260, height: 120 };
}

const ORIGIN = card(0, 0);
const SVC_B: Rect = { x: 55, y: 407.8796081542969, width: 275.65045166015625, height: 91.17669677734375 };
const SVC_C: Rect = { x: 218.2698974609375, y: 575.3902587890625, width: 275.65045166015625, height: 50.88934326171875 };

describe("pickSides", () => {
  it.each([
    ["below", card(0, 400), "bottom", "top"],
    ["above", card(0, -400), "top", "bottom"],
    ["right of", card(600, 0), "right", "left"],
    ["left of", card(-600, 0), "left", "right"],
    ["down and right", card(600, 900), "bottom", "top"],
    ["up and left", card(-900, -200), "left", "right"],
  ] as const)("faces the boundary towards a card %s", (_where, other, sourceSide, targetSide) => {
    expect(pickSides(ORIGIN, other)).toEqual({ sourceSide, targetSide });
  });

  it("faces the separated axis when the other axis overlaps", () => {
    expect(pickSides(SVC_B, SVC_C)).toEqual({ sourceSide: "bottom", targetSide: "top" });
    const wide = { x: 0, y: 0, width: 100, height: 400 };
    const beside = { x: 300, y: 260, width: 100, height: 400 };
    expect(pickSides(wide, beside)).toEqual({ sourceSide: "right", targetSide: "left" });
  });

  it("resolves a collinear pair to one deterministic side", () => {
    const diagonal = { x: 300, y: 300, width: 260, height: 120 };
    expect(pickSides(ORIGIN, diagonal)).toEqual({ sourceSide: "bottom", targetSide: "top" });
    expect(pickSides(ORIGIN, ORIGIN)).toEqual({ sourceSide: "bottom", targetSide: "top" });
  });
});

describe("connection policies", () => {
  it.each([
    ["dagre-lr", "right", "left"],
    ["dagre-rl", "left", "right"],
    ["dagre-tb", "bottom", "top"],
    ["dagre-bt", "top", "bottom"],
    ["elk-layered", "bottom", "top"],
    ["elk-radial", "bottom", "top"],
    ["d3-force", "bottom", "top"],
  ] as const)("follows %s even when the target is vertically offset", (layout, sourceSide, targetSide) => {
    expect(sidesFor("with-layout", LAYOUT_ENGINES[layout].flow, ORIGIN, card(360, 600)))
      .toEqual({ sourceSide, targetSide });
  });

  it.each([
    ["free", "lr", "bottom", "top"],
    ["lr", "free", "right", "left"],
    ["rl", "tb", "left", "right"],
    ["tb", "lr", "bottom", "top"],
    ["bt", "lr", "top", "bottom"],
  ] as const)("lets %s override %s", (policy, flow, sourceSide, targetSide) => {
    expect(sidesFor(policy, flow, ORIGIN, card(360, 600))).toEqual({ sourceSide, targetSide });
  });
});

describe("attachmentPoint", () => {
  it.each(["top", "bottom", "left", "right"] as const)(
    "distributes crowded %s ports without merging or leaving the boundary",
    (side) => {
      const points = Array.from({ length: 21 }, (_, i) => attachmentPoint(ORIGIN, side, i - 10, 21));
      const vertical = side === "top" || side === "bottom";
      const positions = points.map((p) => vertical ? p.x : p.y);
      expect(new Set(positions).size).toBe(21);
      expect(positions[0]).toBe(18);
      expect(positions[20]).toBe((vertical ? ORIGIN.width : ORIGIN.height) - 18);
      expect(points.every((p) => vertical
        ? p.y === (side === "top" ? 0 : ORIGIN.height)
        : p.x === (side === "left" ? 0 : ORIGIN.width))).toBe(true);
    },
  );

  it("sits on the named boundary and clamps a far lane inside the corner", () => {
    expect(attachmentPoint(ORIGIN, "top")).toEqual({ x: 130, y: 0 });
    expect(attachmentPoint(ORIGIN, "bottom")).toEqual({ x: 130, y: 120 });
    expect(attachmentPoint(ORIGIN, "left")).toEqual({ x: 0, y: 60 });
    expect(attachmentPoint(ORIGIN, "right")).toEqual({ x: 260, y: 60 });
    expect(attachmentPoint(ORIGIN, "top", 40)).toEqual({ x: 242, y: 0 });
  });

  it("assigns independent fan-out and fan-in ports through the rendered edge builder", () => {
    const rects = new Map([
      ["svc-a", ORIGIN], ["svc-b", card(520, -120)],
      ["svc-d", card(520, 180)], ["svc-c", card(1040, 0)],
    ]);
    const edges = buildEdges(healthModel.relationships,
      new Map(healthModel.entities.map((entity) => [entity.name, entity])), rects, "lr");
    const endpoints = edges.map((edge) => {
      const data = edge.data as FloatingEdgeData;
      expect(data.style).toBe("smooth");
      expect([data.sourceSide, data.targetSide]).toEqual(["right", "left"]);
      return {
        id: edge.id,
        from: attachmentPoint(rects.get(edge.source)!, data.sourceSide, data.sourceLane, data.sourceLaneCount),
        to: attachmentPoint(rects.get(edge.target)!, data.targetSide, data.targetLane, data.targetLaneCount),
      };
    });

    expect(endpoints.filter((edge) => ["r1", "r3"].includes(edge.id)).map((edge) => edge.from))
      .toEqual([{ x: 260, y: 52 }, { x: 260, y: 68 }]);
    expect(endpoints.filter((edge) => ["r2", "r4"].includes(edge.id)).map((edge) => edge.to))
      .toEqual([{ x: 1040, y: 52 }, { x: 1040, y: 68 }]);
  });
});
