/**
 * Step routing for a tidy tree: the rows of an arrangement, a trunk and a bus per parent, and
 * corridors between cards for relationships that skip a row.
 *
 * Adapted from ahm-diagrammo (MIT), src/layout.mjs and src/swimlane-route.mjs: the track
 * assignment is its interval colouring (`assignTracks`), the corridors are its `corridorsOf` and
 * `pickCorridorX`, and the ports of a card with several parents are spread as it spreads them.
 * The router around them is new: it works on the positions `arrange.ts` returns, moves rows down
 * where a gap needs more tracks than the arrangement left, and places label pills where no other
 * line crosses them.
 *
 * Guarantees, which the tests pin: no route runs through a card, two buses in one gap never share
 * a height where they overlap, two corridor risers keep `TRACK` apart.
 */
import type { Rect } from "./edgeRouting";
import type { Point } from "./layout";

export type { Rect };

export interface RouteNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RouteEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Width of the label pill, or 0 for none. */
  readonly labelWidth?: number;
  /** Drawn in ascending order, so the edges that matter most (higher) end on top. */
  readonly weight?: number;
}

export interface RoutedEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly Point[];
  /** Centre of the label pill, or null. */
  readonly label: Point | null;
}

export interface Routing {
  /** The nodes where they end up: rows move down where a gap needed room for more tracks. */
  readonly nodes: ReadonlyMap<string, Rect>;
  readonly edges: readonly RoutedEdge[];
  readonly bounds: Rect;
}

/** Distance between parallel lines of different edges. */
export const TRACK = 10;
const TOP_CLEAR = 16;
const STUB = 34;
const SPREAD = 64;
const PILL_H = 18;
const PORT_MARGIN = 18;

interface Interval {
  readonly id: string;
  readonly left: number;
  readonly right: number;
  readonly order: number;
}

/** Interval colouring: horizontals that overlap in x never share a track (levels). */
function assignTracks(items: readonly Interval[]): { levels: ReadonlyMap<string, number>; count: number } {
  const levels = new Map<string, number>();
  const occupied: [number, number][][] = [];
  for (const item of [...items].sort((a, b) => a.order - b.order || a.left - b.left)) {
    for (let level = 0; ; level += 1) {
      const used = (occupied[level] ??= []);
      if (used.every(([left, right]) => item.right < left || item.left > right)) {
        used.push([item.left, item.right]);
        levels.set(item.id, level);
        break;
      }
    }
  }
  return { levels, count: occupied.length };
}

/** The gaps between the cards of one row, and the open space on both flanks. */
function corridorsOf(cards: readonly { readonly x: number; readonly width: number }[], margin = 10, flank = 40): [number, number][] {
  const sorted = [...cards].sort((a, b) => a.x - b.x);
  const out: [number, number][] = [];
  let cursor = -Infinity;
  for (const card of sorted) {
    const low = cursor === -Infinity ? card.x - flank - margin : cursor;
    const high = card.x - margin;
    if (high - low >= 8) out.push([low, high]);
    cursor = Math.max(cursor, card.x + card.width + margin);
  }
  out.push([cursor === -Infinity ? -flank : cursor, cursor === -Infinity ? flank : cursor + flank]);
  return out;
}

/** The free x nearest to `want` in the corridors, at least `spacing` from every taken x. */
function pickCorridorX(corridors: readonly [number, number][], want: number, taken: readonly number[], spacing: number): number | null {
  let best: number | null = null;
  let bestCost = Infinity;
  for (const [low, high] of corridors) {
    const candidates = [Math.min(high, Math.max(low, want)), low, high];
    for (const used of taken) candidates.push(used + spacing, used - spacing);
    for (const candidate of candidates) {
      if (candidate < low - 1e-9 || candidate > high + 1e-9 || !taken.every((used) => Math.abs(used - candidate) >= spacing - 1e-9)) continue;
      const cost = Math.abs(candidate - want);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
  }
  return best;
}

interface Net {
  readonly id: string;
  readonly gap: number;
  readonly xs: number[];
  level: number;
}

interface Plan {
  readonly edge: RouteEdge;
  readonly top: number;
  readonly bottom: number;
  /** Corridor x per intermediate row. */
  readonly corridor: Map<number, number>;
  port: number;
  bus?: Net;
  jogs?: Map<number, Net>;
  last?: Net;
}

function simplify(points: readonly Point[]): Point[] {
  const distinct = points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y);
  return distinct.filter((point, index) => {
    if (index === 0 || index === distinct.length - 1) return true;
    const before = distinct[index - 1]!;
    const after = distinct[index + 1]!;
    return !((point.x === before.x && point.x === after.x) || (point.y === before.y && point.y === after.y));
  });
}

