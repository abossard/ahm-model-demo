import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityInfo, Point } from "../model/timeline";
import { overviewCell, seriesCell } from "../model/timelinePlan";
import { DAY, MINUTE } from "../model/timelineScale";
import { CLOSE_SAFETY, WEEK } from "../model/timelineTiles";
import type { KeptTile } from "../model/timeStore";
import { CACHE_SCHEMA, OPEN_TIMEOUT_MS, createTileCache, evictions, idsOfCell, indexedDbStorage, keepable, memoryStorage, tileBytes, tileId, type CacheScope } from "./tileCache";

const ADA: CacheScope = { owner: "tenant-a/ada@example.test", model: "sub/rg/hm" };
const BOB: CacheScope = { owner: "tenant-a/bob@example.test", model: "sub/rg/hm" };
const ADA_ELSEWHERE: CacheScope = { owner: "tenant-b/ada@example.test", model: "sub/rg/hm" };
const OTHER_MODEL: CacheScope = { owner: "tenant-a/ada@example.test", model: "sub/rg/other" };

const points = (count: number, from = 3 * DAY): Point[] => Array.from({ length: count }, (_unused, index) => [from + index * MINUTE, index, 1]);
const seriesTile = (day: number, rows: readonly Point[] = points(3, day * DAY), entity = "api"): KeptTile => ({ kind: "series", entity, signal: "cpu", level: 0, span: { from: day * DAY, to: (day + 1) * DAY }, rows });
const CLOSED_AT = 30 * DAY;

