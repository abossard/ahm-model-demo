import type { Point } from "./layout";

export interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

export type Side = "top" | "right" | "bottom" | "left";
export type LayoutFlow = "tb" | "bt" | "lr" | "rl" | "free";
export type ConnectionPolicy = "with-layout" | "free" | "lr" | "rl" | "tb" | "bt";
export type EdgeStyle = "rounded" | "right-angle" | "smooth";

export const CONNECTION_POLICY_CHOICES: readonly {
  readonly id: ConnectionPolicy;
  readonly label: string;
}[] = [
  { id: "with-layout", label: "With layout" },
  { id: "free", label: "Free" },
  { id: "lr", label: "Left to right" },
  { id: "rl", label: "Right to left" },
  { id: "tb", label: "Top to bottom" },
  { id: "bt", label: "Bottom to top" },
];

export const EDGE_STYLE_CHOICES: readonly { readonly id: EdgeStyle; readonly label: string }[] = [
  { id: "rounded", label: "Rounded orthogonal" },
  { id: "right-angle", label: "Right-angle" },
  { id: "smooth", label: "Smooth curves" },
];

const CORNER_PAD = 18;
const LANE_STEP = 16;

function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Separation between two spans on one axis. Negative when the spans overlap. */
function separation(aMin: number, aSize: number, bMin: number, bSize: number): number {
  return Math.max(bMin - (aMin + aSize), aMin - (bMin + bSize));
}

/** Rectangle separation chooses the facing axis, with vertical ties resolved consistently. */
export function pickSides(source: Rect, target: Rect): {
  readonly sourceSide: Side;
  readonly targetSide: Side;
} {
  const from = centreOf(source);
  const to = centreOf(target);
  if (
    separation(source.x, source.width, target.x, target.width) >
    separation(source.y, source.height, target.y, target.height)
  ) {
    return to.x >= from.x
      ? { sourceSide: "right", targetSide: "left" }
      : { sourceSide: "left", targetSide: "right" };
  }
  return to.y >= from.y
    ? { sourceSide: "bottom", targetSide: "top" }
    : { sourceSide: "top", targetSide: "bottom" };
}

function flowSides(flow: Exclude<LayoutFlow, "free">): {
  readonly sourceSide: Side;
  readonly targetSide: Side;
} {
  if (flow === "lr") return { sourceSide: "right", targetSide: "left" };
  if (flow === "rl") return { sourceSide: "left", targetSide: "right" };
  if (flow === "bt") return { sourceSide: "top", targetSide: "bottom" };
  return { sourceSide: "bottom", targetSide: "top" };
}

export function sidesFor(
  policy: ConnectionPolicy,
  flow: LayoutFlow,
  source: Rect,
  target: Rect,
): {
  readonly sourceSide: Side;
  readonly targetSide: Side;
} {
  if (policy === "free") return pickSides(source, target);
  if (policy === "with-layout") return flow === "free" ? pickSides(source, target) : flowSides(flow);
  return flowSides(policy);
}

/** Compress crowded port spacing so distinct lanes stay inside the card's corner padding. */
export function attachmentPoint(rect: Rect, side: Side, lane = 0, laneCount = 0): Point {
  const centre = centreOf(rect);
  const span = side === "top" || side === "bottom" ? rect.width : rect.height;
  const limit = Math.max(0, span / 2 - CORNER_PAD);
  const extreme = (laneCount - 1) / 2;
  const spacing = extreme > 0 ? Math.min(LANE_STEP, limit / extreme) : LANE_STEP;
  const slide = Math.max(-limit, Math.min(limit, lane * spacing));

  if (side === "top") return { x: centre.x + slide, y: rect.y };
  if (side === "bottom") return { x: centre.x + slide, y: rect.y + rect.height };
  if (side === "left") return { x: rect.x, y: centre.y + slide };
  return { x: rect.x + rect.width, y: centre.y + slide };
}

/** One end of an edge at a side of a node: the edge, and the node at its other end. */
export interface PortEnd {
  readonly id: string;
  /** The rectangle of the node at the other end of the edge. */
  readonly other: Rect;
}

/**
 * Where along a side the ends of its edges attach, as lanes counted from the middle of the side
 * (-1, 0, 1 for three). They are ordered like the nodes they connect to across the side, left to
 * right on a top or bottom side and top to bottom on a left or right one, so no two edges of a
 * node cross where they leave it. Nodes level with each other across the side are told apart by
 * how far away along it they are, then by id: the same neighbours always give the same lanes.
 */
export function spreadPorts(side: Side, ends: readonly PortEnd[]): ReadonlyMap<string, number> {
  const horizontal = side === "top" || side === "bottom";
  const across = (rect: Rect): number => (horizontal ? rect.x + rect.width / 2 : rect.y + rect.height / 2);
  const along = (rect: Rect): number => (horizontal ? rect.y + rect.height / 2 : rect.x + rect.width / 2);
  const sorted = [...ends].sort(
    (left, right) =>
      across(left.other) - across(right.other) ||
      along(left.other) - along(right.other) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  return new Map(sorted.map((end, index) => [end.id, index - (sorted.length - 1) / 2] as const));
}

export interface EdgePorts {
  readonly sourceSide: Side;
  readonly targetSide: Side;
  readonly sourceLane: number;
  readonly targetLane: number;
  readonly sourceLaneCount: number;
  readonly targetLaneCount: number;
}

/**
 * The sides and lanes of every edge between nodes at `rects`. A node's edges on one side are
 * spread by `spreadPorts`, so what leaves a parent is ordered like its children and what arrives
 * at a child like its parents, in every direction, policy and style.
 */
export function edgePorts(
  edges: readonly { readonly id: string; readonly from: string; readonly to: string }[],
  rects: ReadonlyMap<string, Rect>,
  flow: LayoutFlow,
  policy: ConnectionPolicy,
): ReadonlyMap<string, EdgePorts> {
  const sides = new Map<string, ReturnType<typeof sidesFor>>();
  const groups = new Map<string, { side: Side; node: string; ends: PortEnd[] }>();
  const join = (node: string, side: Side, id: string, other: Rect): void => {
    const key = `${node}|${side}`;
    const group = groups.get(key) ?? { side, node, ends: [] };
    group.ends.push({ id, other });
    groups.set(key, group);
  };
  for (const edge of edges) {
    const source = rects.get(edge.from);
    const target = rects.get(edge.to);
    if (!source || !target) continue;
    const chosen = sidesFor(policy, flow, source, target);
    sides.set(edge.id, chosen);
    join(edge.from, chosen.sourceSide, `${edge.id}|source`, target);
    join(edge.to, chosen.targetSide, `${edge.id}|target`, source);
  }
  const lanes = new Map<string, { lane: number; count: number }>();
  for (const group of groups.values()) {
    for (const [id, lane] of spreadPorts(group.side, group.ends)) lanes.set(id, { lane, count: group.ends.length });
  }
  const ports = new Map<string, EdgePorts>();
  for (const edge of edges) {
    const chosen = sides.get(edge.id);
    const source = lanes.get(`${edge.id}|source`);
    const target = lanes.get(`${edge.id}|target`);
    if (!chosen || !source || !target) continue;
    ports.set(edge.id, {
      ...chosen,
      sourceLane: source.lane,
      targetLane: target.lane,
      sourceLaneCount: source.count,
      targetLaneCount: target.count,
    });
  }
  return ports;
}
