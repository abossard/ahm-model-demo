import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../model/types";
import { seriesKey, type TimelineResponse } from "../model/timeline";
import { buildFixture, topologyFixture, type TimelineFixture } from "../model/timelineFixture";
import { REPORT_SIGNAL, parseCell, type Demand, type EntityHint, type TileRequest } from "../model/timelinePlan";
import { DAY, HOUR, MINUTE } from "../model/timelineScale";
import { LEVELS, RETENTION, WEEK, tileOf } from "../model/timelineTiles";
import { EMPTY_STORE, covers, coveredAt, type TimeStore } from "../model/timeStore";
import { createTileCache, memoryStorage, type CacheScope, type TileCache, type TileStorage } from "./tileCache";
import { CONCURRENCY, PREFETCH_IDLE_MS, createTimelineLoader, type TimelineLoader } from "./timelineLoader";

// A Wednesday noon: the week it is in began the Thursday before, the day at midnight.
const NOW = Date.parse("2026-11-11T12:00:00Z");
const TODAY = tileOf(NOW, DAY) * DAY;
const THIS_WEEK = tileOf(NOW, WEEK) * WEEK;
const ADA: CacheScope = { owner: "tenant-a/ada@example.test", model: "sub/rg/hm" };
const BOB: CacheScope = { owner: "tenant-a/bob@example.test", model: "sub/rg/hm" };
const SMALL = buildFixture({ now: NOW, days: 14, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 3, signalsPerResource: 2 });
const LANES = SMALL.entities.filter((entity) => entity.signals.length > 0).map((entity) => entity.name);
const [FIRST, SECOND, THIRD] = LANES as [string, string, string];
const signal = (name: string) => ({ name, displayName: name, kind: null, unit: null, refreshInterval: "PT5M", rules: { degraded: null, unhealthy: null, dynamic: false } });
const large = (count: number, reports = false): TimelineFixture =>
  topologyFixture(
    Array.from({ length: count }, (_unused, index) => ({ name: `e${index}`, displayName: `E ${index}`, parents: index === 0 ? [] : ["e0"], signals: [signal("cpu"), ...(reports ? [signal(REPORT_SIGNAL)] : [])] })),
    { now: NOW, days: 3 },
  );

const demand = (parts: Partial<Demand> = {}): Demand => ({ view: { from: NOW - DAY, to: NOW }, width: 1000, lanes: [], moment: null, watched: [], ...parts });

interface Harness {
  readonly loader: TimelineLoader;
  readonly requests: TileRequest[];
  readonly signals: AbortSignal[];
  readonly sources: ("cache" | "network")[];
  readonly errors: ApiError[];
  readonly store: () => TimeStore;
  readonly peak: () => number;
  /** The requests that are waiting for `release`. */
  readonly pending: () => number;
  readonly release: () => void;
  readonly reading: () => readonly string[];
  now: number;
}

interface Options {
  readonly cache?: TileCache | null;
  readonly hint?: readonly EntityHint[] | null;
  /** Answers wait until `release` is called. */
  readonly gated?: boolean;
  /** What the app answers, when it is not simply the fixture. */
  readonly answer?: (request: TileRequest) => TimelineResponse | Promise<TimelineResponse>;
}

const resolutionOf = (request: TileRequest): number => (request.parts.includes("signals") ? (LEVELS[request.level] as { slot: number }).slot / 1000 : 0);
const answerOf = (fixture: TimelineFixture, request: TileRequest): TimelineResponse =>
  fixture.answer({ from: request.from, to: request.to, include: request.parts, entities: request.entities ?? [], signals: request.signals ?? [], resolution: resolutionOf(request) });

function harness(fixture: TimelineFixture, options: Options = {}): Harness {
  let store = EMPTY_STORE;
  let active = 0;
  let peak = 0;
  let waiting: (() => void)[] = [];
  let reading: readonly string[] = [];
  const self: Harness = {
    requests: [],
    signals: [],
    sources: [],
    errors: [],
    now: NOW,
    store: () => store,
    peak: () => peak,
    pending: () => waiting.length,
    release: () => {
      const all = waiting;
      waiting = [];
      for (const go of all) go();
    },
    reading: () => reading,
    loader: createTimelineLoader({
      fetch: (request, abort) => {
        self.requests.push(request);
        self.signals.push(abort);
        active += 1;
        peak = Math.max(peak, active);
        return new Promise<TimelineResponse>((resolve, reject) => {
          const settle = (): void => {
            active -= 1;
            if (abort.aborted) return reject(new DOMException("aborted", "AbortError"));
            Promise.resolve(options.answer ? options.answer(request) : answerOf(fixture, request)).then(resolve, reject);
          };
          if (options.gated) waiting.push(settle);
          else setTimeout(settle, 0);
        });
      },
      cache: () => options.cache ?? null,
      held: () => store,
      merge: (change, source) => {
        store = change(store);
        self.sources.push(source);
      },
      failed: (_request, error) => self.errors.push(error),
      reading: (entities) => {
        reading = entities;
      },
      hint: () => (options.hint === undefined ? fixture.entities.map((entity) => ({ name: entity.name, reports: entity.signals.some((item) => item.name === REPORT_SIGNAL) })) : options.hint),
      now: () => self.now,
    }),
  };
  return self;
}

