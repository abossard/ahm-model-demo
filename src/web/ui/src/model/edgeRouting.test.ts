import { describe, it, expect } from "vitest";
import { attachmentPoint, edgePorts, pickSides, sidesFor, spreadPorts, CONNECTION_POLICY_CHOICES, type ConnectionPolicy, type LayoutFlow, type Rect, type Side } from "./edgeRouting";
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

function at(x: number, y: number, width = 260, height = 120): Rect {
  return { x, y, width, height };
}

describe("spreadPorts", () => {
  it.each([
    ["one neighbour sits in the middle", "bottom", [["a", at(0, 400)]], { a: 0 }],
    ["neighbours left to right below", "bottom", [["c", at(600, 400)], ["a", at(0, 400)], ["b", at(300, 400)]], { a: -1, b: 0, c: 1 }],
    ["neighbours left to right above", "top", [["c", at(600, -400)], ["a", at(0, -400)], ["b", at(300, -400)]], { a: -1, b: 0, c: 1 }],
    ["neighbours top to bottom on the right", "right", [["c", at(500, 600)], ["a", at(500, 0)], ["b", at(500, 300)]], { a: -1, b: 0, c: 1 }],
    ["neighbours top to bottom on the left", "left", [["b", at(-500, 300)], ["c", at(-500, 600)], ["a", at(-500, 0)]], { a: -1, b: 0, c: 1 }],
    ["two neighbours at once", "bottom", [["right", at(400, 400)], ["left", at(-400, 400)]], { left: -0.5, right: 0.5 }],
    ["a neighbour further down breaks a tie across the side", "bottom", [["far", at(100, 900)], ["near", at(100, 400)]], { near: -0.5, far: 0.5 }],
    ["the id breaks a full tie", "bottom", [["b", at(100, 400)], ["a", at(100, 400)]], { a: -0.5, b: 0.5 }],
    ["five children whatever order the relationships come in", "bottom", [["e", at(1200, 300)], ["b", at(300, 300)], ["d", at(900, 300)], ["a", at(0, 300)], ["c", at(600, 300)]], { a: -2, b: -1, c: 0, d: 1, e: 2 }],
  ] as const)("%s", (_name, side, neighbours, expected) => {
    const lanes = spreadPorts(side as Side, neighbours.map(([id, other]) => ({ id, other })));

    expect(Object.fromEntries(lanes)).toEqual(expected);
  });

  it("gives the same lanes whatever the order the ends are listed in", () => {
    const ends = [["a", at(0, 400)], ["b", at(300, 400)], ["c", at(150, 400)], ["d", at(150, 500)]] as const;
    const forward = spreadPorts("bottom", ends.map(([id, other]) => ({ id, other })));
    const backward = spreadPorts("bottom", [...ends].reverse().map(([id, other]) => ({ id, other })));

    expect([...forward].sort()).toEqual([...backward].sort());
  });
});

/** Where `edgePorts` puts each end, on the node's own boundary. */
function endpoints(rects: ReadonlyMap<string, Rect>, edges: readonly { id: string; from: string; to: string }[], flow: LayoutFlow, policy: ConnectionPolicy) {
  const ports = edgePorts(edges, rects, flow, policy);
  return edges.map((edge) => {
    const port = ports.get(edge.id);
    if (!port) throw new Error(`no ports for ${edge.id}`);
    return {
      ...edge,
      port,
      start: attachmentPoint(rects.get(edge.from) as Rect, port.sourceSide, port.sourceLane, port.sourceLaneCount),
      end: attachmentPoint(rects.get(edge.to) as Rect, port.targetSide, port.targetLane, port.targetLaneCount),
    };
  });
}

function segmentsCross(a: readonly [{ x: number; y: number }, { x: number; y: number }], b: readonly [{ x: number; y: number }, { x: number; y: number }]): boolean {
  const side = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(a[0], a[1], b[0]) * side(a[0], a[1], b[1]) < 0 && side(b[0], b[1], a[0]) * side(b[0], b[1], a[1]) < 0;
}

