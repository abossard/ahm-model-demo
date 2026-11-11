import type { Annotation, Report, Transition as TimelineTransition } from "./timeline";
import type { Entity, HealthModel, ModelSummary, ReportOptions, Relationship } from "./types";

/** What a `delta` event of GET /api/health-model/stream carries: only what changed. Items are whole entities and relationships. */
export interface LiveDelta {
  readonly observedAt?: string;
  readonly model?: Partial<ModelSummary>;
  readonly reportOptions?: ReportOptions;
  readonly entities?: { readonly upsert?: readonly Entity[]; readonly remove?: readonly string[] };
  readonly relationships?: { readonly upsert?: readonly Relationship[]; readonly remove?: readonly string[] };
  /** The entity order, sent only when entities were added or removed. */
  readonly order?: readonly string[];
  readonly timeline?: LiveTimeline;
}

export interface LiveTimeline {
  readonly transitions?: readonly (TimelineTransition & { readonly entity: string })[];
  readonly points?: readonly { readonly entity: string; readonly signal: string; readonly points: readonly (readonly [number, number | null, number])[] }[];
  readonly annotations?: readonly Annotation[];
  readonly reports?: readonly Report[];
}

export type LiveEvent =
  | { readonly kind: "snapshot"; readonly id: string | null; readonly model: HealthModel }
  | { readonly kind: "delta"; readonly id: string | null; readonly delta: LiveDelta }
  /** The server dropped this stream for being too slow: start again from a snapshot. */
  | { readonly kind: "resync" }
  /** The token that opened the stream expired: connect again with a fresh one and the last id. */
  | { readonly kind: "reconnect" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

/** Reads the frame of an event stream into an event; null for a frame this client does not know or cannot read. */
export function parseLiveFrame(event: string, data: string, id: string | null): LiveEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  switch (event) {
    case "snapshot":
      return { kind: "snapshot", id, model: body as HealthModel };
    case "delta":
      return { kind: "delta", id, delta: body as LiveDelta };
    case "resync":
      return { kind: "resync" };
    case "reconnect":
      return { kind: "reconnect" };
    case "error": {
      const error = (body as { error?: { code?: string; message?: string } }).error;
      return { kind: "error", code: error?.code ?? "error", message: error?.message ?? "The live connection was refused." };
    }
    default:
      return null;
  }
}

function replaceBy<T extends { readonly name: string }>(
  items: readonly T[],
  change: { readonly upsert?: readonly T[]; readonly remove?: readonly string[] } | undefined,
): readonly T[] {
  if (!change) return items;
  const removed = new Set(change.remove ?? []);
  const upserts = new Map((change.upsert ?? []).map((item) => [item.name, item]));
  const kept = items.filter((item) => !removed.has(item.name)).map((item) => {
    const next = upserts.get(item.name);
    upserts.delete(item.name);
    return next ?? item;
  });
  return upserts.size === 0 && removed.size === 0 && kept.every((item, index) => item === items[index]) ? items : [...kept, ...upserts.values()];
}

/**
 * The model a delta leads to. Entities and relationships the delta does not touch keep their identity, and so does the
 * whole `relationships` array when only entities changed, so a view that is keyed on its structure does not lay out again.
 */
export function applyDelta(model: HealthModel, delta: LiveDelta): HealthModel {
  let entities = replaceBy(model.entities, delta.entities);
  if (delta.order) {
    const position = new Map(delta.order.map((name, index) => [name, index]));
    entities = [...entities].sort((a, b) => (position.get(a.name) ?? delta.order!.length) - (position.get(b.name) ?? delta.order!.length));
  }
  const relationships = replaceBy(model.relationships, delta.relationships);
  const summary = delta.model ? { ...model.model, ...delta.model } : model.model;
  const changed = entities !== model.entities || relationships !== model.relationships || summary !== model.model || delta.reportOptions !== undefined;
  // A delta that only says when it was observed changes nothing a view draws: the same model keeps every view still.
  if (!changed) return model;
  return {
    model: summary,
    observedAt: delta.observedAt ?? model.observedAt,
    entities,
    relationships,
    reportOptions: delta.reportOptions ?? model.reportOptions,
  };
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A full observation laid over what is held: whatever is equal keeps its old object, so only what changed re-renders. */
export function mergeSnapshot(held: HealthModel | null, next: HealthModel): HealthModel {
  if (held === null) return next;
  const old = new Map(held.entities.map((entity) => [entity.name, entity]));
  const entities = next.entities.map((entity) => {
    const before = old.get(entity.name);
    return before && same(before, entity) ? before : entity;
  });
  const oldLinks = new Map(held.relationships.map((link) => [link.name, link]));
  const links = next.relationships.map((link) => {
    const before = oldLinks.get(link.name);
    return before && same(before, link) ? before : link;
  });
  const sameEntities = entities.length === held.entities.length && entities.every((entity, index) => entity === held.entities[index]);
  const sameLinks = links.length === held.relationships.length && links.every((link, index) => link === held.relationships[index]);
  return {
    model: same(held.model, next.model) ? held.model : next.model,
    observedAt: next.observedAt,
    entities: sameEntities ? held.entities : entities,
    relationships: sameLinks ? held.relationships : links,
    reportOptions: same(held.reportOptions, next.reportOptions) ? held.reportOptions : next.reportOptions,
  };
}

export interface StateChange {
  readonly name: string;
  readonly displayName: string;
  readonly from: string | null;
  readonly to: string;
}

/** The entities whose health state is not what it was: the changes a viewer is told about. New entities are not changes. */
export function stateChanges(before: HealthModel, after: HealthModel): readonly StateChange[] {
  if (before.entities === after.entities) return [];
  const old = new Map(before.entities.map((entity) => [entity.name, entity.healthState]));
  const out: StateChange[] = [];
  for (const entity of after.entities) {
    const was = old.get(entity.name);
    if (was !== undefined && was !== entity.healthState) out.push({ name: entity.name, displayName: entity.displayName, from: was, to: entity.healthState });
  }
  return out;
}

/** What a screen reader hears: "Session Storage is now Unhealthy", and for several, the first and a count. */
export function announcement(changes: readonly StateChange[]): string {
  const first = changes[0];
  if (!first) return "";
  const one = `${first.displayName} is now ${first.to}`;
  return changes.length === 1 ? one : `${one}, and ${changes.length - 1} other ${changes.length === 2 ? "entity" : "entities"} changed`;
}