async function opened(fixture: TimelineFixture, options: Options = {}, scope: CacheScope = ADA, first: Demand = demand()): Promise<Harness> {
  const subject = harness(fixture, options);
  subject.loader.open(scope);
  subject.loader.want(first);
  // An app that waits to be released is released until the first demand is held.
  for (let round = 0; options.gated && round < 50; round += 1) {
    await tick(2);
    if (subject.pending() === 0) break;
    subject.release();
  }
  await subject.loader.idle();
  return subject;
}

/** Long enough for a delayed write of the cache, the owner's hash and an answer of the fake app. */
const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const seriesOf = (requests: readonly TileRequest[]): readonly TileRequest[] => requests.filter((request) => request.parts.includes("signals"));
const overviewOf = (requests: readonly TileRequest[]): readonly TileRequest[] => requests.filter((request) => !request.parts.includes("signals"));
const windowsOf = (requests: readonly TileRequest[]): readonly (readonly [number, number])[] => requests.map((request) => [request.from, request.to]);

afterEach(() => {
  vi.useRealTimers();
});

describe("the overview", () => {
  it("of a small model is one request, and leaves the store with every entity's 30 days", async () => {
    const subject = await opened(SMALL);

    expect(subject.requests).toHaveLength(1);
    expect(subject.requests[0]).toMatchObject({ parts: ["structure", "states", "annotations", "reports"], entities: null });
    expect(subject.store().entities).toHaveLength(SMALL.entities.length);
    for (const entity of SMALL.entities) expect(covers(subject.store().states[entity.name]?.covered ?? [], { from: NOW - RETENTION, to: NOW })).toBe(true);
  });

  it.each([
    { name: "60 entities", count: 60, reports: false },
    { name: "60 entities that all take health reports", count: 60, reports: true },
  ])("of $name comes out complete within what the server reads for one request, where one request for the month does not", async ({ count, reports }) => {
    const fixture = large(count, reports);
    // The server's limit: 400 calls a request, one per entity, part and week (a day for the report signal).
    const budgeted = (request: TileRequest): TimelineResponse => {
      const answer = answerOf(fixture, request);
      const weeks = Math.ceil((Math.min(request.to, NOW) - Math.max(request.from, NOW - 30 * DAY)) / WEEK);
      let calls = 0;
      return {
        ...answer,
        states: answer.states.map((item) => {
          calls += weeks * (reports ? 9 : 2);
          return calls <= 400 ? item : { ...item, transitions: [], complete: false, error: { code: "call_budget", message: "Too many Azure calls for one request: ask for fewer entities.", retryable: true } };
        }),
      };
    };
    const month: TileRequest = { parts: ["states", "annotations", "reports"], entities: null, signals: null, level: 0, from: NOW - 30 * DAY, to: NOW, cells: [], rank: 0 };
    const cut = budgeted(month).states.filter((item) => item.error).length;

    const subject = await opened(fixture, { answer: budgeted });
    const failed = fixture.entities.filter((entity) => subject.store().states[entity.name]?.error !== null).length;
    const complete = fixture.entities.filter((entity) => covers(subject.store().states[entity.name]?.covered ?? [], { from: NOW - RETENTION, to: NOW })).length;

    expect(cut).toBeGreaterThan(0);
    expect([failed, complete]).toEqual([0, count]);
    expect(subject.peak()).toBeLessThanOrEqual(CONCURRENCY);
    console.log(`overview of ${count} entities${reports ? " with health reports" : ""}: one request for the month leaves ${cut} entities unread; tile by tile ${overviewOf(subject.requests).length} requests, all complete`);
  });

  it("reads the week on screen before the older ones", async () => {
    const subject = await opened(large(60));
    const states = subject.requests.filter((request) => request.parts.includes("states"));

    expect(states[0]?.from).toBe(THIS_WEEK);
    expect(states.map((request) => request.from)).toEqual([...states.map((request) => request.from)].sort((a, b) => b - a));
  });
});

