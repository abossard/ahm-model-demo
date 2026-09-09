import { describe, it, expect } from "vitest";
import {
  CLEARANCE,
  GRID_LANES,
  sidesFor,
  attachmentPoint,
  midpointOf,
  pathForStyle,
  pickSides,
  roundedPath,
  routeEdge,
  routeEdges,
  sharedRun,
  simplify,
  type ConnectionPolicy,
  type Rect,
  type Route,
} from "./edgeRouting";
import type { Point } from "./layout";
import { LAYOUT_ENGINES, type LayoutId } from "./layout";
import type { Entity } from "./types";
import { orderEntities, orderWithinRanks } from "./ordering";
import { buildEdges } from "../components/Topology";
import { estimateNodeSize } from "../components/EntityNode";
import {
  DENSE_BLOCKED_EDGE,
  DENSE_CROSSED_CARD,
  DENSE_SEED,
  REAL_SHARED_RUN_PAIRS,
  denseModel,
  realAnbomovModel,
} from "../../tests/denseModel";

function card(x: number, y: number): Rect {
  return { x, y, width: 260, height: 120 };
}

const ORIGIN = card(0, 0);

/** The two rendered `dagre-tb` cards whose painted `r2` path travelled back through both of them. */
const SVC_B: Rect = { x: 55, y: 407.8796081542969, width: 275.65045166015625, height: 91.17669677734375 };
const SVC_C: Rect = { x: 218.2698974609375, y: 575.3902587890625, width: 275.65045166015625, height: 50.88934326171875 };
/** The rendered `dagre-tb` `r4` pair, which crossed `svc-d` and `svc-c` for the same reason. */
const SVC_D: Rect = { x: 415.9169921875, y: 407.8796081542969, width: 275.65045166015625, height: 91.17669677734375 };

const DIRECTIONS: readonly (readonly [string, Rect, string, string])[] = [
  ["below", card(0, 400), "bottom", "top"],
  ["above", card(0, -400), "top", "bottom"],
  ["right of", card(600, 0), "right", "left"],
  ["left of", card(-600, 0), "left", "right"],
  ["down and right", card(600, 900), "bottom", "top"],
  ["up and left", card(-900, -200), "left", "right"],
];

describe("pickSides", () => {
  for (const [where, other, sourceSide, targetSide] of DIRECTIONS) {
    it(`faces the boundary towards a card ${where}`, () => {
      expect(pickSides(ORIGIN, other)).toEqual({ sourceSide, targetSide });
    });
  }

  it("faces the separated axis when the other axis overlaps", () => {
    // The rendered dagre-tb pair that painted a path back through both its own cards: the centres
    // lean horizontal, the x extents overlap, and only the y extents are actually apart.
    expect(pickSides(SVC_B, SVC_C)).toEqual({ sourceSide: "bottom", targetSide: "top" });

    // The mirror case: y extents overlap, x extents are apart, so the facing sides are horizontal
    // even though the centre delta leans vertical.
    const wide = { x: 0, y: 0, width: 100, height: 400 };
    const beside = { x: 300, y: 260, width: 100, height: 400 };
    expect(pickSides(wide, beside)).toEqual({ sourceSide: "right", targetSide: "left" });
  });

  it("resolves a collinear pair to one deterministic side instead of flickering", () => {
    // Equal horizontal and vertical separation, the tie a nearest-side rule cannot settle.
    const diagonal = { x: 300, y: 300, width: 260, height: 120 };
    const first = pickSides(ORIGIN, diagonal);

    expect(first).toEqual(pickSides(ORIGIN, diagonal));
    expect(first).toEqual({ sourceSide: "bottom", targetSide: "top" });
    expect(pickSides(ORIGIN, ORIGIN)).toEqual({ sourceSide: "bottom", targetSide: "top" });
  });
});

