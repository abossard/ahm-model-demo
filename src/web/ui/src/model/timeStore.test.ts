import { describe, expect, it } from "vitest";
import { EMPTY_TIMELINE, seriesKey, type EntityInfo, type Point, type SignalInfo, type TimelineResponse } from "./timeline";
import { DAY, HOUR, MINUTE } from "./timelineScale";
import { LEVELS, WEEK } from "./timelineTiles";
import {
  EMPTY_STORE,
  clearErrors,
  coveredAt,
  covers,
  levelToShow,
  markFailed,
  mergeAnswer,
  mergeKept,
  seriesAtLevel,
  tilesOfAnswer,
  toTimelineData,
  type Asked,
  type KeptTile,
  type TimeStore,
} from "./timeStore";

const SIGNAL: SignalInfo = { name: "cpu", displayName: "CPU", kind: null, unit: null, refreshInterval: "PT1M", rules: { degraded: null, unhealthy: null, dynamic: false } };
const API: EntityInfo = { name: "api", displayName: "API", parents: [], state: 1, signals: [SIGNAL] };
const DB: EntityInfo = { name: "db", displayName: "Database", parents: ["api"], state: 1, signals: [] };
const KEY = seriesKey("api", "cpu");
const OVERVIEW: Asked = { parts: ["structure", "states", "annotations", "reports"], entities: null, signals: null, level: 0 };
const SERIES: Asked = { parts: ["signals"], entities: ["api"], signals: null, level: 0 };
const SIZES = { overview: WEEK, series: (level: number): number => (LEVELS[level] as { tile: number }).tile };

function response(parts: Partial<TimelineResponse>, from = 1000, to = 5000): TimelineResponse {
  return {
    model: "m",
    observedAt: new Date(to).toISOString(),
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    retentionDays: 30,
    resolution: 0,
    partial: false,
    entities: [],
    states: [],
    series: [],
    annotations: [],
    reports: [],
    failures: [],
    ...parts,
  };
}

const point = (t: number, v: number | null = 1): Point => [t, v, 1];
const quiet = (entity: string) => ({ entity, transitions: [], complete: true, earliest: null });
const overview = (parts: Partial<TimelineResponse> = {}, from = 1000, to = 5000): TimelineResponse => response({ entities: [API, DB], states: [quiet("api"), quiet("db")], ...parts }, from, to);
const held = (): TimeStore => mergeAnswer(EMPTY_STORE, overview(), OVERVIEW);

