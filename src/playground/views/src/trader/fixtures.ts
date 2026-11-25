// A mid-run snapshot, for tests and for building the View without a server.
import { PLANETS, type TraderView } from "@playground/contracts";

const routeTo = (to: string, fuelCost: number, days: number, reachable = true) => {
  const planet = PLANETS.find((p) => p.id === to)!;
  return { to: planet.id, name: planet.name, blurb: planet.blurb, x: planet.x, y: planet.y, fuelCost, days, reachable };
};

export const fixtureView: TraderView = {
  pilot: "Neon Courier",
  status: "running",
  day: 6,
  maxDay: 30,
  credits: 742,
  netWorth: 1118,
  fuel: 9,
  fuelCap: 20,
  fuelPrice: 4,
  cargoUsed: 9,
  cargoCap: 30,
  location: "vesper",
  routes: [
    routeTo("kiln", 4, 2),
    routeTo("tallow", 6, 3),
    routeTo("brine", 4, 2),
    routeTo("halcyon", 9, 5),
    routeTo("cinder", 12, 6, false),
  ],
  market: [
    { good: "ice", name: "Water ice", price: 22, held: 4, avgCost: 26 },
    { good: "seed", name: "Seed stock", price: 52, held: 0, avgCost: null },
    { good: "salt", name: "Reactor salt", price: 131, held: 5, avgCost: 104 },
    { good: "glass", name: "Kiln glass", price: 161, held: 0, avgCost: null },
    { good: "gel", name: "Medic gel", price: 286, held: 0, avgCost: null },
  ],
  profitableSales: 1,
  log: [
    { day: 6, text: "Landed at Vesper Yard." },
    { day: 4, text: "Sold 6 Kiln glass for 1,020." },
    { day: 1, text: "Bought 5 Reactor salt for 520." },
  ],
};
