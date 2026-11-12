import { describe, expect, it } from "vitest";
import { buildFixture, topologyFixture, type TimelineFixture } from "./timelineFixture";
import { MAX_COST, MAX_ENTITIES, MAX_SIGNALS, REPORT_SIGNAL, demandKey, overviewCell, parseCell, planRequests, seriesCell, type Demand, type PlanInput, type TileRequest } from "./timelinePlan";
import { DAY, HOUR, MINUTE } from "./timelineScale";
import { RETENTION, WEEK, tileOf } from "./timelineTiles";
import { EMPTY_STORE, mergeAnswer, type TimeStore } from "./timeStore";

// A Wednesday noon: the week tile it is in began the Thursday before.
const NOW = Date.parse("2026-11-11T12:00:00Z");
const TODAY = tileOf(NOW, DAY);
const THIS_WEEK = tileOf(NOW, WEEK);
const SIGNALS = (names: readonly string[]) => names.map((name) => ({ name, displayName: name, kind: null, unit: null, refreshInterval: "PT5M", rules: { degraded: null, unhealthy: null, dynamic: false } }));

const small = buildFixture({ now: NOW, days: 5, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 2, signalsPerResource: 2 });
const many = (count: number, signalNames: readonly string[] = ["cpu"]): TimelineFixture =>
  topologyFixture(
    Array.from({ length: count }, (_unused, index) => ({ name: `e${index}`, displayName: `E ${index}`, parents: index === 0 ? [] : ["e0"], signals: SIGNALS(signalNames) })),
    { now: NOW, days: 2 },
  );

const demand = (parts: Partial<Demand> = {}): Demand => ({ view: { from: NOW - DAY, to: NOW }, width: 1000, lanes: [], moment: null, watched: [], ...parts });

function input(parts: Partial<PlanInput> & { readonly store?: TimeStore } = {}): PlanInput {
  return { store: EMPTY_STORE, demand: demand(), now: NOW, freshAt: NOW - MINUTE, structureAt: 0, busy: new Set(), settled: new Set(), hint: null, idle: false, ...parts };
}

/** The store after the app has answered every request of a plan, and the plans after it, until nothing is left to ask. */
function answered(fixture: TimelineFixture, start: PlanInput): { readonly store: TimeStore; readonly requests: readonly TileRequest[] } {
  let store = start.store;
  const settled = new Set(start.settled);
  const all: TileRequest[] = [];
  for (let round = 0; round < 50; round += 1) {
    const plan = planRequests({ ...start, store, settled, structureAt: store.entities.length > 0 ? NOW : 0 });
    if (plan.requests.length === 0) break;
    for (const request of plan.requests) {
      all.push(request);
      store = mergeAnswer(store, fixture.answer({ from: request.from, to: request.to, include: request.parts, entities: request.entities ?? [], signals: request.signals ?? [], resolution: [0, 900, 3600][request.level] ?? 0 }), request);
      for (const cell of request.cells) settled.add(cell);
    }
  }
  return { store, requests: all };
}

const overviewOf = (requests: readonly TileRequest[]): readonly TileRequest[] => requests.filter((request) => !request.parts.includes("signals"));
const hintOf = (fixture: TimelineFixture) => fixture.entities.map((entity) => ({ name: entity.name, reports: false }));

