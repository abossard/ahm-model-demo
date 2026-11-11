import type { ApplyOutcome, DiffChange, HealthModelSnapshot, VerificationRow } from "./types";

export type ChangeBadge = "added" | "changed" | "removed";

export interface ChangeGroup {
  /** The entity that owns the changes, or null for signal definitions no entity references. */
  readonly entity: string | null;
  readonly changes: readonly DiffChange[];
}

const KIND_ORDER = { entity: 0, signalDefinition: 1, relationship: 2 } as const;

function fold(name: string): string {
  return name.toLowerCase();
}

function propertiesOf(change: DiffChange): Readonly<Record<string, unknown>> {
  return change.after ?? change.before ?? {};
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** The signal definitions an entity's properties point at, whichever signal group holds them. */
export function referencedDefinitions(properties: Readonly<Record<string, unknown>>): readonly string[] {
  const groups = asRecord(properties["signalGroups"]);
  if (!groups) return [];
  const names: string[] = [];
  for (const group of Object.values(groups)) {
    const signals = asRecord(group)?.["signals"];
    if (!Array.isArray(signals)) continue;
    for (const signal of signals) {
      const name = asRecord(signal)?.["signalDefinitionName"];
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/** The parent and child entity a relationship change connects, as the agent named them. */
export function endpointsOf(change: DiffChange): readonly [string | null, string | null] {
  const properties = propertiesOf(change);
  const parent = properties["parentEntityName"];
  const child = properties["childEntityName"];
  return [typeof parent === "string" ? parent : null, typeof child === "string" ? child : null];
}

function entityChanges(changes: readonly DiffChange[]): ReadonlyMap<string, DiffChange> {
  return new Map(changes.filter((change) => change.kind === "entity").map((change) => [fold(change.name), change]));
}

function ownerOf(change: DiffChange, owners: ReadonlyMap<string, DiffChange>): string | null {
  if (change.kind === "entity") return change.name;
  if (change.kind === "signalDefinition") {
    const holder = [...owners.values()].find((entity) =>
      referencedDefinitions(propertiesOf(entity)).some((name) => fold(name) === fold(change.name)),
    );
    return holder?.name ?? change.verification[0]?.entity ?? null;
  }
  const [parent, child] = endpointsOf(change);
  if (child && owners.has(fold(child))) return child;
  if (parent && owners.has(fold(parent))) return parent;
  return child ?? parent;
}

/**
 * One group per owning entity: its own change first, then the signal definitions it references,
 * then the relationships that touch it. A relationship belongs to the child when both ends change.
 */
export function groupChangesByEntity(changes: readonly DiffChange[]): readonly ChangeGroup[] {
  const owners = entityChanges(changes);
  const groups = new Map<string, { entity: string | null; first: number; members: DiffChange[] }>();
  changes.forEach((change, index) => {
    const owner = ownerOf(change, owners);
    const key = owner === null ? "" : fold(owner);
    const group = groups.get(key);
    if (group) {
      group.members.push(change);
      if (change.kind === "entity") group.first = Math.min(group.first, index);
    } else {
      groups.set(key, { entity: owner, first: index, members: [change] });
    }
  });
  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) =>
      leftKey === "" ? 1 : rightKey === "" ? -1 : left.first - right.first,
    )
    .map(([, group]) => ({
      entity: group.entity,
      changes: [...group.members].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]),
    }));
}

/** The graph badge of every entity a diff touches, keyed by the lower-cased entity name. */
export function badgesByEntity(changes: readonly DiffChange[]): ReadonlyMap<string, ChangeBadge> {
  const badges = new Map<string, ChangeBadge>();
  const touch = (name: string | null): void => {
    if (name !== null && !badges.has(fold(name))) badges.set(fold(name), "changed");
  };
  for (const change of changes) {
    if (change.kind !== "entity") continue;
    badges.set(fold(change.name), change.op === "add" ? "added" : change.op === "remove" ? "removed" : "changed");
  }
  for (const change of changes) {
    if (change.kind === "relationship") endpointsOf(change).forEach(touch);
    if (change.kind === "signalDefinition") change.verification.forEach((row) => touch(row.entity));
  }
  return badges;
}

