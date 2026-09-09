import type { JSX } from "react";
import { BaseEdge, useInternalNode } from "@xyflow/react";
import type { Edge, EdgeProps, InternalNode, Node } from "@xyflow/react";
import {
  attachmentPoint,
  midpointOf,
  pathForStyle,
  type EdgeStyle,
  type Rect,
  type Route,
} from "../model/edgeRouting";

export interface FloatingEdgeData extends Record<string, unknown> {
  readonly route: Route;
  readonly lane: number;
  readonly sourceLane?: number;
  readonly targetLane?: number;
  readonly sourceLaneCount?: number;
  readonly targetLaneCount?: number;
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
  const route = props.data?.route;
  if (!source || !target || !route) return null;

  const from = attachmentPoint(rectOf(source), route.sourceSide, props.data?.sourceLane ?? props.data?.lane ?? 0, props.data?.sourceLaneCount ?? 0);
  const to = attachmentPoint(rectOf(target), route.targetSide, props.data?.targetLane ?? props.data?.lane ?? 0, props.data?.targetLaneCount ?? 0);
  const points = [from, ...route.waypoints, to];
  const label = midpointOf(points);

  return (
    <BaseEdge
      id={props.id}
      path={pathForStyle(props.data?.style ?? "rounded", points)}
      style={props.style ?? {}}
      labelX={label.x}
      labelY={label.y}
      label={props.label}
      labelStyle={props.labelStyle ?? {}}
      labelShowBg={props.labelShowBg ?? false}
      labelBgStyle={props.labelBgStyle ?? {}}
      labelBgPadding={props.labelBgPadding ?? [2, 4]}
      labelBgBorderRadius={props.labelBgBorderRadius ?? 2}
    />
  );
}
