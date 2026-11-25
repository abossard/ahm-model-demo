import { GOOD_IDS, GOODS, PLANET_IDS, PLANETS, TRADER_LIMITS } from "@playground/contracts";
import type { GoodId, Notice, NoticeCode, PlanetId, TraderScore, TraderView } from "@playground/contracts";
import type { PlayerEvent, Step, TraderAction, TraderRules } from "../ports";
import { hash, mulberry32 } from "./rng";

interface TraderState {
  seed: number;
  pilot: string;
  day: number;
  credits: number;
  fuel: number;
  location: PlanetId;
  held: Record<GoodId, number>;
  // What the held units cost in all. The average cost is this divided by the units held.
  cost: Record<GoodId, number>;
  profitableSales: number;
  over: boolean;
  log: Array<{ day: number; text: string }>;
}

const AFFINITY: Record<PlanetId, Record<GoodId, number>> = {
  vesper: { ice: 1.10, seed: 1.15, salt: 1.45, glass: 1.15, gel: 1.10 },
  kiln: { ice: 1.60, seed: 1.20, salt: 1.30, glass: 0.60, gel: 1.20 },
  tallow: { ice: 1.00, seed: 0.55, salt: 1.00, glass: 1.30, gel: 1.35 },
  brine: { ice: 0.55, seed: 1.05, salt: 1.10, glass: 1.10, gel: 1.00 },
  halcyon: { ice: 1.25, seed: 1.50, salt: 1.20, glass: 1.55, gel: 0.70 },
  cinder: { ice: 1.40, seed: 1.45, salt: 0.60, glass: 1.00, gel: 1.50 },
};
const FUEL_PRICE: Record<PlanetId, number> = { vesper: 4, brine: 6, kiln: 7, tallow: 7, halcyon: 9, cinder: 8 };
const LOG_LINES = 8;
const planet = (id: PlanetId) => PLANETS.find((candidate) => candidate.id === id)!;
const zeros = (): Record<GoodId, number> => ({ ice: 0, seed: 0, salt: 0, glass: 0, gel: 0 });

export function price(seed: number, at: PlanetId, good: GoodId, day: number): number {
  const base = GOODS.find((candidate) => candidate.id === good)!.base;
  const noise = mulberry32((seed ^ hash(at, good, day)) >>> 0)() * 2 - 1;
  return Math.max(1, Math.round(base * AFFINITY[at][good] * (1 + 0.15 * noise)));
}

export function distance(a: PlanetId, b: PlanetId): number {
  return Math.hypot(planet(a).x - planet(b).x, planet(a).y - planet(b).y);
}
export const fuelCost = (a: PlanetId, b: PlanetId) => Math.max(1, Math.round(distance(a, b) / 8));
export const daysBetween = (a: PlanetId, b: PlanetId) => Math.max(1, Math.round(distance(a, b) / 16));

const used = (state: TraderState) => GOOD_IDS.reduce((sum, good) => sum + state.held[good], 0);
const priceHere = (state: TraderState, good: GoodId) => price(state.seed, state.location, good, state.day);
const netWorth = (state: TraderState) =>
  state.credits + GOOD_IDS.reduce((sum, good) => sum + state.held[good] * priceHere(state, good), 0);

const notice = (code: NoticeCode, message: string): Notice => ({ code, message });
const unchanged = (state: TraderState, because: Notice): Step<TraderState> => ({ state, notice: because, events: [] });
const stepTo = (state: TraderState, line: string, events: PlayerEvent[] = []): Step<TraderState> =>
  ({ state: withLog(state, line), notice: null, events });
const withLog = (state: TraderState, text: string): TraderState =>
  ({ ...state, log: [...state.log, { day: state.day, text: text.slice(0, 120) }].slice(-LOG_LINES) });

function freshRun(pilot: string, seed: number): TraderState {
  return {
    seed, pilot, day: 1, credits: TRADER_LIMITS.startCredits, fuel: TRADER_LIMITS.startFuel,
    location: TRADER_LIMITS.startPlanet, held: zeros(), cost: zeros(), profitableSales: 0, over: false, log: [],
  };
}

function buy(state: TraderState, good: GoodId, qty: number): Step<TraderState> {
  const unit = priceHere(state, good);
  const space = TRADER_LIMITS.cargoCap - used(state);
  const bought = Math.min(qty, space, Math.floor(state.credits / unit));
  if (bought < 1) {
    return space < 1
      ? unchanged(state, notice("cargo_full", "The hold is full."))
      : unchanged(state, notice("insufficient_funds", "Not enough credits."));
  }
  const next: TraderState = {
    ...state,
    credits: state.credits - bought * unit,
    held: { ...state.held, [good]: state.held[good] + bought },
    cost: { ...state.cost, [good]: state.cost[good] + bought * unit },
  };
  return stepTo(next, `Bought ${bought} ${good} at ${unit}.`);
}