describe("the overview", () => {
  it("of a model nobody knows yet is one request for the tiles on screen, which also names the entities", () => {
    const { requests } = planRequests(input());

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ parts: ["structure", "states", "annotations", "reports"], entities: null, rank: 0, to: (THIS_WEEK + 1) * WEEK });
    expect((requests[0] as TileRequest).from).toBe(tileOf(NOW - DAY, WEEK) * WEEK);
  });

  it("of a small model the graph already shows is one request for all the service keeps", () => {
    const { requests } = planRequests(input({ hint: hintOf(small) }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ parts: ["structure", "states", "annotations", "reports"], entities: null, signals: null, rank: 0 });
    expect([(requests[0] as TileRequest).from, (requests[0] as TileRequest).to]).toEqual([tileOf(NOW - RETENTION, WEEK) * WEEK, (THIS_WEEK + 1) * WEEK]);
  });

  it.each([
    { name: "60 entities", count: 60, reports: false, perTile: 1 },
    { name: "60 entities that all take health reports", count: 60, reports: true, perTile: 4 },
    { name: "200 entities", count: 200, reports: false, perTile: 5 },
  ])("of $name is read a week at a time, within what one request may cost, and comes out complete", ({ count, reports, perTile }) => {
    const fixture = many(count, reports ? ["cpu", REPORT_SIGNAL] : ["cpu"]);
    const hint = fixture.entities.map((entity) => ({ name: entity.name, reports }));

    const { store, requests } = answered(fixture, input({ hint }));
    const weeks = tileOf(NOW, WEEK) - tileOf(NOW - RETENTION, WEEK) + 1;
    const cost = (request: TileRequest): number => request.cells.filter((cell) => parseCell(cell).kind === "o").length * (reports ? 9 : 2);

    expect(overviewOf(requests).filter((request) => request.parts.includes("states"))).toHaveLength(weeks * perTile);
    expect(Math.max(...requests.map(cost))).toBeLessThanOrEqual(MAX_COST);
    expect(Math.max(...requests.map((request) => request.entities?.length ?? 0))).toBeLessThanOrEqual(MAX_ENTITIES);
    expect(store.entities).toHaveLength(count);
    for (const entity of fixture.entities) {
      expect(store.states[entity.name]?.covered).toEqual([{ from: NOW - 2 * DAY < 0 ? 0 : store.floor, to: NOW }]);
      expect(store.states[entity.name]?.error).toBeNull();
    }
    expect(planRequests(input({ store, hint, structureAt: NOW, settled: new Set() })).requests).toEqual([]);
  });

  it("of a large model asks for the structure on its own, and for the tiles on screen before the older ones", () => {
    const fixture = many(100);
    const { requests } = planRequests(input({ hint: hintOf(fixture) }));

    expect(requests[0]).toMatchObject({ parts: ["structure"], entities: null, rank: 0 });
    expect(requests.filter((request) => request.rank === 0).every((request) => request.to === (THIS_WEEK + 1) * WEEK || request.parts.includes("structure"))).toBe(true);
    expect(requests.map((request) => request.rank)).toEqual([...requests.map((request) => request.rank)].sort((a, b) => a - b));
    expect(requests.filter((request) => request.rank === 1).map((request) => request.to)).toEqual([...requests.filter((request) => request.rank === 1).map((request) => request.to)].sort((a, b) => b - a));
  });

  it("is read again only for the week that is still open", () => {
    const { store } = answered(small, input({ hint: hintOf(small) }));

    const { requests } = planRequests(input({ store, structureAt: NOW - HOUR, freshAt: NOW + MINUTE, now: NOW + MINUTE }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ parts: ["structure", "states", "annotations", "reports"], entities: null, from: THIS_WEEK * WEEK, to: (THIS_WEEK + 1) * WEEK });
  });

  it("an entity whose states failed is left alone until it is retried", () => {
    const { store } = answered(small, input({ hint: hintOf(small) }));
    const name = small.entities[0]?.name ?? "";
    const broken: TimeStore = { ...store, states: { ...store.states, [name]: { rows: [], covered: [], error: { code: "forbidden", message: "x", retryable: false } } } };

    expect(planRequests(input({ store: broken, structureAt: NOW })).requests).toEqual([]);
  });
});

