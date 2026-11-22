import { describe, expect, it } from "vitest";
import { healthModel } from "../../tests/fixture";
import type { HealthModel } from "../model/types";
import { nextStops, tourStops, type StopId } from "./stops";

const standalone = { ...healthModel, relationships: [], entities: [healthModel.entities[2]!] };
const empty = { ...healthModel, relationships: [], entities: [] };

describe("the assistant's tour", () => {
  it.each([
    ["connected", healthModel, ["dependency", "entity", "signal"]],
    ["standalone", standalone, ["entity"]],
    ["empty", empty, []],
  ] as [string, HealthModel, StopId[]][])("offers real branches at every stop on a %s model", (_, model, objectStops) => {
    const stops = tourStops(model, null);
    expect(stops.filter(stop => ["dependency", "entity", "signal"].includes(stop.id)).map(stop => stop.id).sort()).toEqual(objectStops);
    for (const stop of stops) {
      const choices = nextStops(stop, stops).map(item => item.id);
      expect(choices.length).toBeGreaterThanOrEqual(2);
      expect(choices.length).toBeLessThanOrEqual(3);
      expect(new Set(choices).size).toBe(choices.length);
      expect(choices).not.toContain(stop.id);
      expect(choices.every(id => stops.some(item => item.id === id))).toBe(true);
    }
  });

  it.each([
    ["svc-a", "connection/r1", "signal/svc-a/latency"],
    ["svc-c", "connection/r2", "signal/svc-b/queue"],
    ["gone", "connection/r1", "signal/svc-b/queue"],
  ])("uses the selected entity %s when choosing a connection and a signal", (selected, connection, signal) => {
    const stops = tourStops(healthModel, selected);
    expect(stops.find(stop => stop.id === "dependency")?.action.id).toBe(connection);
    expect(stops.find(stop => stop.id === "signal")?.action.id).toBe(signal);
  });
});
