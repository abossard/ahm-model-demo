/**
 * What a card shows at each zoom. Far out a card is a dot, a little closer a pill with the name,
 * close enough a card with its signals. The floors are zoom factors of the canvas; the sizes are
 * the height of what is drawn, in layout pixels, so the edges meet it where it ends.
 */
export type ZoomLevel = "card" | "pill" | "dot" | "speck";

/**
 * Cards keep their form down to the 0.5 zoom the canvas used to stop at (a hair under it, so
 * float noise in a zoom of "0.5" does not turn them into pills).
 */
export const LEVEL_FLOORS: Readonly<Record<Exclude<ZoomLevel, "speck">, number>> = { card: 0.495, pill: 0.28, dot: 0.15 };

/** The lowest zoom the card graph allows: far enough out for a model of several hundred entities. */
export const SEMANTIC_MIN_ZOOM = 0.06;

export function zoomLevel(zoom: number | undefined): ZoomLevel {
  if (zoom === undefined || zoom >= LEVEL_FLOORS.card) return "card";
  if (zoom >= LEVEL_FLOORS.pill) return "pill";
  return zoom >= LEVEL_FLOORS.dot ? "dot" : "speck";
}

/** Height of the pill, dot and speck; a card has the height of its content. */
export const LEVEL_HEIGHT: Readonly<Record<Exclude<ZoomLevel, "card">, number>> = { pill: 44, dot: 44, speck: 88 };

/**
 * A model of more entities than this opens zoomed out far enough to see all of it, as name pills
 * or dots; a smaller one opens as cards, as the canvas always did, however far it spreads.
 */
export const SEMANTIC_FIT_AT = 60;

/** How far an automatic fit may zoom out for a model of this many entities. */
export function fitFloor(entities: number, cardFloor = 0.5): number {
  return entities > SEMANTIC_FIT_AT ? SEMANTIC_MIN_ZOOM : cardFloor;
}
