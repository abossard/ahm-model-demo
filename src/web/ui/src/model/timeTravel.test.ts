import { describe, expect, it } from "vitest";
import { seriesKey, type EntityInfo, type Point, type SignalInfo, type Transition } from "./timeline";
import { EMPTY_STORE, type Levels, type TimeStore, type Track } from "./timeStore";
import { createModelAt, entityOf, lastChangeAt, rootOf, signalAt, stateAt, statesAt, troubledAt } from "./timeTravel";
import type { Entity, HealthModel } from "./types";

const NOW = 10_000;
const change = (t: number, from: 0 | 1 | 2 | 3, to: 0 | 1 | 2 | 3): Transition => ({ t, from, to, reason: null });
const track = <T>(rows: readonly T[], ...covered: readonly [number, number][]): Track<T> => ({ rows, covered: covered.map(([from, to]) => ({ from, to })), error: null });

describe("stateAt", () => {
  const history = track([change(2000, 1, 2), change(4000, 2, 3), change(6000, 3, 1)], [1000, NOW]);

  it.each([
    { name: "after a change is what it led to", t: 2500, expected: 2 },
    { name: "at the instant of a change is what it led to", t: 4000, expected: 3 },
    { name: "before the first change held is what that change came from", t: 1500, expected: 1 },
    { name: "after the last change is what it led to", t: 9000, expected: 1 },
    { name: "before what is held is not known", t: 500, expected: null },
    { name: "after what is held is not known", t: NOW + 1, expected: null },
  ])("the state $name", ({ t, expected }) => {
    expect(stateAt(history, t, NOW, 1)).toBe(expected);
  });

  it.each([
    { name: "a quiet history that reaches now has the state of now", history: track<Transition>([], [1000, NOW]), t: 3000, expected: 3 },
    { name: "a quiet history that ended earlier does not say", history: track<Transition>([], [1000, 5000]), t: 3000, expected: null },
    { name: "a change before a hole says nothing about after it", history: track([change(2000, 1, 2)], [1000, 3000], [5000, 7000]), t: 6000, expected: null },
    { name: "after a hole the next change says what it came from", history: track([change(2000, 1, 2), change(6500, 3, 1)], [1000, 3000], [5000, 7000]), t: 6000, expected: 3 },
    { name: "no history at all", history: undefined, t: 3000, expected: null },
  ])("$name", ({ history: held, t, expected }) => {
    expect(stateAt(held, t, NOW, 3)).toBe(expected);
  });

  it("looks at a handful of rows, however long the history is", () => {
    const rows = Array.from({ length: 100_000 }, (_unused, index) => change(index * 10, 1, 2));
    let reads = 0;
    const counted = new Proxy(rows, { get: (target, key) => (typeof key === "string" && /^\d+$/.test(key) ? ((reads += 1), target[Number(key)]) : Reflect.get(target, key)) });

    stateAt({ rows: counted, covered: [{ from: 0, to: 2_000_000 }], error: null }, 777_777, 2_000_000, 1);

    expect(reads).toBeLessThan(40);
  });
});

describe("lastChangeAt", () => {
  const history = track([change(2000, 1, 2), change(4000, 2, 3), change(6000, 3, 1)], [1000, NOW]);

  it.each([
    { name: "the change before the moment", history, t: 4500, expected: 4000 },
    { name: "a change at the moment itself", history, t: 6000, expected: 6000 },
    { name: "the newest change after them all", history, t: 9000, expected: 6000 },
    { name: "nothing before the first change held", history, t: 1500, expected: null },
    { name: "the newest change held for now", history, t: null, expected: 6000 },
    { name: "nothing in a quiet history", history: track<Transition>([], [1000, NOW]), t: 5000, expected: null },
    { name: "nothing without a history", history: undefined, t: 5000, expected: null },
  ])("is $name", ({ history: held, t, expected }) => {
    expect(lastChangeAt(held, t)).toBe(expected);
  });
});

