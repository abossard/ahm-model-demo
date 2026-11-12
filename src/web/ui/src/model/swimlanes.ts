import type { ChangeBadge } from "./changes";
import { healthBucket } from "./collapse";
import type { Rect } from "./edgeRouting";
import type { Layering, LaneKind } from "./layerOf";
import type { Point } from "./layout";
import { linkKey } from "./compare";
import { ranksInOrder, type ModelOrder } from "./customOrder";
import { impactOf } from "./palette";
import { FOLD_HEIGHT, foldWidth, measureCard, pillOf, type CardSpec, type SignalMode } from "./swimlaneCard";
import { foldGroups, type FoldGroup } from "./swimlaneFold";
import { orderRows, relaxCoordinates } from "./swimlaneGeometry";
import { PITCH, planRoutes, type RouteEdge } from "./swimlaneRoute";
import type { Entity, HealthState, Relationship } from "./types";

/**
 * The Swimlanes layout: lanes of cards, edges routed through the channels between them.
 *
 * Pipeline: the lane of every entity comes from `layerOf`; cards are measured (`swimlaneCard`);
 * a lane that would be very wide folds its healthy subtrees into one "+N healthy" chip per parent;
 * cards are ordered by barycenter sweeps and a lane that is still wide wraps into several rows;
 * coordinates come from constrained projection with variable card widths; lanes are stacked with
 * a channel between every two rows; and `planRoutes` draws one orthogonal line per edge. A line
 * that finds no free corridor widens that gap and the plan is made again, so no line runs through
 * a card. Everything is a function of the input, so the same entities in any order give the same picture.
 *
 * Ported from the swimlane prototype and ahm-diagrammo (MIT), src/swimlane.mjs.
 */
export interface SwimlaneInput {
  /** What is drawn: the model after the Health filter. */
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  /** The lanes of the whole model, so that a filter never moves an entity to another lane. */
  readonly layering: Layering;
}

export interface SwimlaneOptions {
  /** Show signal rows on the cards. In a dense model only the ones that are not healthy. */
  readonly signals: boolean;
  /** Draw the relationship's label on its line; null leaves them out of a dense model and draws them in any other. */
  readonly labels: boolean | null;
  /** Owners whose folded chip is open, by entity name. */
  readonly open: ReadonlySet<string>;
  /** Entities that never fold, such as the chain of an Explain result. */
  readonly keep: ReadonlySet<string>;
  readonly badges?: ReadonlyMap<string, ChangeBadge>;
  /** A lane whose cards need more than this many px folds its healthy subtrees. 0 never folds. */
  readonly foldAbove?: number;
  /** A lane wider than this wraps into rows. */
  readonly maxRowWidth?: number;
  /**
   * In Compare, both sides are laid out together and each draws only what it has, in the place the
   * shared layout gives it. The lanes, their frames and the bounds stay the same for both.
   */
  readonly only?: SwimlaneOnly;
  /**
   * In Compare, the other side's versions of the entities. A card takes the room of the bigger of
   * its two versions (the card still shows this side's), so an entity takes the same room, and so
   * the same place, on both sides even when an impact chip or a signal makes one version bigger.
   */
  readonly rival?: readonly Entity[];
  /**
   * The order the viewer gave the model by dragging. It is laid over the order the sweeps give a
   * lane: cards that share a parent stand in it, and what hangs below them goes along. No card
   * changes lane for it.
   */
  readonly order?: ModelOrder | null;
}

/** What one side of a Compare draws of a layout made for both. */
export interface SwimlaneOnly {
  readonly entities: ReadonlySet<string>;
  /** The relationships it has, as `linkKey(parent, child)`. */
  readonly links: ReadonlySet<string>;
}

export const FOLD_ABOVE = 2400;
export const MAX_ROW_WIDTH = 2400;
const GAP = 30;
const TOP = 34;
const FIRST_ROW_TOP = 16;
const ROW_TOP = 12;
const ROW_BOTTOM = 14;
const MIN_ROW = 44;
const MARGIN = 28;
/** The column at the left of every lane that holds its title: no card or line goes there. */
export const LANE_GUTTER = 132;
const MAX_PLANS = 10;

