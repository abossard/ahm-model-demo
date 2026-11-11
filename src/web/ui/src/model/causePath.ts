import { healthBucket } from "./collapse";
import { impactOf } from "./palette";
import type { Entity, HealthState, Relationship } from "./types";

/**
 * What the Cause path view draws: every entity that needs attention and the way up to the root,
 * the chain from the failing signal to the root, and chips for everything else.
 *
 * The rule follows `healthmodels inspect --walk Causes` of the Azure MCP: start at the root and
 * go down through the children that drive each state. A child drives when it is Degraded or
 * Unhealthy and not Suppressed; under a BestOf rollup only when no sibling is healthier; an
 * Unknown child only where the rollup counts Unknown children.
 */
export type RollupKind = "WorstOf" | "BestOf";

export interface CauseRule {
  readonly rollup: RollupKind;
  readonly unknownCounts: boolean;
}

/** The health model DTO carries no rollup type yet, so the view assumes the default one. */
export const DEFAULT_CAUSE_RULE: CauseRule = { rollup: "WorstOf", unknownCounts: false };

export type FoldKind = "healthy" | "unknown" | "not-in-rollup" | "unconnected" | "more";

export interface FoldedGroup {
  /** `<owner>|<kind>`: stable across refreshes, so an opened chip stays open. */
  readonly id: string;
  /** The drawn entity the chip hangs under. */
  readonly owner: string;
  readonly kind: FoldKind;
  /** What the chip stands for, or, while it is open, what it opened. */
  readonly names: readonly string[];
  readonly count: number;
  readonly label: string;
  readonly states: Readonly<Partial<Record<HealthState, number>>>;
  readonly open: boolean;
}

export interface CausePath {
  /** Names to draw, in the order of the input. */
  readonly draw: readonly string[];
  /** The primary chain, the failing leaf first and the root last. */
  readonly chain: readonly string[];
  readonly folded: readonly FoldedGroup[];
  /** Nothing is Degraded or Unhealthy. */
  readonly calm: boolean;
  /** Entities that are Degraded or Unhealthy and count towards their parents. */
  readonly alarms: number;
  readonly root: string | null;
}

export interface CauseOptions {
  readonly rule?: CauseRule;
  /** An open Explain result's chain, the asked entity first: it takes precedence for numbering. */
  readonly explainChain?: readonly string[];
  /** Ids of the chips that are open. */
  readonly open?: ReadonlySet<string>;
  /**
   * In Compare, the entities the diff adds, changes or removes. They count as what needs attention:
   * drawn with their ancestors whether or not they are healthy, and everything unchanged and healthy folds.
   */
  readonly changed?: ReadonlySet<string>;
}

/** Group id of the parts that are not connected to the root. */
export const UNCONNECTED = "#unconnected";

const groupId = (owner: string, kind: FoldKind): string => `${owner}|${kind}`;

const RANK: Readonly<Record<string, number>> = { Healthy: 0, Unknown: 1, Degraded: 2, Unhealthy: 3 };

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bucket(entity: Entity): HealthState {
  return healthBucket(entity.healthState);
}

/** A Suppressed or retired entity does not count towards its parents. */
function counts(entity: Entity): boolean {
  return impactOf(entity.impact) !== "Suppressed" && bucket(entity) !== "Deleted";
}

/** What a parent sees of a child: a Limited child is capped at Degraded. */
function contributed(entity: Entity): number {
  const rank = RANK[bucket(entity)] ?? 1;
  return impactOf(entity.impact) === "Limited" && rank > RANK.Degraded! ? RANK.Degraded! : rank;
}

interface Graph {
  readonly byName: ReadonlyMap<string, Entity>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly parents: ReadonlyMap<string, readonly string[]>;
}

function graphOf(entities: readonly Entity[], relationships: readonly Relationship[]): Graph {
  const byEntity = new Map(entities.map((entity) => [entity.name, entity] as const));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const item of relationships) {
    const { parentEntityName: parent, childEntityName: child } = item;
    const key = `${parent}\u0000${child}`;
    if (parent === child || !byEntity.has(parent) || !byEntity.has(child) || seen.has(key)) continue;
    seen.add(key);
    (children.get(parent) ?? children.set(parent, []).get(parent)!).push(child);
    (parents.get(child) ?? parents.set(child, []).get(child)!).push(parent);
  }
  for (const list of [...children.values(), ...parents.values()]) list.sort(byName);
  return { byName: byEntity, children, parents };
}

