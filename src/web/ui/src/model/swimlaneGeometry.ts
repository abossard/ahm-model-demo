/**
 * The arithmetic under the Swimlanes view: card order inside a lane, card coordinates, and the
 * gaps a line can pass through. Pure, no DOM.
 *
 * Adapted from ahm-diagrammo (MIT), src/layout.mjs, through the swimlane prototype: the one-
 * dimensional constrained projection (`projectPositions`), the relaxation that lines every row up
 * with the mean of its neighbours (`relaxCoordinates`), and the corridors between cards
 * (`corridorsOf`, `pickCorridorX`). `orderRows` is the prototype's barycenter sweep over
 * fractional positions, so that an edge that skips a row pulls as well. Edges are drawn by
 * `swimlaneRoute.ts`.
 *
 * Guarantees, which the tests pin: after `projectPositions` the order is kept and every pair of
 * neighbours is at least its separation apart; after `relaxCoordinates` no two cards of a row
 * overlap.
 */

interface Cluster {
  sum: number;
  count: number;
  readonly offsets: number[];
  readonly first: number;
  last: number;
}

/**
 * Positions that keep the order of `desired`, keep neighbour `i` and `i + 1` at least `sep[i]`
 * apart, and are as close as possible to `desired` (weighted least squares). Classic cluster
 * merge: each item starts as a cluster at its wish; while the last two clusters collide they
 * merge and sit at the weighted mean of what their members wanted.
 */
export function projectPositions(desired: readonly number[], sep: readonly number[], weights: readonly number[] | null = null): number[] {
  const n = desired.length;
  if (n === 0) return [];
  const weightOf = (index: number): number => (weights ? (weights[index] as number) : 1);
  const clusters: Cluster[] = [];
  for (let index = 0; index < n; index += 1) {
    const w0 = weightOf(index);
    let current: Cluster = { sum: w0 * (desired[index] as number), count: w0, offsets: [0], first: index, last: index };
    while (clusters.length > 0) {
      const previous = clusters[clusters.length - 1] as Cluster;
      const need = sep[current.first - 1] as number;
      const previousLast = previous.sum / previous.count + (previous.offsets[previous.offsets.length - 1] as number);
      const currentFirst = current.sum / current.count + (current.offsets[0] as number);
      if (currentFirst - previousLast >= need - 1e-9) break;
      // Merge `current` into `previous`: its offsets continue after the previous last offset plus the separation.
      const base = (previous.offsets[previous.offsets.length - 1] as number) + need - (current.offsets[0] as number);
      current.offsets.forEach((offset, k) => {
        const placed = offset + base;
        previous.offsets.push(placed);
        const w = weightOf(current.first + k);
        previous.sum += w * ((desired[current.first + k] as number) - placed);
        previous.count += w;
      });
      previous.last = current.last;
      current = clusters.pop() as Cluster;
    }
    clusters.push(current);
  }
  const out = new Array<number>(n).fill(0);
  for (const cluster of clusters) {
    const position = cluster.sum / cluster.count;
    cluster.offsets.forEach((offset, k) => {
      out[cluster.first + k] = position + offset;
    });
  }
  return out;
}

export interface RelaxOptions {
  /** Room to add to the gap on the right of a card, by its id: where lines need more corridors. */
  readonly extraGap?: ReadonlyMap<string, number>;
  readonly iterations?: number;
}

/**
 * Centre x of every card. Every row is aligned to the mean of the neighbours of each of its cards,
 * projected so that no two cards of a row overlap or come closer than `gap`; rows are swept down
 * and up alternately, forty times. The result starts at x = 0 at the left edge of the leftmost card.
 */