function sell(state: TraderState, good: GoodId, qty: number, playerId: string): Step<TraderState> {
  const held = state.held[good];
  const sold = Math.min(qty, held);
  if (sold < 1) return unchanged(state, notice("not_enough_cargo", `No ${good} in the hold.`));
  const unit = priceHere(state, good);
  const average = state.cost[good] / held;
  const profit = unit > average;
  const next: TraderState = {
    ...state,
    credits: state.credits + sold * unit,
    held: { ...state.held, [good]: held - sold },
    cost: { ...state.cost, [good]: held === sold ? 0 : state.cost[good] * ((held - sold) / held) },
    profitableSales: state.profitableSales + (profit ? 1 : 0),
  };
  const events: PlayerEvent[] = profit ? [{ playerId, event: { type: "trader_profit" } }] : [];
  return stepTo(next, `Sold ${sold} ${good} at ${unit}.`, events);
}

function refuel(state: TraderState, units: number): Step<TraderState> {
  const unit = FUEL_PRICE[state.location];
  const room = TRADER_LIMITS.fuelCap - state.fuel;
  const bought = Math.min(units, room, Math.floor(state.credits / unit));
  if (bought < 1) {
    return room < 1
      ? unchanged(state, notice("cargo_full", "The tank is full."))
      : unchanged(state, notice("insufficient_funds", "Not enough credits."));
  }
  return stepTo({ ...state, fuel: state.fuel + bought, credits: state.credits - bought * unit }, `Refuelled ${bought} at ${unit}.`);
}

function travel(state: TraderState, to: PlanetId): Step<TraderState> {
  if (to === state.location) return unchanged(state, notice("same_planet", "You are already there."));
  const fuel = fuelCost(state.location, to);
  if (fuel > state.fuel) return unchanged(state, notice("not_enough_fuel", `The jump needs ${fuel} fuel.`));
  const day = Math.min(TRADER_LIMITS.maxDay, state.day + daysBetween(state.location, to));
  const over = day >= TRADER_LIMITS.maxDay;
  const arrived = withLog({ ...state, fuel: state.fuel - fuel, location: to, day, over }, `Jumped to ${planet(to).name}.`);
  return { state: over ? withLog(arrived, `The run is over. Net worth ${netWorth(arrived)}.`) : arrived, notice: null, events: [] };
}

export function topScores(views: TraderView[]): TraderScore[] {
  return views
    .map((view) => ({ handle: view.pilot, netWorth: view.netWorth, day: view.day }))
    .sort((a, b) => b.netWorth - a.netWorth || a.day - b.day || a.handle.localeCompare(b.handle))
    .slice(0, 10);
}

export const trader: TraderRules<TraderState> = {
  game: "trader",
  seats: 1,

  create: (by, _options, _now, seed) => freshRun(by.handle, seed),

  apply(state, action: TraderAction, by) {
    if (action.type === "new_run") return stepTo(freshRun(by.handle, action.seed), "A new run begins.");
    if (state.over) return unchanged(state, notice("run_over", "The run is over. Start a new one."));
    switch (action.type) {
      case "buy": return buy(state, action.good, action.qty);
      case "sell": return sell(state, action.good, action.qty, by.id);
      case "travel": return travel(state, action.to);
      case "refuel": return refuel(state, action.units);
    }
  },

  tick: (state) => ({ state, notice: null, events: [] }),
  nextDeadline: () => null,

  view(state): TraderView {
    return {
      pilot: state.pilot,
      status: state.over ? "over" : "running",
      day: state.day,
      maxDay: TRADER_LIMITS.maxDay,
      credits: state.credits,
      netWorth: netWorth(state),
      fuel: state.fuel,
      fuelCap: TRADER_LIMITS.fuelCap,
      fuelPrice: FUEL_PRICE[state.location],
      cargoUsed: used(state),
      cargoCap: TRADER_LIMITS.cargoCap,
      location: state.location,
      routes: PLANET_IDS.filter((id) => id !== state.location).map((id) => {
        const fuel = fuelCost(state.location, id);
        const { name, blurb, x, y } = planet(id);
        return { to: id, name, blurb, x, y, fuelCost: fuel, days: daysBetween(state.location, id), reachable: fuel <= state.fuel };
      }),
      market: GOODS.map(({ id, name }) => ({
        good: id,
        name,
        price: priceHere(state, id),
        held: state.held[id],
        avgCost: state.held[id] > 0 ? Math.round((state.cost[id] / state.held[id]) * 100) / 100 : null,
      })),
      profitableSales: state.profitableSales,
      log: state.log,
    };
  },

  lobby: (state) => ({
    title: `${state.pilot}'s run`.slice(0, 60),
    seatsTaken: 1,
    seatsTotal: 1,
    status: state.over ? "over" : "playing",
  }),
};