describe("mergeAnswer", () => {
  it("holds the entities once and every history by what it is", () => {
    const store = mergeAnswer(
      EMPTY_STORE,
      overview({
        states: [{ entity: "api", transitions: [{ t: 2000, from: 1, to: 2, reason: null }], complete: true, earliest: null }, quiet("db")],
        annotations: [{ entity: "db", id: "a", t: 3000, description: "x", details: {} }],
        reports: [{ entity: "api", t: 2500, state: 2, value: 1, reason: "r", reportId: "r1" }],
      }),
      OVERVIEW,
    );

    expect(store.entities).toEqual([API, DB]);
    expect(store.states.api).toEqual({ rows: [{ t: 2000, from: 1, to: 2, reason: null }], covered: [{ from: 1000, to: 5000 }], error: null });
    expect(store.annotations.db?.rows).toHaveLength(1);
    expect(store.reports.api?.rows).toHaveLength(1);
    expect([store.now, store.floor]).toEqual([5000, 1000]);
  });

  it("a quiet history is held for the window that was read, though it has no row", () => {
    const store = held();

    expect(store.states.db).toEqual({ rows: [], covered: [{ from: 1000, to: 5000 }], error: null });
    expect(store.annotations.api?.covered).toEqual([{ from: 1000, to: 5000 }]);
    expect(store.reports.db?.covered).toEqual([{ from: 1000, to: 5000 }]);
  });

  it("a series is held at the level of the answer, apart from the other levels", () => {
    const raw = mergeAnswer(held(), response({ series: [{ entity: "api", signal: "cpu", points: [point(2000)], complete: true, earliest: null }] }), SERIES);
    const both = mergeAnswer(raw, response({ resolution: 3600, series: [{ entity: "api", signal: "cpu", points: [point(1500)], complete: true, earliest: null }] }, 0, 9000), { ...SERIES, level: 2 });

    expect(both.series[KEY]?.[0]?.rows).toEqual([point(2000)]);
    expect(both.series[KEY]?.[1]).toBeNull();
    expect(both.series[KEY]?.[2]).toEqual({ rows: [point(1500)], covered: [{ from: 0, to: 9000 }], error: null });
  });

  it("a series the service cut covers only from its oldest point, and a second read fills the rest", () => {
    const cut = mergeAnswer(held(), response({ series: [{ entity: "api", signal: "cpu", points: [point(3000), point(4000)], complete: false, earliest: 3000 }] }), SERIES);

    expect(cut.series[KEY]?.[0]?.covered).toEqual([{ from: 3000, to: 5000 }]);

    const filled = mergeAnswer(cut, response({ series: [{ entity: "api", signal: "cpu", points: [point(1500), point(2500), point(3000)], complete: true, earliest: null }] }, 1000, 3000), SERIES);

    expect(filled.series[KEY]?.[0]?.rows.map((p) => p[0])).toEqual([1500, 2500, 3000, 4000]);
    expect(filled.series[KEY]?.[0]?.covered).toEqual([{ from: 1000, to: 5000 }]);
  });

  it("a failed series keeps its points, records the error and covers nothing new", () => {
    const first = mergeAnswer(held(), response({ series: [{ entity: "api", signal: "cpu", points: [point(2000)], complete: true, earliest: null }] }), SERIES);
    const error = { code: "unavailable", message: "x", retryable: true };

    const failed = mergeAnswer(first, response({ series: [{ entity: "api", signal: "cpu", points: [], complete: false, earliest: null, error }] }, 5000, 9000), SERIES);

    expect(failed.series[KEY]?.[0]).toEqual({ rows: [point(2000)], covered: [{ from: 1000, to: 5000 }], error });
  });

  it.each([
    { name: "a series that was asked for and not answered", asked: SERIES, answer: response({ series: [] }), key: KEY, code: "not_found" },
    { name: "a series another signal filter left out", asked: { ...SERIES, signals: ["memory"] }, answer: response({ series: [] }), key: KEY, code: undefined },
  ])("$name: $code", ({ asked, answer, key, code }) => {
    expect(mergeAnswer(held(), answer, asked).series[key]?.[0]?.error?.code).toBe(code);
  });

  it("the structure of a whole answer replaces the list, and of a part of the model only what it names", () => {
    const renamed = { ...API, displayName: "Orders API" };

    const whole = mergeAnswer(held(), overview({ entities: [renamed] , states: [quiet("api")] }), OVERVIEW);
    const part = mergeAnswer(held(), overview({ entities: [renamed], states: [quiet("api")] }), { ...OVERVIEW, entities: ["api"] });

    expect(whole.entities).toEqual([renamed]);
    expect(part.entities).toEqual([renamed, DB]);
  });

  it("the annotations of an entity that failed are marked, and the others are held", () => {
    const error = { code: "busy", message: "x", retryable: true };

    const store = mergeAnswer(EMPTY_STORE, overview({ failures: [{ entity: "db", part: "annotations", error }] }), OVERVIEW);

    expect(store.annotations.db?.error).toEqual(error);
    expect(store.annotations.api?.covered).toHaveLength(1);
    expect(store.reports.db?.error).toBeNull();
  });
});

describe("coverage", () => {
  it.each([
    { name: "all of it", covered: [{ from: 0, to: 10 }], want: { from: 2, to: 8 }, expected: true },
    { name: "an empty want", covered: [], want: { from: 5, to: 5 }, expected: true },
    { name: "a hole", covered: [{ from: 0, to: 4 }, { from: 6, to: 10 }], want: { from: 2, to: 8 }, expected: false },
    { name: "nothing", covered: [], want: { from: 2, to: 8 }, expected: false },
  ])("$name is covered: $expected", ({ covered, want, expected }) => {
    expect(covers(covered, want)).toBe(expected);
  });

  it("finer points count for a coarser level, coarser ones never for a finer", () => {
    const levels = [{ rows: [], covered: [{ from: 0, to: 10 }], error: null }, null, { rows: [], covered: [{ from: 10, to: 30 }], error: null }];

    expect(coveredAt(levels, 0)).toEqual([{ from: 0, to: 10 }]);
    expect(coveredAt(levels, 1)).toEqual([{ from: 0, to: 10 }]);
    expect(coveredAt(levels, 2)).toEqual([{ from: 0, to: 30 }]);
    expect(coveredAt(undefined, 2)).toEqual([]);
  });
});