describe("the series", () => {
  const structure = (fixture: TimelineFixture): PlanInput => {
    const { store } = answered(fixture, input({ hint: hintOf(fixture) }));
    return input({ store, structureAt: NOW });
  };
  const lanes = small.entities.filter((entity) => entity.signals.length > 0).map((entity) => entity.name);
  const [first, second] = lanes as [string, string];
  const seriesOf = (requests: readonly TileRequest[]): readonly TileRequest[] => requests.filter((request) => request.parts.includes("signals"));

  it("of the lanes that show are one request for the day tiles of the window and its margins", () => {
    const base = structure(small);

    const { requests } = planRequests({ ...base, demand: demand({ lanes: [first, second] }) });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ parts: ["signals"], entities: [first, second], signals: null, level: 0, from: (TODAY - 1) * DAY, to: (TODAY + 1) * DAY, rank: 0 });
    expect(requests[0]?.cells).toHaveLength(2 * 2 * 2);
  });

  it.each([
    { name: "a day is raw points by the day", view: DAY, level: 0, from: (TODAY - 1) * DAY },
    { name: "a week is slots of 15 minutes by the day", view: 7 * DAY, level: 1, from: (TODAY - 9) * DAY },
    { name: "a month is slots of an hour by the week", view: 30 * DAY, level: 2, from: tileOf(NOW - RETENTION, WEEK) * WEEK },
  ])("$name", ({ view, level, from }) => {
    const base = structure(small);

    const { requests } = planRequests({ ...base, demand: demand({ lanes: [first], view: { from: NOW - view, to: NOW } }) });

    expect(seriesOf(requests).map((request) => [request.level, request.from])).toEqual([[level, from]]);
  });

  it("asks nothing for a window that is held, whichever way the view moves inside it", () => {
    const base = structure(small);
    const wide = demand({ lanes: [first], view: { from: NOW - 2 * DAY, to: NOW } });
    const { store } = answered(small, { ...base, demand: wide });

    const moves = [
      { from: NOW - 2 * DAY, to: NOW },
      { from: NOW - 6 * HOUR, to: NOW },
      { from: NOW - 30 * HOUR, to: NOW - 24 * HOUR },
      { from: NOW - 2 * DAY, to: NOW - DAY },
    ];

    for (const view of moves) expect(planRequests({ ...base, store, demand: demand({ lanes: [first], view }) }).requests).toEqual([]);
  });

  it("asks only for the tiles that are missing when the view moves out of what is held", () => {
    const base = structure(small);
    const { store } = answered(small, { ...base, demand: demand({ lanes: [first] }) });

    const { requests } = planRequests({ ...base, store, demand: demand({ lanes: [first], view: { from: NOW - 3 * DAY, to: NOW - 2 * DAY } }) });

    expect(requests.map((request) => [request.from, request.to])).toEqual([[(TODAY - 3) * DAY, (TODAY - 1) * DAY]]);
  });

  it("finer points that are held stand in for a coarser level", () => {
    const base = structure(small);
    const month = { from: NOW - 4 * DAY, to: NOW };
    const { store } = answered(small, { ...base, demand: demand({ lanes: [first], view: month, width: 4000 }) });

    const { requests } = planRequests({ ...base, store, demand: demand({ lanes: [first], view: { from: NOW - 3 * DAY, to: NOW }, width: 300 }) });

    expect(requests).toEqual([]);
  });

  it("a lane that is added is asked for alone, and what is in flight is not asked twice", () => {
    const base = structure(small);
    const one = planRequests({ ...base, demand: demand({ lanes: [first] }) });
    const busy = new Set(one.requests.flatMap((request) => request.cells));

    const two = planRequests({ ...base, busy, demand: demand({ lanes: [first, second] }) });

    expect(two.requests.map((request) => request.entities)).toEqual([[second]]);
    expect(planRequests({ ...base, busy, demand: demand({ lanes: [first] }) }).requests).toEqual([]);
    expect(one.requests.every((request) => request.cells.every((cell) => two.wanted.has(cell)))).toBe(true);
  });

  it("only the signals that lack something are named, when the others are held", () => {
    const base = structure(small);
    const { store } = answered(small, { ...base, demand: demand({ lanes: [first] }) });
    const signals = small.entities.find((entity) => entity.name === first)?.signals.map((signal) => signal.name) ?? [];
    const lost: TimeStore = { ...store, series: Object.fromEntries(Object.entries(store.series).filter(([key]) => !key.endsWith(`\u0000${signals[1]}`))) };

    const { requests } = planRequests({ ...base, store: lost, demand: demand({ lanes: [first] }) });

    expect(requests.map((request) => [request.entities, request.signals])).toEqual([[[first], [signals[1]]]]);
  });

  it.each([
    { name: "30 entities of 5 signals over a month", count: 30, signals: 5, view: 30 * DAY },
    { name: "one entity of 150 signals over a day", count: 1, signals: 150, view: DAY },
    { name: "one entity of 30 signals over a month", count: 1, signals: 30, view: 30 * DAY },
  ])("$name stay within what a request may cost, and every cell is in exactly one request", ({ count, signals, view }) => {
    const fixture = many(count, Array.from({ length: signals }, (_unused, index) => `s${index}`));
    const base = structure(fixture);

    const { requests, lacking } = planRequests({ ...base, demand: demand({ lanes: fixture.entities.map((entity) => entity.name), view: { from: NOW - view, to: NOW } }) });
    const cells = requests.flatMap((request) => request.cells);

    for (const request of requests) {
      const names = new Set(request.cells.map((cell) => `${parseCell(cell).entity}/${parseCell(cell).signal}`));
      const days = (request.to - request.from) / DAY;
      expect(names.size * days).toBeLessThanOrEqual(Math.max(MAX_COST, days));
      expect(names.size).toBeLessThanOrEqual(MAX_SIGNALS);
      expect(request.entities?.length ?? 0).toBeLessThanOrEqual(MAX_ENTITIES);
    }
    expect(new Set(cells).size).toBe(cells.length);
    expect(new Set(cells)).toEqual(new Set(lacking));
  });

  it("a lane whose series failed is left alone until it is retried", () => {
    const base = structure(small);
    const key = Object.keys(mergeAnswer(base.store, small.answer({ from: NOW - DAY, to: NOW, include: ["signals"], entities: [first] }), { parts: ["signals"], entities: [first], signals: null, level: 0 }).series);
    const failed: TimeStore = { ...base.store, series: Object.fromEntries(key.map((name) => [name, [{ rows: [], covered: [], error: { code: "busy", message: "x", retryable: true } }, null, null]])) };

    expect(planRequests({ ...base, store: failed, demand: demand({ lanes: [first] }) }).requests).toEqual([]);
  });

  it("the window next to the one on screen is read ahead only when nothing else is left and the view rests", () => {
    const base = structure(small);
    const { store } = answered(small, { ...base, demand: demand({ lanes: [first] }) });
    const settledDemand = { ...base, store, demand: demand({ lanes: [first] }) };

    expect(planRequests(settledDemand).requests).toEqual([]);
    const ahead = planRequests({ ...settledDemand, idle: true }).requests;
    expect(ahead.map((request) => [request.rank, request.from, request.to])).toEqual([[2, (TODAY - 2) * DAY, (TODAY - 1) * DAY]]);
    expect(planRequests({ ...base, demand: demand({ lanes: [first] }), idle: true }).requests.every((request) => request.rank === 0)).toBe(true);
  });
});