describe("attachmentPoint", () => {
  it("sits on the named boundary and slides along it for a separate lane", () => {
    expect(attachmentPoint(ORIGIN, "top")).toEqual({ x: 130, y: 0 });
    expect(attachmentPoint(ORIGIN, "bottom")).toEqual({ x: 130, y: 120 });
    expect(attachmentPoint(ORIGIN, "left")).toEqual({ x: 0, y: 60 });
    expect(attachmentPoint(ORIGIN, "right")).toEqual({ x: 260, y: 60 });

    const first = attachmentPoint(ORIGIN, "top", -1);
    const second = attachmentPoint(ORIGIN, "top", 1);
    expect(first.x).toBeLessThan(second.x);
    expect(first.y).toBe(0);

    // A lane far past the card still lands on the boundary rather than off the corner.
    const far = attachmentPoint(ORIGIN, "top", 40);
    expect(far.x).toBeLessThanOrEqual(ORIGIN.x + ORIGIN.width);
    expect(far.x).toBeGreaterThanOrEqual(ORIGIN.x);
  });

  describe("C9 edge direction and lanes", () => {
    const sourceAbove: Rect = { x: 0, y: 0, width: 260, height: 120 };
    const targetBelow: Rect = { x: 0, y: 360, width: 260, height: 120 };

    it.each([
      ["with-layout", "lr", "right", "left"],
      ["with-layout", "rl", "left", "right"],
      ["with-layout", "tb", "bottom", "top"],
      ["with-layout", "bt", "top", "bottom"],
      ["lr", "tb", "right", "left"],
      ["rl", "tb", "left", "right"],
      ["tb", "lr", "bottom", "top"],
      ["bt", "lr", "top", "bottom"],
    ] as const)("maps %s on %s to %s -> %s", (policy, flow, sourceSide, targetSide) => {
      expect(sidesFor(policy, flow, sourceAbove, targetBelow)).toEqual({ sourceSide, targetSide });
    });

    it("keeps Free geometry independent from a layered flow", () => {
      expect(sidesFor("free", "lr", sourceAbove, targetBelow)).toEqual({
        sourceSide: "bottom",
        targetSide: "top",
      });
      expect(sidesFor("with-layout", "free", sourceAbove, targetBelow)).toEqual({
        sourceSide: "bottom",
        targetSide: "top",
      });
    });

    it("keeps routes that leave the same card boundary on separate segments", () => {
      const hub: Rect = { x: 0, y: 0, width: 260, height: 120 };
      const upper: Rect = { x: 520, y: -120, width: 260, height: 120 };
      const lower: Rect = { x: 520, y: 180, width: 260, height: 120 };
      const rects = new Map([
        ["hub", hub],
        ["upper", upper],
        ["lower", lower],
      ]);
      const entities = new Map([
        ["hub", { name: "hub", displayName: "Hub", healthState: "Healthy", signals: [] }],
        ["upper", { name: "upper", displayName: "Upper", healthState: "Healthy", signals: [] }],
        ["lower", { name: "lower", displayName: "Lower", healthState: "Healthy", signals: [] }],
      ] as const);
      const edges = buildEdges(
        [
          { name: "e-upper", displayName: "", parentEntityName: "hub", childEntityName: "upper" },
          { name: "e-lower", displayName: "", parentEntityName: "hub", childEntityName: "lower" },
        ],
        entities as unknown as ReadonlyMap<string, Entity>,
        rects,
        "computed",
        "lr",
        "rounded",
        "with-layout",
      );
      const paths = edges.map((edge) => {
        const data = edge.data as unknown as {
          readonly route: Route;
          readonly sourceLane?: number;
          readonly targetLane?: number;
          readonly lane?: number;
        };
        return simplify([
          attachmentPoint(hub, data.route.sourceSide, data.sourceLane ?? data.lane ?? 0),
          ...data.route.waypoints,
          attachmentPoint(
            rects.get(edge.target) as Rect,
            data.route.targetSide,
            data.targetLane ?? data.lane ?? 0,
          ),
        ]);
      });

      expect(sharedSegmentCountNear(paths, hub)).toBe(0);
      expect(paths.map((path) => path[0])).toEqual([
        { x: 260, y: 52 },
        { x: 260, y: 68 },
      ]);
    });
  });
});

function samples(points: readonly Point[], every = 4): Point[] {
  const out: Point[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1] as Point;
    const to = points[index] as Point;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(length / every));
    for (let step = 0; step <= steps; step += 1) {
      out.push({
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      });
    }
  }
  return out;
}