type Segment = { readonly horizontal: boolean; readonly fixed: number; readonly from: number; readonly to: number; readonly owner: string };

function segmentsOf(edge: RoutedEdge): Segment[] {
  const out: Segment[] = [];
  for (let index = 1; index < edge.points.length; index += 1) {
    const a = edge.points[index - 1]!;
    const b = edge.points[index]!;
    if (a.y === b.y) out.push({ horizontal: true, fixed: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x), owner: edge.id });
    else if (a.x === b.x) out.push({ horizontal: false, fixed: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y), owner: edge.id });
  }
  return out;
}

function crosses(box: Rect, segment: Segment): boolean {
  if (segment.horizontal) return segment.fixed > box.y && segment.fixed < box.y + box.height && segment.to > box.x && segment.from < box.x + box.width;
  return segment.fixed > box.x && segment.fixed < box.x + box.width && segment.to > box.y && segment.from < box.y + box.height;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Where a label goes: on the way into the child if clear, else along the line, else where fewest lines cross. */
function placeLabels(edges: readonly RoutedEdge[], widths: ReadonlyMap<string, number>, nodes: ReadonlyMap<string, Rect>): Map<string, Point> {
  const segments = new Map(edges.map((edge) => [edge.id, segmentsOf(edge)] as const));
  const all = [...segments.values()].flat();
  const placed: Rect[] = [];
  const result = new Map<string, Point>();
  for (const edge of edges) {
    const width = widths.get(edge.id) ?? 0;
    if (width === 0 || edge.points.length < 2) continue;
    const own = segments.get(edge.id)!;
    const candidates: Point[] = [];
    const last = own[own.length - 1];
    if (last && !last.horizontal) for (const back of [14, 32, 50]) if (last.to - last.from - back > PILL_H) candidates.push({ x: last.fixed, y: last.to - back });
    for (const segment of [...own].reverse()) {
      if (segment.horizontal) {
        for (const fraction of [0.5, 0.3, 0.7, 0.15, 0.85]) candidates.push({ x: segment.from + (segment.to - segment.from) * fraction, y: segment.fixed });
      } else if (segment.to - segment.from > 2 * PILL_H) {
        candidates.push({ x: segment.fixed, y: (segment.from + segment.to) / 2 });
      }
    }
    let best: Point | null = null;
    let bestCost = Infinity;
    for (const [index, candidate] of candidates.entries()) {
      const box: Rect = { x: candidate.x - width / 2, y: candidate.y - PILL_H / 2, width, height: PILL_H };
      let cost = index * 0.01;
      for (const segment of all) if (segment.owner !== edge.id && crosses(box, segment)) cost += 1;
      for (const other of placed) if (overlaps(box, other)) cost += 4;
      for (const node of nodes.values()) if (overlaps(box, node)) cost += 8;
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
      if (cost < 0.5) break;
    }
    if (best) {
      result.set(edge.id, best);
      placed.push({ x: best.x - width / 2, y: best.y - PILL_H / 2, width, height: PILL_H });
    }
  }
  return result;
}

export function routeSteps(nodeList: readonly RouteNode[], edgeList: readonly RouteEdge[]): Routing {
  const byId = new Map(nodeList.map((node) => [node.id, node] as const));
  const keyOf = (node: RouteNode): number => Math.round(node.y * 2) / 2;
  const ys = [...new Set(nodeList.map(keyOf))].sort((a, b) => a - b);
  const rowOf = new Map(nodeList.map((node) => [node.id, ys.indexOf(keyOf(node))] as const));
  const rowCards: RouteNode[][] = ys.map(() => []);
  for (const node of nodeList) rowCards[rowOf.get(node.id)!]!.push(node);
  const rowHeight = rowCards.map((cards) => Math.max(0, ...cards.map((card) => card.height)));
  const centre = (id: string): number => byId.get(id)!.x + byId.get(id)!.width / 2;

  const corridors = rowCards.map((cards) => corridorsOf(cards));
  const taken: number[][] = ys.map(() => []);

  const plans: Plan[] = [];
  const direct: RouteEdge[] = [];
  for (const edge of edgeList) {
    const from = rowOf.get(edge.from);
    const to = rowOf.get(edge.to);
    if (from === undefined || to === undefined || edge.from === edge.to) continue;
    if (to <= from) direct.push(edge);
    else plans.push({ edge, top: from, bottom: to, corridor: new Map(), port: 0 });
  }

  // Corridors through the rows an edge skips, longest first, so short ones fit around them.
  for (const plan of plans.filter((item) => item.bottom - item.top > 1).sort((a, b) => b.bottom - b.top - (a.bottom - a.top))) {
    let previous = centre(plan.edge.from);
    for (let row = plan.top + 1; row < plan.bottom; row += 1) {
      const want = previous + (centre(plan.edge.to) - previous) / (plan.bottom - row + 1);
      const x = pickCorridorX(corridors[row]!, want, taken[row]!, TRACK) ?? want;
      taken[row]!.push(x);
      plan.corridor.set(row, x);
      previous = x;
    }
  }

  // Where each edge arrives on its child: spread over the top of the card when several come in.
  const arriving = new Map<string, Plan[]>();
  for (const plan of plans) (arriving.get(plan.edge.to) ?? arriving.set(plan.edge.to, []).get(plan.edge.to)!).push(plan);
  const approach = (plan: Plan): number => (plan.bottom - plan.top > 1 ? plan.corridor.get(plan.bottom - 1)! : centre(plan.edge.from));
  const portOf = new Map<Plan, { x: number; k: number; n: number }>();
  for (const [id, list] of arriving) {
    list.sort((a, b) => approach(a) - approach(b));
    const width = byId.get(id)!.width;
    const count = list.length;
    const step = count > 1 ? Math.min(SPREAD, (width - 2 * PORT_MARGIN) / (count - 1)) : 0;
    list.forEach((plan, k) => portOf.set(plan, { x: centre(id) + (k - (count - 1) / 2) * step, k, n: count }));
  }

  // Horizontal runs per gap: a bus for every parent, a jog where a riser changes corridor, a last approach.
  const nets: Net[][] = ys.map(() => []);
  const buses = new Map<string, Net>();
  for (const plan of plans) {
    const parent = plan.edge.from;
    const port = portOf.get(plan)!.x;
    plan.port = port;
    let bus = buses.get(parent);
    if (!bus) {
      bus = { id: `bus:${parent}`, gap: plan.top, xs: [centre(parent)], level: 0 };
      buses.set(parent, bus);
      nets[plan.top]!.push(bus);
    }
    bus.xs.push(plan.bottom - plan.top > 1 ? plan.corridor.get(plan.top + 1)! : port);
    plan.bus = bus;
    if (plan.bottom - plan.top > 1) {
      for (let row = plan.top + 1; row < plan.bottom - 1; row += 1) {
        const a = plan.corridor.get(row)!;
        const b = plan.corridor.get(row + 1)!;
        if (Math.abs(a - b) <= 0.5) continue;
        const jog: Net = { id: `jog:${plan.edge.id}:${row}`, gap: row, xs: [a, b], level: 0 };
        nets[row]!.push(jog);
        (plan.jogs ??= new Map()).set(row, jog);
      }
      const last: Net = { id: `last:${plan.edge.id}`, gap: plan.bottom - 1, xs: [plan.corridor.get(plan.bottom - 1)!, port], level: 0 };
      nets[plan.bottom - 1]!.push(last);
      plan.last = last;
    }
  }
  const counts = nets.map((list) => {
    if (list.length === 0) return 0;
    const result = assignTracks(list.map((net) => ({ id: net.id, left: Math.min(...net.xs) - TRACK * 0.7, right: Math.max(...net.xs) + TRACK * 0.7, order: Math.min(...net.xs) })));
    for (const net of list) net.level = result.levels.get(net.id)!;
    return result.count;
  });

  // Rows move down where a gap needs more tracks than the arrangement left.
  const top = ys.slice();
  let shift = 0;
  for (let row = 0; row < ys.length; row += 1) {
    if (row > 0) {
      const need = counts[row - 1]! > 0 ? TOP_CLEAR + (counts[row - 1]! - 1) * TRACK + STUB : 0;
      shift += Math.max(0, need - (ys[row]! - (ys[row - 1]! + rowHeight[row - 1]!)));
    }
    top[row] = ys[row]! + shift;
  }
  const nodes = new Map<string, Rect>();
  for (const node of nodeList) nodes.set(node.id, { x: node.x, y: top[rowOf.get(node.id)!]!, width: node.width, height: node.height });
  const topOf = (id: string): number => nodes.get(id)!.y;
  const bottomOf = (id: string): number => nodes.get(id)!.y + nodes.get(id)!.height;
  const trackY = (net: Net): number => top[net.gap]! + rowHeight[net.gap]! + TOP_CLEAR + net.level * TRACK;

  const routed: RoutedEdge[] = [];
  const ordered = [...plans].sort((a, b) => (a.edge.weight ?? 0) - (b.edge.weight ?? 0));
  for (const plan of ordered) {
    const { edge } = plan;
    const port = plan.port;
    const points: Point[] = [{ x: centre(edge.from), y: bottomOf(edge.from) }];
    const busY = trackY(plan.bus!);
    if (plan.bottom - plan.top === 1) points.push({ x: centre(edge.from), y: busY }, { x: port, y: busY });
    else {
      points.push({ x: centre(edge.from), y: busY }, { x: plan.corridor.get(plan.top + 1)!, y: busY });
      for (let row = plan.top + 1; row < plan.bottom - 1; row += 1) {
        const jog = plan.jogs?.get(row);
        if (!jog) continue;
        const y = trackY(jog);
        points.push({ x: plan.corridor.get(row)!, y }, { x: plan.corridor.get(row + 1)!, y });
      }
      const lastY = trackY(plan.last!);
      points.push({ x: plan.corridor.get(plan.bottom - 1)!, y: lastY }, { x: port, y: lastY });
    }
    points.push({ x: port, y: topOf(edge.to) });
    routed.push({ id: edge.id, from: edge.from, to: edge.to, points: simplify(points), label: null });
  }
  for (const edge of direct) {
    const points = [{ x: centre(edge.from), y: bottomOf(edge.from) }, { x: centre(edge.to), y: topOf(edge.to) }];
    routed.push({ id: edge.id, from: edge.from, to: edge.to, points, label: null });
  }

  const widths = new Map(edgeList.map((edge) => [edge.id, edge.labelWidth ?? 0] as const));
  const labels = placeLabels(routed, widths, nodes);
  const edges = routed.map((edge) => ({ ...edge, label: labels.get(edge.id) ?? null }));

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const grow = (x: number, y: number, w = 0, h = 0): void => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + w);
    y2 = Math.max(y2, y + h);
  };
  for (const rect of nodes.values()) grow(rect.x, rect.y, rect.width, rect.height);
  for (const edge of edges) {
    for (const point of edge.points) grow(point.x, point.y);
    if (edge.label) {
      const width = widths.get(edge.id) ?? 0;
      grow(edge.label.x - width / 2, edge.label.y - PILL_H / 2, width, PILL_H);
    }
  }
  const bounds = nodes.size === 0 ? { x: 0, y: 0, width: 0, height: 0 } : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  return { nodes, edges, bounds };
}