describe("a selected moment", () => {
  const moment = NOW - 8 * DAY;

  it("eight days ago in a model of 60 entities needs the weeks from the moment to now first, then the raw day around it for what is watched", () => {
    const fixture = many(60);
    const hint = hintOf(fixture);
    const plan = planRequests(input({ hint, demand: demand({ moment }) }));
    const urgent = plan.requests.filter((request) => request.rank === 0 && request.parts.includes("states"));

    expect(urgent.map((request) => request.from)).toEqual([THIS_WEEK * WEEK, (THIS_WEEK - 1) * WEEK]);

    const { store } = answered(fixture, input({ hint }));
    const watching = planRequests(input({ store, structureAt: NOW, demand: demand({ moment, watched: ["e1", "e2"] }) }));

    expect(watching.requests).toHaveLength(1);
    expect(watching.requests[0]).toMatchObject({ parts: ["signals"], entities: ["e1", "e2"], level: 0, from: tileOf(moment, DAY) * DAY, to: (tileOf(moment, DAY) + 1) * DAY, rank: 0 });
  });

  it("just after midnight also reads the day before, where the last evaluation may be", () => {
    const fixture = many(3);
    const { store } = answered(fixture, input({ hint: hintOf(fixture) }));
    const early = tileOf(moment, DAY) * DAY + 10 * MINUTE;

    const { requests } = planRequests(input({ store, structureAt: NOW, demand: demand({ moment: early, watched: ["e1"] }) }));

    expect(requests.map((request) => [request.from, request.to])).toEqual([[(tileOf(moment, DAY) - 1) * DAY, (tileOf(moment, DAY) + 1) * DAY]]);
  });
});

describe("demandKey", () => {
  it.each([
    { name: "a small pan inside the same tiles", other: demand({ view: { from: NOW - DAY - HOUR, to: NOW - HOUR } }), same: true },
    { name: "the clock moving on", other: demand({ view: { from: NOW - DAY + MINUTE, to: NOW + MINUTE } }), same: true },
    { name: "another lane", other: demand({ lanes: ["x"] }), same: false },
    { name: "a zoom that changes the level", other: demand({ view: { from: NOW - 8 * DAY, to: NOW } }), same: false },
    { name: "a pan into another day", other: demand({ view: { from: NOW - 3 * DAY, to: NOW - 2 * DAY } }), same: false },
    { name: "a selected moment", other: demand({ moment: NOW - HOUR }), same: false },
  ])("$name is the same demand: $same", ({ other, same }) => {
    expect(demandKey(other, NOW) === demandKey(demand(), NOW)).toBe(same);
  });

  it("cells name what they read", () => {
    expect(parseCell(seriesCell("api", "cpu", 1, 42))).toEqual({ kind: "s", entity: "api", signal: "cpu", level: 1, tile: 42 });
    expect(parseCell(overviewCell("api", 7))).toEqual({ kind: "o", entity: "api", signal: "", level: 0, tile: 7 });
  });
});