function inside(point: Point, rect: Rect): boolean {
  // A hair inside the boundary: an attachment point sits exactly on it, and interpolating a sample
  // to the end of a segment can land a rounding step past it. Neither is a crossing.
  const edge = 1e-6;
  return (
    point.x > rect.x + edge &&
    point.x < rect.x + rect.width - edge &&
    point.y > rect.y + edge &&
    point.y < rect.y + rect.height - edge
  );
}

function segmentOverlap(
  leftA: Point,
  leftB: Point,
  rightA: Point,
  rightB: Point,
): number {
  if (leftA.x === leftB.x && rightA.x === rightB.x && leftA.x === rightA.x) {
    return Math.max(
      0,
      Math.min(Math.max(leftA.y, leftB.y), Math.max(rightA.y, rightB.y)) -
        Math.max(Math.min(leftA.y, leftB.y), Math.min(rightA.y, rightB.y)),
    );
  }
  if (leftA.y === leftB.y && rightA.y === rightB.y && leftA.y === rightA.y) {
    return Math.max(
      0,
      Math.min(Math.max(leftA.x, leftB.x), Math.max(rightA.x, rightB.x)) -
        Math.max(Math.min(leftA.x, leftB.x), Math.min(rightA.x, rightB.x)),
    );
  }
  return 0;
}

function nearCard(a: Point, b: Point, card: Rect): boolean {
  return (
    Math.min(a.x, b.x) <= card.x + card.width + CLEARANCE &&
    Math.max(a.x, b.x) >= card.x - CLEARANCE &&
    Math.min(a.y, b.y) <= card.y + card.height + CLEARANCE &&
    Math.max(a.y, b.y) >= card.y - CLEARANCE
  );
}

function sharedSegmentCountNear(paths: readonly (readonly Point[])[], card: Rect): number {
  let shared = 0;
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const leftPath = paths[left] as readonly Point[];
      const rightPath = paths[right] as readonly Point[];
      for (let leftIndex = 1; leftIndex < leftPath.length; leftIndex += 1) {
        const leftA = leftPath[leftIndex - 1] as Point;
        const leftB = leftPath[leftIndex] as Point;
        if (!nearCard(leftA, leftB, card)) continue;
        for (let rightIndex = 1; rightIndex < rightPath.length; rightIndex += 1) {
          const rightA = rightPath[rightIndex - 1] as Point;
          const rightB = rightPath[rightIndex] as Point;
          if (nearCard(rightA, rightB, card) && segmentOverlap(leftA, leftB, rightA, rightB) > 0) {
            shared += 1;
          }
        }
      }
    }
  }
  return shared;
}

/**
 * The polyline the edge actually paints: `roundedPath` draws `simplify(...)`, so anything the router
 * validated before simplification proves nothing about the picture on screen.
 */
function drawn(source: Rect, target: Rect, route: Route): Point[] {
  return simplify([
    attachmentPoint(source, route.sourceSide),
    ...route.waypoints,
    attachmentPoint(target, route.targetSide),
  ]);
}

/** Every card the drawn polyline enters, endpoint cards included, sampled every half pixel. */
function entered(path: readonly Point[], cards: Readonly<Record<string, Rect>>): string[] {
  const found = new Set<string>();
  for (const point of samples(path, 0.5)) {
    for (const [id, rect] of Object.entries(cards)) if (inside(point, rect)) found.add(id);
  }
  return [...found].sort();
}

