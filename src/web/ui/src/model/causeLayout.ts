import { arrange } from "./arrange";
import type { CausePath, FoldedGroup } from "./causePath";
import type { Rect } from "./edgeRouting";
import type { Point } from "./layout";
import { impactOf } from "./palette";
import { routeSteps, type RouteEdge, type RouteNode } from "./stepRouter";
import type { Entity, EntitySignal, Relationship } from "./types";

/**
 * Sizes and places what the Cause path view draws. Sizes follow severity, not content: a broken
 * part is a large card with its failing signals, a degraded one a normal card, the rest a small
 * pill. Every size is a function of the data, so the layout needs no measuring and the same input
 * always gives the same picture.
 */
export type CardKind = "hero" | "card" | "pill";

export const CARD_WIDTH: Readonly<Record<CardKind, number>> = { hero: 284, card: 252, pill: 190 };
const HEADER = 56;
const CHIP_ROW = 26;
const ROW = 22;
const ROWS_PAD = 8;
const SUMMARY_ROW = 20;
const PILL_HEIGHT = 34;
const CHIP_HEIGHT = 28;
/** Signals a card lists before it says "and N more". */
export const MAX_SIGNAL_ROWS = 4;

export interface Placement {
  /** The entity's name, or `fold:<group id>` for a chip. */
  readonly id: string;
  readonly kind: CardKind | "chip";
  readonly rect: Rect;
  /** Position in the chain from the failing leaf, from 1; null off the chain. */
  readonly step: number | null;
  /** The signals a card lists: the ones that are not Healthy, worst first. */
  readonly rows: readonly EntitySignal[];
  readonly moreRows: number;
  readonly healthySignals: number;
  readonly group: FoldedGroup | null;
}

export interface PlacedEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly Point[];
  readonly label: Point | null;
  readonly text: string;
  /** The relationship, or null for the line to a chip. */
  readonly relationship: Relationship | null;
}

export interface CauseLayout {
  readonly nodes: readonly Placement[];
  readonly edges: readonly PlacedEdge[];
  readonly bounds: Rect;
}

export const chipId = (group: FoldedGroup): string => `fold:${group.id}`;

const SEVERITY: Readonly<Record<string, number>> = { Unhealthy: 0, Degraded: 1, Unknown: 2, Healthy: 3 };

/** `changed`: the diff of a Compare touches it, which needs attention too: at least a card. */
export function kindOf(entity: Entity, step: number | null, changed = false): CardKind {
  if (entity.healthState === "Unhealthy" && impactOf(entity.impact) !== "Suppressed") return "hero";
  if (step !== null) return "hero";
  if (changed || (entity.healthState === "Degraded" && impactOf(entity.impact) !== "Suppressed")) return "card";
  return "pill";
}

function rowsOf(entity: Entity, kind: CardKind): Pick<Placement, "rows" | "moreRows" | "healthySignals"> {
  if (kind === "pill") return { rows: [], moreRows: 0, healthySignals: 0 };
  const failing = entity.signals
    .filter((signal) => signal.healthState !== "Healthy")
    .sort((left, right) => (SEVERITY[left.healthState] ?? 2) - (SEVERITY[right.healthState] ?? 2));
  return {
    rows: failing.slice(0, MAX_SIGNAL_ROWS),
    moreRows: Math.max(0, failing.length - MAX_SIGNAL_ROWS),
    healthySignals: entity.signals.length - failing.length,
  };
}

function sizeOf(entity: Entity, kind: CardKind, rows: ReturnType<typeof rowsOf>): { width: number; height: number } {
  const width = CARD_WIDTH[kind];
  if (kind === "pill") return { width: Math.min(width + 40, Math.max(width - 40, 56 + entity.displayName.length * 6.4)), height: PILL_HEIGHT };
  const lines = rows.rows.length + (rows.moreRows > 0 ? 1 : 0);
  const summary = rows.healthySignals > 0 ? SUMMARY_ROW : 0;
  const body = lines + (summary > 0 ? 1 : 0) > 0 ? ROWS_PAD + lines * ROW + summary : 0;
  return { width, height: HEADER + (impactOf(entity.impact) === "Standard" ? 0 : CHIP_ROW) + body };
}

export function chipWidth(group: FoldedGroup): number {
  return Math.round(36 + (group.open ? 4 : group.label.length) * 6.6);
}

export function layoutCause(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  path: CausePath,
  labelWidth: (text: string) => number,
  changed: ReadonlySet<string> = new Set(),
): CauseLayout {
  const byName = new Map(entities.map((entity) => [entity.name, entity] as const));
  const steps = new Map(path.chain.map((name, index) => [name, index + 1] as const));
  const drawn = path.draw.map((name) => byName.get(name) as Entity);

  const sizes = new Map<string, { width: number; height: number }>();
  const meta = new Map<string, Pick<Placement, "kind" | "rows" | "moreRows" | "healthySignals" | "step" | "group">>();
  for (const entity of drawn) {
    const step = steps.get(entity.name) ?? null;
    const kind = kindOf(entity, step, changed.has(entity.name));
    const rows = rowsOf(entity, kind);
    sizes.set(entity.name, sizeOf(entity, kind, rows));
    meta.set(entity.name, { kind, ...rows, step, group: null });
  }
  for (const group of path.folded) {
    sizes.set(chipId(group), { width: chipWidth(group), height: CHIP_HEIGHT });
    meta.set(chipId(group), { kind: "chip", rows: [], moreRows: 0, healthySignals: 0, step: null, group });
  }

  const drawnNames = new Set(path.draw);
  const lines = relationships.filter((item) => drawnNames.has(item.parentEntityName) && drawnNames.has(item.childEntityName));
  const links = [
    ...lines.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName, text: item.displayName ?? "", relationship: item })),
    ...path.folded.map((group) => ({ id: `chip:${group.id}`, from: group.owner, to: chipId(group), text: "", relationship: null })),
  ];

  const ids = [...sizes.keys()];
  const arrangement = arrange(
    ids.map((id) => ({ name: id, ...sizes.get(id)! })),
    links.map((link) => ({ parentEntityName: link.from, childEntityName: link.to, displayName: link.text })),
    "tb",
  );
  const nodes: RouteNode[] = ids.map((id) => ({ id, ...arrangement.positions.get(id)!, ...sizes.get(id)! }));
  const weight = (link: (typeof links)[number]): number => {
    const child = byName.get(link.to);
    return child ? 3 - (SEVERITY[child.healthState] ?? 2) : -1;
  };
  const routeEdges: RouteEdge[] = links.map((link) => ({ id: link.id, from: link.from, to: link.to, labelWidth: link.text ? Math.ceil(labelWidth(link.text)) + 16 : 0, weight: weight(link) }));
  const routing = routeSteps(nodes, routeEdges);
  const textOf = new Map(links.map((link) => [link.id, link] as const));

  return {
    nodes: ids.map((id) => ({ id, rect: routing.nodes.get(id)!, ...meta.get(id)! })),
    edges: routing.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      points: edge.points,
      label: edge.label,
      text: textOf.get(edge.id)!.text,
      relationship: textOf.get(edge.id)!.relationship,
    })),
    bounds: routing.bounds,
  };
}
