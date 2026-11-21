import { ancestorsToExpand, healthBucket } from "../model/collapse";
import type { Entity, Relationship } from "../model/types";
import type { Store } from "./store";

/** Open just the branches and health filters that would otherwise hide the requested entities. */
export function revealGraphEntities(state: Store, names: readonly string[], entities: readonly Entity[], relationships: readonly Relationship[]) {
  const health = new Set(state.selectedHealth);
  const collapsed = new Set(state.collapsed);
  const expand = new Set<string>();
  for (const name of names) {
    const entity = entities.find(item => item.name === name);
    if (!entity) continue;
    const bucket = healthBucket(entity.healthState);
    if (bucket !== "Deleted") health.add(bucket);
    for (const parent of ancestorsToExpand(name, entities, relationships, collapsed)) expand.add(parent);
  }
  if (health.size !== state.selectedHealth.length) state.setSelectedHealth([...health]);
  if (expand.size) state.expandMany([...expand]);
}
