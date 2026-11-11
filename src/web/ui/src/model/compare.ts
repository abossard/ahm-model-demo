import { badgesByEntity, badgesForSide, unionSnapshots, type ChangeBadge, type CompareSide } from "./changes";
import type { DiffView, Entity, HealthModelSnapshot, Relationship } from "./types";

/**
 * How a view draws a compared diff. A view says which of the two it does, and Compare gives it
 * the data for it:
 *
 * - `split`: the view is drawn twice, Base and Proposed, each with its own entities and the marks
 *   that exist on its side, on an arrangement the two share, so an entity keeps its place.
 * - `merged`: the view is drawn once over everything either side has, every entity carrying its
 *   mark. A second copy would add nothing, for a tree, an icicle or a list of what needs attention.
 */
export type CompareMode = "split" | "merged";

export type CompareDrawing = CompareSide | "merged";

/** What a view is told while it draws a diff. */
export interface CompareProps {
  /** Which copy of a split view this is, or `merged` for the one drawing of a merged view. */
  readonly side: CompareDrawing;
  /**
   * Everything either side draws, with this side's version of each entity it has. A split view
   * arranges on this and draws its own entities, so both sides get the same places and its cards
   * are as big as this side's entities need.
   */
  readonly basis: HealthModelSnapshot;
  /** The same list with the other side's version of each entity: what a card may need as much room as. */
  readonly other: HealthModelSnapshot;
  /**
   * Everything either side draws, one version of each (the Proposed model's where both have it), the
   * same object for both sides: what has to be decided once for both, such as the lane of an entity.
   */
  readonly union: HealthModelSnapshot;
  /** Every mark of the diff, on both sides: what must stay unfolded in the shared arrangement. */
  readonly marks: ReadonlyMap<string, ChangeBadge>;
}

/** One drawing of a view in Compare: the entities and marks it draws, and what it is told. */
export interface CompareDrawingData {
  readonly side: CompareDrawing;
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  /** What the diff does to each entity this drawing has, keyed by lower-cased name. */
  readonly badges: ReadonlyMap<string, ChangeBadge>;
  readonly compare: CompareProps;
}

export const SIDE_LABEL: Readonly<Record<CompareSide, string>> = { base: "Model now", proposed: "Model after the changes" };

/**
 * Both sides on one list of entities and relationships, in the order of the union, with the
 * version of each that `side` has. The order is the same for both sides, so that two arrangements
 * that sort by input order agree.
 */
export function basisFor(view: Pick<DiffView, "base" | "proposed">, side: CompareSide): HealthModelSnapshot {
  const own = side === "base" ? view.base : view.proposed;
  const ownEntities = new Map(own.entities.map((entity) => [entity.name, entity] as const));
  const ownRelationships = new Map(own.relationships.map((item) => [item.name, item] as const));
  const both = unionSnapshots(view.base, view.proposed);
  return {
    entities: both.entities.map((entity) => ownEntities.get(entity.name) ?? entity),
    relationships: both.relationships.map((item) => ownRelationships.get(item.name) ?? item),
  };
}

export function compareDrawings(view: Pick<DiffView, "base" | "proposed" | "changes">, mode: CompareMode): readonly CompareDrawingData[] {
  const marks = badgesByEntity(view.changes);
  const union = unionSnapshots(view.base, view.proposed);
  if (mode === "merged") {
    return [{ side: "merged", entities: union.entities, relationships: union.relationships, badges: marks, compare: { side: "merged", basis: union, other: union, union, marks } }];
  }
  return (["base", "proposed"] as const).map((side): CompareDrawingData => {
    const own = side === "base" ? view.base : view.proposed;
    return { side, entities: own.entities, relationships: own.relationships, badges: badgesForSide(marks, side), compare: { side, basis: basisFor(view, side), other: basisFor(view, side === "base" ? "proposed" : "base"), union, marks } };
  });
}

/** What a view says when it has nothing to draw: in a split Compare, which side is empty. */
export function noEntitiesText(compare: CompareProps | undefined): string {
  return emptyText(compare !== undefined && compare.side !== "merged" ? SIDE_LABEL[compare.side] : undefined);
}

/** The same sentence for a drawing that only knows the caption of its side. */
export function emptyText(sideLabel: string | undefined): string {
  return sideLabel ? `${sideLabel}: no entities.` : "This health model has no entities.";
}

/** The pair of entities a relationship joins, as one key. */
export const linkKey = (parent: string, child: string): string => `${parent}\u0000${child}`;
