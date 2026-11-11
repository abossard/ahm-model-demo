// @vitest-environment node
import { describe, it } from "vitest";
import { arrange } from "./arrange";
import { causePath } from "./causePath";
import { layoutCause } from "./causeLayout";
import { coverage } from "./coverage";
import { layoutCoverage } from "./coverageLayout";
import { routeSteps } from "./stepRouter";
import { denseIncidentModel, incidentModel } from "../../tests/viewModels";
import type { Entity, HealthModel } from "./types";

// Timing notes for the view calculations, not assertions: a timing bound flakes on a loaded machine.
//   BENCH=1 npx vitest run src/model/views.bench.test.ts
const bench = process.env["BENCH"] ? describe : describe.skip;

function median(run: () => unknown): number {
  run();
  const times = Array.from({ length: 9 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return times[4] as number;
}

function large(count: number): HealthModel {
  const base = incidentModel();
  const entities: Entity[] = Array.from({ length: count }, (_, index) => ({
    ...(base.entities[0] as Entity),
    name: `n${index}`,
    displayName: `Node ${index}`,
    healthState: index % 9 === 0 ? "Degraded" : "Healthy",
    signals: [],
  }));
  const relationships = entities.slice(1).map((entity, index) => ({ name: `r${index}`, displayName: null, parentEntityName: `n${Math.floor(index / 4)}`, childEntityName: entity.name }));
  return { ...base, entities, relationships };
}

bench("view calculations", () => {
  const measure = (text: string): number => text.length * 6;
  it.each([
    ["incident, 17 entities", incidentModel()],
    ["dense, 81 entities", denseIncidentModel()],
    ["generated, 300 entities", large(300)],
  ] as const)("%s", (name, model) => {
    const path = causePath(model.entities, model.relationships);
    const layout = layoutCause(model.entities, model.relationships, path, measure);
    const sizes = new Map(model.entities.map((entity) => [entity.name, { width: 200, height: 72 }] as const));
    const arranged = arrange(model.entities.map((entity) => ({ name: entity.name, ...sizes.get(entity.name)! })), model.relationships, "tb");
    const nodes = model.entities.map((entity) => ({ id: entity.name, ...arranged.positions.get(entity.name)!, ...sizes.get(entity.name)! }));
    const rows = {
      "causePath (ms)": median(() => causePath(model.entities, model.relationships)),
      "causePath + layoutCause, folded (ms)": median(() => layoutCause(model.entities, model.relationships, causePath(model.entities, model.relationships), measure)),
      "arrange, everything (ms)": median(() => arrange(model.entities.map((entity) => ({ name: entity.name, ...sizes.get(entity.name)! })), model.relationships, "tb")),
      "routeSteps, everything (ms)": median(() => routeSteps(nodes, model.relationships.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName, labelWidth: item.displayName ? 60 : 0 })))),
      "coverage + layoutCoverage (ms)": median(() => layoutCoverage(coverage(model.entities, model.relationships), (n) => n, 1360)),
      "nodes drawn by causePath": layout.nodes.length,
    };
    console.log(name, JSON.stringify(Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, typeof value === "number" ? Math.round(value * 100) / 100 : value]))));
  });
});