describe("routeEdge", () => {
  it("bends around a card parked in the straight corridor", () => {
    const source = card(0, 0);
    const target = card(0, 700);
    const blocker = card(0, 320);

    const route = routeEdge(source, target, [blocker]);
    const path = [attachmentPoint(source, route.sourceSide), ...route.waypoints, attachmentPoint(target, route.targetSide)];

    expect(route.clear).toBe(true);
    expect(samples(path).filter((point) => inside(point, blocker))).toEqual([]);
    expect(route.waypoints.length).toBeGreaterThan(2);
  });

  // The exact rendered pairs whose painted paths ran back through their own source and target.
  for (const [id, source, target, others] of [
    ["r2 svc-b -> svc-c", SVC_B, SVC_C, { "svc-d": SVC_D }],
    ["r4 svc-d -> svc-c", SVC_D, SVC_C, { "svc-b": SVC_B }],
  ] as const) {
    it(`keeps ${id} out of both endpoint bodies and every other card`, () => {
      const route = routeEdge(source, target, Object.values(others));
      const cards = { source, target, ...others };

      expect(entered(drawn(source, target, route), cards)).toEqual([]);
      // A route that enters a card it touches is no more drawable than one crossing a stranger, so
      // the class the edge paints has to say so.
      expect(route.clear).toBe(true);
    });
  }

  it("never doubles the drawn path back over the boundary it just left", () => {
    const route = routeEdge(SVC_B, SVC_C, []);
    const path = drawn(SVC_B, SVC_C, route);
    const first = path[0] as Point;
    const last = path[path.length - 1] as Point;

    // Leaving through `bottom` means the far end lies below, so the corridor never has to reverse.
    expect(route.sourceSide).toBe("bottom");
    expect(last.y).toBeGreaterThanOrEqual(first.y);
    expect((path[1] as Point).y).toBeGreaterThan(first.y);
  });

  it("reports a miss when the only corridor would run through an endpoint card", () => {
    // Two cards laid on top of each other: every attachment point starts inside the other body, so
    // no corridor exists. Reporting clear here would paint a line through both and call it routed.
    const route = routeEdge(card(0, 0), card(60, 40), []);

    expect(route.clear).toBe(false);
  });

  it("shares a tight gap between the two stubs instead of overshooting into the other card", () => {
    // A wide, short card sitting 10 px above a small one: a full 30 px stub would start inside it.
    const wide: Rect = { x: -500, y: -50, width: 1000, height: 40 };
    const small: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const route = routeEdge(small, wide, []);

    expect(route.clear).toBe(true);
    expect(entered(drawn(small, wide, route), { small, wide })).toEqual([]);
  });

  it("keeps a stub out of a third card standing straight ahead of it", () => {
    // The `elk-layered` geometry that had no route at all: card `n7` sits 21 px off the target's
    // arrival boundary, so the target's full 30 px stub began inside it and every corridor started
    // in a card. Only the two ends were consulted for stub room, never a stranger.
    const source: Rect = { x: 1063, y: 405, width: 260, height: 48 };
    const target: Rect = { x: 518, y: 590, width: 260, height: 152 };
    const others = {
      n3: { x: 544, y: 361, width: 260, height: 157 },
      n7: { x: 799, y: 597, width: 260, height: 130 },
    };
    const route = routeEdge(source, target, Object.values(others));

    expect(entered(drawn(source, target, route), { source, target, ...others })).toEqual([]);
    expect(route.clear).toBe(true);
  });

  it("keeps a clear corridor short when nothing is in the way", () => {
    const route = routeEdge(card(0, 0), card(0, 400), []);

    expect(route.clear).toBe(true);
    expect(simplify([attachmentPoint(card(0, 0), "bottom"), ...route.waypoints, attachmentPoint(card(0, 400), "top")])).toHaveLength(2);
  });

  it("gives two paths into the same boundary their own lanes", () => {
    const target = card(0, 700);
    const left = routeEdge(card(-500, 0), target, [], -1);
    const right = routeEdge(card(500, 0), target, [], 1);

    const leftEnd = attachmentPoint(target, left.targetSide, -1);
    const rightEnd = attachmentPoint(target, right.targetSide, 1);
    expect(leftEnd.x).not.toBe(rightEnd.x);
    expect(leftEnd.y).toBe(rightEnd.y);
  });

  it("threads a wall that used to be reported as unroutable", () => {
    // Before the lane search this pair was declared a miss: the only way in is round the left card
    // and back through the gap above the target, which no single-coordinate corridor can draw.
    const target = card(0, 700);
    const wall = [card(-260, 700), card(260, 700), card(0, 560), card(0, 840)];
    const route = routeEdge(card(0, 0), target, wall);
    const cards = Object.fromEntries([
      ["source", card(0, 0)],
      ["target", target],
      ...wall.map((rect, index) => [`w${index}`, rect] as const),
    ]);

    expect(entered(drawn(card(0, 0), target, route), cards)).toEqual([]);
    expect(route.clear).toBe(true);
  });

  it("clears an obstacle by more than the drawn stroke width", () => {
    const blocker = card(0, 320);
    const route = routeEdge(card(0, 0), card(0, 700), [blocker]);
    const path = [attachmentPoint(card(0, 0), "bottom"), ...route.waypoints, attachmentPoint(card(0, 700), "top")];
    const nearest = Math.min(
      ...samples(path).map((point) =>
        Math.max(
          blocker.x - point.x,
          point.x - (blocker.x + blocker.width),
          blocker.y - point.y,
          point.y - (blocker.y + blocker.height),
        ),
      ),
    );

    expect(nearest).toBeGreaterThanOrEqual(CLEARANCE - 1);
  });
});

