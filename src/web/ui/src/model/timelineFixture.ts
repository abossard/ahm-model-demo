import { MINUTE, HOUR } from "./timelineScale";
import { decimate, levelOfResolution } from "./timelineTiles";
import { EMPTY_STORE, mergeAnswer, toTimelineData, type TimeStore } from "./timeStore";
import { EMPTY_TIMELINE } from "./timeline";
import type {
  Annotation,
  EntityInfo,
  Point,
  Report,
  SignalInfo,
  StateCode,
  TimelineData,
  TimelineResponse,
  Transition,
} from "./timeline";

/** What the browser holds after some answers for the whole model: the store, and the store as the plot reads it. */
export function heldFrom(...responses: readonly TimelineResponse[]): { readonly store: TimeStore; readonly data: TimelineData } {
  let store = EMPTY_STORE;
  for (const response of responses) {
    store = mergeAnswer(store, response, { parts: ["structure", "states", "annotations", "reports", ...(response.series.length > 0 ? (["signals"] as const) : [])], entities: null, signals: null, level: levelOfResolution(response.resolution) });
  }
  return { store, data: toTimelineData(store, { level: 0, window: null }, EMPTY_TIMELINE) };
}

/** A synthetic health model with history, shaped like GET /api/timeline answers it: for tests, benchmarks and stubs. */
export interface FixtureOptions {
  /** The instant "now" is. */
  readonly now: number;
  readonly flows?: number;
  readonly componentsPerFlow?: number;
  readonly resourcesPerComponent?: number;
  readonly signalsPerResource?: number;
  readonly days?: number;
  readonly intervalMs?: number;
}

export interface TimelineFixture {
  readonly entities: readonly EntityInfo[];
  readonly options: Required<FixtureOptions>;
  /** The incidents of the root, as [from, to] with `to` null while going. */
  readonly incidents: readonly (readonly [number, number | null])[];
  readonly overview: (from: number, to: number) => TimelineResponse;
  readonly signals: (names: readonly string[], from: number, to: number) => TimelineResponse;
  /** What GET /api/timeline answers to a query: the parts, the entities, the signals and the resolution it asks for. */
  readonly answer: (query: FixtureQuery) => TimelineResponse;
  readonly signalCount: number;
}

export interface FixtureQuery {
  readonly from: number;
  readonly to: number;
  readonly include: readonly string[];
  /** Empty for every entity. */
  readonly entities?: readonly string[];
  /** Empty for every signal. */
  readonly signals?: readonly string[];
  /** Seconds a slot, 0 for every point. */
  readonly resolution?: number;
}

const RULES_HIGH: SignalInfo["rules"] = {
  degraded: { operator: "GreaterThan", threshold: 70 },
  unhealthy: { operator: "GreaterThan", threshold: 90 },
  dynamic: false,
};
const RULES_LOW: SignalInfo["rules"] = {
  degraded: { operator: "LessThan", threshold: 99 },
  unhealthy: { operator: "LessThan", threshold: 95 },
  dynamic: false,
};
const SIGNAL_NAMES = ["cpu", "memory", "latency", "availability", "errors", "queue"] as const;

