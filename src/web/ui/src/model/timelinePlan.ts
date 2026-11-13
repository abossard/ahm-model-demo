import { seriesKey, type Span } from "./timeline";
import { DAY, HOUR } from "./timelineScale";
import { LEVELS, OVERVIEW_TILE, RAW, RETENTION, levelFor, tileRuns, tileSpan, tilesIn, type Level } from "./timelineTiles";
import { coveredAt, covers, type Asked, type TimeStore } from "./timeStore";

/**
 * What to ask the app for so that a view of the timeline is held: the tiles that are missing, as few requests as the
 * server's limits allow, the ones on screen first. A calculation: the loader gives it what is held, in flight and
 * settled, and starts what it returns.
 */

/** What the viewer looks at. */
export interface Demand {
  /** The window of time on screen. */
  readonly view: Span;
  /** The width of the plot in pixels: it decides how fine the series have to be. */
  readonly width: number;
  /** The entities whose signal lanes show. */
  readonly lanes: readonly string[];
  /** The selected moment, null for now. */
  readonly moment: number | null;
  /** The entities whose signal values show at the selected moment, wherever on the page. */
  readonly watched: readonly string[];
  /** The entities whose signals show as sparklines on the graph's cards: their series are read for `sparkWindow`. */
  readonly sparks: readonly string[];
  /** The timeline shows, so the states, annotations and reports of every entity are read. Without it only the structure and the series are. */
  readonly overview: boolean;
}

export interface TileRequest extends Asked {
  /** The window, on tile boundaries. */
  readonly from: number;
  readonly to: number;
  /** What it reads: one cell per history and tile. Two requests never hold the same cell. */
  readonly cells: readonly string[];
  /** 0 is on screen, 1 the rest of the model's history, 2 the window next to the one on screen. */
  readonly rank: number;
}

/** An entity the graph already knows, for a first plan before the timeline has read the structure. */
export interface EntityHint {
  readonly name: string;
  /** It has the signal health reports are written to, which is read with the overview. */
  readonly reports: boolean;
}

export interface PlanInput {
  readonly store: TimeStore;
  readonly demand: Demand;
  readonly now: number;
  /** A tile that is still open must be held up to here: when the model was opened, or last refreshed. */
  readonly freshAt: number;
  /** When the structure was last read, 0 for never. */
  readonly structureAt: number;
  /** The cells of the requests in flight. */
  readonly busy: ReadonlySet<string>;
  /** The cells that were answered or failed since the last refresh: they are not asked again. */
  readonly settled: ReadonlySet<string>;
  readonly hint: readonly EntityHint[] | null;
  /** Nothing is in flight and the view rests: the neighbouring window may be read ahead. */
  readonly idle: boolean;
}

export interface Plan {
  /** In the order to start them. */
  readonly requests: readonly TileRequest[];
  /** Every cell the demand names, held or not: a request in flight that holds none of them is nobody's any more. */
  readonly wanted: ReadonlySet<string>;
  /** The wanted cells that are not held: the browser's cache is asked for them before the network is. */
  readonly lacking: readonly string[];
}

/** Histories read toward Azure in one request, at most: the server allows 400 calls and a history can take two or three. */
export const MAX_COST = 160;
/** The server refuses more than 120 series in a request. */
export const MAX_SIGNALS = 100;
/** Entity names travel in the address, which has a length limit. */
export const MAX_ENTITIES = 40;
/** The signal health reports are written to: the server reads it a day at a time, like every signal. */
export const REPORT_SIGNAL = "web-ui-health-report";
/** How long an evaluation is believed to hold at most: a value at a moment may be this much older than the moment. */
const MAX_HOLD = 2 * HOUR;
const SEP = "\u0001";
/** How far back a sparkline on a card reaches from the moment it ends at. */
export const SPARK_SPAN = 6 * HOUR;
/**
 * The level a sparkline is read at: slots of 15 minutes, so 6 hours are some 24 slots for a line of about 56 pixels,
 * and a tile is a day, which costs one history call a signal. The hourly level would give 6 slots and week tiles.
 */
export const SPARK_LEVEL = 1;

/** The window a sparkline shows: the `SPARK_SPAN` that ends at `end`, within what the service keeps. */
export const sparkWindow = (end: number, now: number): Span => ({ from: Math.max(now - RETENTION, end - SPARK_SPAN), to: Math.min(now, end) });
const STRUCTURE_CELL = "x";
const ANY = "*";

export const overviewCell = (entity: string, tile: number): string => `o${SEP}${entity}${SEP}${SEP}0${SEP}${tile}`;
export const seriesCell = (entity: string, signal: string, level: number, tile: number): string => `s${SEP}${entity}${SEP}${signal}${SEP}${level}${SEP}${tile}`;