describe("simplify", () => {
  it("drops collinear vertices including retraced stub hooks without leaving the checked line", () => {
    // Between: the middle point adds nothing, so the drawn line is unchanged without it.
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 0, y: 50 },
        { x: 0, y: 100 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ]);

    const stub = [
      { x: 284, y: 269 },
      { x: 314, y: 269 },
      { x: 231, y: 269 },
    ];
    expect(simplify(stub)).toEqual([stub[0], stub[2]]);
    expect(simplify([
      { x: 948, y: 600 }, { x: 978, y: 600 }, { x: 956, y: 600 }, { x: 956, y: 941 },
    ])).toEqual([{ x: 948, y: 600 }, { x: 956, y: 600 }, { x: 956, y: 941 }]);
  });
});

describe("roundedPath", () => {
  it("rounds every turn and leaves a straight run alone", () => {
    const bent = roundedPath([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 200, y: 100 },
    ]);
    expect(bent.match(/Q/g)).toHaveLength(1);
    expect(bent.startsWith("M 0,0")).toBe(true);
    expect(bent.endsWith("L 200,100")).toBe(true);

    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }])).toBe("M 0,0 L 0,100");
  });

  it("shrinks the radius rather than overshooting a short segment", () => {
    const path = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 6 },
        { x: 60, y: 6 },
      ],
      14,
    );
    const entryY = Number(/L 0,([\d.]+)/.exec(path)?.[1]);

    expect(entryY).toBeGreaterThanOrEqual(3);
    expect(entryY).toBeLessThanOrEqual(6);
  });
});

describe("edge style paths", () => {
  it("keeps rounded, right-angle and smooth visibly distinct on one routed corridor", () => {
    const points: readonly Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 80 },
      { x: 120, y: 80 },
      { x: 120, y: 160 },
    ];

    const rounded = pathForStyle("rounded", points);
    const rightAngle = pathForStyle("right-angle", points);
    const smooth = pathForStyle("smooth", points);

    expect([rounded.match(/Q/g)?.length ?? 0, rounded.match(/C/g)?.length ?? 0]).toEqual([2, 0]);
    expect([rightAngle.match(/[QC]/g)?.length ?? 0, rightAngle]).toEqual([
      0,
      "M 0,0 L 0,80 L 120,80 L 120,160",
    ]);
    expect([smooth.match(/Q/g)?.length ?? 0, smooth.match(/C/g)?.length ?? 0]).toEqual([0, 2]);
    expect(new Set([rounded, rightAngle, smooth]).size).toBe(3);
  });
});

describe("midpointOf", () => {
  it("lands half way along the drawn length, not half way between the ends", () => {
    expect(midpointOf([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }])).toEqual({
      x: 0,
      y: 100,
    });
  });
});

/**
 * The six-node repository fixture is not representative of every supported model, and an
 * independent inspection found a valid generated graph whose route the fixed corridor shapes could
 * not serve. These cases run production card sizing, production ordering, the registered engines
 * and the production lane assignment in `buildEdges`, then sample the polyline the edge actually
 * paints against every card body, its own two included.
 */
const DENSE_LAYOUTS: readonly LayoutId[] = [
  "dagre-tb",
  "dagre-bt",
  "dagre-lr",
  "dagre-rl",
  "elk-layered",
  "d3-force",
];
/** Node and relationship counts, so a rank stays crowded enough to need a real detour. */
const DENSE_SHAPES: readonly (readonly [number, number])[] = [
  [12, 18],
  [16, 26],
];
const DENSE_GRAPHS = 30;