describe("signalAt", () => {
  const info: SignalInfo = { name: "cpu", displayName: "CPU", kind: null, unit: "Percent", refreshInterval: "PT1M", rules: { degraded: { operator: "GreaterThan", threshold: 70 }, unhealthy: { operator: "GreaterThan", threshold: 90 }, dynamic: false } };
  const minute = 60_000;
  const raw = track<Point>([[1 * minute, 10, 1], [2 * minute, 80, 2], [3 * minute, 95, 3], [4 * minute, 20, 1]], [0, 5 * minute]);
  const coarse = track<Point>([[10 * minute, 10, 1], [20 * minute, 30, 1], [30 * minute, 50, 1]], [0, 120 * minute]);

  it.each([
    { name: "the last evaluation at or before the moment", t: 2.5 * minute, expected: { t: 2 * minute, value: 80, state: 2, age: 0.5 * minute, rule: info.rules.degraded, stale: false, level: 0 } },
    { name: "an evaluation at the moment itself", t: 3 * minute, expected: { t: 3 * minute, value: 95, state: 3, age: 0, rule: info.rules.unhealthy, stale: false, level: 0 } },
    { name: "a healthy evaluation has no rule", t: 4.2 * minute, expected: { t: 4 * minute, value: 20, state: 1, age: 0.2 * minute, rule: null, stale: false, level: 0 } },
    { name: "a coarser level where the finer one does not reach", t: 31 * minute, expected: { t: 30 * minute, value: 50, state: 1, age: minute, rule: null, stale: false, level: 2 } },
    { name: "an evaluation older than three of its usual intervals is stale", t: 70 * minute, expected: { t: 30 * minute, value: 50, state: 1, age: 40 * minute, rule: null, stale: true, level: 2 } },
  ])("reads $name", ({ t, expected }) => {
    expect(signalAt([raw, null, coarse], info, t)).toEqual(expected);
  });

  it.each([
    { name: "before the first evaluation held", levels: [raw, null, null] as Levels, t: 0.5 * minute },
    { name: "outside what is held", levels: [raw, null, null] as Levels, t: 9 * minute },
    { name: "a series that was never read", levels: undefined, t: minute },
  ])("is null $name", ({ levels, t }) => {
    expect(signalAt(levels, info, t)).toBeNull();
  });
});

