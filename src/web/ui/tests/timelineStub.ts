import type { Page } from "@playwright/test";
import type { Entity, HealthModel } from "../src/model/types";
import { buildFixture, topologyFixture, type TimelineFixture } from "../src/model/timelineFixture";
import { stateName } from "../src/model/timeline";
import { healthModel, installStubs } from "./fixture";

export const RULES = {
  degraded: { operator: "GreaterThan", threshold: 70 },
  unhealthy: { operator: "GreaterThan", threshold: 90 },
  dynamic: false,
} as const;

/** The history of the stubbed model `healthModel` of tests/fixture.ts: same entity names, simulated from "now". */
export function stubbedHistory(now: number): TimelineFixture {
  return topologyFixture(
    healthModel.entities.map((entity) => ({
      name: entity.name,
      displayName: entity.displayName,
      parents: entity.parents,
      signals: entity.signals.map((signal) => ({
        name: signal.name,
        displayName: signal.displayName ?? signal.name,
        kind: "AzureResourceMetric",
        unit: "Percent",
        refreshInterval: "PT5M",
        rules: RULES,
      })),
    })),
    { now, days: 14 },
  );
}

/** A graph model with the same entities as a simulated history, for the specs that need many. */
export function modelOf(fixture: TimelineFixture): HealthModel {
  const entities: Entity[] = fixture.entities.map((entity) => ({
    name: entity.name,
    displayName: entity.displayName,
    healthState: stateName(entity.state),
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: entity.parents,
    children: fixture.entities.filter((other) => other.parents.includes(entity.name)).map((other) => other.name),
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: "web-ui-health-report" },
  }));
  return {
    ...healthModel,
    entities,
    relationships: fixture.entities.flatMap((entity) =>
      entity.parents.map((parent) => ({ name: `${parent}-${entity.name}`, displayName: null, parentEntityName: parent, childEntityName: entity.name })),
    ),
  };
}

export interface TimelineRequests {
  readonly seen: URLSearchParams[];
}

/** Answers GET /api/timeline from a simulated history, as the service does: the window, the entities, the parts. */
export async function installTimeline(page: Page, fixture: TimelineFixture, answer?: (query: URLSearchParams) => number): Promise<TimelineRequests> {
  const seen: URLSearchParams[] = [];
  await page.route("**/api/timeline?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    seen.push(query);
    const from = Date.parse(query.get("from") ?? "");
    const to = Date.parse(query.get("to") ?? "");
    const include = (query.get("include") ?? "").split(",");
    const body = include.includes("signals") ? fixture.signals(query.getAll("entity"), from, to) : fixture.overview(from, to);
    const status = answer?.(query) ?? 200;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(status === 200 ? body : { error: { code: "health_model_unavailable", message: "Health Model data is temporarily unavailable.", retryable: true, operationId: "x" } }),
    });
  });
  return { seen };
}

export async function bootWith(page: Page, fixture: TimelineFixture, model?: HealthModel): Promise<TimelineRequests> {
  await installStubs(page, { healthModelFails: false, ...(model ? { model } : {}) });
  return installTimeline(page, fixture);
}

export { buildFixture };