describe("series", () => {
  it("of the lanes that show are read once, however often they are asked for", async () => {
    const subject = await opened(SMALL);
    const lanes = demand({ lanes: [FIRST, SECOND] });

    subject.loader.want(lanes);
    subject.loader.want(lanes);
    subject.loader.want({ ...lanes });
    await subject.loader.idle();
    subject.loader.want(lanes);
    await subject.loader.idle();

    expect(seriesOf(subject.requests).map((request) => request.entities)).toEqual([[FIRST, SECOND]]);
    expect(Object.keys(subject.store().series)).toHaveLength(4);
  });

  it("a later demand joins what is in flight and asks only for what is new", async () => {
    const subject = await opened(SMALL, { gated: true });

    subject.loader.want(demand({ lanes: [FIRST] }));
    await tick();
    subject.loader.want(demand({ lanes: [FIRST, SECOND] }));
    await tick();

    expect(seriesOf(subject.requests).map((request) => request.entities)).toEqual([[FIRST], [SECOND]]);
    expect(subject.signals.every((abort) => !abort.aborted)).toBe(true);
    expect(subject.reading()).toEqual([FIRST, SECOND]);
    subject.release();
    await subject.loader.idle();
    expect(subject.reading()).toEqual([]);
  });

  it("only what nobody wants any more is cancelled", async () => {
    const subject = await opened(SMALL, { gated: true });

    subject.loader.want(demand({ lanes: [FIRST] }));
    await tick();
    subject.loader.want(demand({ lanes: [FIRST, SECOND] }));
    await tick();
    subject.loader.want(demand({ lanes: [SECOND] }));
    await tick();
    const aborted = seriesOf(subject.requests).map((request, index) => [request.entities, subject.signals[subject.requests.indexOf(request)]?.aborted, index]);

    expect(aborted.map(([entities, gone]) => [entities, gone])).toEqual([[[FIRST], true], [[SECOND], false]]);
    subject.release();
    await subject.loader.idle();
    expect(seriesOf(subject.requests)).toHaveLength(2);
    expect(subject.store().series[seriesKey(FIRST, "cpu")]).toBeUndefined();
  });

  it("moving back over a window that is held asks nothing, and moving out of it asks only for the gap", async () => {
    const subject = await opened(SMALL, {}, ADA, demand({ lanes: [FIRST] }));
    const before = subject.requests.length;

    for (const view of [{ from: NOW - 6 * HOUR, to: NOW }, { from: NOW - 30 * HOUR, to: NOW - 24 * HOUR }, { from: NOW - DAY, to: NOW }, { from: NOW - HOUR, to: NOW }]) {
      subject.loader.want(demand({ lanes: [FIRST], view }));
      await subject.loader.idle();
    }
    expect(subject.requests).toHaveLength(before);

    subject.loader.want(demand({ lanes: [FIRST], view: { from: NOW - 3 * DAY, to: NOW - 2 * DAY } }));
    await subject.loader.idle();
    subject.loader.want(demand({ lanes: [FIRST] }));
    await subject.loader.idle();

    expect(windowsOf(subject.requests.slice(before))).toEqual([[TODAY - 3 * DAY, TODAY - DAY]]);
  });

  it("a zoom out reads the thinned level, a zoom back in reads nothing, and the thinned points are far fewer", async () => {
    const minutely = topologyFixture([{ name: "api", displayName: "API", parents: [], signals: [signal("cpu")] }], { now: NOW, days: 30, intervalMs: MINUTE });
    const subject = await opened(minutely, {}, ADA, demand({ lanes: ["api"] }));

    subject.loader.want(demand({ lanes: ["api"], view: { from: NOW - RETENTION, to: NOW } }));
    await subject.loader.idle();
    const month = seriesOf(subject.requests).slice(1);
    subject.loader.want(demand({ lanes: ["api"] }));
    await subject.loader.idle();

    const levels = subject.store().series[seriesKey("api", "cpu")] ?? [];
    expect(month.every((request) => request.level === 2)).toBe(true);
    expect(seriesOf(subject.requests)).toHaveLength(1 + month.length);
    expect(levels[2]?.rows.length).toBeLessThan(30 * 24 * 5 + 1);
    expect(levels[2]?.rows.length).toBeLessThan((30 * 24 * 60) / 10);
    expect(covers(coveredAt(levels, 2), { from: NOW - RETENTION, to: NOW })).toBe(true);
  });

  it(`never has more than ${CONCURRENCY} requests in flight, and reads what is on screen before the rest`, async () => {
    const fixture = large(60);
    const subject = harness(fixture, { gated: true });
    subject.loader.open(ADA);
    subject.loader.want(demand({ lanes: ["e1"] }));
    await tick();

    expect(subject.pending()).toBe(CONCURRENCY);
    expect(subject.requests.map((request) => request.rank)).toEqual([0, 1, 1, 1]);
    for (let round = 0; round < 20 && subject.pending() > 0; round += 1) {
      subject.release();
      await tick(5);
    }
    await subject.loader.idle();
    expect(subject.peak()).toBe(CONCURRENCY);
    expect(seriesOf(subject.requests)).toHaveLength(1);
  });

  it("a request that fails marks nothing as held, and is tried again when it is retried", async () => {
    let fail = true;
    const subject = await opened(SMALL, { answer: (request) => (fail && request.parts.includes("signals") ? Promise.reject({ code: "health_model_unavailable", message: "x", retryable: true, operationId: null }) : answerOf(SMALL, request)) });

    subject.loader.want(demand({ lanes: [FIRST] }));
    await subject.loader.idle();
    subject.loader.want(demand({ lanes: [FIRST], view: { from: NOW - 23 * HOUR, to: NOW } }));
    await subject.loader.idle();

    expect(subject.errors.map((error) => error.code)).toEqual(["health_model_unavailable"]);
    expect(seriesOf(subject.requests)).toHaveLength(1);

    fail = false;
    subject.loader.retry();
    await subject.loader.idle();

    expect(seriesOf(subject.requests)).toHaveLength(2);
    expect(subject.store().series[seriesKey(FIRST, "cpu")]?.[0]?.rows.length).toBeGreaterThan(100);
  });
});

