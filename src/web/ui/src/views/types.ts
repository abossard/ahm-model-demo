import type { ComponentType } from "react";
import type { ChangeBadge } from "../model/changes";
import type { CompareMode, CompareProps } from "../model/compare";
import type { Entity, Relationship } from "../model/types";
import type { ViewMeta } from "../model/views";

/**
 * What every view is given. A view reads whatever else it needs, such as the Health filter, the
 * open chips or the zoom, from the store itself with atomic selectors; the props are only what
 * all views share. Entities and relationships are the whole model: a view applies the Health
 * filter itself (`visibleGraph` in `model/collapse.ts` does it).
 */
export interface ViewProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  readonly selectedName: string | null;
  /** The entity a search result or "Show on graph" points at: drawn with a stronger ring. */
  readonly highlightedName: string | null;
  /** The entities an open Explain result traces, the asked one first: mark them, numbered from the last. */
  readonly chainNames: readonly string[];
  /** What a compared diff does to each entity this drawing has, keyed by lower-cased name. Only in Compare. */
  readonly badges?: ReadonlyMap<string, ChangeBadge>;
  /** The entities whose changes are ticked in the change list, lower-cased: mark them. Only in Compare. */
  readonly marked?: ReadonlySet<string>;
  /** Present while a diff is compared: which copy this is, and what a split view arranges on. */
  readonly compare?: CompareProps;
  /** Open an entity: `actions.activateEntity`. Selecting, in Compare ticking its changes, is the store's business. */
  readonly onActivate: (name: string) => void;
}

/** What a view's own toolbar controls are given. */
export interface ViewControlsProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

export interface ViewDefinition extends ViewMeta {
  readonly Component: ComponentType<ViewProps>;
  /**
   * How the view draws a compared diff. `split`: twice, Base and Proposed, on an arrangement they
   * share (`compare.basis`), each side drawing its own entities. `merged`: once, over everything
   * either side has, with `badges` on every entity that is added, changed or removed.
   */
  readonly compareMode: CompareMode;
  /** Controls that only make sense for this view, shown in the toolbar while it is selected. */
  readonly Controls?: ComponentType<ViewControlsProps>;
  /** Extra lines for the legend: what a lane, a chip or a cell means in this view. */
  readonly legendNotes?: readonly string[];
}
