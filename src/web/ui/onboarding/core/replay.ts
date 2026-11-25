import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { stateName, type TimelineResponse } from "../../src/model/timeline";
import { decimate } from "../../src/model/timelineTiles";
import type { EntityDetail, HealthModel, ModelRef, ModelSelection } from "../../src/model/types";
import { searchFromSelection } from "../../src/model/selection";

interface Recording {
  source: { provider: string; apiVersion: string; resourceGroup: string; observedAt: string };
  model: HealthModel;
  design: HealthModel;
  history: TimelineResponse;
}

const recording: Recording = JSON.parse(readFileSync(new URL("./data/recording.json", import.meta.url), "utf8"));
export const coreModel = recording.model;
export const coreHistory = recording.history;
export const coreObservedAt = recording.source.observedAt;
const subscriptionId = "00000000-0000-0000-0000-000000000000";
const resourceGroup = recording.source.resourceGroup;
export const coreTarget: ModelSelection = { name: coreModel.model.name, subscriptionId, resourceGroup };
export const coreUrl = "/" + searchFromSelection(coreTarget);
export const coreDesignTarget: ModelSelection = { ...coreTarget, name: recording.design.model.name };

function detail(model: HealthModel, name: string): EntityDetail | undefined {
  const entity = model.entities.find(item => item.name === name);
  if (!entity) return undefined;
  const history = model === coreModel ? coreHistory : null;
  const canonical = model.reportOptions.signalName;
  return {
    entity, observedAt: model.observedAt,
    transitions: (history?.states.find(item => item.entity === name)?.transitions ?? []).slice(-20).reverse()
      .map(row => ({ previousState: stateName(row.from), healthState: stateName(row.to), occurredAt: new Date(row.t).toISOString() })),
    canonicalSignal: {
      name: canonical, current: entity.signals.find(signal => signal.name === canonical) ?? null,
      history: (history?.reports ?? []).filter(row => row.entity === name).slice(-20).reverse()
        .map(row => ({ healthState: stateName(row.state), value: row.value, occurredAt: new Date(row.t).toISOString() })),
    },
  };
}

/** Honor the website's tile bounds, part selection, entity/signal filters and requested resolution. */
function historyFor(query: URLSearchParams): TimelineResponse {
  const history = coreHistory;
  const start = Date.parse(history.range.from);
  const end = Date.parse(history.range.to);
  const requestedFrom = Date.parse(query.get("from") ?? history.range.from);
  const to = Math.min(Date.parse(query.get("to") ?? history.range.to), end);
  const part = new Set((query.get("include") ?? "structure,states,annotations,reports").split(","));
  const names = query.getAll("entity");
  const signals = query.getAll("signal");
  const wanted = (name: string) => !names.length || names.includes(name);
  const inside = (time: number) => time >= requestedFrom && time <= to;
  const resolution = Number(query.get("resolution") ?? 0);
  // A query can include dates before the recording. Only the overlap was observed.
  const complete = requestedFrom >= start;
  return {
    ...history, resolution, partial: !complete,
    range: { from: new Date(requestedFrom).toISOString(), to: new Date(to).toISOString() },
    entities: part.has("structure") ? history.entities.filter(row => wanted(row.name)) : [],
    states: part.has("states") ? history.states.filter(row => wanted(row.entity)).map(row => ({
      ...row, transitions: row.transitions.filter(point => inside(point.t)), complete,
      earliest: complete ? null : Math.min(start, to),
    })) : [],
    series: part.has("signals") ? history.series.filter(row => wanted(row.entity) && (!signals.length || signals.includes(row.signal)))
      .map(row => ({ ...row, points: decimate(row.points.filter(point => inside(point[0])), 1000 * resolution),
        complete, earliest: complete ? null : Math.min(start, to) })) : [],
    reports: part.has("reports") ? history.reports.filter(row => wanted(row.entity) && inside(row.t)) : [],
    annotations: part.has("annotations") ? history.annotations.filter(row => wanted(row.entity) && inside(row.t)) : [],
  };
}

/** The local website reads a dated Azure recording. Its transport never forwards a request to the Azure deployment. */
export async function installCore(page: Page) {
  await page.clock.setFixedTime(new Date(coreObservedAt));
  const models = [coreModel, recording.design];
  const refs: ModelRef[] = models.map(({ model }) => ({
    ...coreTarget, name: model.name, id: null, location: model.location, provisioningState: model.provisioningState,
  }));
  const local = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  await page.route(url => local(url) && (["/api/health-models", "/api/health-model", "/api/timeline"].includes(url.pathname)
    || url.pathname.startsWith("/api/entities/")), async route => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    if (url.pathname === "/api/health-models") return route.fulfill({ json: { default: coreTarget, models: refs } });
    const model = models.find(entry => entry.model.name === (url.searchParams.get("model") ?? coreTarget.name));
    if (!model) return route.fallback();
    if (url.pathname === "/api/health-model") return route.fulfill({ json: model });
    if (url.pathname === "/api/timeline") {
      if (model !== coreModel) return route.fulfill({ status: 404, json: { error: {
        code: "history_not_recorded", message: "This walkthrough records CORE history.", retryable: false,
      } } });
      return route.fulfill({ json: historyFor(url.searchParams) });
    }
    const entity = detail(model, decodeURIComponent(url.pathname.slice("/api/entities/".length)));
    if (!entity) return route.fallback();
    await route.fulfill({ json: entity });
  });
  // Playwright routes buffer a reply to completion. Keep a genuine event stream open in the page
  // so pause, resume and the live status work without inventing new samples for a frozen snapshot.
  await page.addInitScript(inventories => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const model = inventories.find(item => item.model.name === url.searchParams.get("model"));
      if (url.origin !== location.origin || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          || url.pathname !== "/api/health-model/stream" || !model) return original(input, init);
      const encoder = new TextEncoder();
      let timer: number;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`id: 0123abcd-0\nevent: snapshot\ndata: ${JSON.stringify(model)}\n\n`));
          timer = window.setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 15000);
          init?.signal?.addEventListener("abort", () => { clearInterval(timer); controller.close(); }, { once: true });
        },
        cancel() { clearInterval(timer); },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    };
  }, models);
}