async function denseRun(
  seed: number,
  layoutId: LayoutId,
  nodes: number,
  edges: number,
): Promise<string[]> {
  const model = denseModel(seed, nodes, edges);
  const engine = LAYOUT_ENGINES[layoutId];
  const sizes = new Map(model.entities.map((item) => [item.name, estimateNodeSize(item)] as const));
  const laid = await engine.run(model.entities, model.relationships, (item) =>
    sizes.get(item.name) ?? estimateNodeSize(item),
  );
  const order = orderEntities(model.entities, "name", false).map((item) => item.name);
  const placed = orderWithinRanks(laid, order, engine.rankAxis, sizes);

  const rects = new Map<string, Rect>();
  for (const [name, point] of placed.positions) {
    const size = sizes.get(name) as { readonly width: number; readonly height: number };
    rects.set(name, { x: point.x, y: point.y, width: size.width, height: size.height });
  }
  const cards = Object.fromEntries(rects);

  const failures: string[] = [];
  const byName = new Map(model.entities.map((item) => [item.name, item] as const));
  for (const edge of buildEdges(model.relationships, byName, rects, "computed")) {
    const data = edge.data as unknown as {
      readonly route: Route;
      readonly lane: number;
      readonly sourceLane?: number;
      readonly targetLane?: number;
      readonly sourceLaneCount?: number;
      readonly targetLaneCount?: number;
    };
    const source = rects.get(edge.source) as Rect;
    const target = rects.get(edge.target) as Rect;
    const path = simplify([
      attachmentPoint(source, data.route.sourceSide, data.sourceLane ?? data.lane, data.sourceLaneCount ?? 0),
      ...data.route.waypoints,
      attachmentPoint(target, data.route.targetSide, data.targetLane ?? data.lane, data.targetLaneCount ?? 0),
    ]);
    if (!data.route.clear) failures.push(`${layoutId} g${seed}n${nodes} ${edge.id} blocked`);
    for (const card of entered(path, cards)) {
      failures.push(`${layoutId} g${seed}n${nodes} ${edge.id} crosses ${card}`);
    }
  }
  return failures;
}

interface RoutedPath {
  readonly id: string;
  readonly path: readonly Point[];
}

async function routedModelPaths(
  layoutId: LayoutId = "dagre-tb",
  policy: ConnectionPolicy = "with-layout",
): Promise<{
  readonly paths: readonly RoutedPath[];
  readonly cards: Readonly<Record<string, Rect>>;
}> {
  const model = realAnbomovModel();
  const engine = LAYOUT_ENGINES[layoutId];
  const sizes = new Map(model.entities.map((item) => [item.name, estimateNodeSize(item)] as const));
  const laid = await engine.run(model.entities, model.relationships, (item) =>
    sizes.get(item.name) ?? estimateNodeSize(item),
  );
  const order = orderEntities(model.entities, "name", false).map((item) => item.name);
  const placed = orderWithinRanks(laid, order, engine.rankAxis, sizes);
  const rects = new Map<string, Rect>();
  for (const [name, point] of placed.positions) {
    const size = sizes.get(name) as { readonly width: number; readonly height: number };
    rects.set(name, { x: point.x, y: point.y, width: size.width, height: size.height });
  }

  const byName = new Map(model.entities.map((item) => [item.name, item] as const));
  return {
    cards: Object.fromEntries(rects),
    paths: buildEdges(
      model.relationships,
      byName,
      rects,
      "computed",
      engine.flow,
      "rounded",
      policy,
    ).map((edge) => {
      const data = edge.data as unknown as {
        readonly route: Route;
        readonly lane: number;
        readonly sourceLane?: number;
        readonly targetLane?: number;
        readonly sourceLaneCount?: number;
        readonly targetLaneCount?: number;
      };
      const source = rects.get(edge.source) as Rect;
      const target = rects.get(edge.target) as Rect;
      return {
        id: edge.id,
        path: simplify([
          attachmentPoint(source, data.route.sourceSide, data.sourceLane ?? data.lane, data.sourceLaneCount ?? 0),
          ...data.route.waypoints,
          attachmentPoint(target, data.route.targetSide, data.targetLane ?? data.lane, data.targetLaneCount ?? 0),
        ]),
      };
    }),
  };
}

