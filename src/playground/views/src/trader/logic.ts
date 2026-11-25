// Drift Ledger view logic. Calculations only: no React, no clock, no I/O.
import type { GoodId, PlanetId, TraderScore, TraderView } from "@playground/contracts";

export type Route = TraderView["routes"][number];
export type MarketRow = TraderView["market"][number];

export const QTY_STEPS = [1, 5, 10, 99] as const;
export type Qty = (typeof QTY_STEPS)[number];
export const MAX_QTY: Qty = 99;

export function qtyLabel(qty: number): string {
  return qty === MAX_QTY ? "Max" : String(qty);
}

export function formatCredits(value: number): string {
  return value.toLocaleString("en-US");
}

export function fraction(value: number, cap: number): number {
  return cap <= 0 ? 0 : Math.min(1, Math.max(0, value / cap));
}

export function daysLeft(view: Pick<TraderView, "day" | "maxDay">): number {
  return Math.max(0, view.maxDay - view.day);
}

export function isOver(view: Pick<TraderView, "status">): boolean {
  return view.status === "over";
}

// Map units (0..100) to a percentage inside the chart with a margin, so a port on the edge keeps its label.
export function chartPoint(x: number, y: number): { left: number; top: number } {
  const margin = 8;
  const span = 100 - margin * 2;
  return { left: margin + (x / 100) * span, top: margin + (y / 100) * span };
}

// Where each port's name sits against its node, chosen so no two labels or routes cross it on the 100 by 100 map.
const PORT_SIDE: Record<PlanetId, "left" | "right" | "above" | "below"> = {
  vesper: "below", kiln: "above", tallow: "right", brine: "right", halcyon: "above", cinder: "below",
};

export function portSide(planet: PlanetId): "left" | "right" | "above" | "below" {
  return PORT_SIDE[planet];
}

// How many units of a row a buy of `want` really moves: the server fits to credits and space.
export function buyFit(view: TraderView, row: MarketRow, want: number): number {
  const byCredits = Math.floor(view.credits / row.price);
  const bySpace = view.cargoCap - view.cargoUsed;
  return Math.max(0, Math.min(want, byCredits, bySpace));
}

export function sellFit(row: MarketRow, want: number): number {
  return Math.max(0, Math.min(want, row.held));
}

export type Margin = { kind: "none" } | { kind: "up" | "down" | "flat"; perUnit: number };

// Held units against the price here: what a sale right now would earn per unit.
export function margin(row: MarketRow): Margin {
  if (row.held === 0 || row.avgCost === null) return { kind: "none" };
  const perUnit = Math.round(row.price - row.avgCost);
  return { kind: perUnit > 0 ? "up" : perUnit < 0 ? "down" : "flat", perUnit };
}

export function marginText(m: Margin): string {
  if (m.kind === "none") return "";
  if (m.kind === "flat") return "even";
  return `${m.perUnit > 0 ? "+" : "−"}${Math.abs(m.perUnit)} each`;
}

export function refuelUnits(view: TraderView): number {
  return Math.max(0, Math.min(view.fuelCap - view.fuel, Math.floor(view.credits / view.fuelPrice)));
}

export function refuelCost(view: TraderView): number {
  return refuelUnits(view) * view.fuelPrice;
}

export function routeCostText(route: Pick<Route, "fuelCost" | "days">): string {
  return `${route.fuelCost} fuel, ${route.days} ${route.days === 1 ? "day" : "days"}`;
}

export type JumpState = "here" | "ready" | "no_fuel" | "over";

export function jumpState(view: TraderView, route: Route | undefined, planet: PlanetId): JumpState {
  if (isOver(view)) return "over";
  if (planet === view.location || !route) return "here";
  if (!route.reachable || route.fuelCost > view.fuel) return "no_fuel";
  return "ready";
}

export function jumpHint(state: JumpState): string {
  switch (state) {
    case "here": return "You are here.";
    case "no_fuel": return "Not enough fuel. Refuel first.";
    case "over": return "The run is over.";
    case "ready": return "";
  }
}

// The planet with the best sale for what the hold carries is not known to the View: it sees one market.
// What it can say honestly is where a held good sells above its cost right here.
export function sellable(view: TraderView): GoodId[] {
  return view.market.filter((row) => margin(row).kind === "up").map((row) => row.good);
}

export function holdUnits(view: TraderView): number {
  return view.market.reduce((sum, row) => sum + row.held, 0);
}

export function holdValue(view: TraderView): number {
  return view.market.reduce((sum, row) => sum + row.held * row.price, 0);
}

export interface RankedScore extends TraderScore {
  rank: number;
  mine: boolean;
}

export function rankScores(scores: readonly TraderScore[], pilot: string): RankedScore[] {
  return [...scores]
    .sort((a, b) => b.netWorth - a.netWorth || b.day - a.day)
    .map((score, index) => ({ ...score, rank: index + 1, mine: score.handle === pilot }));
}

export function verdict(view: Pick<TraderView, "netWorth" | "profitableSales">): string {
  const start = 1000;
  if (view.netWorth >= start * 3) return "A run the ports will talk about.";
  if (view.netWorth > start) return "The ledger closes in the black.";
  if (view.netWorth === start) return "Even. The fuel was the only profit.";
  return "The ledger closes in the red.";
}

export function modelContextText(view: TraderView, planetName: string): string {
  return view.status === "over"
    ? `Drift Ledger run over on day ${view.day}. Net worth ${view.netWorth}.`
    : `Drift Ledger day ${view.day} of ${view.maxDay} at ${planetName}. ${view.credits} credits, ${view.fuel} fuel, ${view.cargoUsed} units of cargo.`;
}

// The kind of a ledger line, for the log's chips: what the pilot did.
export function logKind(text: string): string {
  if (text.startsWith("Bought")) return "buy";
  if (text.startsWith("Sold")) return "sell";
  if (text.startsWith("Refuelled")) return "refuel";
  if (text.startsWith("Jumped")) return "jump";
  return "run";
}