describe("edgePorts", () => {
  const FLOWS = [
    ["tb", (x: number, y: number) => at(x, y)],
    ["bt", (x: number, y: number) => at(x, -y)],
    ["lr", (x: number, y: number) => at(y * 2, x)],
    ["rl", (x: number, y: number) => at(-y * 2, x)],
  ] as const;
  // The relationships of a root with five children are listed out of the order the children stand in.
  const FIVE = ["root>e", "root>a", "root>d", "root>b", "root>c"].map((text) => {
    const [from = "", to = ""] = text.split(">");
    return { id: text, from, to };
  });
  const place = (to: (x: number, y: number) => Rect): ReadonlyMap<string, Rect> =>
    new Map([["root", to(620, 0)], ...["a", "b", "c", "d", "e"].map((name, index) => [name, to(index * 310, 300)] as const)]);

  it.each(FLOWS)("a root with five children, %s: its ports are in the order of the children and no two lines cross", (flow, to) => {
    const rects = place(to);
    const found = endpoints(rects, FIVE, flow, "with-layout");
    const sorted = [...found].sort((left, right) => {
      const [l, r] = [rects.get(left.to) as Rect, rects.get(right.to) as Rect];
      return flow === "tb" || flow === "bt" ? l.x - r.x : l.y - r.y;
    });
    const along = (point: { x: number; y: number }): number => (flow === "tb" || flow === "bt" ? point.x : point.y);

    expect(sorted.map((edge) => edge.to)).toEqual(["a", "b", "c", "d", "e"]);
    expect(sorted.map((edge) => along(edge.start))).toEqual([...sorted.map((edge) => along(edge.start))].sort((a, b) => a - b));
    expect(new Set(found.map((edge) => along(edge.start))).size).toBe(5);
    for (const [index, one] of found.entries()) {
      for (const other of found.slice(index + 1)) {
        expect(segmentsCross([one.start, one.end], [other.start, other.end]), `${one.id} and ${other.id}`).toBe(false);
      }
    }
  });

  it.each(CONNECTION_POLICY_CHOICES.map((choice) => choice.id))("under the %s policy, edges that share a side of a node are ordered like the nodes at their other ends", (policy) => {
    // A hub with neighbours all round it, listed in an order that is not their order in space.
    const spots: readonly (readonly [string, number, number])[] = [
      ["n1", 900, -500], ["n2", -900, 700], ["n3", 300, 800], ["n4", -300, -700], ["n5", 1100, 100], ["n6", -1100, -100],
      ["n7", 0, 1000], ["n8", 700, 900], ["n9", -700, -900], ["n10", 500, -800],
    ];
    const rects = new Map<string, Rect>([["hub", at(0, 0)], ...spots.map(([name, x, y]) => [name, at(x, y)] as const)]);
    const edges = spots.flatMap(([name], index) => [index % 2 === 0 ? { id: `e-${name}`, from: "hub", to: name } : { id: `e-${name}`, from: name, to: "hub" }]);
    const ports = edgePorts(edges, rects, "tb", policy);

    for (const side of ["top", "bottom", "left", "right"] as const) {
      const ends = edges.flatMap((edge) => {
        const port = ports.get(edge.id) as NonNullable<ReturnType<typeof ports.get>>;
        if (edge.from === "hub" && port.sourceSide === side) return [{ other: rects.get(edge.to) as Rect, lane: port.sourceLane }];
        if (edge.to === "hub" && port.targetSide === side) return [{ other: rects.get(edge.from) as Rect, lane: port.targetLane }];
        return [];
      });
      const across = (rect: Rect): number => (side === "top" || side === "bottom" ? rect.x + rect.width / 2 : rect.y + rect.height / 2);
      const byLane = [...ends].sort((left, right) => left.lane - right.lane).map((end) => across(end.other));

      expect(byLane, `${policy} ${side}`).toEqual([...byLane].sort((a, b) => a - b));
    }
  });

  it("leaves an edge between nodes that are not drawn without ports", () => {
    expect(edgePorts([{ id: "x", from: "a", to: "ghost" }], new Map([["a", at(0, 0)]]), "tb", "with-layout").size).toBe(0);
  });
});
