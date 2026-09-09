import type { JSX } from "react";
import { BaseEdge, getBezierPath, getSmoothStepPath, useInternalNode } from "@xyflow/react";
import type { Edge, EdgeProps, InternalNode, Node, Position } from "@xyflow/react";
import {
  attachmentPoint,
  type EdgeStyle,
  type Rect,
  type Side,
} from "../model/edgeRouting";

export interface FloatingEdgeData extends Record<string, unknown> {
  readonly sourceSide: Side;
  readonly targetSide: Side;
  readonly sourceLane: number;
  readonly targetLane: number;
  readonly sourceLaneCount: number;
  readonly targetLaneCount: number;
  readonly style?: EdgeStyle;
}

export type FloatingRfEdge = Edge<FloatingEdgeData, "floating">;

/** The card as React Flow measured it, so an endpoint lands on the painted boundary. */
function rectOf(node: InternalNode<Node>): Rect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  };
}

export function FloatingEdge(props: EdgeProps<FloatingRfEdge>): JSX.Element | null {
  const source = useInternalNode(props.source);
  const target = useInternalNode(props.target);
  const data = props.data;
  if (!source || !target || !data) return null;

  const from = attachmentPoint(rectOf(source), data.sourceSide, data.sourceLane, data.sourceLaneCount);
  const to = attachmentPoint(rectOf(target), data.targetSide, data.targetLane, data.targetLaneCount);
  const ends = {
    sourceX: from.x, sourceY: from.y, sourcePosition: data.sourceSide as Position,
    targetX: to.x, targetY: to.y, targetPosition: data.targetSide as Position,
  };
  const [path, labelX, labelY] = (data.style ?? "smooth") === "smooth"
    ? getBezierPath(ends)
    : getSmoothStepPath(data.style === "right-angle" ? { ...ends, borderRadius: 0 } : ends);

  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style ?? {}}
      labelX={labelX}
      labelY={labelY}
      label={props.label}
      labelStyle={props.labelStyle ?? {}}
      labelShowBg={props.labelShowBg ?? false}
      labelBgStyle={props.labelBgStyle ?? {}}
      labelBgPadding={props.labelBgPadding ?? [2, 4]}
      labelBgBorderRadius={props.labelBgBorderRadius ?? 2}
    />
  );
}