describe("the tiles of an answer", () => {
  const day = (index: number): number => index * DAY;
  const dense = [point(day(1) + 10), point(day(1) + 20), point(day(2) + 5)];

  it("are one per history and tile, cut to what the answer read", () => {
    const answer = response({ series: [{ entity: "api", signal: "cpu", points: dense, complete: true, earliest: null }] }, day(1), day(2) + 100);

    const tiles = tilesOfAnswer(answer, SERIES, SIZES);

    expect(tiles).toEqual([
      { kind: "series", entity: "api", signal: "cpu", level: 0, span: { from: day(1), to: day(2) }, rows: [dense[0], dense[1]] },
      { kind: "series", entity: "api", signal: "cpu", level: 0, span: { from: day(2), to: day(2) + 100 }, rows: [dense[2]] },
    ]);
  });

  it.each([
    { name: "a failed series", series: { entity: "api", signal: "cpu", points: [], complete: false, earliest: null, error: { code: "busy", message: "x", retryable: true } } },
    { name: "a series that was cut", series: { entity: "api", signal: "cpu", points: dense, complete: false, earliest: day(1) + 10 } },
  ])("$name is not kept", ({ series }) => {
    expect(tilesOfAnswer(response({ series: [series] }, day(1), day(2)), SERIES, SIZES)).toEqual([]);
  });

  it("the overview gives the states, annotations and reports of every entity, also the quiet ones", () => {
    const answer = overview({ annotations: [{ entity: "db", id: "a", t: 3000, description: "x", details: {} }] });

    const tiles = tilesOfAnswer(answer, OVERVIEW, SIZES);

    expect(tiles.map((tile) => `${tile.kind} ${tile.entity} ${tile.rows.length}`)).toEqual(["states api 0", "states db 0", "annotations api 0", "annotations db 1", "reports api 0", "reports db 0"]);
  });

  it("kept tiles give back what the answer gave", () => {
    const answer = response({ series: [{ entity: "api", signal: "cpu", points: dense, complete: true, earliest: null }] }, day(1), day(3));
    const direct = mergeAnswer(held(), answer, SERIES);

    const kept = mergeKept(held(), tilesOfAnswer(answer, SERIES, SIZES));

    expect(kept.series[KEY]).toEqual(direct.series[KEY]);
    expect(mergeKept(kept, [])).toBe(kept);
  });

  it.each([
    { name: "the earlier tile first", merge: (tiles: readonly KeptTile[]) => mergeKept(held(), tiles) },
    { name: "the later tile first", merge: (tiles: readonly KeptTile[]) => mergeKept(held(), [...tiles].reverse()) },
    { name: "the earlier tile over the answer", merge: (tiles: readonly KeptTile[], answer: TimelineResponse) => mergeKept(mergeAnswer(held(), answer, SERIES), tiles.slice(0, 1)) },
    { name: "the later tile over the answer", merge: (tiles: readonly KeptTile[], answer: TimelineResponse) => mergeKept(mergeAnswer(held(), answer, SERIES), tiles.slice(1)) },
  ])("a row on the boundary of two tiles is held once, whatever is merged first: $name", ({ merge }) => {
    const rows = [point(day(1) + 10), point(day(2)), point(day(2) + 5)];
    const answer = response({ series: [{ entity: "api", signal: "cpu", points: rows, complete: true, earliest: null }] }, day(1), day(3));
    const tiles = tilesOfAnswer(answer, SERIES, SIZES);

    expect(tiles.map((tile) => tile.rows)).toEqual([[rows[0]], [rows[1], rows[2]]]);
    expect(merge(tiles, answer).series[KEY]?.[0]?.rows).toEqual(rows);
  });
});