/** Long enough for the owner's hash and the delayed write to have happened. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
const QUICK = { delayMs: 0 };

describe("keys", () => {
  it("a tile is kept under its scope, what it is and the tile it is of", () => {
    const tile = seriesTile(3);

    expect(tileId("p", tile)).toBe(["p", "series", "api", "cpu", 0, 3].join("\u0001"));
    expect(idsOfCell("p", seriesCell("api", "cpu", 0, 3))).toEqual([tileId("p", tile)]);
  });

  it("the overview of an entity is its states, annotations and reports of that week, and a cell for nobody in particular is none", () => {
    expect(idsOfCell("p", overviewCell("api", 7))).toEqual(["states", "annotations", "reports"].map((kind) => ["p", kind, "api", "", 0, 7].join("\u0001")));
    expect(idsOfCell("p", overviewCell("*", 7))).toEqual([]);
    expect(tileId("p", { kind: "states", entity: "api", signal: null, level: 0, span: { from: 7 * WEEK + 5 } })).toBe(["p", "states", "api", "", 0, 7].join("\u0001"));
  });
});

describe("keepable", () => {
  const tile = seriesTile(3, points(60, 3 * DAY + 23 * 60 * MINUTE));

  it.each([
    { name: "long after it closed is kept whole", observedAt: 5 * DAY, to: 4 * DAY, rows: 60 },
    { name: "just after the safety margin is kept whole", observedAt: 4 * DAY + CLOSE_SAFETY, to: 4 * DAY, rows: 60 },
    { name: "inside the safety margin is kept up to the margin before the read", observedAt: 4 * DAY + 5 * MINUTE, to: 4 * DAY - 10 * MINUTE, rows: 51 },
    { name: "while it was open is kept up to the margin before the read", observedAt: 3 * DAY + 23.5 * 60 * MINUTE, to: 3 * DAY + 23.25 * 60 * MINUTE, rows: 16 },
  ])("a tile read $name", ({ observedAt, to, rows }) => {
    const kept = keepable(tile, observedAt);

    expect(kept?.span).toEqual({ from: 3 * DAY, to });
    expect(kept?.rows).toHaveLength(rows);
  });

  it("a tile that began less than the margin before the read is not kept", () => {
    expect(keepable(tile, 3 * DAY + 5 * MINUTE)).toBeNull();
  });
});

describe("evictions", () => {
  const usage = [
    { id: "old", usedAt: 1, bytes: 40 },
    { id: "new", usedAt: 3, bytes: 40 },
    { id: "mid", usedAt: 2, bytes: 40 },
  ];

  it.each([
    { name: "nothing under the bound", bound: 120, drop: [] },
    { name: "the least recently used first", bound: 100, drop: ["old"] },
    { name: "as many as it takes to be a tenth under the bound", bound: 50, drop: ["old", "mid"] },
    { name: "everything when nothing fits", bound: 10, drop: ["old", "mid", "new"] },
  ])("drops $name", ({ bound, drop }) => {
    expect(evictions(usage, bound)).toEqual(drop);
  });

  it("a tile's size grows with its rows", () => {
    expect(tileBytes(seriesTile(3, points(1000)))).toBeGreaterThan(tileBytes(seriesTile(3, points(10))) * 10);
  });
});

describe("the cache", () => {
  const cell = seriesCell("api", "cpu", 0, 3);

  it("gives back what was kept, also before it reached the storage", async () => {
    const cache = createTileCache(memoryStorage(), { delayMs: 60_000 });
    cache.write(ADA, [seriesTile(3)], CLOSED_AT);
    await settle();

    expect(await cache.read(ADA, [cell])).toEqual([seriesTile(3)]);
    expect(await cache.read(ADA, [cell, seriesCell("api", "cpu", 0, 4)])).toEqual([seriesTile(3)]);
  });

  it.each([
    { name: "another user", scope: BOB },
    { name: "the same user in another directory", scope: ADA_ELSEWHERE },
    { name: "another model", scope: OTHER_MODEL },
  ])("$name never reads it", async ({ scope }) => {
    const storage = memoryStorage();
    const cache = createTileCache(storage, QUICK);
    cache.write(ADA, [seriesTile(3)], CLOSED_AT);
    cache.writeStructure(ADA, [{ name: "api", displayName: "API", parents: [], state: 1, signals: [] }]);
    await settle();

    expect(await cache.read(scope, [cell])).toEqual([]);
    expect(await cache.readStructure(scope)).toBeNull();
    expect(await cache.read(ADA, [cell])).toHaveLength(1);
  });

  it("writes neither the user nor the directory into a key", async () => {
    const storage = memoryStorage();
    const cache = createTileCache(storage, QUICK);
    cache.write(ADA, [seriesTile(3)], CLOSED_AT);
    await settle();

    const keys = [...storage.items.keys()].join(" ");
    expect(keys).not.toContain("ada");
    expect(keys).not.toContain("tenant-a");
    expect(keys).toContain("sub/rg/hm");
  });

  it("keeps the structure of a model", async () => {
    const entities: readonly EntityInfo[] = [{ name: "api", displayName: "API", parents: [], state: 1, signals: [] }];
    const cache = createTileCache(memoryStorage(), QUICK);
    cache.writeStructure(ADA, entities);
    await settle();

    expect(await cache.readStructure(ADA)).toEqual(entities);
  });

  it("an entry of another schema is not read", async () => {
    const storage = memoryStorage();
    const cache = createTileCache(storage, QUICK);
    cache.write(ADA, [seriesTile(3)], CLOSED_AT);
    await settle();
    for (const [id, entry] of storage.items) storage.items.set(id, { ...entry, schema: CACHE_SCHEMA - 1 });

    expect(await cache.read(ADA, [cell])).toEqual([]);
  });

  it("stays under its size: the tiles used least recently go, the ones just read stay", async () => {
    const storage = memoryStorage();
    let clock = 1000;
    const cache = createTileCache(storage, { ...QUICK, now: () => clock, maxBytes: 3 * tileBytes(seriesTile(1, points(100))) + 10 });
    for (const day of [1, 2, 3]) {
      clock += 1000;
      cache.write(ADA, [seriesTile(day, points(100, day * DAY))], CLOSED_AT);
      await settle();
    }
    clock += 2 * 3600 * 1000;
    await cache.read(ADA, [seriesCell("api", "cpu", 0, 1)]);
    await settle();

    clock += 1000;
    cache.write(ADA, [seriesTile(4, points(100, 4 * DAY))], CLOSED_AT);
    await settle();

    const days = async (): Promise<number[]> => (await cache.read(ADA, [1, 2, 3, 4].map((day) => seriesCell("api", "cpu", 0, day)))).map((tile) => tile.span.from / DAY);
    expect(await days()).toEqual([1, 4]);
  });

  it("a storage that fails is a cache that holds nothing", async () => {
    const broken = { get: () => Promise.reject(new Error("no")), put: () => Promise.reject(new Error("no")), remove: () => Promise.reject(new Error("no")), usage: () => Promise.reject(new Error("no")) };
    const cache = createTileCache(broken, QUICK);
    cache.write(ADA, [seriesTile(3)], CLOSED_AT);
    await settle();

    expect(await cache.read(ADA, [cell])).toEqual([]);
    expect(await cache.readStructure(ADA)).toBeNull();
  });
});

describe("the browser's database", () => {
  type Handler = (() => void) | null;
  interface Opening {
    onupgradeneeded: Handler;
    onblocked: Handler;
    onsuccess: Handler;
    onerror: Handler;
    result: unknown;
    error: unknown;
  }
  let openings: Opening[];
  const database = () => ({
    close: vi.fn(),
    onversionchange: null as Handler,
    transaction: () => {
      throw new Error("no store in a test");
    },
  });
  const opened = (at: number, db: ReturnType<typeof database>): void => {
    const opening = openings[at] as Opening;
    opening.result = db;
    opening.onsuccess?.();
  };

  beforeEach(() => {
    openings = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("indexedDB", {
      open: () => {
        const opening: Opening = { onupgradeneeded: null, onblocked: null, onsuccess: null, onerror: null, result: null, error: null };
        openings.push(opening);
        return opening;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    { name: "a tab of an older build holds it at its schema", stall: async (opening: Opening) => opening.onblocked?.() },
    { name: "it does not answer", stall: async () => void (await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS)) },
  ])("the timeline goes on without it when $name, and lets go of it should it open later", async ({ stall }) => {
    const storage = indexedDbStorage()!;
    const reading = expect(storage.get(["id"])).rejects.toThrow();

    await stall(openings[0] as Opening);
    await reading;
    expect(await createTileCache(storage).readStructure(ADA)).toBeNull();

    const late = database();
    opened(0, late);
    expect(late.close).toHaveBeenCalled();
    expect(openings).toHaveLength(1);
  });

  it("lets a tab of a newer build upgrade it, and opens it again when it next needs it", async () => {
    const storage = indexedDbStorage()!;
    const reading = expect(storage.get(["id"])).rejects.toThrow("no store in a test");
    const first = database();
    opened(0, first);
    await reading;

    first.onversionchange?.();
    void storage.get(["id"]).catch(() => undefined);

    expect(first.close).toHaveBeenCalled();
    expect(openings).toHaveLength(2);
  });
});
