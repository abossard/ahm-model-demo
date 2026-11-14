import { Suspense, createElement, lazy, type ComponentType } from "react";
import { DEFAULT_VIEW, VIEWS, type BuiltViewId, type ViewId } from "../model/views";
import type { ViewDefinition, ViewProps } from "./types";
import { CausePathView } from "./CausePathView";
import { OutlineControls } from "./OutlineControls";
import { ZoomControls } from "./ZoomControls";

/**
 * A view fetched when it is first shown. The fallback fills the same flex space the view does, so nothing moves
 * when the view arrives. The default view stays in the main bundle: it is what the first load draws.
 */
function lazyView(load: () => Promise<ComponentType<ViewProps>>): ComponentType<ViewProps> {
  const View = lazy(async () => ({ default: await load() }));
  return (props) => createElement(Suspense, { fallback: createElement("div", { style: { flex: 1, minWidth: 0, minHeight: 0 } }) }, createElement(View, props));
}

const SwimlanesView = lazyView(async () => (await import("./SwimlanesView")).SwimlanesView);
const TidyView = lazyView(async () => (await import("./TidyView")).TidyView);
const ZoomView = lazyView(async () => (await import("./ZoomView")).ZoomView);
const OutlineView = lazyView(async () => (await import("./OutlineView")).OutlineView);
const CoverageView = lazyView(async () => (await import("./CoverageView")).CoverageView);

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