export interface SwimLane {
  readonly index: number;
  readonly kind: LaneKind;
  readonly title: string;
  /** Entities in the lane, folded ones included. */
  readonly count: number;
  readonly rect: Rect;
}

export interface SwimCard {
  readonly id: string;
  readonly lane: number;
  /** The row of the layout: a lane that wrapped has several. */
  readonly row: number;
  readonly rect: Rect;
  readonly spec: CardSpec;
}

/** A chip that stands for the healthy leaves of one parent. */
export interface SwimFold {
  readonly id: string;
  readonly owner: string;
  readonly lane: number;
  readonly row: number;
  readonly rect: Rect;
  readonly members: readonly string[];
  readonly open: boolean;
  /** Members per health state. */
  readonly states: Readonly<Partial<Record<HealthState, number>>>;
}

export interface SwimEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly Point[];
  /** The centre of the label pill, or null. */
  readonly label: Point | null;
  readonly text: string;
  /** The relationship, or null for the line to a chip. */
  readonly relationship: string | null;
}

export interface SwimlaneLayout {
  readonly lanes: readonly SwimLane[];
  /** Cards and chips are listed lane by lane, row by row, left to right: the order of the keyboard. */
  readonly cards: readonly SwimCard[];
  readonly folds: readonly SwimFold[];
  readonly edges: readonly SwimEdge[];
  readonly bounds: Rect;
  /** The model was wide enough to fold its healthy subtrees and show only the signals that are not healthy. */
  readonly dense: boolean;
  /** Whether the lines carry their labels. */
  readonly labels: boolean;
  /** Corridors that found no free slot after the last plan: none unless a row had no gap left to widen. */
  readonly shortages: number;
}

export const foldId = (owner: string): string => `fold:${owner}`;
const key = (a: string, b: string): string => `${a}\u0000${b}`;
const text = (entity: Entity): string => (entity.displayName || entity.name).toLowerCase();
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const WEIGHT: Readonly<Record<string, number>> = { Healthy: 0, Unknown: 1, Degraded: 2, Unhealthy: 3 };

interface Drawn {
  readonly id: string;
  readonly lane: number;
  readonly width: number;
  readonly height: number;
  readonly sortKey: string;
}

/**
 * The rows a lane wraps into: as many as its width needs, with consecutive cards going down a
 * column (card i is in row i mod k). Siblings, which the order keeps together, then stack under
 * each other and the lane is a k-th as wide, instead of its second half sitting under the wrong parents.
 */
function wrap(ids: readonly string[], widthOf: (id: string) => number, maxWidth: number): string[][] {
  const total = ids.reduce((sum, id) => sum + widthOf(id), 0) + GAP * Math.max(0, ids.length - 1);
  const count = Math.min(ids.length, Math.max(1, Math.ceil(total / maxWidth)));
  const rows: string[][] = Array.from({ length: count }, () => []);
  ids.forEach((id, index) => rows[index % count]!.push(id));
  return rows;
}

/** Widens the gap nearest to `x` in a row: one more corridor fits through it. */
function widen(row: readonly string[], centre: ReadonlyMap<string, number>, widths: ReadonlyMap<string, number>, x: number, extra: Map<string, number>): boolean {
  const sorted = [...row].sort((a, b) => (centre.get(a) as number) - (centre.get(b) as number));
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const left = sorted[index] as string;
    const right = sorted[index + 1] as string;
    const middle = ((centre.get(left) as number) + (widths.get(left) as number) / 2 + (centre.get(right) as number) - (widths.get(right) as number) / 2) / 2;
    if (Math.abs(middle - x) < bestDistance) {
      bestDistance = Math.abs(middle - x);
      best = index;
    }
  }
  if (best < 0) return false;
  const id = sorted[best] as string;
  extra.set(id, (extra.get(id) ?? 0) + 2 * PITCH);
  return true;
}

