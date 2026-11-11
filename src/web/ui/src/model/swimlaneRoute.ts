/**
 * Edge routing for the Swimlanes view: layered channel routing.
 *
 * Adapted from ahm-diagrammo (MIT), src/swimlane-route.mjs, through the swimlane prototype. Card
 * positions are fixed. Every edge runs from its lower card up to its upper card with one
 * horizontal per channel it crosses, and passes the rows in between through gaps between cards.
 * Inside one channel this is channel routing in the manner of ELK Layered (Sander, "Layout of
 * directed hypergraphs with orthogonal hyperedges", GD 2003):
 * - ports: an edge owns one port on each card side, never shared ink. Ports are ordered by where
 *   the edge goes, so siblings nest instead of crossing, spread over the side and at least
 *   `PITCH` apart; an edge whose cards line up keeps a straight drop.
 * - corridors: an edge that skips a row picks a gap between cards in every row it passes, by
 *   dynamic programming over the rows against the current ports; rip-up and reroute re-scores its
 *   best few chains of gaps on the fully routed channels.
 * - rows: every pair of overlapping horizontals gets a "who sits higher" dependency weighted by
 *   the crossings the other order would cost; cycles are broken greedily (Eades, Lin, Smyth) and
 *   nets are packed into rows in that order, `PITCH` apart. Two horizontals of one channel never
 *   share a row where they overlap.
 * - pills: a labelled edge's row in the channel nearest its child is as tall as its pill, the row
 *   order keeps verticals off the pill, and the pill slides along its horizontal away from any
 *   vertical that still crosses it.
 *
 * Two phases, because channel heights decide where the rows sit and routes need final ys:
 * `planRoutes` classifies edges, plans every x and row and reports each channel's height;
 * `realize` takes the stacked geometry, places label pills and emits one polyline per edge.
 * Channel `g` is the horizontal strip below row `g`; channel -1 is the strip above row 0.
 *
 * What differs from the original: labels are one-line pills measured by the caller, the draw order
 * is a weight the caller gives, and a corridor that finds no free slot is reported in `shortages`
 * so that the caller can widen that gap and plan again; until then the line goes round the outside
 * of the row instead of through a card.
 */
import type { Point } from "./layout";
import { corridorsOf, pickCorridorX, projectPositions } from "./swimlaneGeometry";

/** Minimum distance between two parallel lines of different edges. */
export const PITCH = 10;
const PORT_INSET = 12;
const ROW_PAD = 6;
/** Weight of an order that would make two verticals collinear. */
const CRITICAL = 1000;
/** Weight of a vertical that would run through a label pill. */
const PILL_HIT = 4;
/** A port that keeps its edge straight yields this much less to its neighbours. */
const STRAIGHT_WEIGHT = 50;
/** Corridor search: the cost of a crossing, a bend, a pixel of travel. */
const GAP_CROSS = 3;
const GAP_BEND = 1;
const GAP_LEN = 0.002;
const GAP_ROUNDS = 2;
const GAP_ALTERNATIVES = 6;

export interface PillSize {
  readonly width: number;
  readonly height: number;
}

export interface RouteEdge {
  readonly id: string;
  readonly parent: string;
  readonly child: string;
  /** The label pill's size, or null for an edge without a label. */
  readonly pill: PillSize | null;
  /** Drawn in ascending order, so the edges that matter most end on top. */
  readonly weight: number;
}

export interface RouteInput {
  readonly edges: readonly RouteEdge[];
  /** The cards of every row, left to right. An edge between two cards of one row runs over the top of the row. */
  readonly rows: readonly (readonly string[])[];
  readonly centre: ReadonlyMap<string, number>;
  readonly width: ReadonlyMap<string, number>;
}

/** A row where a corridor wanted a slot near `x` and found none: widen the gap there and plan again. */
export interface Shortage {
  readonly row: number;
  readonly x: number;
}

export interface Placement {
  /** The y of the top of channel `g`. */
  readonly channelTop: (channel: number) => number;
  /** The top and bottom of every card. */
  readonly cards: ReadonlyMap<string, { readonly top: number; readonly bottom: number }>;
}

