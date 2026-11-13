import { DEFAULT_VIEW, VIEWS, type BuiltViewId, type ViewId } from "../model/views";
import type { ViewDefinition } from "./types";
import { CausePathView } from "./CausePathView";
import { CoverageView } from "./CoverageView";
import { OutlineControls } from "./OutlineControls";
import { OutlineView } from "./OutlineView";
import { SwimlanesView } from "./SwimlanesView";
import { TidyView } from "./TidyView";
import { ZoomControls } from "./ZoomControls";
import { ZoomView } from "./ZoomView";

type Parts = Omit<ViewDefinition, "id" | "label" | "description">;

/** The component of every built view. The type fails to compile when a view in `VIEWS` has none. */
const PARTS: { readonly [K in BuiltViewId]: Parts } = {
  swimlanes: { Component: SwimlanesView, compareMode: "split", legendNotes: ["Lane = layer: flows, systems, resources, context", "Line colour = what the child contributes", "Dashed chip = healthy parts folded under their parent"] },
  tidy: { Component: TidyView, compareMode: "split", legendNotes: ["Dashed frame = parts not connected to the root", "Count tile = healthy leaves folded in a large model: click to open"] },
  cause: { Component: CausePathView, compareMode: "merged", legendNotes: ["Big = broken, small = fine", "Dashed chip = folded parts: click or press Enter to open"] },
  zoom: { Component: ZoomView, compareMode: "split", Controls: ZoomControls, cardSignals: true },
  outline: { Component: OutlineView, compareMode: "merged", Controls: OutlineControls, legendNotes: ["Right edge: one mark per row, click to jump", "Arrow keys move, Right and Left open and close, Enter opens the entity"] },
  coverage: { Component: CoverageView, compareMode: "merged", legendNotes: ["Width = leaf parts below", "Number badge = parents; arcs show on selection"] },
};

export const VIEW_DEFINITIONS: readonly ViewDefinition[] = VIEWS.map((meta) => ({ ...meta, ...PARTS[meta.id] }));

/** The definition of a view; one that is not built yet is shown as the default view, or the first. */
export function viewDefinition(id: ViewId): ViewDefinition {
  return (
    VIEW_DEFINITIONS.find((definition) => definition.id === id) ??
    VIEW_DEFINITIONS.find((definition) => definition.id === DEFAULT_VIEW) ??
    (VIEW_DEFINITIONS[0] as ViewDefinition)
  );
}
