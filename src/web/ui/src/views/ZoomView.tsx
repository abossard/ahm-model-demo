import type { JSX } from "react";
import { Topology } from "../components/Topology";
import { SIDE_LABEL } from "../model/compare";
import { SEMANTIC_MIN_ZOOM, fitFloor } from "../model/zoomLevels";
import type { ViewProps } from "./types";

// Each side has half the width, so a wide graph needs to zoom out further than a single graph does.
const COMPARE_MIN_ZOOM = 0.15;

/**
 * The card graph: every entity as a card with its signals, arranged by the chosen layout. It is
 * today's graph and grows into the semantic zoom view. It reads layout, order, collapse and
 * filter state from the store itself. In Compare it is drawn twice, once per side, both arranged
 * on everything either side has.
 */
export function ZoomView({ entities, relationships, badges, marked, compare }: ViewProps): JSX.Element {
  const side = compare !== undefined && compare.side !== "merged" ? compare.side : null;
  const shared = {
    entities,
    relationships,
    ...(badges ? { badges } : {}),
    ...(marked ? { marked } : {}),
  };
  if (side !== null && compare !== undefined) {
    return <Topology idPrefix={`graph-${side}`} label={SIDE_LABEL[side]} minZoom={COMPARE_MIN_ZOOM} basis={compare.basis} {...shared} />;
  }
  return <Topology idPrefix="topology" minZoom={SEMANTIC_MIN_ZOOM} fitMinZoom={fitFloor(entities.length)} minimap {...shared} />;
}