export function layoutSwimlanes({ entities, relationships, layering }: SwimlaneInput, options: SwimlaneOptions): SwimlaneLayout {
  const byName = new Map(entities.map((entity) => [entity.name, entity] as const));
  const used = layering.lanes.map((lane, index) => ({ lane, index, names: lane.names.filter((name) => byName.has(name)) })).filter((item) => item.names.length > 0);
  const lastLane = Math.max(0, used.length - 1);
  const laneOf = new Map<string, number>();
  used.forEach((item, index) => item.names.forEach((name) => laneOf.set(name, index)));
  for (const entity of entities) if (!laneOf.has(entity.name)) laneOf.set(entity.name, lastLane);

  const pairs = new Map<string, Relationship>();
  for (const item of relationships) {
    const { parentEntityName: parent, childEntityName: child } = item;
    if (parent === child || !byName.has(parent) || !byName.has(child)) continue;
    if (!pairs.has(key(parent, child))) pairs.set(key(parent, child), item);
  }
  const relations = [...pairs.entries()].sort(([a], [b]) => byText(a, b)).map(([, item]) => item);
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const item of relations) {
    (parentsOf.get(item.childEntityName) ?? parentsOf.set(item.childEntityName, []).get(item.childEntityName)!).push(item.parentEntityName);
    (childrenOf.get(item.parentEntityName) ?? childrenOf.set(item.parentEntityName, []).get(item.parentEntityName)!).push(item.childEntityName);
  }

  // ----- measure; a lane that needs a lot of width makes the model dense -----
  const measure = (mode: SignalMode): Map<string, CardSpec> => new Map(entities.map((entity) => [entity.name, measureCard(entity, mode, options.badges?.get(entity.name.toLowerCase()) ?? null)] as const));
  let specs = measure(options.signals ? "all" : "none");
  const laneWidth = (names: readonly string[]): number => names.reduce((sum, name) => sum + (specs.get(name) as CardSpec).width, 0) + GAP * Math.max(0, names.length - 1);
  const foldAbove = options.foldAbove ?? FOLD_ABOVE;
  const dense = foldAbove > 0 && used.some((item) => laneWidth(item.names) > foldAbove);
  if (dense && options.signals) specs = measure("problems");

  // ----- fold the healthy subtrees of a dense model, one chip per parent -----
  const kindOfName = (name: string): LaneKind => used[laneOf.get(name) as number]?.lane.kind ?? "resources";
  const { groups, hidden } = dense
    ? foldGroups({ names: entities.map((entity) => entity.name), byName, parentsOf, childrenOf, kindOf: kindOfName, open: options.open, keep: options.keep })
    : { groups: new Map<string, FoldGroup>(), hidden: new Set<string>() };

  // ----- the nodes that are drawn: cards, and a chip per group -----
  const rivals = new Map((options.rival ?? []).map((entity) => [entity.name, entity] as const));
  const mode: SignalMode = options.signals ? (dense ? "problems" : "all") : "none";
  const drawn = new Map<string, Drawn>();
  for (const entity of entities) {
    if (hidden.has(entity.name)) continue;
    const spec = specs.get(entity.name) as CardSpec;
    const rival = rivals.get(entity.name);
    const theirs = rival ? measureCard(rival, mode, options.badges?.get(entity.name.toLowerCase()) ?? null) : spec;
    drawn.set(entity.name, { id: entity.name, lane: laneOf.get(entity.name) as number, width: Math.max(spec.width, theirs.width), height: Math.max(spec.height, theirs.height), sortKey: text(entity) });
  }
  const chipLabel = (count: number, open: boolean): string => (open ? `Hide ${count} healthy` : `+${count} healthy`);
  for (const [owner, group] of [...groups].sort(([a], [b]) => byText(a, b))) {
    const lane = Math.min(...group.roots.map((root) => laneOf.get(root) as number));
    const open = options.open.has(owner);
    drawn.set(foldId(owner), { id: foldId(owner), lane, width: foldWidth(chipLabel(group.all.length, open)), height: FOLD_HEIGHT, sortKey: `${text(byName.get(owner) as Entity)}\uffff` });
  }

  interface Line {
    readonly id: string;
    readonly parent: string;
    readonly child: string;
    readonly label: string;
    readonly relationship: string | null;
  }
  const labelsOn = options.labels ?? !dense;
  const lines: Line[] = [];
  for (const item of relations) {
    if (!drawn.has(item.parentEntityName) || !drawn.has(item.childEntityName)) continue;
    lines.push({ id: item.name, parent: item.parentEntityName, child: item.childEntityName, label: labelsOn ? (item.displayName ?? "") : "", relationship: item.name });
  }
  for (const owner of [...groups.keys()].sort(byText)) lines.push({ id: foldId(owner), parent: owner, child: foldId(owner), label: "", relationship: null });

  // ----- order each lane, then wrap a long lane into rows -----
  const laneNodes: string[][] = used.map(() => []);
  for (const node of [...drawn.values()].sort((a, b) => byText(a.sortKey, b.sortKey) || byText(a.id, b.id))) laneNodes[node.lane]!.push(node.id);
  const upper = new Map<string, string[]>();
  const lower = new Map<string, string[]>();
  for (const line of lines) {
    (upper.get(line.child) ?? upper.set(line.child, []).get(line.child)!).push(line.parent);
    (lower.get(line.parent) ?? lower.set(line.parent, []).get(line.parent)!).push(line.child);
  }
  for (const list of [...upper.values(), ...lower.values()]) list.sort(byText);
  const ordered = ranksInOrder(
    orderRows(laneNodes, upper, lower),
    lines.map((line) => ({ parentEntityName: line.parent, childEntityName: line.child })),
    options.order,
  );
  const widthOf = (id: string): number => (drawn.get(id) as Drawn).width;
  const maxRow = options.maxRowWidth ?? MAX_ROW_WIDTH;
  const rows: string[][] = [];
  const rowLane: number[] = [];
  ordered.forEach((ids, lane) => {
    for (const row of wrap(ids, widthOf, maxRow)) {
      rows.push(row);
      rowLane.push(lane);
    }
  });
  const rowOf = new Map<string, number>();
  rows.forEach((row, index) => row.forEach((id) => rowOf.set(id, index)));
  const neighbours = new Map<string, string[]>();
  for (const line of lines) {
    (neighbours.get(line.parent) ?? neighbours.set(line.parent, []).get(line.parent)!).push(line.child);
    (neighbours.get(line.child) ?? neighbours.set(line.child, []).get(line.child)!).push(line.parent);
  }
  for (const list of neighbours.values()) list.sort(byText);

  // ----- coordinates and routes; where a corridor finds no slot, widen the gap and plan again -----
  const widths = new Map([...drawn.values()].map((node) => [node.id, node.width] as const));
  const routeEdges: RouteEdge[] = lines.map((line) => {
    const pill = pillOf(line.label);
    const child = byName.get(line.child);
    const weight = child === undefined || impactOf(child.impact) === "Suppressed" ? 0 : (WEIGHT[healthBucket(child.healthState)] ?? 0);
    return { id: line.id, parent: line.parent, child: line.child, pill: pill ? { width: pill.width, height: pill.height } : null, weight };
  });
  const extraGap = new Map<string, number>();
  let centre = relaxCoordinates(rows, widths, neighbours, GAP, { extraGap });
  let plan = planRoutes({ edges: routeEdges, rows, centre, width: widths });
  for (let attempt = 1; attempt < MAX_PLANS && plan.shortages.length > 0; attempt += 1) {
    let widened = false;
    for (const shortage of plan.shortages) widened = widen(rows[shortage.row] as string[], centre, widths, shortage.x, extraGap) || widened;
    if (!widened) break;
    centre = relaxCoordinates(rows, widths, neighbours, GAP, { extraGap });
    plan = planRoutes({ edges: routeEdges, rows, centre, width: widths });
  }

  // ----- stack the rows with the channels the routes need between them -----
  const rowHeight = rows.map((row) => Math.max(MIN_ROW, ...row.map((id) => (drawn.get(id) as Drawn).height)));
  const firstOfLane = rows.map((_row, index) => index === 0 || rowLane[index - 1] !== rowLane[index]);
  const pad = (index: number): number => (firstOfLane[index] ? FIRST_ROW_TOP : ROW_TOP);
  const rowTop: number[] = [];
  const channelTops: number[] = [];
  let cursor = TOP + plan.channelHeight(-1);
  rows.forEach((_row, index) => {
    rowTop.push(cursor);
    channelTops.push(cursor + pad(index) + (rowHeight[index] as number) + ROW_BOTTOM);
    cursor += pad(index) + (rowHeight[index] as number) + ROW_BOTTOM + plan.channelHeight(index);
  });
  const cardTop = (id: string): number => (rowTop[rowOf.get(id) as number] as number) + pad(rowOf.get(id) as number);
  const placement = new Map([...drawn.values()].map((node) => [node.id, { top: cardTop(node.id), bottom: cardTop(node.id) + node.height }] as const));
  const routed = plan.realize({ channelTop: (channel) => (channel < 0 ? TOP : (channelTops[channel] as number)), cards: placement });

  // ----- the pictures of everything -----
  const rectOf = (id: string): Rect => {
    const node = drawn.get(id) as Drawn;
    return { x: (centre.get(id) as number) - node.width / 2, y: cardTop(id), width: node.width, height: node.height };
  };
  // A lane whose cards a chip folded away has no row and is not drawn; the lanes that are drawn are numbered from 0.
  const drawnLanes = [...new Set(rowLane)];
  const laneNumber = new Map(drawnLanes.map((lane, position) => [lane, position] as const));
  const cards: SwimCard[] = [];
  const folds: SwimFold[] = [];
  const ownerOfFold = new Map([...groups.keys()].map((owner) => [foldId(owner), owner] as const));
  const only = options.only;
  for (const [index, row] of rows.entries()) {
    for (const id of [...row].sort((a, b) => (centre.get(a) as number) - (centre.get(b) as number))) {
      const owner = ownerOfFold.get(id);
      if (owner !== undefined) {
        const members = (groups.get(owner) as FoldGroup).all.filter((name) => only === undefined || only.entities.has(name));
        if (members.length === 0) continue;
        const states: Partial<Record<HealthState, number>> = {};
        for (const name of members) {
          const state = healthBucket((byName.get(name) as Entity).healthState);
          states[state] = (states[state] ?? 0) + 1;
        }
        folds.push({ id, owner, lane: laneNumber.get(rowLane[index] as number) as number, row: index, rect: rectOf(id), members: [...members].sort(byText), open: options.open.has(owner), states });
      } else if (only === undefined || only.entities.has(id)) cards.push({ id, lane: laneNumber.get(rowLane[index] as number) as number, row: index, rect: rectOf(id), spec: specs.get(id) as CardSpec });
    }
  }
  const lineById = new Map(lines.map((line) => [line.id, line] as const));
  const present = new Set([...cards.map((card) => card.id), ...folds.map((fold) => fold.id)]);
  const edges: SwimEdge[] = routed
    .filter((line) => {
      if (only === undefined) return true;
      const source = lineById.get(line.edge.id) as Line;
      if (!present.has(source.parent) || !present.has(source.child)) return false;
      return source.relationship === null || only.links.has(linkKey(source.parent, source.child));
    })
    .map((line) => {
      const source = lineById.get(line.edge.id) as Line;
      const label = line.pill ? { x: line.pill.x, y: line.pill.y } : null;
      return { id: line.edge.id, from: source.parent, to: source.child, points: line.points, label, text: line.pill ? (pillOf(source.label)?.text ?? "") : "", relationship: source.relationship };
    });

  let left = Infinity;
  let right = -Infinity;
  const grow = (x: number): void => {
    left = Math.min(left, x);
    right = Math.max(right, x);
  };
  for (const id of drawn.keys()) {
    const rect = rectOf(id);
    grow(rect.x);
    grow(rect.x + rect.width);
  }
  for (const line of routed) {
    for (const point of line.points) grow(point.x);
    if (line.pill) {
      grow(line.pill.x - line.pill.width / 2);
      grow(line.pill.x + line.pill.width / 2);
    }
  }
  if (!Number.isFinite(left)) {
    left = 0;
    right = 0;
  }
  const x0 = left - MARGIN - LANE_GUTTER;
  const width = right + MARGIN - x0;
  const lanes: SwimLane[] = drawnLanes.map((usedIndex, index) => {
    const item = used[usedIndex] as (typeof used)[number];
    const first = rowLane.indexOf(usedIndex);
    const last = rowLane.lastIndexOf(usedIndex);
    const top = rowTop[first] as number;
    const bottom = (rowTop[last] as number) + pad(last) + (rowHeight[last] as number) + ROW_BOTTOM + plan.channelHeight(last);
    return { index, kind: item.lane.kind, title: item.lane.title, count: only === undefined ? item.names.length : item.names.filter((name) => only.entities.has(name)).length, rect: { x: x0, y: top, width, height: bottom - top } };
  });
  const height = rows.length === 0 ? 0 : cursor + 8;
  return { lanes, cards, folds, edges, bounds: { x: x0, y: 0, width, height }, dense, labels: labelsOn, shortages: plan.shortages.length };
}