function unit(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

function judge(value: number | null, rules: SignalInfo["rules"]): StateCode {
  if (value === null) return 0;
  const low = rules.degraded?.operator === "LessThan";
  const degraded = rules.degraded?.threshold ?? 0;
  const unhealthy = rules.unhealthy?.threshold ?? 0;
  if (low) return value < unhealthy ? 3 : value < degraded ? 2 : 1;
  return value > unhealthy ? 3 : value > degraded ? 2 : 1;
}

function worstOf(states: readonly StateCode[]): StateCode {
  const known = states.filter((state) => state !== 0);
  if (known.length === 0) return 0;
  return known.includes(3) ? 3 : known.includes(2) ? 2 : 1;
}

export function buildFixture(options: FixtureOptions): TimelineFixture {
  const full: Required<FixtureOptions> = {
    flows: 3,
    componentsPerFlow: 2,
    resourcesPerComponent: 3,
    signalsPerResource: 4,
    days: 14,
    intervalMs: 5 * MINUTE,
    ...options,
  };
  const entities: EntityInfo[] = [];
  const faulty = new Set<string>();
  const addEntity = (name: string, displayName: string, parents: string[], signals: SignalInfo[]): void => {
    entities.push({ name, displayName, parents, state: 1, signals });
  };
  addEntity("root", "Shop", [], []);
  let resourceIndex = 0;
  for (let f = 0; f < full.flows; f += 1) {
    addEntity(`flow-${f}`, `Flow ${f}`, ["root"], []);
    for (let c = 0; c < full.componentsPerFlow; c += 1) {
      addEntity(`flow-${f}-comp-${c}`, `Component ${f}.${c}`, [`flow-${f}`], []);
      for (let r = 0; r < full.resourcesPerComponent; r += 1) {
        const signals: SignalInfo[] = [];
        for (let s = 0; s < full.signalsPerResource; s += 1) {
          const label = SIGNAL_NAMES[s % SIGNAL_NAMES.length] ?? "cpu";
          const rules = label === "availability" ? RULES_LOW : RULES_HIGH;
          const name = `${label}${s >= SIGNAL_NAMES.length ? s : ""}`;
          signals.push({
            name,
            displayName: label.charAt(0).toUpperCase() + label.slice(1),
            kind: s % 3 === 2 ? "AzureLogAnalytics" : "AzureResourceMetric",
            unit: label === "latency" ? "MilliSeconds" : "Percent",
            refreshInterval: "PT5M",
            rules,
          });
        }
        const name = `res-${resourceIndex}`;
        if (resourceIndex % 5 === 3) faulty.add(name);
        addEntity(name, `Resource ${resourceIndex}`, [`flow-${f}-comp-${c}`], signals);
        resourceIndex += 1;
      }
    }
  }
  return simulate(entities, full, faulty);
}

/** The entities of a model, without history, as `[name, displayName, parents, signals]`: a topology to simulate. */
export function topologyFixture(
  topology: readonly Pick<EntityInfo, "name" | "displayName" | "parents" | "signals">[],
  options: FixtureOptions,
): TimelineFixture {
  const full: Required<FixtureOptions> = { flows: 0, componentsPerFlow: 0, resourcesPerComponent: 0, signalsPerResource: 0, days: 14, intervalMs: 5 * MINUTE, ...options };
  const entities = topology.map((entity): EntityInfo => ({ ...entity, state: 1 }));
  const faulty = new Set(entities.filter((entity, index) => entity.signals.length > 0 && index % 3 === 1).map((entity) => entity.name));
  return simulate(entities, full, faulty);
}

function simulate(entities: EntityInfo[], full: Required<FixtureOptions>, faulty: ReadonlySet<string>): TimelineFixture {
  const { now, intervalMs } = full;
  const incidents: readonly (readonly [number, number | null])[] = [
    [now - 3 * 24 * HOUR - 2 * HOUR, now - 3 * 24 * HOUR],
    [now - 6 * HOUR, now - 4.5 * HOUR],
    [now - 95 * MINUTE, null],
  ];
  const children = new Map<string, string[]>();
  for (const entity of entities) for (const parent of entity.parents) children.set(parent, [...(children.get(parent) ?? []), entity.name]);

  const indexOf = new Map(entities.map((entity, index) => [entity.name, index]));

  const valueAt = (entity: string, signal: SignalInfo, index: number, t: number): number | null => {
    const e = indexOf.get(entity) ?? 0;
    const bucket = Math.floor(t / intervalMs);
    if (e % 11 === 5 && index === 1 && ((now - t) / HOUR) % 24 > 22.5 && now - t > 2 * HOUR) return null;
    const high = signal.rules.degraded?.operator !== "LessThan";
    const wobble = unit(e * 31 + index, bucket) - 0.5;
    const inIncident = incidents.some(([from, to]) => t >= from && t <= (to ?? now + intervalMs));
    const hit = faulty.has(entity) && inIncident && index % 2 === 0;
    if (!high) return Math.round((hit ? 93 + wobble * 3 : 99.6 + wobble * 0.7) * 100) / 100;
    const base = 28 + 12 * Math.sin((t / HOUR / 24) * 2 * Math.PI + e) + wobble * 14;
    return Math.round((hit ? 88 + wobble * 18 : base) * 100) / 100;
  };

  const own = (entity: EntityInfo, t: number): StateCode[] =>
    entity.signals.map((signal, index) => judge(valueAt(entity.name, signal, index, t), signal.rules));
  const stateAt = (name: string, t: number): StateCode => {
    const entity = entities[indexOf.get(name) ?? 0] as EntityInfo;
    return worstOf([...own(entity, t), ...(children.get(name) ?? []).map((child) => stateAt(child, t))]);
  };

  const start = Math.ceil((now - full.days * 24 * HOUR) / intervalMs) * intervalMs;
  const grid = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let t = Math.max(start, Math.ceil(from / intervalMs) * intervalMs); t <= Math.min(now, to); t += intervalMs) out.push(t);
    return out;
  };
  const transitionsOf = (name: string, from: number, to: number): Transition[] => {
    const out: Transition[] = [];
    let previous: StateCode = from <= start ? 0 : stateAt(name, Math.floor((from - 1) / intervalMs) * intervalMs);
    for (const t of grid(from, to)) {
      const state = stateAt(name, t);
      if (state !== previous) {
        out.push({ t, from: previous, to: state, reason: name === "root" || (children.get(name)?.length ?? 0) > 0 ? "ChildEntityTransition" : "SignalTransition" });
        previous = state;
      }
    }
    return out;
  };

  const withState = entities.map((entity) => ({ ...entity, state: stateAt(entity.name, Math.floor(now / intervalMs) * intervalMs) }));
  const firstFaulty = [...faulty][0] ?? "res-0";
  const annotations: Annotation[] = [
    { entity: firstFaulty, id: "a1", t: incidents[2]?.[0] ?? now, description: "Failover started", details: { phase: "start", source: "runbook" } },
    { entity: "root", id: "a2", t: now - 30 * HOUR, description: "Release 2026.11.10", details: { source: "deployment" } },
  ];
  const reports: Report[] = [
    { entity: "flow-0", t: now - 100 * MINUTE, state: 2, value: 0.5, reason: "Maintenance window", reportId: "r1" },
  ];
  const range = (from: number, to: number): TimelineResponse["range"] => ({
    from: new Date(from).toISOString(),
    to: new Date(Math.min(to, now)).toISOString(),
  });
  const base = (from: number, to: number): Omit<TimelineResponse, "entities" | "states" | "series" | "annotations" | "reports"> => ({
    model: "hm-fixture",
    observedAt: new Date(now).toISOString(),
    range: range(from, to),
    retentionDays: 30,
    resolution: 0,
    partial: false,
    failures: [],
  });

  const answer = (query: FixtureQuery): TimelineResponse => {
    const part = (name: string): boolean => query.include.includes(name);
    const asked = withState.filter((entity) => !query.entities?.length || query.entities.includes(entity.name));
    const names = new Set(asked.map((entity) => entity.name));
    const { from, to } = query;
    return {
      ...base(from, to),
      resolution: query.resolution ?? 0,
      entities: part("structure") ? asked : [],
      states: part("states") ? asked.map((entity) => ({ entity: entity.name, transitions: transitionsOf(entity.name, from, to), complete: true, earliest: null })) : [],
      series: part("signals")
        ? asked.flatMap((entity) =>
            entity.signals
              .map((signal, index) => ({ signal, index }))
              .filter(({ signal }) => !query.signals?.length || query.signals.includes(signal.name))
              .map(({ signal, index }) => ({
                entity: entity.name,
                signal: signal.name,
                points: decimate(
                  grid(from, to).map((t): Point => {
                    const value = valueAt(entity.name, signal, index, t);
                    return [t, value, judge(value, signal.rules)];
                  }),
                  (query.resolution ?? 0) * 1000,
                ),
                complete: true,
                earliest: null,
              })),
          )
        : [],
      annotations: part("annotations") ? annotations.filter((item) => names.has(item.entity) && item.t >= from && item.t <= to) : [],
      reports: part("reports") ? reports.filter((item) => names.has(item.entity) && item.t >= from && item.t <= to) : [],
    };
  };

  return {
    entities: withState,
    options: full,
    incidents,
    answer,
    signalCount: withState.reduce((sum, entity) => sum + entity.signals.length, 0),
    overview: (from, to) => ({
      ...base(from, to),
      entities: withState,
      states: withState.map((entity) => ({ entity: entity.name, transitions: transitionsOf(entity.name, from, to), complete: true, earliest: null })),
      series: [],
      annotations: annotations.filter((item) => item.t >= from && item.t <= to),
      reports: reports.filter((item) => item.t >= from && item.t <= to),
    }),
    signals: (names, from, to) => ({
      ...base(from, to),
      entities: withState.filter((entity) => names.includes(entity.name)),
      states: [],
      series: withState
        .filter((entity) => names.includes(entity.name))
        .flatMap((entity) =>
          entity.signals.map((signal, index) => ({
            entity: entity.name,
            signal: signal.name,
            points: grid(from, to).map((t): Point => {
              const value = valueAt(entity.name, signal, index, t);
              return [t, value, judge(value, signal.rules)];
            }),
            complete: true,
            earliest: null,
          })),
        ),
      annotations: [],
      reports: [],
    }),
  };
}