export interface RoutedLine {
  readonly edge: RouteEdge;
  readonly points: readonly Point[];
  /** The label pill's centre and size, or null. */
  readonly pill: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

export interface RoutePlan {
  /** What the plan could not give a free corridor, in the rows it names. */
  readonly shortages: readonly Shortage[];
  /** The height channel `g` needs, 0 for none. */
  readonly channelHeight: (channel: number) => number;
  /** The polylines, in draw order. */
  readonly realize: (placement: Placement) => readonly RoutedLine[];
}

type Side = "top" | "bottom";
type End = "lo" | "up";

interface Pin {
  readonly x: number;
  readonly side: Side;
}

interface Route {
  readonly edge: RouteEdge;
  /** The lower card (larger row) and the upper. */
  readonly lo: string;
  readonly up: string;
  /** The upper and lower row. */
  readonly u: number;
  readonly l: number;
  readonly sameRow: boolean;
  /** The x of the riser in every row the edge passes. */
  readonly corr: Map<number, number>;
  pLo: number;
  pUp: number;
  chains: number[][];
  lanes: number[];
  nets: Net[];
  points: Point[];
}

interface Net {
  readonly route: Route;
  readonly g: number;
  readonly pins: readonly Pin[];
  readonly xBelow: number;
  readonly xAbove: number;
  readonly lo: number;
  readonly hi: number;
  readonly straight: boolean;
  readonly pill: boolean;
  readonly pL: number;
  readonly pR: number;
  row: number | null;
}

interface Channel {
  readonly nets: Net[];
  rows: { h: number }[];
  h: number;
}

interface PortRef {
  readonly route: Route;
  readonly end: End;
  far: number;
  index: number;
}

interface Dependency {
  readonly from: Net;
  readonly to: Net;
  readonly w: number;
}

/**
 * Positions for `desired.length` ordered ports in [low, high]: as close to `desired` as possible
 * (heavier ports move less), keeping the order and at least `pitch` apart; a narrow side shrinks
 * the pitch rather than let a port leave the card.
 */
function spreadPorts(desired: readonly number[], low: number, high: number, pitch: number, weights: readonly number[] | null): number[] {
  const n = desired.length;
  if (n === 0) return [];
  if (n === 1) return [Math.min(high, Math.max(low, desired[0] as number))];
  const step = Math.min(pitch, (high - low) / (n - 1));
  const clamped = desired.map((x, index) => Math.min(high - (n - 1 - index) * step, Math.max(low + index * step, x)));
  return projectPositions(clamped, new Array<number>(n - 1).fill(step), weights);
}

const overlaps = (a: Net, b: Net): boolean => a.pL < b.pR && b.pL < a.pR;

/**
 * The cost of net `a`'s horizontal sitting above net `b`'s: a's drops to the channel bottom pass
 * b's row, b's risers from the channel top pass a's row. Each crossing costs 1, each vertical
 * through the spot where a label pill wants to sit costs `PILL_HIT`, a drop beside a riser `CRITICAL`.
 */
function costAbove(a: Net, b: Net): number {
  const inside = (x: number, net: Net): boolean => x > net.lo + 0.5 && x < net.hi - 0.5;
  const onPill = (x: number, net: Net): boolean => {
    const pill = net.route.edge.pill;
    return net.pill && pill !== null && Math.abs(x - net.xBelow) < pill.width / 2 + 3;
  };
  let cost = 0;
  for (const pin of a.pins) if (pin.side === "bottom") cost += (inside(pin.x, b) ? 1 : 0) + (onPill(pin.x, b) ? PILL_HIT : 0);
  for (const pin of b.pins) if (pin.side === "top") cost += (inside(pin.x, a) ? 1 : 0) + (onPill(pin.x, a) ? PILL_HIT : 0);
  for (const p of a.pins) for (const q of b.pins) if (p.side === "bottom" && q.side === "top" && Math.abs(p.x - q.x) < PITCH) cost += CRITICAL;
  return cost;
}

/** The total cost of a channel as routed: every overlapping pair in its row order, plus every straight vertical through another net's horizontal. */
function channelCost(channel: Channel): number {
  let cost = 0;
  for (const a of channel.nets) {
    for (const b of channel.nets) {
      if (a === b) continue;
      if (a.row !== null && b.row !== null && a.row < b.row && overlaps(a, b)) cost += costAbove(a, b);
      if (a.straight && !a.pill && b.row !== null && a.lo > b.lo + 0.5 && a.lo < b.hi - 0.5) cost += 1;
    }
  }
  return cost;
}

/**
 * A linear order of nets that violates as little dependency weight as possible (the Eades, Lin,
 * Smyth greedy feedback arc set heuristic): sinks go to the back, sources to the front, otherwise
 * the net with the largest out-minus-in weight.
 */
function feedbackOrder(nodes: readonly Net[], dependencies: readonly Dependency[]): Net[] {
  const out = new Map<Net, Map<Net, number>>(nodes.map((net) => [net, new Map()]));
  const into = new Map<Net, Map<Net, number>>(nodes.map((net) => [net, new Map()]));
  for (const { from, to, w } of dependencies) {
    out.get(from)!.set(to, w);
    into.get(to)!.set(from, w);
  }
  const left = new Set(nodes);
  const front: Net[] = [];
  const back: Net[] = [];
  const drop = (net: Net): void => {
    left.delete(net);
    for (const other of out.get(net)!.keys()) into.get(other)!.delete(net);
    for (const other of into.get(net)!.keys()) out.get(other)!.delete(net);
  };
  while (left.size > 0) {
    for (let changed = true; changed; ) {
      changed = false;
      for (const net of [...left]) {
        if (out.get(net)!.size === 0) {
          back.unshift(net);
          drop(net);
          changed = true;
        }
      }
      for (const net of [...left]) {
        if (into.get(net)!.size === 0) {
          front.push(net);
          drop(net);
          changed = true;
        }
      }
    }
    if (left.size === 0) break;
    let best: Net | null = null;
    let bestDelta = -Infinity;
    for (const net of left) {
      let delta = 0;
      for (const w of out.get(net)!.values()) delta += w;
      for (const w of into.get(net)!.values()) delta -= w;
      if (delta > bestDelta) {
        best = net;
        bestDelta = delta;
      }
    }
    front.push(best as Net);
    drop(best as Net);
  }
  return [...front, ...back];
}

/** The row of every net (0 is the top of the channel). Overlapping nets never share a row; a net sits below every net its kept dependencies put above it. Returns the number of rows. */
function assignRows(nets: readonly Net[]): number {
  const dependencies: Dependency[] = [];
  for (let i = 0; i < nets.length; i += 1) {
    for (let j = i + 1; j < nets.length; j += 1) {
      const a = nets[i] as Net;
      const b = nets[j] as Net;
      if (!overlaps(a, b)) continue;
      const ab = costAbove(a, b);
      const ba = costAbove(b, a);
      if (ab < ba) dependencies.push({ from: a, to: b, w: ba - ab });
      else if (ba < ab) dependencies.push({ from: b, to: a, w: ab - ba });
    }
  }
  const order = feedbackOrder(nets, dependencies);
  const rank = new Map(order.map((net, index) => [net, index] as const));
  const predecessors = new Map<Net, Net[]>(nets.map((net) => [net, []]));
  for (const d of dependencies) if ((rank.get(d.from) as number) < (rank.get(d.to) as number)) predecessors.get(d.to)!.push(d.from);
  const rows: Net[][] = [];
  for (const net of order) {
    let row = Math.max(0, ...predecessors.get(net)!.map((before) => (before.row as number) + 1));
    while (rows[row]?.some((other) => overlaps(other, net))) row += 1;
    (rows[row] ??= []).push(net);
    net.row = row;
  }
  return rows.length;
}

/** Whether two cards' x spans, shrunk by the port inset, leave room for a straight drop, and where. */
const between = (x: number, a: number, b: number): boolean => x > Math.min(a, b) + 0.5 && x < Math.max(a, b) - 0.5;

function segmentCost(others: readonly (readonly [number, number])[], x1: number, x2: number): number {
  if (Math.abs(x1 - x2) < 0.5) return GAP_CROSS * others.filter(([a, b]) => between(x1, a, b)).length;
  let cost = 2 * GAP_BEND + GAP_LEN * Math.abs(x1 - x2);
  for (const [a, b] of others) {
    cost += GAP_CROSS * ((between(a, x1, x2) ? 1 : 0) + (between(b, x1, x2) ? 1 : 0));
    cost += (GAP_CROSS / 2) * ((between(x1, a, b) ? 1 : 0) + (between(x2, a, b) ? 1 : 0));
  }
  return cost;
}

export function planRoutes({ edges, rows, centre, width }: RouteInput): RoutePlan {
  const rowOf = new Map<string, number>();
  rows.forEach((row, index) => row.forEach((id) => rowOf.set(id, index)));
  const half = (id: string): number => (width.get(id) as number) / 2;
  const span = (id: string): [number, number] => [(centre.get(id) as number) - half(id) + PORT_INSET, (centre.get(id) as number) + half(id) - PORT_INSET];

  // ----- classify: every drawable edge becomes a route from a lower card `lo` to an upper card `up` -----
  const routes: Route[] = [];
  for (const edge of edges) {
    const parentRow = rowOf.get(edge.parent);
    const childRow = rowOf.get(edge.child);
    if (parentRow === undefined || childRow === undefined || edge.parent === edge.child) continue;
    const base = { edge, corr: new Map<number, number>(), pLo: 0, pUp: 0, chains: [], lanes: [], nets: [], points: [] };
    if (parentRow === childRow) routes.push({ ...base, lo: edge.child, up: edge.parent, u: parentRow, l: childRow, sameRow: true });
    else if (parentRow < childRow) routes.push({ ...base, lo: edge.child, up: edge.parent, u: parentRow, l: childRow, sameRow: false });
    else routes.push({ ...base, lo: edge.parent, up: edge.child, u: childRow, l: parentRow, sameRow: false });
  }

  // ----- corridors through the rows between: a first guess on the straight line between the cards -----
  const corridors = new Map<number, [number, number][]>();
  const taken = new Map<number, number[]>();
  const shortages: Shortage[] = [];
  for (const route of routes) {
    if (route.sameRow) continue;
    const upX = centre.get(route.up) as number;
    const loX = centre.get(route.lo) as number;
    for (let j = route.l - 1; j > route.u; j -= 1) {
      if (!corridors.has(j)) {
        corridors.set(j, corridorsOf((rows[j] as readonly string[]).map((id) => ({ x: (centre.get(id) as number) - half(id), width: width.get(id) as number }))));
        taken.set(j, []);
      }
      const want = loX + (upX - loX) * ((route.l - j) / (route.l - route.u));
      let x = pickCorridorX(corridors.get(j) as [number, number][], want, taken.get(j) as number[], PITCH);
      if (x === null) {
        // Every corridor is taken: go round the outside of the row rather than through a card.
        shortages.push({ row: j, x: want });
        const spare = corridors.get(j) as [number, number][];
        x = (spare[spare.length - 1] as [number, number])[1] + PITCH * (shortages.filter((item) => item.row === j).length + 1);
      }
      (taken.get(j) as number[]).push(x);
      route.corr.set(j, x);
    }
  }

  // ----- ports: parents' bottom sides first, then children's top sides aim at them -----
  const sides = new Map<string, PortRef[]>();
  const addPort = (id: string, side: Side, route: Route, end: End): void => {
    const key = `${id}|${side}`;
    const list = sides.get(key);
    const port: PortRef = { route, end, far: 0, index: 0 };
    if (list) list.push(port);
    else sides.set(key, [port]);
  };
  for (const route of routes) {
    addPort(route.lo, "top", route, "lo");
    addPort(route.up, route.sameRow ? "top" : "bottom", route, "up");
  }
  const portOf = (route: Route, end: End): number => (end === "lo" ? route.pLo : route.pUp);
  const setPort = (route: Route, end: End, x: number): void => {
    if (end === "lo") route.pLo = x;
    else route.pUp = x;
  };
  const farX = ({ route, end }: PortRef): number => {
    if (route.sameRow) return centre.get(end === "lo" ? route.up : route.lo) as number;
    if (end === "up") return route.l - route.u > 1 ? (route.corr.get(route.u + 1) as number) : (centre.get(route.lo) as number);
    return route.l - route.u > 1 ? (route.corr.get(route.l - 1) as number) : route.pUp;
  };
  const placeSide = (id: string, list: PortRef[], wantOf: (port: PortRef, slot: number, low: number, high: number) => { x: number; w: number }): void => {
    const [low, high] = span(id);
    list.forEach((port, index) => {
      port.far = farX(port);
      port.index = index;
    });
    list.sort((a, b) => a.far - b.far || a.index - b.index);
    const slot = (index: number): number => low + ((index + 0.5) * (high - low)) / list.length;
    const wants = list.map((port, index) => wantOf(port, slot(index), low, high));
    const xs = spreadPorts(wants.map((want) => want.x), low, high, PITCH, wants.map((want) => want.w));
    list.forEach((port, index) => setPort(port.route, port.end, xs[index] as number));
  };
  const placePorts = (): void => {
    for (const [key, list] of sides) {
      const [id, side] = key.split("|") as [string, Side];
      if (side !== "bottom") continue;
      placeSide(id, list, ({ route }, slot) => {
        if (route.l - route.u > 1) return { x: slot, w: 1 };
        const [a, b] = span(route.lo);
        const [c, d] = span(route.up);
        const straightLow = Math.max(a, c);
        const straightHigh = Math.min(b, d);
        // Keep a straight drop possible.
        return straightLow <= straightHigh ? { x: Math.min(straightHigh, Math.max(straightLow, slot)), w: STRAIGHT_WEIGHT } : { x: slot, w: 1 };
      });
    }
    for (const [key, list] of sides) {
      const [id, side] = key.split("|") as [string, Side];
      if (side !== "top") continue;
      placeSide(id, list, (port, slot, low, high) => (port.far >= low - 0.5 && port.far <= high + 0.5 ? { x: port.far, w: STRAIGHT_WEIGHT } : { x: slot, w: 1 }));
    }
  };
  placePorts();
  const portsFacing = (row: number, side: Side, except: Route | null = null): number[] => {
    const xs: number[] = [];
    for (const id of rows[row] ?? []) for (const port of sides.get(`${id}|${side}`) ?? []) if (port.route !== except) xs.push(portOf(port.route, port.end));
    return xs;
  };

  // ----- negotiate corridors: every row-skipping edge re-picks its chain of gaps by dynamic programming
  // over the rows it passes, against the current ports and the other edges' risers (estimated crossings,
  // then bends, then travel); the ports re-aim after every round -----
  const netsIn = (channel: number, except: Route | null): [number, number][] => {
    const out: [number, number][] = [];
    for (const route of routes) {
      if (route === except) continue;
      if (route.sameRow) {
        if (route.u - 1 === channel) out.push([route.pLo, route.pUp]);
        continue;
      }
      if (channel < route.u || channel >= route.l) continue;
      out.push([channel === route.l - 1 ? route.pLo : (route.corr.get(channel + 1) as number), channel === route.u ? route.pUp : (route.corr.get(channel) as number)]);
    }
    return out;
  };
  const skippers = routes.filter((route) => !route.sameRow && route.l - route.u > 1).sort((a, b) => b.l - b.u - (a.l - a.u));
  for (let round = 0; round < GAP_ROUNDS && skippers.length > 0; round += 1) {
    for (const route of skippers) {
      const lanes: number[] = [];
      for (let j = route.l - 1; j > route.u; j -= 1) lanes.push(j);
      const [loA, loB] = span(route.lo);
      const [upA, upB] = span(route.up);
      const candidates = lanes.map((j) => {
        const others = skippers.filter((other) => other !== route && other.corr.has(j)).map((other) => other.corr.get(j) as number);
        const blocked = [...others, ...portsFacing(j + 1, "top", route), ...portsFacing(j - 1, "bottom", route)];
        const xs: number[] = [];
        for (const [a, b] of corridors.get(j) as [number, number][]) {
          for (const w of [a, b, (a + b) / 2, route.corr.get(j) as number, route.pLo, route.pUp, centre.get(route.lo) as number, centre.get(route.up) as number]) xs.push(Math.min(b, Math.max(a, w)));
        }
        const free = xs.filter((x) => blocked.every((used) => Math.abs(used - x) >= PITCH));
        return [...new Set(free.length > 0 ? free : [route.corr.get(j) as number])];
      });
      // The channel cost from the child (bottom) up to the first gap, gap to gap, and the last gap to the parent.
      const fromLo = (x: number): number => (x >= loA && x <= loB ? 0 : segmentCost(netsIn(route.l - 1, route), route.pLo, x));
      const toUp = (x: number): number => (x >= upA && x <= upB ? 0 : segmentCost(netsIn(route.u, route), x, route.pUp));
      let best: { cost: number; path: number[] }[] = (candidates[0] as number[]).map((x) => ({ cost: fromLo(x), path: [x] }));
      for (let k = 1; k < lanes.length; k += 1) {
        const others = netsIn(lanes[k] as number, route);
        best = (candidates[k] as number[]).map((x) => {
          let pick: { cost: number; path: number[] } | null = null;
          for (const before of best) {
            const cost = before.cost + segmentCost(others, before.path[before.path.length - 1] as number, x);
            if (!pick || cost < pick.cost) pick = { cost, path: [...before.path, x] };
          }
          return pick as { cost: number; path: number[] };
        });
      }
      const done = best.map((entry) => ({ ...entry, cost: entry.cost + toUp(entry.path[entry.path.length - 1] as number) })).sort((a, b) => a.cost - b.cost);
      lanes.forEach((j, k) => route.corr.set(j, (done[0] as { path: number[] }).path[k] as number));
      route.chains = done.slice(0, GAP_ALTERNATIVES).map((entry) => entry.path);
      route.lanes = lanes;
    }
    for (const j of taken.keys()) taken.set(j, skippers.filter((other) => other.corr.has(j)).map((other) => other.corr.get(j) as number));
    placePorts();
  }

  // ----- channel nets: one horizontal per route per channel, bottom pins at the child side -----
  const buildChannels = (): Map<number, Channel> => {
    const channels = new Map<number, Channel>();
    const addNet = (route: Route, g: number, pins: readonly Pin[], xBelow: number, xAbove: number): Net => {
      let channel = channels.get(g);
      if (!channel) channels.set(g, (channel = { nets: [], rows: [], h: 0 }));
      const xs = pins.map((pin) => pin.x);
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      const pill = route.edge.pill !== null && g === (route.sameRow ? route.u - 1 : route.l - 1);
      // Pills slide past the segment ends.
      const pad = pill ? Math.max(16, (route.edge.pill as PillSize).width - 6) : PITCH / 2;
      const net: Net = { route, g, pins, xBelow, xAbove, lo, hi, straight: hi - lo < 0.5, pill, pL: lo - pad, pR: hi + pad, row: null };
      channel.nets.push(net);
      return net;
    };
    for (const route of routes) {
      route.nets = [];
      if (route.sameRow) {
        route.nets.push(addNet(route, route.u - 1, [{ x: route.pLo, side: "bottom" }, { x: route.pUp, side: "bottom" }], route.pLo, route.pUp));
        continue;
      }
      for (let g = route.l - 1; g >= route.u; g -= 1) {
        const xBelow = g === route.l - 1 ? route.pLo : (route.corr.get(g + 1) as number);
        const xAbove = g === route.u ? route.pUp : (route.corr.get(g) as number);
        route.nets.push(addNet(route, g, [{ x: xBelow, side: "bottom" }, { x: xAbove, side: "top" }], xBelow, xAbove));
      }
    }
    for (const channel of channels.values()) {
      const rowed = channel.nets.filter((net) => !net.straight || net.pill);
      const count = assignRows(rowed);
      channel.rows = Array.from({ length: count }, (_unused, index) => {
        const pills = rowed.filter((net) => net.row === index && net.pill);
        return { h: pills.length > 0 ? Math.max(20, ...pills.map((net) => (net.route.edge.pill as PillSize).height)) + 7 : PITCH };
      });
      channel.h = channel.rows.length > 0 ? ROW_PAD * 2 + channel.rows.reduce((sum, row) => sum + row.h, 0) : 0;
    }
    return channels;
  };

  // Rip-up and reroute: each row-skipping edge tries its best few chains of gaps and keeps the one
  // whose fully routed channels cost least (crossings first, then bends).
  const totalCost = (): number => {
    const channels = buildChannels();
    let cost = 0;
    let bends = 0;
    for (const channel of channels.values()) {
      cost += channelCost(channel);
      bends += channel.nets.filter((net) => net.row !== null && !net.straight).length;
    }
    return cost * 1000 + bends;
  };
  if (skippers.length > 0) {
    let current = totalCost();
    for (const route of skippers) {
      const keep = new Map(route.corr);
      for (const chain of route.chains) {
        if (route.lanes.every((j, k) => chain[k] === keep.get(j))) continue;
        const clash = route.lanes.some((j, k) => skippers.some((other) => other !== route && other.corr.has(j) && Math.abs((other.corr.get(j) as number) - (chain[k] as number)) < PITCH));
        if (clash) continue;
        route.lanes.forEach((j, k) => route.corr.set(j, chain[k] as number));
        placePorts();
        const cost = totalCost();
        if (cost < current) {
          current = cost;
          for (const [j, x] of route.corr) keep.set(j, x);
        } else for (const [j, x] of keep) route.corr.set(j, x);
      }
      for (const [j, x] of keep) route.corr.set(j, x);
      placePorts();
    }
    for (const j of taken.keys()) taken.set(j, skippers.filter((other) => other.corr.has(j)).map((other) => other.corr.get(j) as number));
  }

  // A corridor riser that lands within PITCH of a port it passes moves along its gap, then the
  // ports re-aim at the moved risers.
  let moved = false;
  for (const route of routes) {
    for (const j of [...route.corr.keys()]) {
      const near = [...portsFacing(j + 1, "top"), ...portsFacing(j - 1, "bottom")];
      const at = route.corr.get(j) as number;
      if (!near.some((x) => Math.abs(x - at) < PITCH)) continue;
      const others = (taken.get(j) as number[]).filter((x) => x !== at);
      const x = pickCorridorX(corridors.get(j) as [number, number][], at, [...others, ...near], PITCH);
      if (x === null) continue;
      taken.set(j, [...others, x]);
      route.corr.set(j, x);
      moved = true;
    }
  }
  if (moved) placePorts();
  // A near-aligned adjacent pair snaps straight when the moved port keeps its neighbours PITCH away.
  const sideOf = (route: Route, end: End): PortRef[] => sides.get(`${end === "lo" ? route.lo : route.up}|${end === "lo" || route.sameRow ? "top" : "bottom"}`) as PortRef[];
  const trySnap = (route: Route, end: End, x: number): boolean => {
    const [low, high] = span(end === "lo" ? route.lo : route.up);
    if (x < low || x > high) return false;
    if (sideOf(route, end).some((port) => port.route !== route && Math.abs(portOf(port.route, port.end) - x) < PITCH)) return false;
    setPort(route, end, x);
    return true;
  };
  for (const route of routes) {
    if (route.sameRow || route.l - route.u > 1 || route.pLo === route.pUp || Math.abs(route.pLo - route.pUp) >= PITCH) continue;
    if (!trySnap(route, "lo", route.pUp)) trySnap(route, "up", route.pLo);
  }

  const channels = buildChannels();
  const channelHeight = (channel: number): number => channels.get(channel)?.h ?? 0;

  function realize({ channelTop, cards }: Placement): readonly RoutedLine[] {
    const rowY = (net: Net): number => {
      const channel = channels.get(net.g) as Channel;
      let y = channelTop(net.g) + ROW_PAD;
      for (let index = 0; index < (net.row as number); index += 1) y += (channel.rows[index] as { h: number }).h;
      return y + (channel.rows[net.row as number] as { h: number }).h / 2;
    };

    // ----- polylines -----
    for (const route of routes) {
      const lower = cards.get(route.lo) as { top: number; bottom: number };
      const upper = cards.get(route.up) as { top: number; bottom: number };
      let points: Point[];
      if (route.sameRow) {
        const y = rowY(route.nets[0] as Net);
        points = [{ x: route.pLo, y: lower.top }, { x: route.pLo, y }, { x: route.pUp, y }, { x: route.pUp, y: upper.top }];
      } else {
        points = [{ x: route.pLo, y: lower.top }];
        for (const net of route.nets) {
          if (net.row === null) continue; // straight through this channel
          const y = rowY(net);
          points.push({ x: net.xBelow, y }, { x: net.xAbove, y });
        }
        points.push({ x: route.pUp, y: upper.bottom });
      }
      // A bend under half a pixel is no bend: a straight drop whose two ports differ by a hair stays straight.
      for (let index = 1; index < points.length; index += 1) {
        const before = points[index - 1] as Point;
        const here = points[index] as Point;
        if (Math.abs(here.x - before.x) < 0.5) points[index] = { x: before.x, y: here.y };
        else if (Math.abs(here.y - before.y) < 0.5) points[index] = { x: here.x, y: before.y };
      }
      // Drop repeated and collinear interior points.
      const distinct = points.filter((p, index) => index === 0 || p.x !== (points[index - 1] as Point).x || p.y !== (points[index - 1] as Point).y);
      route.points = distinct.filter((p, index) => {
        if (index === 0 || index === distinct.length - 1) return true;
        const before = distinct[index - 1] as Point;
        const after = distinct[index + 1] as Point;
        return !((p.x === before.x && p.x === after.x) || (p.y === before.y && p.y === after.y));
      });
    }

    // ----- pills slide along their horizontal to the spot crossed by the fewest other verticals -----
    const verticals: { x: number; y1: number; y2: number; route: Route }[] = [];
    for (const route of routes) {
      for (let index = 1; index < route.points.length; index += 1) {
        const a = route.points[index - 1] as Point;
        const b = route.points[index] as Point;
        if (a.x === b.x) verticals.push({ x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y), route });
      }
    }
    const pills = new Map<Route, { x: number; y: number; width: number; height: number }>();
    for (const route of routes) {
      const size = route.edge.pill;
      const net = route.nets.find((candidate) => candidate.pill);
      if (!size || !net) continue;
      const y = rowY(net);
      const halfHeight = size.height / 2;
      const near = verticals.filter((v) => v.route !== route && v.y1 < y + halfHeight && v.y2 > y - halfHeight);
      const anchor = net.xBelow;
      const overhang = Math.max(0, size.width / 2 - 10);
      const domainLow = net.lo - overhang;
      const domainHigh = net.hi + overhang;
      const conflicts = (x: number): number => near.reduce((count, v) => count + (Math.abs(v.x - x) < size.width / 2 + 3 ? 1 : 0), 0);
      let bestX = Math.min(domainHigh, Math.max(domainLow, anchor));
      let bestConflicts = conflicts(bestX);
      let bestDistance = 0;
      if (bestConflicts > 0) {
        const candidates = [domainLow, domainHigh];
        for (let x = domainLow; x < domainHigh; x += 4) candidates.push(x);
        for (const v of near) candidates.push(v.x + size.width / 2 + 3.5, v.x - size.width / 2 - 3.5);
        bestDistance = Infinity;
        for (const candidate of candidates) {
          if (candidate < domainLow - 1e-9 || candidate > domainHigh + 1e-9) continue;
          const count = conflicts(candidate);
          const distance = Math.abs(candidate - anchor);
          if (count < bestConflicts || (count === bestConflicts && distance < bestDistance)) {
            bestX = candidate;
            bestConflicts = count;
            bestDistance = distance;
          }
        }
      }
      pills.set(route, { x: bestX, y, width: size.width, height: size.height });
    }

    return routes
      .map((route, index) => ({ route, index }))
      .sort((a, b) => a.route.edge.weight - b.route.edge.weight || a.index - b.index)
      .map(({ route }) => ({ edge: route.edge, points: route.points, pill: pills.get(route) ?? null }));
  }

  return { shortages, channelHeight, realize };
}

/**
 * How many pairs of lines of different edges run along one and the same line and overlap, for
 * tests and checks: two parallel segments never share a track.
 */
export function sharedTracks(lines: readonly { readonly id: string; readonly points: readonly Point[] }[]): number {
  interface Segment {
    readonly horizontal: boolean;
    readonly fixed: number;
    readonly from: number;
    readonly to: number;
    readonly owner: string;
  }
  const segments: Segment[] = [];
  for (const line of lines) {
    for (let index = 1; index < line.points.length; index += 1) {
      const a = line.points[index - 1] as Point;
      const b = line.points[index] as Point;
      if (a.y === b.y) segments.push({ horizontal: true, fixed: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x), owner: line.id });
      else if (a.x === b.x) segments.push({ horizontal: false, fixed: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y), owner: line.id });
    }
  }
  let count = 0;
  for (const [index, a] of segments.entries()) {
    for (const b of segments.slice(index + 1)) {
      if (a.owner !== b.owner && a.horizontal === b.horizontal && Math.abs(a.fixed - b.fixed) < 0.5 && a.to > b.from + 0.5 && b.to > a.from + 0.5) count += 1;
    }
  }
  return count;
}
