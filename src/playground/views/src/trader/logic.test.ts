import { describe, expect, it } from "vitest";
import type { TraderView } from "@playground/contracts";
import { fixtureView } from "./fixtures";
import {
  buyFit, chartPoint, logKind, portSide, daysLeft, fraction, holdUnits, holdValue, jumpState, margin, marginText, qtyLabel,
  rankScores, refuelCost, refuelUnits, routeCostText, sellFit, sellable, verdict,
} from "./logic";

const view = (patch: Partial<TraderView>): TraderView => ({ ...fixtureView, ...patch });
const row = (good: string) => fixtureView.market.find((r) => r.good === good)!;

describe("fraction", () => {
  it.each([
    [0, 20, 0], [10, 20, 0.5], [25, 20, 1], [-3, 20, 0], [5, 0, 0],
  ])("fraction(%i of %i) = %f", (value, cap, expected) => {
    expect(fraction(value, cap)).toBe(expected);
  });
});

describe("qtyLabel", () => {
  it.each([[1, "1"], [5, "5"], [10, "10"], [99, "Max"]])("%i reads %s", (qty, label) => {
    expect(qtyLabel(qty)).toBe(label);
  });
});

describe("daysLeft", () => {
  it.each([[1, 29], [29, 1], [30, 0]])("day %i leaves %i", (day, left) => {
    expect(daysLeft({ day, maxDay: 30 })).toBe(left);
  });
});

describe("chartPoint", () => {
  it.each([
    [0, 0, 8, 8], [100, 100, 92, 92], [50, 50, 50, 50],
  ])("(%i,%i) lands at %f%%,%f%%", (x, y, left, top) => {
    expect(chartPoint(x, y)).toEqual({ left, top });
  });
});

describe("buyFit", () => {
  it.each([
    ["plenty of everything", { credits: 1000, cargoUsed: 0 }, "ice", 5, 5],
    ["credits bind", { credits: 50, cargoUsed: 0 }, "ice", 5, 2],
    ["space binds", { credits: 1000, cargoUsed: 28 }, "ice", 5, 2],
    ["full hold", { credits: 1000, cargoUsed: 30 }, "ice", 5, 0],
    ["broke", { credits: 5, cargoUsed: 0 }, "glass", 1, 0],
  ])("%s", (_name, patch, good, want, expected) => {
    expect(buyFit(view(patch), row(good), want)).toBe(expected);
  });
});

describe("sellFit", () => {
  it.each([[5, 3, 3], [2, 3, 2], [99, 3, 3]])("want %i of %i held sells %i", (want, held, expected) => {
    expect(sellFit({ ...row("ice"), held }, want)).toBe(expected);
  });
});

describe("margin", () => {
  it.each([
    ["nothing held", { held: 0, avgCost: null, price: 20 }, "none", ""],
    ["above cost", { held: 4, avgCost: 15, price: 22 }, "up", "+7 each"],
    ["below cost", { held: 4, avgCost: 30, price: 22 }, "down", "−8 each"],
    ["even", { held: 4, avgCost: 22, price: 22 }, "flat", "even"],
  ])("%s", (_name, patch, kind, text) => {
    const m = margin({ ...row("ice"), ...patch });
    expect(m.kind).toBe(kind);
    expect(marginText(m)).toBe(text);
  });
});

describe("refuel", () => {
  it.each([
    ["room and money", { fuel: 12, credits: 1000 }, 8, 8 * 4],
    ["credits bind", { fuel: 12, credits: 10 }, 2, 8],
    ["tank full", { fuel: 20, credits: 1000 }, 0, 0],
    ["no credits", { fuel: 3, credits: 0 }, 0, 0],
  ])("%s", (_name, patch, units, cost) => {
    expect(refuelUnits(view(patch))).toBe(units);
    expect(refuelCost(view(patch))).toBe(cost);
  });
});

describe("routeCostText", () => {
  it.each([[{ fuelCost: 3, days: 1 }, "3 fuel, 1 day"], [{ fuelCost: 7, days: 4 }, "7 fuel, 4 days"]])("%o", (route, text) => {
    expect(routeCostText(route)).toBe(text);
  });
});

describe("jumpState", () => {
  const kiln = fixtureView.routes.find((r) => r.to === "kiln")!;
  it.each([
    ["current port", {}, undefined, "vesper", "here"],
    ["reachable", {}, kiln, "kiln", "ready"],
    ["too far", { fuel: 1 }, kiln, "kiln", "no_fuel"],
    ["flagged unreachable", {}, { ...kiln, reachable: false }, "kiln", "no_fuel"],
    ["run over", { status: "over" as const }, kiln, "kiln", "over"],
  ])("%s", (_name, patch, route, planet, expected) => {
    expect(jumpState(view(patch), route, planet as never)).toBe(expected);
  });
});

describe("hold", () => {
  it("sums units and value at local prices", () => {
    expect(holdUnits(fixtureView)).toBe(9);
    expect(holdValue(fixtureView)).toBe(row("ice").held * row("ice").price + row("salt").held * row("salt").price);
  });
  it("lists goods that sell above cost here", () => {
    expect(sellable(fixtureView)).toEqual(["salt"]);
  });
});

describe("rankScores", () => {
  it("orders by net worth, breaks ties by day, marks the pilot", () => {
    const ranked = rankScores(
      [{ handle: "B", netWorth: 900, day: 30 }, { handle: "A", netWorth: 2000, day: 30 }, { handle: "C", netWorth: 900, day: 12 }],
      "C",
    );
    expect(ranked.map((r) => [r.handle, r.rank, r.mine])).toEqual([["A", 1, false], ["B", 2, false], ["C", 3, true]]);
  });
});

describe("verdict", () => {
  it.each([[3500, "A run that people at the ports will talk about."], [1500, "The ledger closes in the black."], [1000, "Even. The fuel was the only profit."], [400, "The ledger closes in the red."]])(
    "net worth %i", (netWorth, text) => {
      expect(verdict({ netWorth, profitableSales: 0 })).toBe(text);
    },
  );
});

describe("portSide", () => {
  it.each([["vesper", "below"], ["kiln", "above"], ["halcyon", "above"], ["cinder", "below"]] as const)("%s opens %s", (planet, side) => {
    expect(portSide(planet)).toBe(side);
  });
});

describe("logKind", () => {
  it.each([
    ["Bought 5 ice at 20.", "buy"], ["Sold 5 ice at 24.", "sell"], ["Refuelled 4 at 3.", "refuel"],
    ["Jumped to Kiln.", "jump"], ["A new run begins.", "run"], ["The run is over. Net worth 900.", "run"],
  ])("%s", (text, kind) => {
    expect(logKind(text)).toBe(kind);
  });
});
