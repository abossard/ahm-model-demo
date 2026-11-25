import { z } from "zod";
import { Handle, snapshotOf } from "./ids";

// Drift Ledger: one pilot, six ports, five goods, thirty days. All names are ours.
export const PLANET_IDS = ["vesper", "kiln", "tallow", "brine", "halcyon", "cinder"] as const;
export const PlanetId = z.enum(PLANET_IDS);
export type PlanetId = z.infer<typeof PlanetId>;
export const GOOD_IDS = ["ice", "seed", "salt", "glass", "gel"] as const;
export const GoodId = z.enum(GOOD_IDS);
export type GoodId = z.infer<typeof GoodId>;

export const PLANETS: ReadonlyArray<{ id: PlanetId; name: string; blurb: string; x: number; y: number }> = [
  { id: "vesper", name: "Vesper Yard", blurb: "Shipyard moon. Cheap fuel, hungry crews.", x: 12, y: 46 },
  { id: "kiln", name: "Kiln", blurb: "Furnace world. Makes glass, drinks ice.", x: 34, y: 14 },
  { id: "tallow", name: "Tallow Reach", blurb: "Farm belt. Seed is cheap, everything else is not.", x: 58, y: 62 },
  { id: "brine", name: "Brine", blurb: "Ocean world. Ice by the tonne.", x: 44, y: 38 },
  { id: "halcyon", name: "Halcyon Ring", blurb: "Rich habitat. Pays for glass and gel.", x: 82, y: 22 },
  { id: "cinder", name: "Cinder Gate", blurb: "Mining outpost. Salt in, salt out.", x: 88, y: 70 },
];

export const GOODS: ReadonlyArray<{ id: GoodId; name: string; base: number }> = [
  { id: "ice", name: "Water ice", base: 20 },
  { id: "seed", name: "Seed stock", base: 45 },
  { id: "salt", name: "Reactor salt", base: 90 },
  { id: "glass", name: "Kiln glass", base: 140 },
  { id: "gel", name: "Medic gel", base: 260 },
];

export const TRADER_LIMITS = {
  startCredits: 1000, startFuel: 12, fuelCap: 20, cargoCap: 30, maxDay: 30, startPlanet: "vesper" as PlanetId,
} as const;

export const TraderView = z.object({
  pilot: Handle,
  status: z.enum(["running", "over"]),
  day: z.number().int().min(1),
  maxDay: z.number().int(),
  credits: z.number().int().min(0),
  netWorth: z.number().int().min(0),
  fuel: z.number().int().min(0),
  fuelCap: z.number().int(),
  fuelPrice: z.number().int().min(1),
  cargoUsed: z.number().int().min(0),
  cargoCap: z.number().int(),
  location: PlanetId,
  routes: z.array(z.object({
    to: PlanetId,
    name: z.string(),
    blurb: z.string(),
    x: z.number(),
    y: z.number(),
    fuelCost: z.number().int().min(0),
    days: z.number().int().min(0),
    reachable: z.boolean(),
  })),
  market: z.array(z.object({
    good: GoodId,
    name: z.string(),
    price: z.number().int().min(1),
    held: z.number().int().min(0),
    // What the held units cost on average. Null when none are held.
    avgCost: z.number().nullable(),
  })),
  profitableSales: z.number().int().min(0),
  log: z.array(z.object({ day: z.number().int(), text: z.string().max(120) })).max(8),
});
export type TraderView = z.infer<typeof TraderView>;

export const TraderSnapshot = snapshotOf("trader", TraderView);
export type TraderSnapshot = z.infer<typeof TraderSnapshot>;

export const TraderScore = z.object({ handle: z.string(), netWorth: z.number().int(), day: z.number().int() });
export type TraderScore = z.infer<typeof TraderScore>;