describe("modelAt", () => {
  const signal = (name: string): Entity["signals"][number] => ({ name, displayName: name, kind: "metric", healthState: "Healthy", value: 1, reportedAt: "2026-01-01T00:00:00Z", writable: false });
  const entity = (name: string, signals: readonly string[] = []): Entity => ({
    name,
    displayName: name,
    healthState: "Healthy",
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: signals.map(signal),
    report: { eligible: false, signalName: null },
  });
  const model: HealthModel = {
    model: { id: null, name: "shop", location: null, provisioningState: null, healthState: "Healthy" },
    observedAt: "2026-01-01T00:00:00Z",
    entities: [entity("shop"), entity("api", ["cpu"]), entity("db")],
    relationships: [{ name: "r", displayName: null, parentEntityName: "shop", childEntityName: "api" }],
    reportOptions: { signalName: "x", healthStates: [], values: [], expiries: [], reasonPresets: [] },
  };
  const info = (name: string, signals: readonly string[] = []): EntityInfo => ({
    name,
    displayName: name,
    parents: [],
    state: 1,
    signals: signals.map((item) => ({ name: item, displayName: item, kind: null, unit: null, refreshInterval: "PT1M", rules: { degraded: null, unhealthy: null, dynamic: false } })),
  });
  const store: TimeStore = {
    ...EMPTY_STORE,
    entities: [info("shop"), info("api", ["cpu"]), info("db")],
    states: {
      shop: track([change(4000, 1, 2)], [0, NOW]),
      api: track([change(3000, 1, 3), change(7000, 3, 1)], [0, NOW]),
      db: track<Transition>([], [0, NOW]),
    },
    series: { [seriesKey("api", "cpu")]: [track<Point>([[2000, 40, 1], [5000, 99, 3]], [0, NOW]), null, null] },
    now: NOW,
  };
  const states = (at: HealthModel): readonly string[] => at.entities.map((item) => item.healthState);

  it("is the live model itself while no moment is selected", () => {
    expect(createModelAt()(model, store, null)).toBe(model);
  });

  it.each([
    { t: 1000, expected: ["Healthy", "Healthy", "Healthy"], model: "Healthy", cpu: [null, "Unknown"] },
    { t: 3500, expected: ["Healthy", "Unhealthy", "Healthy"], model: "Healthy", cpu: [40, "Healthy"] },
    { t: 5500, expected: ["Degraded", "Unhealthy", "Healthy"], model: "Degraded", cpu: [99, "Unhealthy"] },
    { t: 8000, expected: ["Degraded", "Healthy", "Healthy"], model: "Degraded", cpu: [99, "Unhealthy"] },
  ])("at $t the entities are $expected and the model, by its root, is $model", ({ t, expected, model: health, cpu }) => {
    const at = createModelAt()(model, store, t);
    const read = at.entities[1]?.signals[0];

    expect(states(at)).toEqual(expected);
    expect(at.model.healthState).toBe(health);
    expect([read?.value, read?.healthState]).toEqual(cpu);
    expect(at.relationships).toBe(model.relationships);
    expect(at.observedAt).toBe(new Date(t).toISOString());
  });

  it("a signal whose history at the moment is not held reads as unknown, never as its value of now", () => {
    const at = createModelAt()(model, { ...store, series: {} }, 5500);

    expect(at.entities[1]?.signals[0]).toMatchObject({ value: null, healthState: "Unknown", reportedAt: null });
  });

  it("an entity whose history does not say reads as Unknown", () => {
    const at = createModelAt()(model, { ...store, states: {} }, 5500);

    expect(states(at)).toEqual(["Unknown", "Unknown", "Unknown"]);
  });

  it("a moment that crosses no change gives the same object, and one that does keeps the entities that did not change", () => {
    const at = createModelAt();

    const first = at(model, store, 3200);
    const still = at(model, store, 3900);
    const later = at(model, store, 4500);

    expect(still).toBe(first);
    expect(later).not.toBe(first);
    expect(later.entities[1]).toBe(first.entities[1]);
    expect(later.entities[2]).toBe(first.entities[2]);
    expect(later.entities[0]).not.toBe(first.entities[0]);
  });

  it("while a moment is selected, new data after it changes nothing that is shown", () => {
    const at = createModelAt();
    const first = at(model, store, 3200);
    const live: TimeStore = { ...store, states: { ...store.states, db: track([change(NOW + 500, 1, 3)], [0, NOW + 1000]) }, now: NOW + 1000 };

    expect(at(model, live, 3200)).toBe(first);
  });

  it("a change of the model's structure gives a new model around the same entities", () => {
    const at = createModelAt();
    const first = at(model, store, 3200);

    const next = at({ ...model, relationships: [] }, store, 3200);

    expect(next).not.toBe(first);
    expect(next.relationships).toEqual([]);
    expect(next.entities.every((item, index) => item === first.entities[index])).toBe(true);
  });

  it("gives the state of every entity at a moment by name", () => {
    expect([...statesAt(store, 5500)]).toEqual([["shop", 2], ["api", 3], ["db", 1]]);
  });

  it.each([
    { t: 1000, expected: [] },
    { t: 3500, expected: [{ entity: "api", displayName: "api", state: 3 }] },
    { t: 5500, expected: [{ entity: "shop", displayName: "shop", state: 2 }, { entity: "api", displayName: "api", state: 3 }] },
    { t: 8000, expected: [{ entity: "shop", displayName: "shop", state: 2 }] },
    { t: NOW + 1, expected: [] },
  ])("names what was degraded or unhealthy at $t, in the order of the model", ({ t, expected }) => {
    expect(troubledAt(store, t)).toEqual(expected);
  });

  it.each([
    { t: 1000, expected: null },
    { t: 3500, expected: new Date(2000).toISOString() },
    { t: 5500, expected: new Date(5000).toISOString() },
  ])("an entity was last evaluated at $t when the newest of its signals was, as of then", ({ t, expected }) => {
    expect(createModelAt()(model, store, t).entities[1]?.latestEvaluationAt).toBe(expected);
  });

  const parented = (name: string, parents: readonly string[], children: readonly string[]): Entity => ({ ...entity(name), parents, children });
  it.each([
    { name: "the entity named like the model", entities: [entity("api"), entity("shop")], expected: "shop" },
    { name: "else the first that has dependencies and no parent", entities: [entity("alone"), parented("edge", [], ["api"]), parented("api", ["edge"], [])], expected: "edge" },
    { name: "none in a model of entities that relate to nothing", entities: [entity("a"), entity("b")], expected: undefined },
    { name: "none in an empty model", entities: [], expected: undefined },
  ])("the root is $name", ({ entities, expected }) => {
    expect(rootOf({ ...model, entities })?.name).toBe(expected);
  });

  it("the state of a model whose root is not named like it is that of its root at the moment", () => {
    const unnamed: HealthModel = { ...model, model: { ...model.model, name: "A display name" }, entities: [parented("shop", [], ["api"]), parented("api", ["shop"], []), entity("db")] };

    expect(createModelAt()(unnamed, store, 5500).model.healthState).toBe("Degraded");
    expect(createModelAt()(unnamed, store, 1000).model.healthState).toBe("Healthy");
  });

  it.each([
    { name: "an entity of the model", wanted: "api", expected: "api" },
    { name: "nothing for a name the model does not have", wanted: "ghost", expected: undefined },
    { name: "nothing without a name", wanted: null, expected: undefined },
  ])("finds $name by its name", ({ wanted, expected }) => {
    expect(entityOf(model, wanted)?.name).toBe(expected);
    expect(entityOf(null, wanted)).toBeUndefined();
  });

  it("answers 2000 moments over 60 entities with 300 signals in well under a frame each", () => {
    const names = Array.from({ length: 60 }, (_unused, index) => `e${index}`);
    const signals = ["a", "b", "c", "d", "e"];
    const big: TimeStore = {
      ...EMPTY_STORE,
      entities: names.map((name) => info(name, signals)),
      states: Object.fromEntries(names.map((name, index) => [name, track(Array.from({ length: 200 }, (_unused, row) => change(row * 1000 + index, 1, 2)), [0, 1_000_000])])),
      series: Object.fromEntries(names.flatMap((name) => signals.map((item) => [seriesKey(name, item), [track<Point>(Array.from({ length: 5000 }, (_unused, row): Point => [row * 200, row % 100, 1]), [0, 1_000_000]), null, null]]))),
      now: 1_000_000,
    };
    const wide: HealthModel = { ...model, entities: names.map((name) => entity(name, signals)) };
    const at = createModelAt();

    const started = performance.now();
    for (let step = 0; step < 2000; step += 1) at(wide, big, 100_000 + step * 37);
    const each = (performance.now() - started) / 2000;

    expect(each).toBeLessThan(4);
  });
});