describe("refresh", () => {
  it("reads only the tiles that are still open, with the structure", async () => {
    const subject = await opened(SMALL, {}, ADA, demand({ lanes: [FIRST] }));
    const before = subject.requests.length;
    subject.now = NOW + MINUTE;

    subject.loader.refresh();
    await subject.loader.idle();

    const again = subject.requests.slice(before);
    expect(again.map((request) => [request.parts.join(), request.from, request.to])).toEqual([
      ["structure,states,annotations,reports", THIS_WEEK, THIS_WEEK + WEEK],
      ["signals", TODAY, TODAY + DAY],
    ]);
  });
});

describe("clocks", () => {
  it.each([
    { name: "behind the browser's", ahead: 90_000 },
    { name: "ahead of the browser's", ahead: -90_000 },
  ])("an app whose clock is $name does not make what was just read look old: another level over the same window asks nothing", async ({ ahead }) => {
    const subject = harness(SMALL);
    subject.now = NOW + ahead;
    const view = { from: subject.now - DAY, to: subject.now };
    subject.loader.open(ADA);
    subject.loader.want(demand({ lanes: [FIRST], view }));
    await subject.loader.idle();
    const before = subject.requests.length;

    subject.loader.want(demand({ lanes: [FIRST], view, width: 60 }));
    await subject.loader.idle();

    expect(subject.requests.slice(before)).toEqual([]);

    subject.now += MINUTE;
    subject.loader.refresh();
    await subject.loader.idle();
    expect(seriesOf(subject.requests.slice(before)).map((request) => [request.level, request.from])).toEqual([[1, TODAY]]);
  });
});

describe("reading ahead", () => {
  it("reads the window before the one on screen once the view has rested, and not again", async () => {
    vi.useFakeTimers();
    const subject = harness(SMALL);
    subject.loader.open(ADA);
    subject.loader.want(demand({ lanes: [FIRST] }));
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS - 500);
    const before = subject.requests.length;

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS * 3);

    expect(before).toBe(2);
    expect(subject.requests.slice(before).map((request) => [request.rank, request.entities, request.from, request.to])).toEqual([[2, [FIRST], TODAY - 2 * DAY, TODAY - DAY]]);
  });

  it("a view that moves on cancels what was read ahead for the old one", async () => {
    vi.useFakeTimers();
    const subject = harness(SMALL, { gated: true });
    subject.loader.open(ADA);
    subject.loader.want(demand({ lanes: [FIRST] }));
    for (let round = 0; round < 4; round += 1) {
      await vi.advanceTimersByTimeAsync(10);
      subject.release();
    }
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS + 100);
    expect(subject.requests.at(-1)?.rank).toBe(2);

    subject.loader.want(demand({ lanes: [SECOND] }));
    await vi.advanceTimersByTimeAsync(10);

    expect(subject.signals.at(-2)?.aborted).toBe(true);
    expect(subject.requests.at(-1)).toMatchObject({ rank: 0, entities: [SECOND] });
  });
});