describe("what the plot reads", () => {
  const minute = (index: number, value = index % 50): Point => [index * MINUTE, value, 1];
  const rawDay = Array.from({ length: 24 * 60 }, (_unused, index) => minute(index));
  const withRaw = (): TimeStore => mergeAnswer(held(), response({ series: [{ entity: "api", signal: "cpu", points: rawDay, complete: true, earliest: null }] }, 0, DAY), SERIES);
  const coarse = [point(DAY + 10 * MINUTE, 7), point(DAY + 40 * MINUTE, 9)];
  const withBoth = (): TimeStore => mergeAnswer(withRaw(), response({ resolution: 3600, series: [{ entity: "api", signal: "cpu", points: coarse, complete: true, earliest: null }] }, DAY, 2 * DAY), { ...SERIES, level: 2 });

  it("a series held at one level is that level's points, as they are", () => {
    const store = withRaw();

    expect(seriesAtLevel(store.series[KEY] ?? [], 0).points).toBe(store.series[KEY]?.[0]?.rows);
  });

  it("finer points are thinned to the level that is drawn, so the whole series is evenly dense", () => {
    const levels = withBoth().series[KEY] ?? [];

    const drawn = seriesAtLevel(levels, 2);

    expect(drawn.covered).toEqual([{ from: 0, to: 2 * DAY }]);
    expect(drawn.points.length).toBeLessThanOrEqual(24 * 5 + coarse.length);
    expect(drawn.points.length).toBeGreaterThan(24 * 2);
    expect(drawn.points.slice(-2)).toEqual(coarse);
    expect(drawn.points.every((row, index, rows) => index === 0 || row[0] >= (rows[index - 1] as Point)[0])).toBe(true);
    expect(seriesAtLevel(levels, 2)).toBe(drawn);
  });

  it.each([
    { name: "the level asked for when it holds the window", level: 0, window: { from: HOUR, to: 5 * HOUR }, shown: 0 },
    { name: "a coarser level that holds the window while the finer one does not", level: 0, window: { from: DAY + HOUR, to: DAY + 5 * HOUR }, shown: 2 },
    { name: "the level asked for when finer points hold the window", level: 1, window: { from: HOUR, to: 5 * HOUR }, shown: 1 },
    { name: "the level asked for when nothing holds the whole window but it has some of it", level: 1, window: { from: -DAY, to: DAY }, shown: 1 },
    { name: "the level asked for when no level holds the window", level: 0, window: { from: 5 * DAY, to: 6 * DAY }, shown: 0 },
  ])("draws $name", ({ level, window, shown }) => {
    expect(levelToShow(withBoth().series[KEY] ?? [], level, window)).toBe(shown);
  });

  it("gives the same objects back while nothing changed, and new ones only for what did", () => {
    const store = withRaw();
    const shown = { level: 0, window: { from: 0, to: DAY } };

    const first = toTimelineData(store, shown, EMPTY_TIMELINE);
    const again = toTimelineData(store, shown, first);
    const more = mergeAnswer(store, response({ states: [{ entity: "db", transitions: [{ t: 2000, from: 1, to: 3, reason: null }], complete: true, earliest: null }] }), { ...OVERVIEW, parts: ["states"], entities: ["db"] });
    const next = toTimelineData(more, shown, first);

    expect(again).toBe(first);
    expect(next).not.toBe(first);
    expect(next.series).toBe(first.series);
    expect(next.states.api).toBe(first.states.api);
    expect(next.states.db).not.toBe(first.states.db);
    expect(next.annotations).toBe(first.annotations);
    expect(first.series[KEY]?.points).toBe(store.series[KEY]?.[0]?.rows);
  });

  it("lists the annotations and reports of every entity in time order", () => {
    const store = mergeAnswer(
      EMPTY_STORE,
      overview({ annotations: [{ entity: "db", id: "b", t: 4000, description: null, details: {} }, { entity: "api", id: "a", t: 2000, description: null, details: {} }] }),
      OVERVIEW,
    );

    expect(toTimelineData(store, { level: 0, window: null }, EMPTY_TIMELINE).annotations.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("errors", () => {
  const busy = { code: "busy", message: "x", retryable: true };
  const refused = { code: "forbidden", message: "x", retryable: false };
  const failing = (): TimeStore =>
    mergeAnswer(
      mergeAnswer(EMPTY_STORE, overview({ states: [{ entity: "api", transitions: [], complete: false, earliest: null, error: refused }, { entity: "db", transitions: [], complete: false, earliest: null, error: busy }] }), OVERVIEW),
      response({ series: [{ entity: "api", signal: "cpu", points: [], complete: false, earliest: null, error: busy }] }),
      SERIES,
    );

  it.each([
    { name: "every error", names: null, passing: false, left: [null, null, null] },
    { name: "the errors of one entity", names: ["db"], passing: false, left: ["forbidden", null, "busy"] },
    { name: "only the errors that may pass", names: null, passing: true, left: ["forbidden", null, null] },
  ])("clears $name", ({ names, passing, left }) => {
    const store = clearErrors(failing(), names, passing);

    expect([store.states.api?.error?.code ?? null, store.states.db?.error?.code ?? null, store.series[KEY]?.[0]?.error?.code ?? null]).toEqual(left);
  });

  it("clearing nothing gives the same store", () => {
    const store = held();

    expect(clearErrors(store, null)).toBe(store);
  });

  it("a request for series that failed as a whole names every series it asked for, at the level it asked", () => {
    const store = markFailed(held(), { ...SERIES, level: 1 }, busy);

    expect(store.series[KEY]?.[1]?.error).toEqual(busy);
    expect(markFailed(held(), OVERVIEW, busy)).toEqual(held());
  });
});

describe("the structure", () => {
  it("read again keeps every entity, signal and rule object that says the same, and replaces only what changed", () => {
    const store = held();
    const copy = (entity: EntityInfo): EntityInfo => JSON.parse(JSON.stringify(entity)) as EntityInfo;

    const same = mergeAnswer(store, overview({ entities: [copy(API), copy(DB)] }), OVERVIEW);
    const changed = mergeAnswer(store, overview({ entities: [{ ...copy(API), state: 3 }, { ...copy(DB), displayName: "Orders database" }] }), OVERVIEW);

    expect(same.entities).toBe(store.entities);
    expect(changed.entities[0]).not.toBe(store.entities[0]);
    expect(changed.entities[0]?.signals).toBe(store.entities[0]?.signals);
    expect(changed.entities[0]?.signals[0]?.rules).toBe(store.entities[0]?.signals[0]?.rules);
    expect(changed.entities[1]?.displayName).toBe("Orders database");
  });
});
