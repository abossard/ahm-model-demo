import { memo } from "react";
import type { JSX } from "react";
import { BaseEdge } from "@xyflow/react";
import type { Edge, EdgeProps, EdgeTypes } from "@xyflow/react";
import { cardTokens, type EdgeAppearance } from "../model/palette";
import type { Point } from "../model/layout";
import { roundedPath } from "../model/stepRouter";

/**
 * An edge that draws points computed beforehand, by `routeSteps` or by a view's own router: the
 * line through them with rounded corners, and the label pill where the router put it. Views
 * that route their own lines use it instead of React Flow's, which pick the path themselves.
 */
export interface StepEdgeData extends Record<string, unknown> {
  readonly points: readonly Point[];
  /** The centre of the label pill, or null for none. */
  readonly label: Point | null;
}

export type StepRfEdge = Edge<StepEdgeData, "step">;

function StepEdgeImpl(props: EdgeProps<StepRfEdge>): JSX.Element | null {
  const data = props.data;
  if (!data) return null;
  return (
    <BaseEdge
      id={props.id}
      path={roundedPath(data.points, 8)}
      style={props.style ?? {}}
      {...(data.label ? { labelX: data.label.x, labelY: data.label.y, label: props.label } : {})}
      labelStyle={props.labelStyle ?? {}}
      labelShowBg={props.labelShowBg ?? false}
      labelBgStyle={props.labelBgStyle ?? {}}
      labelBgPadding={props.labelBgPadding ?? [2, 4]}
      labelBgBorderRadius={props.labelBgBorderRadius ?? 2}
    />
  );
}

export const StepEdge = memo(StepEdgeImpl);

/** Register as `edgeTypes={stepEdgeTypes}` and build edges with `stepEdge`. */
export const stepEdgeTypes: EdgeTypes = { step: StepEdge };

export interface StepEdgeInput {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly points: readonly Point[];
  readonly label: Point | null;
  /** The text of the label pill, or empty for none. */
  readonly text: string;
  readonly appearance: EdgeAppearance;
  /** On the chain an Explain result or the Cause path view numbers: drawn thicker. */
  readonly emphasised?: boolean;
}

export function stepEdge(input: StepEdgeInput): StepRfEdge {
  const { appearance } = input;
  return {
    id: input.id,
    source: input.source,
    target: input.target,
    type: "step",
    ...(input.emphasised ? { className: "step-edge--chain" } : {}),
    data: { points: input.points, label: input.label },
    ...(input.text ? { label: input.text } : {}),
    labelShowBg: input.text.length > 0,
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 9,
    labelBgStyle: { fill: cardTokens.pillFill, stroke: cardTokens.pillStroke },
    labelStyle: { fill: cardTokens.ink, fontSize: 10.5 },
    style: {
      stroke: appearance.stroke,
      strokeWidth: input.emphasised ? appearance.width + 1.2 : appearance.width,
      ...(appearance.dash ? { strokeDasharray: appearance.dash, strokeLinecap: appearance.cap } : {}),
    },
  };
}
