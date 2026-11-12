import type { ApiError } from "../model/types";
import type { EntityInfo, TimelineResponse } from "../model/timeline";
import { demandKey, parseCell, planRequests, type Demand, type EntityHint, type TileRequest } from "../model/timelinePlan";
import { LEVELS, OVERVIEW_TILE, type Level } from "../model/timelineTiles";
import { mergeAnswer, mergeKept, tilesOfAnswer, type TimeStore } from "../model/timeStore";
import type { CacheScope, TileCache } from "./tileCache";

/**
 * The one way timeline data reaches the browser. A caller says what it looks at; the loader works out which tiles are
 * missing, takes them from the browser's cache when it has them and from the app otherwise, and hands every answer to
 * the store. Tiles, levels, batches, the cache, how many requests run at once and which are cancelled are its business
 * alone.
 */
export interface TimelineLoader {
  /** Another model or another user (null for none): everything in flight is cancelled and what was asked is forgotten. */
  readonly open: (scope: CacheScope | null) => void;
  /** What the viewer looks at now. It replaces what was wanted before; calling it again with the same view costs nothing. */
  readonly want: (demand: Demand) => void;
  /** The tiles that are still open are read again: the live stream was away, or the viewer asked. */
  readonly refresh: () => void;
  /** What failed is asked for again. */
  readonly retry: () => void;
  /** Cancels everything in flight and keeps what is held: the timeline closed. */
  readonly stop: () => void;
  /** Resolves when nothing is being read, from the cache or the network. */
  readonly idle: () => Promise<void>;
}

/** What the loader needs from the world around it. */
export interface LoaderPorts {
  /** GET /api/timeline for one request. */
  readonly fetch: (request: TileRequest, signal: AbortSignal) => Promise<TimelineResponse>;
  readonly cache: () => TileCache | null;
  readonly held: () => TimeStore;
  /** Something arrived: the change to make to the store, and where it came from. */
  readonly merge: (change: (store: TimeStore) => TimeStore, source: "cache" | "network", request: TileRequest | null) => void;
  /** A request failed as a whole. */
  readonly failed: (request: TileRequest, error: ApiError) => void;
  /** The entities whose series are being read, and whether the overview is. */
  readonly reading: (entities: readonly string[], overview: boolean) => void;
  /** The entities the graph already shows, when the structure is not held yet. */
  readonly hint: () => readonly EntityHint[] | null;
  readonly now: () => number;
}

/** Requests toward the app at once. The server reads 8 histories at a time for each, and 24 across the app. */
export const CONCURRENCY = 4;
/** The view has to rest this long, with nothing left to read, before the window next to it is read ahead. */
export const PREFETCH_IDLE_MS = 4000;

const TILE_SIZES = { overview: OVERVIEW_TILE, series: (level: number): number => (LEVELS[level] as Level).tile };

interface Flight {
  readonly request: TileRequest;
  readonly controller: AbortController;
}

function asApiError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) return error as ApiError;
  return { code: "unknown", message: error instanceof Error ? error.message : "The timeline could not be loaded.", retryable: true, operationId: null };
}