/** Whether a route runs through a card other than the two it connects (for tests and checks). */
export function throughCards(routing: Routing): { readonly edge: string; readonly node: string }[] {
  const found: { edge: string; node: string }[] = [];
  for (const edge of routing.edges) {
    const segments = segmentsOf(edge);
    for (const [id, rect] of routing.nodes) {
      if (id === edge.from || id === edge.to) continue;
      if (segments.some((segment) => crosses(rect, segment))) found.push({ edge: edge.id, node: id });
    }
  }
  return found;
}

/**
 * Pairs of horizontal runs that lie on one line and overlap, for edges of different parents. The
 * edges of one parent share their bus on purpose.
 */
export function collinearOverlaps(routing: Routing): number {
  const horizontals = routing.edges.flatMap((edge) => segmentsOf(edge).filter((segment) => segment.horizontal).map((segment) => ({ ...segment, parent: edge.from })));
  let count = 0;
  for (const [index, a] of horizontals.entries()) {
    for (const b of horizontals.slice(index + 1)) {
      if (a.parent !== b.parent && Math.abs(a.fixed - b.fixed) < 1 && a.to > b.from + 1 && b.to > a.from + 1) count += 1;
    }
  }
  return count;
}

/** An SVG path through orthogonal points with every corner rounded (smaller where a run is short). */
export function roundedPath(points: readonly Point[], radius = 8): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  let path = `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const before = points[index - 1]!;
    const after = points[index + 1]!;
    const incoming = Math.hypot(point.x - before.x, point.y - before.y);
    const outgoing = Math.hypot(after.x - point.x, after.y - point.y);
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const ux = (point.x - before.x) / (incoming || 1);
    const uy = (point.y - before.y) / (incoming || 1);
    const vx = (after.x - point.x) / (outgoing || 1);
    const vy = (after.y - point.y) / (outgoing || 1);
    path += ` L${(point.x - ux * r).toFixed(1)} ${(point.y - uy * r).toFixed(1)} Q${point.x.toFixed(1)} ${point.y.toFixed(1)} ${(point.x + vx * r).toFixed(1)} ${(point.y + vy * r).toFixed(1)}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}