export function relaxCoordinates(
  rows: readonly (readonly string[])[],
  widths: ReadonlyMap<string, number>,
  neighbours: ReadonlyMap<string, readonly string[]>,
  gap: number,
  { extraGap = new Map<string, number>(), iterations = 40 }: RelaxOptions = {},
): Map<string, number> {
  const width = (id: string): number => widths.get(id) as number;
  const x = new Map<string, number>();
  const separations = rows.map((row) => row.slice(0, -1).map((id, index) => width(id) / 2 + width(row[index + 1] as string) / 2 + gap + (extraGap.get(id) ?? 0)));
  rows.forEach((row, rowIndex) => {
    let cursor = 0;
    row.forEach((id, index) => {
      if (index > 0) cursor += separations[rowIndex]![index - 1]!;
      x.set(id, cursor);
    });
  });

  for (let pass = 0; pass < iterations; pass += 1) {
    const order = rows.map((_row, index) => (pass % 2 === 0 ? index : rows.length - 1 - index));
    for (const rowIndex of order) {
      const row = rows[rowIndex] as readonly string[];
      if (row.length === 0) continue;
      const desired = row.map((id) => {
        const around = neighbours.get(id) ?? [];
        if (around.length === 0) return x.get(id) as number;
        return around.reduce((sum, other) => sum + (x.get(other) as number), 0) / around.length;
      });
      const placed = projectPositions(desired, separations[rowIndex] as number[]);
      row.forEach((id, index) => x.set(id, placed[index] as number));
    }
  }

  let leftmost = Infinity;
  for (const row of rows) for (const id of row) leftmost = Math.min(leftmost, (x.get(id) as number) - width(id) / 2);
  if (Number.isFinite(leftmost)) for (const id of [...x.keys()]) x.set(id, (x.get(id) as number) - leftmost);
  return x;
}

export interface Card1D {
  /** Left edge. */
  readonly x: number;
  readonly width: number;
}

/**
 * The usable vertical corridors through a row: the gaps between adjacent cards, `margin` away from
 * each card, and the open space on both flanks.
 */
export function corridorsOf(cards: readonly Card1D[], margin = 10, flank = 60): [number, number][] {
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

/**
 * The x in `corridors` nearest to `want` that is at least `spacing` from every x in `taken`, or
 * null when no corridor has a slot left.
 */
export function pickCorridorX(corridors: readonly (readonly [number, number])[], want: number, taken: readonly number[] = [], spacing = 7): number | null {
  let best: number | null = null;
  let bestCost = Infinity;
  for (const [low, high] of corridors) {
    // The wish clamped into the corridor, a slot beside every taken position, and both ends.
    const candidates = [Math.min(high, Math.max(low, want))];
    for (const used of taken) candidates.push(used + spacing, used - spacing);
    candidates.push(low, high);
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

/**
 * Orders the cards of every row by barycenter sweeps: six rounds down, each row by the mean
 * position of its parents, and up, by its children. Positions are fractions of the row, so a line
 * that skips a row pulls on its end as hard as one that does not. Cards without neighbours keep
 * their place. `rows` is returned re-ordered; the input is not changed.
 */
export function orderRows(
  rows: readonly (readonly string[])[],
  parents: ReadonlyMap<string, readonly string[]>,
  children: ReadonlyMap<string, readonly string[]>,
  rounds = 6,
): string[][] {
  const order = rows.map((row) => [...row]);
  const fraction = new Map<string, number>();
  const refresh = (row: readonly string[]): void => row.forEach((id, index) => fraction.set(id, (index + 0.5) / row.length));
  order.forEach(refresh);
  const barycenter = (ids: readonly string[]): number | null => {
    const known = ids.map((id) => fraction.get(id)).filter((value): value is number => value !== undefined);
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
  };
  const sortRow = (rowIndex: number, around: ReadonlyMap<string, readonly string[]>): void => {
    const row = order[rowIndex] as string[];
    order[rowIndex] = row
      .map((id, index) => ({ id, index, key: barycenter(around.get(id) ?? []) }))
      .sort((a, b) => (a.key ?? a.index / row.length) - (b.key ?? b.index / row.length) || a.index - b.index)
      .map((item) => item.id);
    refresh(order[rowIndex] as string[]);
  };
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 1; index < order.length; index += 1) sortRow(index, parents);
    for (let index = order.length - 2; index >= 0; index -= 1) sortRow(index, children);
  }
  return order;
}