function nearCollinearRun(
  leftA: Point,
  leftB: Point,
  rightA: Point,
  rightB: Point,
  tolerance = 2,
): number {
  if (leftA.x === leftB.x && rightA.x === rightB.x && Math.abs(leftA.x - rightA.x) <= tolerance) {
    return Math.max(
      0,
      Math.min(Math.max(leftA.y, leftB.y), Math.max(rightA.y, rightB.y)) -
        Math.max(Math.min(leftA.y, leftB.y), Math.min(rightA.y, rightB.y)),
    );
  }
  if (leftA.y === leftB.y && rightA.y === rightB.y && Math.abs(leftA.y - rightA.y) <= tolerance) {
    return Math.max(
      0,
      Math.min(Math.max(leftA.x, leftB.x), Math.max(rightA.x, rightB.x)) -
        Math.max(Math.min(leftA.x, leftB.x), Math.min(rightA.x, rightB.x)),
    );
  }
  return 0;
}

function maxSharedRunNearCard(
  left: readonly Point[],
  right: readonly Point[],
  cards: Readonly<Record<string, Rect>>,
): number {
  return sharedRun(left, right, Object.values(cards));
}

describe("sharedRun CSS geometry", () => {
  const along = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const cards = [{ x: 0, y: 10, width: 100, height: 10 }];
  it.each([
    ["same direction", [{ x: 20, y: 0 }, { x: 80, y: 0 }], 1, 60],
    ["opposite direction", [{ x: 80, y: 0 }, { x: 20, y: 0 }], 1, 60],
    ["near parallel at fitted zoom", [{ x: 0, y: 3 }, { x: 100, y: 3 }], 0.5, 50],
    ["separate at actual size", [{ x: 0, y: 3 }, { x: 100, y: 3 }], 1, 0],
  ] as const)("%s", (_name, other, zoom, expected) => {
    expect(sharedRun(along, other, cards, zoom)).toBe(expected);
  });

  it("clips only the shared interval to the union of nearby card envelopes", () => {
    expect(sharedRun(
      [{ x: 0, y: 0 }, { x: 1500, y: 0 }],
      [{ x: 500, y: 0 }, { x: 2000, y: 0 }],
      [{ x: 0, y: 10, width: 10, height: 10 }, { x: 1990, y: 10, width: 10, height: 10 }],
    )).toBe(0);
    expect(sharedRun(along, along,
      [{ x: 0, y: 10, width: 20, height: 10 }, { x: 60, y: 10, width: 20, height: 10 }], 1)).toBe(100);
    expect(sharedRun(along, along, [{ x: 0, y: 10, width: 20, height: 10 }], 1)).toBe(48);
  });
});

describe("routeEdge over generated dense models", () => {
  for (const layoutId of DENSE_LAYOUTS) {
    it(`clears every card on generated 12- and 16-node graphs in ${layoutId}`, async () => {
      const failures: string[] = [];
      for (const [nodes, edges] of DENSE_SHAPES) {
        for (let seed = 0; seed < DENSE_GRAPHS; seed += 1) {
          failures.push(...(await denseRun(seed, layoutId, nodes, edges)));
        }
      }

      expect(failures).toEqual([]);
    }, 120000);
  }

  it(`routes the recorded ${DENSE_BLOCKED_EDGE} counterexample around ${DENSE_CROSSED_CARD}`, async () => {
    // The exact case the independent inspection reproduced in the browser: a valid 12-node d3-force
    // model whose one blocked route was painted straight through a third-party card.
    const failures = await denseRun(DENSE_SEED, "d3-force", 12, 18);

    expect(failures).toEqual([]);
  });

  it("separates the real C10 shared corridors instead of merging beside cards", async () => {
    const routed = await routedModelPaths();
    const byId = new Map(routed.paths.map((path) => [path.id, path.path] as const));

    const measured = REAL_SHARED_RUN_PAIRS.map(([left, right]) => [
      `${left}|${right}`,
      maxSharedRunNearCard(byId.get(left) as readonly Point[], byId.get(right) as readonly Point[], routed.cards),
    ]);

    expect(measured).toEqual([
      ["8da6b1cd-61e8-4206-9663-3cf7f6800221|r-app-hosting-aks", 0],
      ["r-ask-copilot-ai-inference|r-ask-copilot-app-hosting", 0],
    ]);
  });
});

