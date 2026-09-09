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