export interface Cell {
  readonly kind: "o" | "s" | "x";
  readonly entity: string;
  readonly signal: string;
  readonly level: number;
  readonly tile: number;
}

export function parseCell(cell: string): Cell {
  const [kind, entity, signal, level, tile] = cell.split(SEP);
  return { kind: (kind ?? "x") as Cell["kind"], entity: entity ?? "", signal: signal ?? "", level: Number(level ?? 0), tile: Number(tile ?? 0) };
}

/** The part of a tile that can be held now: not before what the service keeps, not after now, and up to `freshAt` while it is open. */
function wantOf(tile: Span, now: number, freshAt: number): Span {
  const from = Math.max(tile.from, now - RETENTION);
  const open = tile.to > now;
  return { from, to: open ? Math.min(now, Math.max(freshAt, from + 1)) : tile.to };
}

const pad = (view: Span, now: number): Span => {
  const margin = (view.to - view.from) / 4;
  return { from: Math.max(now - RETENTION, view.from - margin), to: Math.min(now, view.to + margin) };
};

const overlaps = (a: Span, b: Span): boolean => a.from < b.to && b.from < a.to;

interface Unit {
  readonly entity: string;
  /** The signals to read, null for all the entity has. */
  readonly signals: readonly string[] | null;
  readonly count: number;
  readonly first: number;
  readonly last: number;
  readonly cells: readonly string[];
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** The series requests that read `need` (entity, then signal, then the tiles it lacks) at one level. */
function seriesRequests(need: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>, signalsOf: (entity: string) => number, level: number, rank: number): TileRequest[] {
  const size = (LEVELS[level] as Level).tile;
  const perTile = size / DAY;
  const units: Unit[] = [];
  for (const [entity, bySignal] of need) {
    const names = [...bySignal.keys()];
    const tiles = [...new Set(names.flatMap((name) => [...(bySignal.get(name) ?? [])]))].sort((a, b) => a - b);
    // An entity whose signals all lack something travels with others; one that lacks a few is asked for those alone.
    const groups = names.length === signalsOf(entity) && names.length <= Math.min(MAX_SIGNALS, MAX_COST / perTile) ? [null] : chunks(names, Math.min(MAX_SIGNALS, Math.floor(MAX_COST / perTile)));
    for (const group of groups) {
      const count = group?.length ?? names.length;
      const most = Math.max(1, Math.floor(MAX_COST / (count * perTile)));
      for (const [first, last] of tileRuns(tiles)) {
        for (let start = first; start <= last; start += most) {
          const end = Math.min(last, start + most - 1);
          const cells: string[] = [];
          for (const name of group ?? names) for (let tile = start; tile <= end; tile += 1) if (bySignal.get(name)?.has(tile)) cells.push(seriesCell(entity, name, level, tile));
          if (cells.length > 0) units.push({ entity, signals: group, count, first: start, last: end, cells });
        }
      }
    }
  }
  const out: TileRequest[] = [];
  const open = new Map<string, { entities: string[]; cells: string[]; cost: number; count: number }>();
  const close = (key: string, first: number, last: number): void => {
    const batch = open.get(key);
    if (!batch) return;
    open.delete(key);
    out.push({ parts: ["signals"], entities: batch.entities, signals: null, level, from: first * size, to: (last + 1) * size, cells: batch.cells, rank });
  };
  for (const unit of units) {
    if (unit.signals !== null) {
      out.push({ parts: ["signals"], entities: [unit.entity], signals: unit.signals, level, from: unit.first * size, to: (unit.last + 1) * size, cells: unit.cells, rank });
      continue;
    }
    const key = `${unit.first}:${unit.last}`;
    const cost = unit.count * perTile * (unit.last - unit.first + 1);
    const batch = open.get(key);
    if (batch && (batch.cost + cost > MAX_COST || batch.count + unit.count > MAX_SIGNALS || batch.entities.length >= MAX_ENTITIES)) close(key, unit.first, unit.last);
    const into = open.get(key) ?? { entities: [], cells: [], cost: 0, count: 0 };
    into.entities.push(unit.entity);
    into.cells.push(...unit.cells);
    into.cost += cost;
    into.count += unit.count;
    open.set(key, into);
  }
  for (const key of [...open.keys()]) {
    const [first, last] = key.split(":").map(Number);
    close(key, first ?? 0, last ?? 0);
  }
  return out;
}

/**
 * What a demand reads, in words: two demands with the same key need the same tiles, so the second one changes nothing.
 */
export function demandKey(demand: Demand, now: number): string {
  const level = levelFor(demand.view.to - demand.view.from, demand.width);
  // By the day, whatever the level: that is as fine as what is held ever ends.
  const tiles = tilesIn(pad(demand.view, now), DAY);
  const moment = demand.moment === null ? "" : `${Math.floor(demand.moment / HOUR)}`;
  const sparks = demand.sparks.length === 0 ? [] : tilesIn(sparkWindow(demand.moment ?? now, now), DAY);
  return [
    level,
    tiles[0] ?? "",
    tiles[tiles.length - 1] ?? "",
    moment,
    demand.lanes.join(SEP),
    demand.moment === null ? "" : demand.watched.join(SEP),
    demand.overview ? "o" : "",
    demand.sparks.join(SEP),
    sparks[0] ?? "",
    sparks[sparks.length - 1] ?? "",
  ].join("|");
}

export function planRequests(input: PlanInput): Plan {
  const { store, demand, now, freshAt, busy, settled } = input;
  const wanted = new Set<string>();
  const lacking: string[] = [];
  const requests: TileRequest[] = [];
  const free = (cell: string): boolean => !busy.has(cell) && !settled.has(cell);
  const onScreen: Span = demand.moment === null ? demand.view : { from: Math.min(demand.view.from, demand.moment), to: now };

  /* The overview: the states, annotations and reports of every entity, for as long as the service keeps them. */
  const known = store.entities.length > 0 ? store.entities.map((entity) => ({ name: entity.name, reports: entity.signals.some((signal) => signal.name === REPORT_SIGNAL) })) : input.hint;
  const overviewTiles = tilesIn({ from: now - RETENTION, to: now }, OVERVIEW_TILE);
  const needStructure = (store.entities.length === 0 || input.structureAt < freshAt) && free(STRUCTURE_CELL);
  let structureRides = false;
  const structure = (): readonly ("structure")[] => {
    if (!needStructure || structureRides) return [];
    structureRides = true;
    return ["structure"];
  };
  // The structure on its way is still wanted: the request that reads it alone holds no other cell to keep it.
  if (needStructure || busy.has(STRUCTURE_CELL)) wanted.add(STRUCTURE_CELL);

  // Without the timeline on screen nothing shows the overview: only the structure is read, to know the signals of the series.
  if (demand.overview && known === null) {
    // Nothing says which entities there are: the tiles on screen are read for all of them, and the answer names them.
    const first = overviewTiles.find((tile) => overlaps(tileSpan(tile, OVERVIEW_TILE), onScreen)) ?? overviewTiles[overviewTiles.length - 1] ?? 0;
    const cells = overviewTiles.filter((tile) => tile >= first).map((tile) => overviewCell(ANY, tile));
    for (const cell of cells) wanted.add(cell);
    const todo = cells.filter(free);
    lacking.push(...todo);
    if (todo.length > 0) {
      const tiles = todo.map((cell) => parseCell(cell).tile);
      requests.push({ parts: [...structure(), "states", "annotations", "reports"], entities: null, signals: null, level: RAW, from: Math.min(...tiles) * OVERVIEW_TILE, to: (Math.max(...tiles) + 1) * OVERVIEW_TILE, cells: todo, rank: 0 });
    }
  } else if (demand.overview && known !== null) {
    const costOf = (entity: EntityHint): number => 2 + (entity.reports ? OVERVIEW_TILE / DAY : 0);
    const whole = known.reduce((sum, entity) => sum + costOf(entity), 0);
    // Neighbouring tiles that the whole model lacks, read together while one request can.
    const batch: { tiles: number[]; cells: string[]; rank: number } = { tiles: [], cells: [], rank: 1 };
    const flush = (): void => {
      if (batch.tiles.length === 0) return;
      requests.push({ parts: [...structure(), "states", "annotations", "reports"], entities: null, signals: null, level: RAW, from: Math.min(...batch.tiles) * OVERVIEW_TILE, to: (Math.max(...batch.tiles) + 1) * OVERVIEW_TILE, cells: batch.cells, rank: batch.rank });
      batch.tiles = [];
      batch.cells = [];
      batch.rank = 1;
    };
    for (const tile of [...overviewTiles].reverse()) {
      const span = tileSpan(tile, OVERVIEW_TILE);
      const want = wantOf(span, now, freshAt);
      const rank = overlaps(span, onScreen) ? 0 : 1;
      const need: EntityHint[] = [];
      for (const entity of known) {
        const cell = overviewCell(entity.name, tile);
        wanted.add(cell);
        const states = store.states[entity.name];
        if (states?.error) continue;
        const held = (track: { readonly covered: readonly Span[]; readonly error: unknown } | undefined): boolean => track !== undefined && (track.error !== null || covers(track.covered, want));
        if (covers(states?.covered ?? [], want) && held(store.annotations[entity.name]) && held(store.reports[entity.name])) continue;
        lacking.push(cell);
        if (free(cell) && !busy.has(overviewCell(ANY, tile))) need.push(entity);
      }
      if (need.length === 0) {
        flush();
        continue;
      }
      const cells = need.map((entity) => overviewCell(entity.name, tile));
      if (need.length === known.length && whole <= MAX_COST) {
        if ((batch.tiles.length + 1) * whole > MAX_COST) flush();
        batch.tiles.push(tile);
        batch.cells.push(...cells);
        batch.rank = Math.min(batch.rank, rank);
        continue;
      }
      flush();
      let entities: string[] = [];
      let cost = 0;
      const send = (): void => {
        if (entities.length > 0) requests.push({ parts: ["states", "annotations", "reports"], entities, signals: null, level: RAW, from: span.from, to: span.to, cells: entities.map((name) => overviewCell(name, tile)), rank });
        entities = [];
        cost = 0;
      };
      for (const entity of need) {
        if (cost + costOf(entity) > MAX_COST || entities.length >= MAX_ENTITIES) send();
        entities.push(entity.name);
        cost += costOf(entity);
      }
      send();
    }
    flush();
  }
  if (needStructure && !structureRides) {
    // No request reads the whole model, so the structure is asked for on its own: it costs the server no history call.
    const open = tileSpan(overviewTiles[overviewTiles.length - 1] ?? 0, OVERVIEW_TILE);
    requests.unshift({ parts: ["structure"], entities: null, signals: null, level: RAW, from: open.from, to: open.to, cells: [STRUCTURE_CELL], rank: 0 });
  } else if (structureRides) {
    const first = requests.find((request) => request.parts.includes("structure"));
    if (first) requests[requests.indexOf(first)] = { ...first, cells: [...first.cells, STRUCTURE_CELL], rank: 0 };
  }

  /* The series of the lanes that show, at the level the window calls for, and at full detail around a selected moment. */
  const byName = new Map(store.entities.map((entity) => [entity.name, entity]));
  const series = (entities: readonly string[], level: number, window: Span, rank: number): void => {
    const need = new Map<string, Map<string, Set<number>>>();
    const size = (LEVELS[level] as Level).tile;
    if (window.to <= window.from) return;
    for (const name of new Set(entities)) {
      for (const signal of byName.get(name)?.signals ?? []) {
        const levels = store.series[seriesKey(name, signal.name)];
        if (levels?.[level]?.error) continue;
        const covered = coveredAt(levels, level);
        for (const tile of tilesIn(window, size)) {
          const cell = seriesCell(name, signal.name, level, tile);
          wanted.add(cell);
          // Only the part of the tile the window shows has to be held: finer points that reach that far are enough.
          const want = wantOf(tileSpan(tile, size), now, freshAt);
          if (covers(covered, { from: Math.max(want.from, window.from), to: Math.min(want.to, Math.max(window.to, want.from + 1)) })) continue;
          lacking.push(cell);
          if (!free(cell)) continue;
          const bySignal = need.get(name) ?? new Map<string, Set<number>>();
          need.set(name, bySignal);
          bySignal.set(signal.name, (bySignal.get(signal.name) ?? new Set<number>()).add(tile));
        }
      }
    }
    requests.push(...seriesRequests(need, (entity) => byName.get(entity)?.signals.length ?? 0, level, rank));
  };
  const span = demand.view.to - demand.view.from;
  const level = levelFor(span, demand.width);
  series(demand.lanes, level, pad(demand.view, now), 0);
  if (demand.moment !== null) {
    series([...demand.watched, ...demand.lanes], RAW, { from: Math.max(now - RETENTION, demand.moment - MAX_HOLD), to: Math.min(now, demand.moment + 1) }, 0);
  }
  if (demand.sparks.length > 0) series(demand.sparks, SPARK_LEVEL, sparkWindow(demand.moment ?? now, now), 0);
  if (input.idle && requests.length === 0) {
    // The window before the one on screen, and the one after it when the view does not end at now.
    series(demand.lanes, level, { from: Math.max(now - RETENTION, demand.view.from - span), to: demand.view.from }, 2);
    series(demand.lanes, level, { from: demand.view.to, to: Math.min(now, demand.view.to + span) }, 2);
  }

  const order = [...requests].sort((a, b) => a.rank - b.rank || b.to - a.to);
  return { requests: order, wanted, lacking };
}