describe("bounded lane search", () => {
  it("separates the recorded ELK half-lane tracks at the painted half zoom", () => {
    const sourceA = { x: 736 + 1 / 3, y: 199.5, width: 260, height: 54 };
    const targetA = { x: 1925, y: 346, width: 260, height: 54 };
    const sourceB = { x: 2259, y: 179, width: 260, height: 54 };
    const targetB = { x: 671 + 1 / 3, y: 346, width: 260, height: 54 };
    const requests = [
      { source: sourceA, target: targetA, obstacles: [sourceB, targetB],
        options: { sourceSide: "bottom", targetSide: "top", sourceLane: 1, targetLane: 0,
          sourceLaneCount: 3, targetLaneCount: 1, detourLane: 1 } },
      { source: sourceB, target: targetB, obstacles: [sourceA, targetA],
        options: { sourceSide: "bottom", targetSide: "top", sourceLane: 0, targetLane: 1.5,
          sourceLaneCount: 1, targetLaneCount: 4, detourLane: 1.5 } },
    ] as const;
    const routes = routeEdges(requests);
    const paths = routes.map((route, index) => {
      const request = requests[index]!;
      return simplify([
        attachmentPoint(request.source, route.sourceSide, request.options.sourceLane, request.options.sourceLaneCount),
        ...route.waypoints,
        attachmentPoint(request.target, route.targetSide, request.options.targetLane, request.options.targetLaneCount),
      ]);
    });
    const overlaps = paths[0]!.slice(1).flatMap((b, i) =>
      paths[1]!.slice(1).map((d, j) => nearCollinearRun(paths[0]![i]!, b, paths[1]![j]!, d, 4) * 0.5));
    expect(Math.max(...overlaps)).toBeLessThanOrEqual(6);
    expect(routes.map((route) => route.clear)).toEqual([true, true]);
  });

  it("reaches into a pocket that no single-coordinate corridor can enter", () => {
    // The target sits in a U open at the bottom, so the only route leaves the source, runs down
    // outside the pocket, along under it, and back up inside: more turns than any corridor with one
    // free coordinate can make. Twenty far-off cards sit outside the lane ceiling, so this also
    // shows the ceiling picking the cards that matter rather than the first ones it is handed.
    const pocket: Rect[] = [
      { x: -400, y: 560, width: 1000, height: 80 },
      { x: -400, y: 560, width: 80, height: 500 },
      { x: 520, y: 560, width: 80, height: 500 },
    ];
    const distant = Array.from({ length: 20 }, (_unused, index) => ({
      x: 4000 + index * 320,
      y: 3000,
      width: 260,
      height: 120,
    }));
    const source = card(0, 0);
    const target = card(0, 700);

    expect(GRID_LANES).toBe(14);
    expect(pocket.length + distant.length).toBeGreaterThan(GRID_LANES);

    const route = routeEdge(source, target, [...distant, ...pocket]);
    const path = drawn(source, target, route);
    const cards = Object.fromEntries([
      ["source", source],
      ["target", target],
      ...[...pocket, ...distant].map((rect, index) => [`w${index}`, rect] as const),
    ]);

    expect(entered(path, cards)).toEqual([]);
    expect(route.clear).toBe(true);
    expect(path.length).toBeGreaterThan(4);
  });

  it("still reports a miss when a card is laid over the target", () => {
    // Nothing the search can do here: every attachment point on the target sits inside a third card,
    // so no route begins. It has to say so rather than paint a line and call it routed.
    const target = card(0, 700);
    const covering = { x: -40, y: 660, width: 340, height: 200 };

    expect(routeEdge(card(0, 0), target, [covering]).clear).toBe(false);
  });
});