export function createTimelineLoader(ports: LoaderPorts): TimelineLoader {
  let scope: CacheScope | null = null;
  let demand: Demand | null = null;
  let wantedKey = "";
  /** Bumped whenever the scope changes: an answer of an earlier one is dropped. */
  let generation = 0;
  let freshAt = 0;
  /**
   * The app's clock minus the browser's, as the last answer for a tile that is still open showed it. What is held is
   * stamped by the app, `freshAt` by the browser: the difference keeps a clock that runs ahead from asking twice.
   */
  let offset = 0;
  let structureAt = 0;
  /** The cached structure of the scope was looked for: planning waits for it, so a reload asks only for what the cache lacks. */
  let ready = false;
  let probing = 0;
  let rested = false;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  let sequence = 0;
  const flights = new Map<number, Flight>();
  /** The cells that were answered or failed since the last refresh: asking again would get the same answer. */
  const settled = new Set<string>();
  const probed = new Set<string>();
  let waiting: (() => void)[] = [];

  const cancelAll = (): void => {
    for (const flight of flights.values()) flight.controller.abort();
    flights.clear();
  };

  const report = (): void => {
    const entities = new Set<string>();
    let overview = false;
    for (const { request } of flights.values()) {
      if (request.parts.includes("signals")) for (const cell of request.cells) entities.add(parseCell(cell).entity);
      else overview = true;
    }
    ports.reading([...entities], overview);
    if (flights.size === 0 && probing === 0 && (ready || scope === null)) {
      const done = waiting;
      waiting = [];
      for (const resolve of done) resolve();
    }
  };

  const rest = (): void => {
    if (restTimer !== null) clearTimeout(restTimer);
    restTimer = null;
    if (rested || scope === null || demand === null) return;
    const mine = generation;
    restTimer = setTimeout(() => {
      restTimer = null;
      if (mine !== generation || flights.size > 0) return;
      rested = true;
      run();
    }, PREFETCH_IDLE_MS);
  };

  const start = (request: TileRequest): void => {
    const mine = generation;
    const id = (sequence += 1);
    const controller = new AbortController();
    const at = scope as CacheScope;
    flights.set(id, { request, controller });
    const mineStill = (): boolean => mine === generation && flights.get(id)?.controller === controller;
    ports.fetch(request, controller.signal).then(
      (response) => {
        if (!mineStill()) return;
        flights.delete(id);
        for (const cell of request.cells) settled.add(cell);
        if (request.parts.includes("structure")) structureAt = ports.now();
        const reached = Date.parse(response.range.to);
        if (reached < request.to) offset = reached - ports.now();
        ports.merge((store) => mergeAnswer(store, response, request), "network", request);
        const cache = ports.cache();
        const observedAt = Date.parse(response.observedAt);
        cache?.write(at, tilesOfAnswer(response, request, TILE_SIZES), Number.isFinite(observedAt) ? observedAt : ports.now());
        if (request.parts.includes("structure") && response.entities.length > 0) cache?.writeStructure(at, response.entities);
        run();
      },
      (error: unknown) => {
        if (!mineStill()) return;
        flights.delete(id);
        for (const cell of request.cells) settled.add(cell);
        ports.failed(request, asApiError(error));
        run();
      },
    );
  };

  function run(): void {
    if (scope === null || demand === null || !ready) return report();
    const busy = new Set<string>();
    for (const { request } of flights.values()) for (const cell of request.cells) busy.add(cell);
    // The plan is made on the app's clock: that is the clock of everything held, and of what the service still keeps.
    const now = ports.now() + offset;
    const plan = planRequests({ store: ports.held(), demand, now, freshAt: freshAt + offset, structureAt: structureAt + offset, busy, settled, hint: ports.hint(), idle: rested });

    // A request none of whose cells is wanted any more is nobody's: it is the only kind that is cancelled.
    for (const [id, flight] of flights) {
      if (flight.request.cells.some((cell) => plan.wanted.has(cell))) continue;
      flight.controller.abort();
      flights.delete(id);
    }

    // What the browser kept is asked first: only what it lacks goes to the network.
    const cache = ports.cache();
    const unprobed = cache === null ? [] : plan.lacking.filter((cell) => !probed.has(cell) && !settled.has(cell) && !busy.has(cell));
    if (cache !== null && unprobed.length > 0) {
      for (const cell of unprobed) probed.add(cell);
      const mine = generation;
      probing += 1;
      void cache.read(scope, unprobed).then((tiles) => {
        if (mine !== generation) return;
        probing -= 1;
        if (tiles.length > 0) ports.merge((store) => mergeKept(store, tiles), "cache", null);
        run();
      });
      return report();
    }
    if (probing > 0) return report();

    for (const request of plan.requests) {
      if (flights.size >= CONCURRENCY) break;
      // Reading ahead never competes with what is on screen.
      if (request.rank === 2 && flights.size > 0) break;
      start(request);
    }
    if (flights.size === 0) rest();
    report();
  }

  return {
    open: (next) => {
      generation += 1;
      cancelAll();
      settled.clear();
      probed.clear();
      scope = next;
      demand = null;
      wantedKey = "";
      freshAt = ports.now();
      offset = 0;
      structureAt = 0;
      probing = 0;
      rested = false;
      if (restTimer !== null) clearTimeout(restTimer);
      restTimer = null;
      const cache = ports.cache();
      ready = next === null || cache === null;
      if (next !== null && cache !== null) {
        const mine = generation;
        void cache.readStructure(next).then((entities: readonly EntityInfo[] | null) => {
          if (mine !== generation) return;
          ready = true;
          if (entities && entities.length > 0) ports.merge((store) => (store.entities.length === 0 ? { ...store, entities } : store), "cache", null);
          run();
        });
      }
      report();
    },
    want: (next) => {
      const key = demandKey(next, ports.now());
      demand = next;
      if (key === wantedKey && (flights.size > 0 || probing > 0 || restTimer !== null || rested)) return;
      if (key !== wantedKey) rested = false;
      wantedKey = key;
      run();
    },
    refresh: () => {
      // A tile that is still open has to reach this instant, so it is read again, with the structure. What is held and
      // closed stays as it is; what failed or came back cut is asked for once more.
      freshAt = ports.now();
      settled.clear();
      rested = false;
      run();
    },
    retry: () => {
      settled.clear();
      rested = false;
      run();
    },
    stop: () => {
      cancelAll();
      if (restTimer !== null) clearTimeout(restTimer);
      restTimer = null;
      wantedKey = "";
      report();
    },
    idle: () =>
      new Promise((resolve) => {
        if (flights.size === 0 && probing === 0 && (ready || scope === null)) resolve();
        else waiting.push(resolve);
      }),
  };
}