/** Every change the user reaches by picking this entity on the graph. */
export function changeIdsForEntity(changes: readonly DiffChange[], entity: string): readonly string[] {
  const owned = groupChangesByEntity(changes).find((group) => group.entity !== null && fold(group.entity) === fold(entity));
  const ids = new Set(owned?.changes.map((change) => change.id));
  for (const change of changes) {
    if (change.kind === "relationship" && endpointsOf(change).some((end) => end !== null && fold(end) === fold(entity))) {
      ids.add(change.id);
    }
  }
  return changes.filter((change) => ids.has(change.id)).map((change) => change.id);
}

/** The entities whose graph nodes mark the given changes. */
export function entitiesOfChanges(changes: readonly DiffChange[], ids: readonly string[]): readonly string[] {
  const wanted = new Set(ids);
  const names = new Set<string>();
  for (const change of changes) {
    if (!wanted.has(change.id)) continue;
    if (change.kind === "entity") names.add(fold(change.name));
    if (change.kind === "relationship") endpointsOf(change).forEach((end) => end !== null && names.add(fold(end)));
    if (change.kind === "signalDefinition") change.verification.forEach((row) => names.add(fold(row.entity)));
  }
  return [...names];
}

export interface SelectionPreview {
  /** Every change Apply will write, in diff order. */
  readonly written: readonly string[];
  /** The part of `written` that the user did not pick but a picked change depends on. */
  readonly added: readonly string[];
}

export function previewSelection(changes: readonly DiffChange[], selected: readonly string[]): SelectionPreview {
  const wanted = new Set(selected);
  for (const change of changes) {
    if (wanted.has(change.id)) change.dependsOn.forEach((id) => wanted.add(id));
  }
  const written = changes.filter((change) => wanted.has(change.id)).map((change) => change.id);
  const picked = new Set(selected);
  return { written, added: written.filter((id) => !picked.has(id)) };
}

export type CompareSide = "base" | "proposed";

/**
 * The badges one side of a comparison draws: an entity that is added exists only in the Proposed
 * model and one that is removed only in the Base model, so neither shows on the other side.
 */
export function badgesForSide(
  badges: ReadonlyMap<string, ChangeBadge>,
  side: CompareSide,
): ReadonlyMap<string, ChangeBadge> {
  const hidden: ChangeBadge = side === "base" ? "added" : "removed";
  return new Map([...badges].filter(([, badge]) => badge !== hidden));
}

/** Both sides of a comparison as one graph, each entity and relationship once, the Proposed model's first. */
export function unionSnapshots(base: HealthModelSnapshot, proposed: HealthModelSnapshot): HealthModelSnapshot {
  const entities = new Map(base.entities.map((entity) => [entity.name, entity] as const));
  const relationships = new Map(base.relationships.map((item) => [item.name, item] as const));
  for (const entity of proposed.entities) entities.set(entity.name, entity);
  for (const item of proposed.relationships) relationships.set(item.name, item);
  return { entities: [...entities.values()], relationships: [...relationships.values()] };
}

/** The changes earlier Apply calls wrote; the live model has them already, so they cannot be picked again. */
export function writtenIds(applies: readonly ApplyOutcome[]): ReadonlySet<string> {
  return new Set(applies.flatMap((outcome) => outcome.written));
}

/**
 * The Verification rows no change shows: a Review that finds nothing to change still ran its queries, and
 * their results belong to no change's chips.
 */
export function unattachedVerification(
  changes: readonly DiffChange[],
  verification: readonly VerificationRow[],
): readonly VerificationRow[] {
  const shown = new Set(changes.flatMap((change) => change.verification.map((row) => `${row.entity}/${row.signal}`)));
  return verification.filter((row) => !shown.has(`${row.entity}/${row.signal}`));
}