describe("the browser's cache", () => {
  const cached = (storage: TileStorage): TileCache => createTileCache(storage, { delayMs: 0, now: () => NOW });

  it("after a reload paints from what was kept, and asks the app only for the tiles that were still open", async () => {
    const storage = memoryStorage();
    const first = await opened(SMALL, { cache: cached(storage) }, ADA, demand({ lanes: [FIRST] }));
    await tick();

    const again = harness(SMALL, { cache: cached(storage), hint: null });
    again.now = NOW + 5 * MINUTE;
    again.loader.open(ADA);
    again.loader.want(demand({ lanes: [FIRST], view: { from: again.now - DAY, to: again.now } }));
    await again.loader.idle();

    expect(first.requests).toHaveLength(2);
    expect(again.sources.indexOf("cache")).toBe(0);
    expect(again.sources.indexOf("network")).toBeGreaterThan(again.sources.lastIndexOf("cache"));
    expect(again.requests.map((request) => [request.parts.join(), request.from, request.to])).toEqual([
      ["structure,states,annotations,reports", THIS_WEEK, THIS_WEEK + WEEK],
      ["signals", TODAY, TODAY + DAY],
    ]);
    expect(again.store().states[FIRST]).toEqual(first.store().states[FIRST]);
    expect(again.store().series[seriesKey(FIRST, "cpu")]?.[0]?.rows).toEqual(first.store().series[seriesKey(FIRST, "cpu")]?.[0]?.rows);
  });

  it("holds what the app answered before the cache was asked, so nothing is read from the app that the browser kept", async () => {
    const storage = memoryStorage();
    await opened(SMALL, { cache: cached(storage) }, ADA, demand({ lanes: [FIRST, SECOND], view: { from: NOW - 3 * DAY, to: NOW } }));
    await tick();

    const again = await opened(SMALL, { cache: cached(storage), hint: null }, ADA, demand({ lanes: [FIRST, SECOND], view: { from: NOW - 3 * DAY, to: NOW } }));

    expect(seriesOf(again.requests).map((request) => [request.from, request.to])).toEqual([[TODAY, TODAY + DAY]]);
  });

  it("is one user's: another user of the same browser starts with nothing and reads everything from the app", async () => {
    const storage = memoryStorage();
    const ada = await opened(SMALL, { cache: cached(storage) }, ADA, demand({ lanes: [FIRST] }));
    await tick();

    const bob = await opened(SMALL, { cache: cached(storage), hint: null }, BOB, demand({ lanes: [FIRST] }));

    expect(bob.sources).not.toContain("cache");
    expect(ada.requests).toHaveLength(2);
    expect(windowsOf(bob.requests)).toEqual([
      [THIS_WEEK, THIS_WEEK + WEEK],
      [TODAY - DAY, TODAY + DAY],
      [tileOf(NOW - RETENTION, WEEK) * WEEK, THIS_WEEK],
    ]);
    expect([...storage.items.keys()].some((key) => key.includes("ada") || key.includes("bob") || key.includes("tenant"))).toBe(false);
  });

  it.each([
    { name: "the structure", slow: 0 },
    { name: "the tiles", slow: 1 },
  ])("a read of $name that lands after the timeline closed asks the app for nothing, and the next view does", async ({ slow }) => {
    const inner = memoryStorage();
    const waiting: (() => void)[] = [];
    let calls = 0;
    const storage: TileStorage = {
      ...inner,
      get: (ids) => {
        calls += 1;
        return calls - 1 === slow ? new Promise((resolve) => waiting.push(() => resolve(inner.get(ids)))) : inner.get(ids);
      },
    };
    const subject = harness(SMALL, { cache: cached(storage) });
    subject.loader.open(ADA);
    subject.loader.want(demand());
    await tick();
    expect(waiting).toHaveLength(1);

    subject.loader.stop();
    for (const go of waiting) go();
    await subject.loader.idle();
    await tick();
    expect(subject.requests).toEqual([]);

    subject.loader.want(demand());
    await subject.loader.idle();
    expect(subject.requests.length).toBeGreaterThan(0);
  });

  it("another model, or no model, gets nothing of it and cancels what was in flight", async () => {
    const subject = await opened(SMALL, { gated: true });
    subject.loader.want(demand({ lanes: [FIRST] }));
    await tick();

    subject.loader.open(null);
    subject.release();
    await subject.loader.idle();

    expect(subject.signals.at(-1)?.aborted).toBe(true);
    expect(subject.store().series).toEqual({});
  });
});

