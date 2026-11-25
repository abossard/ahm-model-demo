import { describe, expect, it } from "vitest";
import { GOOD_IDS, PLANET_IDS, TRADER_LIMITS } from "@playground/contracts";
import type { GoodId, PlanetId, TraderView } from "@playground/contracts";
import type { TraderAction } from "../ports";
import { price, topScores, trader } from "./trader";

const pilot = { id: "p-aaaaaaaa", handle: "Ann" };
const NOW = 0;
const SEED = 7;

const run = () => trader.create(pilot, {}, NOW, SEED);
const act = (state: ReturnType<typeof run>, action: TraderAction) => trader.apply(state, action, pilot, NOW);
const view = (state: ReturnType<typeof run>) => trader.view(state, pilot);
const holding = (state: ReturnType<typeof run>, good: GoodId) => view(state).market.find((row) => row.good === good)!;

describe("prices", () => {
  it.each<[number, number[][]]>([
    [1, [[25, 59, 120, 156, 304], [28, 59, 131, 76, 302], [19, 25, 103, 183, 303], [11, 50, 104, 174, 281], [23, 75, 121, 236, 178], [28, 64, 53, 157, 391]]],
    [2, [[24, 52, 128, 158, 283], [28, 56, 116, 78, 270], [19, 24, 99, 203, 312], [12, 47, 89, 175, 233], [28, 68, 112, 245, 187], [30, 72, 58, 145, 419]]],
    [3, [[23, 54, 140, 165, 326], [32, 48, 110, 84, 353], [20, 26, 93, 198, 341], [10, 50, 113, 156, 287], [22, 59, 93, 248, 169], [27, 69, 47, 153, 398]]],
  ])("the table of day %i for one seed", (day, expected) => {
    expect(PLANET_IDS.map((planet) => GOOD_IDS.map((good) => price(SEED, planet, good, day)))).toEqual(expected);
  });

  it("repeat for the same seed and day, and differ between seeds", () => {
    expect(price(SEED, "kiln", "glass", 4)).toBe(price(SEED, "kiln", "glass", 4));
    const seeds = new Set(Array.from({ length: 20 }, (_, seed) => price(seed, "kiln", "glass", 4)));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it.each(PLANET_IDS.map((planet) => [planet] as [PlanetId]))("%s has a good that always sells dearer somewhere else", (planet) => {
    const seeds = Array.from({ length: 40 }, (_, seed) => seed);
    const days = Array.from({ length: 30 }, (_, day) => day + 1);
    const dearer = GOOD_IDS.some((good) =>
      PLANET_IDS.some((other) =>
        other !== planet && seeds.every((seed) => days.every((day) => price(seed, other, good, day) > price(seed, planet, good, day)))));
    expect(dearer).toBe(true);
  });
});

describe("a new run", () => {
  it("starts at Vesper Yard on day 1 with the contract's limits", () => {
    expect(view(run())).toMatchObject({
      pilot: "Ann", status: "running", day: 1, maxDay: 30, credits: 1000, netWorth: 1000, fuel: 12, fuelCap: 20,
      fuelPrice: 4, cargoUsed: 0, cargoCap: 30, location: TRADER_LIMITS.startPlanet, profitableSales: 0, log: [],
    });
  });

  it.each<[PlanetId, number, number]>([["kiln", 5, 2], ["brine", 4, 2], ["cinder", 10, 5]])(
    "the route to %s costs %i fuel and %i days", (to, fuel, days) => {
      const route = view(run()).routes.find((candidate) => candidate.to === to)!;
      expect(route).toMatchObject({ fuelCost: fuel, days, reachable: true });
    });

  it("lists every other port and marks the ones the fuel does not reach", () => {
    const routes = view({ ...run(), fuel: 4 }).routes;
    expect(routes.map((route) => route.to)).toEqual(PLANET_IDS.filter((id) => id !== "vesper"));
    expect(routes.filter((route) => route.reachable).map((route) => route.to)).toEqual(["brine"]);
  });

  it("lists the market of the port with held units and no average cost", () => {
    expect(view(run()).market.map((row) => [row.good, row.price, row.held, row.avgCost])).toEqual([
      ["ice", 25, 0, null], ["seed", 59, 0, null], ["salt", 120, 0, null], ["glass", 156, 0, null], ["gel", 304, 0, null],
    ]);
  });

  it("is a one-seat table that is playing", () => {
    expect(trader.lobby(run())).toEqual({ title: "Ann's run", seatsTaken: 1, seatsTotal: 1, status: "playing" });
    expect(trader.nextDeadline(run())).toBeNull();
    expect(trader.tick(run(), 10 ** 9).state).toEqual(run());
  });
});

describe("buy", () => {
  it.each<[string, GoodId, number, number, number]>([
    ["what was asked for", "ice", 4, 4, 1000 - 4 * 25],
    ["what the credits allow", "salt", 99, 8, 1000 - 8 * 120],
    ["what the hold allows", "ice", 99, 30, 1000 - 30 * 25],
  ])("takes %s", (_name, good, qty, bought, credits) => {
    const step = act(run(), { type: "buy", good, qty });
    expect(step.notice).toBeNull();
    expect(holding(step.state, good).held).toBe(bought);
    expect(view(step.state).credits).toBe(credits);
  });

  it.each<[string, Partial<ReturnType<typeof run>>, GoodId, string]>([
    ["no credits for one unit", { credits: 10 }, "gel", "insufficient_funds"],
    ["a full hold", { held: { ice: 30, seed: 0, salt: 0, glass: 0, gel: 0 } }, "seed", "cargo_full"],
  ])("answers %s with a notice and the same state", (_name, patch, good, code) => {
    const state = { ...run(), ...patch };
    const step = act(state, { type: "buy", good, qty: 1 });
    expect(step.notice?.code).toBe(code);
    expect(step.state).toBe(state);
  });

  it("keeps the average cost over two buys", () => {
    const first = act(run(), { type: "buy", good: "ice", qty: 2 }).state;
    const second = act({ ...first, day: 2 }, { type: "buy", good: "ice", qty: 2 }).state;
    expect(price(SEED, "vesper", "ice", 1)).toBe(25);
    expect(price(SEED, "vesper", "ice", 2)).toBe(24);
    expect(holding(second, "ice")).toMatchObject({ held: 4, avgCost: 24.5 });
  });

  it("counts the held units in net worth at the local price", () => {
    const state = act(run(), { type: "buy", good: "ice", qty: 4 }).state;
    expect(view(state).netWorth).toBe(1000 - 100 + 4 * 25);
  });
});

describe("sell", () => {
  const stocked = () => act(run(), { type: "buy", good: "ice", qty: 5 }).state;

  it.each<[string, number, number]>([["what was asked for", 3, 3], ["what is held", 99, 5]])("takes %s", (_name, qty, sold) => {
    const step = act(stocked(), { type: "sell", good: "ice", qty });
    expect(step.notice).toBeNull();
    expect(holding(step.state, "ice").held).toBe(5 - sold);
    expect(view(step.state).credits).toBe(1000 - 5 * 25 + sold * 25);
  });

  it("answers an empty hold with not_enough_cargo", () => {
    const state = run();
    const step = act(state, { type: "sell", good: "gel", qty: 1 });
    expect(step.notice?.code).toBe("not_enough_cargo");
    expect(step.state).toBe(state);
  });

  it("keeps the average cost of what is left", () => {
    expect(holding(act(stocked(), { type: "sell", good: "ice", qty: 2 }).state, "ice")).toMatchObject({ held: 3, avgCost: 25 });
    expect(holding(act(stocked(), { type: "sell", good: "ice", qty: 5 }).state, "ice").avgCost).toBeNull();
  });

  it.each<[string, PlanetId, number]>([
    ["dearer than it cost", "kiln", 1],
    ["at the price it cost", "vesper", 0],
    ["cheaper than it cost", "brine", 0],
  ])("a sale %s gives %i profitable sales", (_name, where, profits) => {
    const step = act({ ...stocked(), location: where }, { type: "sell", good: "ice", qty: 5 });
    expect(view(step.state).profitableSales).toBe(profits);
    expect(step.events).toEqual(profits ? [{ playerId: pilot.id, event: { type: "trader_profit" } }] : []);
  });
});

describe("refuel", () => {
  it.each<[string, Partial<ReturnType<typeof run>>, number, number, number]>([
    ["what was asked for", {}, 3, 15, 1000 - 12],
    ["what the tank allows", {}, 99, 20, 1000 - 32],
    ["what the credits allow", { credits: 9 }, 99, 14, 1],
  ])("takes %s", (_name, patch, units, fuel, credits) => {
    const step = act({ ...run(), ...patch }, { type: "refuel", units });
    expect(step.notice).toBeNull();
    expect(view(step.state)).toMatchObject({ fuel, credits });
  });

  it.each<[string, Partial<ReturnType<typeof run>>, string]>([
    ["no credits for one unit", { credits: 3 }, "insufficient_funds"],
    ["a full tank", { fuel: 20 }, "cargo_full"],
  ])("answers %s with a notice", (_name, patch, code) => {
    const state = { ...run(), ...patch };
    const step = act(state, { type: "refuel", units: 1 });
    expect(step.notice?.code).toBe(code);
    expect(step.state).toBe(state);
  });

  it("charges the local fuel price", () => {
    const step = act({ ...run(), location: "halcyon" }, { type: "refuel", units: 2 });
    expect(view(step.state)).toMatchObject({ fuelPrice: 9, credits: 1000 - 18 });
  });
});

describe("travel", () => {
  it("spends fuel and days and arrives", () => {
    const step = act(run(), { type: "travel", to: "kiln" });
    expect(step.notice).toBeNull();
    expect(view(step.state)).toMatchObject({ location: "kiln", fuel: 7, day: 3, status: "running" });
  });

  it.each<[string, Partial<ReturnType<typeof run>>, PlanetId, string]>([
    ["the same port", {}, "vesper", "same_planet"],
    ["too little fuel", { fuel: 9 }, "cinder", "not_enough_fuel"],
  ])("answers %s with a notice and the same state", (_name, patch, to, code) => {
    const state = { ...run(), ...patch };
    const step = act(state, { type: "travel", to });
    expect(step.notice?.code).toBe(code);
    expect(step.state).toBe(state);
  });

  it("changes prices only when the day changes", () => {
    const before = view(run()).market.map((row) => row.price);
    const afterBuy = view(act(run(), { type: "buy", good: "ice", qty: 1 }).state).market.map((row) => row.price);
    expect(afterBuy).toEqual(before);
    const afterJump = view(act(run(), { type: "travel", to: "kiln" }).state).market.map((row) => row.price);
    expect(afterJump).not.toEqual(before);
  });
});

describe("the end of a run", () => {
  it.each<[string, number, PlanetId, string, number]>([
    ["a two day jump from day 28", 28, "kiln", "over", 30],
    ["a five day jump from day 29 stops at day 30", 29, "cinder", "over", 30],
    ["a two day jump from day 25", 25, "kiln", "running", 27],
  ])("%s", (_name, day, to, status, arrival) => {
    const step = act({ ...run(), day, fuel: 20 }, { type: "travel", to });
    expect(view(step.state)).toMatchObject({ status, day: arrival });
    expect(trader.lobby(step.state).status).toBe(status === "over" ? "over" : "playing");
  });

  it.each<TraderAction>([
    { type: "buy", good: "ice", qty: 1 },
    { type: "sell", good: "ice", qty: 1 },
    { type: "travel", to: "kiln" },
    { type: "refuel", units: 1 },
  ])("answers $type on an ended run with run_over", (action) => {
    const ended = act({ ...run(), day: 28 }, { type: "travel", to: "kiln" }).state;
    const step = act(ended, action);
    expect(step.notice?.code).toBe("run_over");
    expect(step.state).toBe(ended);
  });

  it("starts again on new_run, even from an ended or a running run", () => {
    const ended = act({ ...run(), day: 28 }, { type: "travel", to: "kiln" }).state;
    for (const from of [ended, act(run(), { type: "buy", good: "ice", qty: 3 }).state]) {
      const fresh = act(from, { type: "new_run", seed: 99 });
      expect(fresh.notice).toBeNull();
      expect(view(fresh.state)).toMatchObject({ day: 1, credits: 1000, fuel: 12, cargoUsed: 0, status: "running", profitableSales: 0 });
      expect(fresh.state.seed).toBe(99);
    }
  });

  it("keeps the last eight log lines", () => {
    let state = run();
    for (let i = 0; i < 12; i++) state = act(state, { type: "buy", good: "ice", qty: 1 }).state;
    expect(view(state).log).toHaveLength(8);
    expect(view(state).log.every((line) => line.text.length <= 120)).toBe(true);
  });
});

describe("topScores", () => {
  const row = (handle: string, netWorth: number, day = 5) => ({ ...view(run()), pilot: handle, netWorth, day }) as TraderView;
  it("returns the ten richest, richest first", () => {
    const views = Array.from({ length: 14 }, (_, i) => row(`Pilot ${i}`, 1000 + i * 10));
    const scores = topScores(views);
    expect(scores).toHaveLength(10);
    expect(scores[0]).toEqual({ handle: "Pilot 13", netWorth: 1130, day: 5 });
    expect(scores.map((score) => score.netWorth)).toEqual([...scores.map((score) => score.netWorth)].sort((a, b) => b - a));
  });

  it("breaks a tie by the earlier day, then the name", () => {
    const scores = topScores([row("Zed", 900, 9), row("Amy", 900, 9), row("Bob", 900, 4)]);
    expect(scores.map((score) => score.handle)).toEqual(["Bob", "Amy", "Zed"]);
  });
});
