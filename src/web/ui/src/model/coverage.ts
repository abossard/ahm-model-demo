import type { Entity, Relationship } from "./types";

/**
 * The model as a partition (an icicle): a part is as wide as the number of leaf parts below it,
 * so the whole model reads as one band however large it is.
 *
 * An entity with several parents sits under its first parent, the one whose label sorts first;
 * the others are listed on its cell so a view can draw arcs to them. Order is by label, never by
 * the order of the input, so a refresh moves nothing but states.
 */
export interface CoverageCell {
  readonly name: string;
  /** The parent the cell sits under, or null for the root of a band. */
  readonly parent: string | null;
  /** The other parents, which this partition cannot show by position. */
  readonly otherParents: readonly string[];
  /** Rows below the root of the band, or below the entity zoomed to. */
  readonly depth: number;
  /** Where the cell starts and how wide it is, in leaf columns of its band. */
  readonly start: number;
  readonly span: number;
  readonly leaf: boolean;
  /** 0 for everything under the root, 1 for the parts that are not connected to it. */
  readonly band: 0 | 1;
}

export interface CoverageBand {
  readonly band: 0 | 1;
  /** Leaf columns in the band, the unit of `start` and `span`. */
  readonly leaves: number;
  /** Rows the band needs. */
  readonly rows: number;
}

export interface Coverage {
  /** Parents before children, siblings left to right. */
  readonly cells: readonly CoverageCell[];
  readonly bands: readonly CoverageBand[];
  /** The entity zoomed to, or null for the whole model. */
  readonly focus: string | null;
  /** From the root down to the entity zoomed to, or empty. */
  readonly trail: readonly string[];
}

export type Direction = "left" | "right" | "up" | "down" | "first" | "last";

function labelOf(entity: Entity): string {
  return (entity.displayName || entity.name).toLocaleLowerCase();
}

export function coverage(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  options: { readonly focus?: string | null } = {},
): Coverage {
  const byName = new Map(entities.map((entity) => [entity.name, entity] as const));
  const compare = (left: string, right: string): number => {
    const a = labelOf(byName.get(left) as Entity);
    const b = labelOf(byName.get(right) as Entity);
    return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
  };

  const parents = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const item of relationships) {
    const { parentEntityName: parent, childEntityName: child } = item;
    const key = `${parent}\u0000${child}`;
    if (parent === child || !byName.has(parent) || !byName.has(child) || seen.has(key)) continue;
    seen.add(key);
    (parents.get(child) ?? parents.set(child, []).get(child)!).push(parent);
  }
  for (const list of parents.values()) list.sort(compare);

  // The tree under first parents; an entity whose first-parent chain loops back is left for the unconnected band.
  const children = new Map<string, string[]>();
  const primary = new Map<string, string>();
  for (const entity of entities) {
    const first = parents.get(entity.name)?.[0];
    if (first === undefined) continue;
    primary.set(entity.name, first);
    (children.get(first) ?? children.set(first, []).get(first)!).push(entity.name);
  }
  for (const list of children.values()) list.sort(compare);

  const weights = new Map<string, number>();
  const weigh = (name: string, path: ReadonlySet<string>): number => {
    const known = weights.get(name);
    if (known !== undefined) return known;
    const next = new Set(path).add(name);
    const below = (children.get(name) ?? []).filter((child) => !next.has(child));
    const total = below.length === 0 ? 1 : below.reduce((sum, child) => sum + weigh(child, next), 0);
    weights.set(name, total);
    return total;
  };
  const rootNames = entities.map((entity) => entity.name).filter((name) => !primary.has(name)).sort(compare);
  const mainRoot = rootNames.reduce<string | null>((best, name) => (best === null || weigh(name, new Set()) > weigh(best, new Set()) ? name : best), null);
  const others = rootNames.filter((name) => name !== mainRoot);

  const cells: CoverageCell[] = [];
  const placed = new Set<string>();
  const depthOf = new Map<string, number>();
  const place = (name: string, start: number, depth: number, band: 0 | 1, parent: string | null): void => {
    placed.add(name);
    depthOf.set(name, depth);
    const below = (children.get(name) ?? []).filter((child) => !placed.has(child));
    cells.push({
      name,
      parent,
      otherParents: (parents.get(name) ?? []).filter((item) => item !== parent),
      depth,
      start,
      span: weigh(name, new Set()),
      leaf: below.length === 0,
      band,
    });
    let cursor = start;
    for (const child of below) {
      place(child, cursor, depth + 1, band, name);
      cursor += weigh(child, new Set());
    }
  };

  const focus = options.focus !== undefined && options.focus !== null && byName.has(options.focus) ? options.focus : null;
  const trail: string[] = [];
  if (focus !== null) {
    for (let name: string | undefined = focus; name !== undefined && !trail.includes(name); name = primary.get(name)) trail.unshift(name);
    place(focus, 0, 0, 0, null);
    const leaves = weigh(focus, new Set());
    return { cells, bands: [{ band: 0, leaves, rows: Math.max(...cells.map((cell) => cell.depth)) + 1 }], focus, trail };
  }

  let mainLeaves = 0;
  if (mainRoot !== null) {
    place(mainRoot, 0, 0, 0, null);
    mainLeaves = weigh(mainRoot, new Set());
  }
  const mainRows = cells.length === 0 ? 0 : Math.max(...cells.map((cell) => cell.depth)) + 1;
  let cursor = 0;
  const unconnectedFrom = cells.length;
  for (const name of others) {
    if (placed.has(name)) continue;
    place(name, cursor, 0, 1, null);
    cursor += weigh(name, new Set());
  }
  // Entities caught in a loop of first parents belong to no tree: show them in the same band.
  for (const entity of entities) {
    if (placed.has(entity.name)) continue;
    place(entity.name, cursor, 0, 1, null);
    cursor += weigh(entity.name, new Set());
  }
  const bands: CoverageBand[] = [];
  if (mainRoot !== null) bands.push({ band: 0, leaves: mainLeaves, rows: mainRows });
  if (cells.length > unconnectedFrom) {
    bands.push({ band: 1, leaves: cursor, rows: Math.max(...cells.slice(unconnectedFrom).map((cell) => cell.depth)) + 1 });
  }
  return { cells, bands, focus: null, trail };
}

/**
 * The cell a key moves to by structure: left and right along the siblings, up to the parent, down
 * to the first child. Roots of all bands count as siblings. Null where there is nowhere to go.
 */
export function neighbour(model: Coverage, name: string, direction: Direction): string | null {
  const cell = model.cells.find((item) => item.name === name);
  if (!cell) return null;
  const siblings = model.cells.filter((item) => (cell.parent === null ? item.parent === null : item.parent === cell.parent));
  const index = siblings.findIndex((item) => item.name === name);
  switch (direction) {
    case "left":
      return siblings[index - 1]?.name ?? null;
    case "right":
      return siblings[index + 1]?.name ?? null;
    case "first":
      return siblings[0]?.name ?? null;
    case "last":
      return siblings[siblings.length - 1]?.name ?? null;
    case "up":
      return cell.parent;
    case "down":
      return model.cells.find((item) => item.parent === name)?.name ?? null;
  }
}