/** What changes the picture, as a string: names, states, impacts, signal values and links. A refresh that brings the same model changes nothing. */
export function contentKey(entities: readonly Entity[], relationships: readonly Relationship[]): string {
  const parts = entities.map((entity) =>
    [
      entity.name,
      entity.displayName,
      entity.healthState,
      entity.impact,
      entity.discoveredBy ?? "",
      entity.unlinked ? "u" : "",
      ...entity.signals.map((signal) => `${signal.name}|${signal.displayName ?? ""}|${signal.healthState}|${String(signal.value)}`),
    ].join("\u0001"),
  );
  const links = relationships.map((item) => `${item.parentEntityName}\u0001${item.childEntityName}\u0001${item.displayName ?? ""}\u0001${item.name}`);
  return `${parts.join("\u0002")}\u0003${links.join("\u0002")}`;
}

/**
 * The card to open on in a model too big to read whole: the deepest Unhealthy card, else the
 * deepest Degraded one, the leftmost of those; null when nothing needs attention.
 */
export function firstProblem(layout: SwimlaneLayout, byName: ReadonlyMap<string, Entity>): string | null {
  const severity = (id: string): number => ((WEIGHT[healthBucket(byName.get(id)?.healthState ?? "Healthy")] ?? 0) >= 2 ? (WEIGHT[healthBucket(byName.get(id)?.healthState ?? "Healthy")] as number) : 0);
  let best: SwimCard | null = null;
  for (const card of layout.cards) {
    if (severity(card.id) === 0) continue;
    if (best === null || severity(card.id) > severity(best.id) || (severity(card.id) === severity(best.id) && card.lane > best.lane)) best = card;
  }
  return best?.id ?? null;
}

/** A card and the cards that draw a line into it: what to bring into view to show where it sits. */
export function withParents(layout: SwimlaneLayout, id: string): readonly string[] {
  const cards = new Set(layout.cards.map((card) => card.id));
  return [id, ...layout.edges.filter((edge) => edge.to === id && cards.has(edge.from)).map((edge) => edge.from)];
}

/**
 * The edges from `names` up to the root, every way there is: the lineage of an entity. In a dense
 * picture the rest of the lines fade, so the one that matters can be followed.
 */
export function lineageOf(layout: SwimlaneLayout, names: readonly string[]): ReadonlySet<string> {
  const into = new Map<string, SwimEdge[]>();
  for (const edge of layout.edges) (into.get(edge.to) ?? into.set(edge.to, []).get(edge.to)!).push(edge);
  const reached = new Set(names);
  const edges = new Set<string>();
  const pending = [...names];
  while (pending.length > 0) {
    for (const edge of into.get(pending.pop() as string) ?? []) {
      edges.add(edge.id);
      if (!reached.has(edge.from)) {
        reached.add(edge.from);
        pending.push(edge.from);
      }
    }
  }
  return edges;
}