function reach(start: string, next: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const found = new Set<string>();
  const stack = [...(next.get(start) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (found.has(current) || current === start) continue;
    found.add(current);
    stack.push(...(next.get(current) ?? []));
  }
  return found;
}

/** The entity everything hangs under: the parentless one with the most descendants. */
function rootOf(graph: Graph): string | null {
  let best: string | null = null;
  let bestSize = -1;
  for (const name of [...graph.byName.keys()].sort(byName)) {
    if ((graph.parents.get(name) ?? []).length > 0) continue;
    const size = reach(name, graph.children).size;
    if (size > bestSize) {
      best = name;
      bestSize = size;
    }
  }
  return best;
}

/** The children of `parent` that drive its state under the rule, worst first. */
function drivers(graph: Graph, parent: string, rule: CauseRule): readonly string[] {
  const counted = (graph.children.get(parent) ?? [])
    .map((name) => graph.byName.get(name) as Entity)
    .filter((child) => counts(child) && (rule.unknownCounts || bucket(child) !== "Unknown"));
  const best = counted.reduce((lowest, child) => Math.min(lowest, contributed(child)), Infinity);
  const worst = counted.reduce((highest, child) => Math.max(highest, contributed(child)), 0);
  return counted
    .filter((child) => {
      const rank = contributed(child);
      // Unknown drives only where nothing worse sits beside it and the rollup counts it.
      if (rank < RANK.Degraded!) return rule.unknownCounts && rank === RANK.Unknown && worst === RANK.Unknown;
      return rule.rollup === "BestOf" ? rank === best : true;
    })
    .sort((left, right) => contributed(right) - contributed(left) || (RANK[bucket(right)] ?? 0) - (RANK[bucket(left)] ?? 0) || byName(left.name, right.name))
    .map((child) => child.name);
}

/** From the root down, always through the worst driver: the failing leaf is where it ends. */
function walkCauses(graph: Graph, root: string, rule: CauseRule): readonly string[] {
  const path = [root];
  const seen = new Set(path);
  for (;;) {
    const next = drivers(graph, path[path.length - 1] as string, rule).find((name) => !seen.has(name));
    if (next === undefined) break;
    path.push(next);
    seen.add(next);
  }
  const rootEntity = graph.byName.get(root) as Entity;
  if (path.length === 1 && !(counts(rootEntity) && contributed(rootEntity) >= RANK.Degraded!)) return [];
  return path.reverse();
}

function explainChainOf(graph: Graph, names: readonly string[]): readonly string[] {
  const lower = new Map([...graph.byName.keys()].map((name) => [name.toLowerCase(), name] as const));
  const found: string[] = [];
  for (const name of names) {
    const actual = lower.get(name.toLowerCase());
    if (actual !== undefined && !found.includes(actual)) found.push(actual);
  }
  return found.reverse();
}

/** What a hidden entity is folded as: one chip per owner and kind, so a chip says what it holds. */
function kindOf(entity: Entity): FoldKind {
  if (bucket(entity) === "Deleted") return "more";
  if (impactOf(entity.impact) === "Suppressed") return "not-in-rollup";
  if (bucket(entity) === "Healthy") return "healthy";
  return bucket(entity) === "Unknown" ? "unknown" : "more";
}

const LABELS: Readonly<Record<FoldKind, string>> = {
  healthy: "healthy",
  unknown: "unknown",
  "not-in-rollup": "not in rollup",
  unconnected: "not connected",
  more: "more",
};

export function causePath(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  options: CauseOptions = {},
): CausePath {
  const rule = options.rule ?? DEFAULT_CAUSE_RULE;
  const open = options.open ?? new Set<string>();
  const graph = graphOf(entities, relationships);
  const root = rootOf(graph);
  const alarmed = entities.filter((entity) => counts(entity) && contributed(entity) >= RANK.Degraded!);
  const calm = alarmed.length === 0;

  const primary = root === null ? [] : walkCauses(graph, root, rule);
  const explained = explainChainOf(graph, options.explainChain ?? []);
  const chain = explained.length > 0 ? explained : primary;

  // What is drawn before any chip is open.
  const drawn = new Set<string>();
  const keep = (name: string): void => {
    drawn.add(name);
    for (const ancestor of reach(name, graph.parents)) drawn.add(ancestor);
  };
  if (root !== null) drawn.add(root);
  if (!calm) for (const entity of entities) if (counts(entity) && bucket(entity) !== "Healthy") keep(entity.name);
  for (const name of chain) keep(name);
  for (const name of options.changed ?? []) if (graph.byName.has(name)) keep(name);

  // An open chip shows what it stands for, one level down; what is below that folds again.
  const opened = new Map<string, string[]>();
  const hiddenUnder = (owner: string, kind: FoldKind): readonly string[] => {
    if (owner === UNCONNECTED) {
      return [...graph.byName.keys()].filter((name) => !drawn.has(name) && (graph.parents.get(name) ?? []).length === 0).sort(byName);
    }
    return (graph.children.get(owner) ?? []).filter((name) => !drawn.has(name) && kindOf(graph.byName.get(name) as Entity) === kind);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of open) {
      if (opened.has(id)) continue;
      const split = id.lastIndexOf("|");
      const owner = id === UNCONNECTED ? UNCONNECTED : id.slice(0, split);
      const kind = id === UNCONNECTED ? "unconnected" : (id.slice(split + 1) as FoldKind);
      if (owner !== UNCONNECTED && !drawn.has(owner)) continue;
      const names = hiddenUnder(owner, kind);
      if (names.length === 0) continue;
      opened.set(id, [...names]);
      for (const name of names) drawn.add(name);
      changed = true;
    }
  }

  // Everything else hangs under its nearest drawn ancestor, or under the root when it has none.
  const owners = new Map<string, string>();
  const ownerOf = (name: string, path: Set<string>): string | null => {
    const known = owners.get(name);
    if (known !== undefined) return known === UNCONNECTED ? null : known;
    path.add(name);
    let found: string | null = null;
    for (const parent of graph.parents.get(name) ?? []) {
      if (drawn.has(parent)) found = parent;
      else if (!path.has(parent)) found = ownerOf(parent, path);
      if (found !== null) break;
    }
    path.delete(name);
    owners.set(name, found ?? UNCONNECTED);
    return found;
  };
  const hidden = new Map<string, { owner: string; kind: FoldKind; members: Entity[] }>();
  for (const name of graph.byName.keys()) {
    if (drawn.has(name)) continue;
    const entity = graph.byName.get(name) as Entity;
    const owner = ownerOf(name, new Set());
    const kind = owner === null ? "unconnected" : kindOf(entity);
    const id = owner === null ? UNCONNECTED : groupId(owner, kind);
    (hidden.get(id) ?? hidden.set(id, { owner: owner ?? (root as string), kind, members: [] }).get(id)!).members.push(entity);
  }

  const drawOrder = new Map(entities.map((entity, index) => [entity.name, index] as const));
  const ownerRank = (id: string): number => drawOrder.get(id === UNCONNECTED ? "" : id.slice(0, id.lastIndexOf("|"))) ?? Infinity;
  const KIND_ORDER: readonly FoldKind[] = ["healthy", "unknown", "more", "not-in-rollup", "unconnected"];
  const folded: FoldedGroup[] = [];
  const entries = new Map<string, { owner: string; kind: FoldKind; members: Entity[]; isOpen: boolean }>();
  for (const [id, group] of hidden) entries.set(id, { ...group, isOpen: false });
  for (const [id, names] of opened) {
    const split = id.lastIndexOf("|");
    const owner = id === UNCONNECTED ? (root as string) : id.slice(0, split);
    const kind: FoldKind = id === UNCONNECTED ? "unconnected" : (id.slice(split + 1) as FoldKind);
    entries.set(id, { owner, kind, members: names.map((name) => graph.byName.get(name) as Entity), isOpen: true });
  }
  const keys = [...entries.keys()].sort((left, right) => ownerRank(left) - ownerRank(right) || KIND_ORDER.indexOf((entries.get(left) as { kind: FoldKind }).kind) - KIND_ORDER.indexOf((entries.get(right) as { kind: FoldKind }).kind));
  for (const id of keys) {
    const entry = entries.get(id) as { owner: string; kind: FoldKind; members: Entity[]; isOpen: boolean };
    const members = [...entry.members].sort((left, right) => byName(left.name, right.name));
    const states: Partial<Record<HealthState, number>> = {};
    for (const entity of members) states[bucket(entity)] = (states[bucket(entity)] ?? 0) + 1;
    folded.push({
      id,
      owner: entry.owner,
      kind: entry.kind,
      names: members.map((entity) => entity.name),
      count: members.length,
      label: entry.isOpen ? "hide" : `+${members.length} ${LABELS[entry.kind]}`,
      states,
      open: entry.isOpen,
    });
  }

  return {
    draw: entities.filter((entity) => drawn.has(entity.name)).map((entity) => entity.name),
    chain,
    folded: root === null ? [] : folded,
    calm,
    alarms: alarmed.length,
    root,
  };
}

/**
 * The chips to open so that every name is drawn. A name inside a folded group needs that group,
 * and the group of what it hides in turn, so this repeats until nothing is left.
 */
export function openToReveal(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  options: CauseOptions,
  names: readonly string[],
): ReadonlySet<string> {
  const open = new Set(options.open ?? []);
  for (let round = 0; round <= entities.length; round += 1) {
    const result = causePath(entities, relationships, { ...options, open });
    const drawn = new Set(result.draw);
    const missing = names.filter((name) => !drawn.has(name));
    if (missing.length === 0) break;
    const added = result.folded.filter((group) => !group.open && missing.some((name) => group.names.includes(name)));
    if (added.length === 0) break;
    for (const group of added) open.add(group.id);
  }
  return open;
}
