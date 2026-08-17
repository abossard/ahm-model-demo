import type { GraphLayout, NodeSize, Point } from "./layout";
import type { Entity, HealthState } from "./types";

export type SortKey = "name" | "observed" | "health";

export type RankAxis = "x" | "y" | null;

export const HEALTH_SORT_ORDER: readonly HealthState[] = [
  "Unhealthy",
  "Degraded",
  "Unknown",
  "Healthy",
  "Deleted",
];

export const SORT_CHOICES: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: "name", label: "Name" },
  { key: "observed", label: "Last observed" },
  { key: "health", label: "Health state" },
];

function labelOf(item: Entity): string {
  return (item.displayName || item.name).toLocaleLowerCase();
}

function severityOf(item: Entity): number {
  const index = HEALTH_SORT_ORDER.indexOf(item.healthState);
  return index < 0 ? HEALTH_SORT_ORDER.length : index;
}

function byName(left: Entity, right: Entity): number {
  return labelOf(left).localeCompare(labelOf(right));
}

/** Entities with no `latestEvaluationAt` are never comparable, so they are held out of the sort. */
function isUndated(item: Entity): boolean {
  return !item.latestEvaluationAt;
}

export function orderEntities(
  entities: readonly Entity[],
  key: SortKey,
  reversed: boolean,
): readonly Entity[] {
  const undated = key === "observed" ? entities.filter(isUndated) : [];
  const sortable = key === "observed" ? entities.filter((item) => !isUndated(item)) : [...entities];

  sortable.sort((left, right) => {
    if (key === "name") return byName(left, right);
    if (key === "health") return severityOf(left) - severityOf(right) || byName(left, right);
    const compared = (right.latestEvaluationAt ?? "").localeCompare(left.latestEvaluationAt ?? "");
    return compared || byName(left, right);
  });

  if (reversed) sortable.reverse();
  return [...sortable, ...undated.sort(byName)];
}

function crossOf(point: Point, axis: Exclude<RankAxis, null>): number {
  return axis === "x" ? point.y : point.x;
}

function alongOf(point: Point, axis: Exclude<RankAxis, null>): number {
  return axis === "x" ? point.x : point.y;
}

function extentOf(size: NodeSize, axis: Exclude<RankAxis, null>): number {
  return axis === "x" ? size.width : size.height;
}

/**
 * The smallest edge-to-edge gap dagre already used on this rank. Reusing it keeps a reordered rank
 * as tight as the original instead of inventing a spacing constant.
 */
function gapOf(
  members: readonly string[],
  positions: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
  axis: Exclude<RankAxis, null>,
): number {
  const spans = members
    .map((name) => ({
      start: alongOf(positions.get(name) ?? { x: 0, y: 0 }, axis),
      size: extentOf(sizes.get(name) ?? { width: 0, height: 0 }, axis),
    }))
    .sort((left, right) => left.start - right.start);

  let gap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    if (!previous || !current) continue;
    gap = Math.min(gap, current.start - (previous.start + previous.size));
  }
  return Number.isFinite(gap) ? Math.max(0, gap) : 0;
}

/**
 * Re-seats same-rank nodes along the rank axis to match `order`, packing them so nodes of differing
 * size can never overlap. A layout with no shared ranks (radial, force) is returned untouched.
 */
export function orderWithinRanks(
  layout: GraphLayout,
  order: readonly string[],
  axis: RankAxis,
  sizes: ReadonlyMap<string, NodeSize>,
): GraphLayout {
  if (!axis) return layout;

  const ranks = new Map<number, string[]>();
  for (const [name, point] of layout.positions) {
    const key = crossOf(point, axis);
    const members = ranks.get(key);
    if (members) members.push(name);
    else ranks.set(key, [name]);
  }

  const rankOf = new Map(order.map((name, index) => [name, index] as const));
  const positions = new Map(layout.positions);

  for (const members of ranks.values()) {
    if (members.length < 2) continue;

    const slots = members
      .map((name) => alongOf(layout.positions.get(name) ?? { x: 0, y: 0 }, axis))
      .sort((left, right) => left - right);
    const gap = gapOf(members, layout.positions, sizes, axis);
    const sorted = [...members].sort(
      (left, right) =>
        (rankOf.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (rankOf.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

    let cursor = Number.NEGATIVE_INFINITY;
    sorted.forEach((name, index) => {
      const point = positions.get(name);
      if (!point) return;
      const start = Math.max(slots[index] ?? 0, cursor);
      cursor = start + extentOf(sizes.get(name) ?? { width: 0, height: 0 }, axis) + gap;
      positions.set(name, axis === "x" ? { x: start, y: point.y } : { x: point.x, y: start });
    });
  }

  let width = 0;
  let height = 0;
  for (const [name, point] of positions) {
    const size = sizes.get(name) ?? { width: 0, height: 0 };
    width = Math.max(width, point.x + size.width);
    height = Math.max(height, point.y + size.height);
  }

  return { positions, width, height };
}
