import type { Entity, EntitySignal, HealthModelSnapshot } from "../model/types";

export interface DiagramEntity extends Pick<Entity, "name" | "displayName" | "healthState" | "impact"> {
  readonly signals: readonly Pick<EntitySignal, "name" | "displayName" | "healthState" | "value">[];
  readonly signalCount?: number;
}

export interface DiagramData {
  readonly anchor: DiagramEntity | null;
  readonly neighbors: readonly DiagramEntity[];
  readonly neighborCount?: number;
  /** The anchor has no dependencies and appears below the entities that depend on it. */
  readonly leaf: boolean;
  readonly timeLabel?: string;
}

function diagramEntity(entity: Entity): DiagramEntity {
  const {name, displayName, healthState, impact, signals} = entity;
  return {name, displayName, healthState, impact, signalCount: signals.length,
    signals: signals.slice(0, 24).map(({name, displayName, healthState, value}) => ({name, displayName, healthState, value}))};
}

/** Project just the visible part of the host's model into the read-only MCP App. */
export function diagramData(model: HealthModelSnapshot, entityName?: string | null, timeLabel?: string): DiagramData {
  const anchor = entityName ? model.entities.find(entity => entity.name === entityName)
    : model.entities.find(entity => entity.parents.length === 0 && entity.children.length > 0) ?? model.entities[0];
  const children = new Set<string>();
  const parents = new Set<string>();
  for (const { parentEntityName, childEntityName } of model.relationships) {
    if (parentEntityName === childEntityName) continue;
    if (parentEntityName === anchor?.name) children.add(childEntityName);
    if (childEntityName === anchor?.name) parents.add(parentEntityName);
  }
  const dependencies = model.entities.filter(entity => children.has(entity.name));
  const leaf = dependencies.length === 0;
  const neighbors = leaf ? model.entities.filter(entity => parents.has(entity.name)) : dependencies;
  return {anchor: anchor ? diagramEntity(anchor) : null, leaf, neighborCount: neighbors.length,
    neighbors: neighbors.slice(0, 6).map(diagramEntity), ...(timeLabel && {timeLabel})};
}