describe("a selected moment", () => {
  it.each([
    { name: "six days ago, after the overview was read", days: 6, cold: false },
    { name: "six days ago, at once after opening", days: 6, cold: true },
    { name: "eight days ago, in the week before, at once after opening", days: 8, cold: true },
  ])("$name in a model of 60 entities", async ({ days, cold }) => {
    const fixture = large(60);
    const moment = NOW - days * DAY;
    const subject = cold ? harness(fixture, { gated: true }) : await opened(fixture);
    if (cold) subject.loader.open(ADA);
    const before = subject.requests.length;

    subject.loader.want(demand({ moment, watched: ["e1", "e2", "e3"] }));
    for (let round = 0; round < 30; round += 1) {
      await tick(2);
      subject.release();
    }
    await subject.loader.idle();
    const asked = subject.requests.slice(before);
    const known = (): boolean => fixture.entities.every((entity) => covers(subject.store().states[entity.name]?.covered ?? [], { from: moment, to: NOW }));
    const urgent = asked.filter((request) => request.rank === 0);

    expect(known()).toBe(true);
    expect(seriesOf(asked).map((request) => [request.entities, request.level, request.from])).toEqual([[["e1", "e2", "e3"], 0, tileOf(moment, DAY) * DAY]]);
    expect(urgent.length).toBe(cold ? (days === 8 ? 3 : 2) : 1);
    console.log(`select a moment ${days} days ago in a 60-entity model${cold ? " at once after opening" : ""}: ${urgent.length} requests for the moment (${overviewOf(urgent).length} overview, ${seriesOf(urgent).length} series), ${asked.length} in all`);
  });
});

describe("a scripted session", () => {
  it("open, open three entities, zoom in, pan, zoom out, back, the whole history, reload", async () => {
    const storage = memoryStorage();
    const cache = createTileCache(storage, { delayMs: 0, now: () => NOW });
    const subject = await opened(SMALL, { cache });
    const steps: [string, number, number][] = [];
    const mark = (step: string): void => void steps.push([step, overviewOf(subject.requests).length, seriesOf(subject.requests).length]);
    const show = async (parts: Partial<Demand>): Promise<void> => {
      subject.loader.want(demand(parts));
      await subject.loader.idle();
    };
    mark("open");
    await show({ lanes: [FIRST, SECOND, THIRD] });
    mark("open three entities");
    await show({ lanes: [FIRST, SECOND, THIRD], view: { from: NOW - 6 * HOUR, to: NOW } });
    mark("zoom in");
    await show({ lanes: [FIRST, SECOND, THIRD], view: { from: NOW - 9 * HOUR, to: NOW - 3 * HOUR } });
    mark("pan");
    await show({ lanes: [FIRST, SECOND, THIRD], view: { from: NOW - 7 * DAY, to: NOW } });
    mark("zoom out");
    await show({ lanes: [FIRST, SECOND, THIRD] });
    mark("back to the first window");
    await show({ lanes: [FIRST, SECOND, THIRD], view: { from: NOW - RETENTION, to: NOW } });
    mark("the whole history");
    await tick();

    const again = await opened(SMALL, { cache, hint: null }, ADA, demand({ lanes: [FIRST, SECOND, THIRD], view: { from: NOW - 7 * DAY, to: NOW } }));

    expect(steps).toEqual([
      ["open", 1, 0],
      ["open three entities", 1, 1],
      ["zoom in", 1, 1],
      ["pan", 1, 1],
      ["zoom out", 1, 2],
      ["back to the first window", 1, 2],
      ["the whole history", 1, 4],
    ]);
    expect([overviewOf(again.requests).length, seriesOf(again.requests).length]).toEqual([1, 1]);
    expect(again.requests.every((request) => request.to > NOW)).toBe(true);
    expect(new Set(subject.requests.flatMap((request) => request.cells)).size).toBe(subject.requests.flatMap((request) => request.cells).length);
    expect(subject.requests.flatMap((request) => request.cells).map(parseCell).every((cell) => cell.kind !== "s" || LANES.includes(cell.entity))).toBe(true);
  });
});
