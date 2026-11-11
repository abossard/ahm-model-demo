import { healthBucket } from "./collapse";
import type { LaneKind } from "./layerOf";
import { impactOf } from "./palette";
import type { Entity } from "./types";

/**
 * What a dense Swimlanes view folds: a part that is Healthy, has no other parent and whose
 * children are all folded the same way, is a healthy subtree. The healthy subtrees of one parent
 * become one "+N healthy" chip, N being everything under it. Opening a chip shows the parts
 * under it, and what is below them folds again under their own chip.
 *
 * Context and the root never fold; an entity in `keep` (the chain of an Explain result) never
 * folds; a parent with fewer than two entities to fold gets no chip.
 */
export interface FoldGroup {
  readonly owner: string;
  /** The entities the chip stands for, one level down: they are drawn when the chip is open. */
  readonly roots: readonly string[];
  /** Everything under the chip, the roots and what is below them. */
  readonly all: readonly string[];
}

export interface FoldInput {
  readonly names: readonly string[];
  readonly byName: ReadonlyMap<string, Entity>;
  readonly parentsOf: ReadonlyMap<string, readonly string[]>;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly kindOf: (name: string) => LaneKind;
  readonly open: ReadonlySet<string>;
  readonly keep: ReadonlySet<string>;
}

export interface Folding {
  readonly groups: ReadonlyMap<string, FoldGroup>;
  /** What is not drawn because a closed chip stands for it. */
  readonly hidden: ReadonlySet<string>;
}

export function foldGroups({ names, byName, parentsOf, childrenOf, kindOf, open, keep }: FoldInput): Folding {
  const children = (name: string): readonly string[] => childrenOf.get(name) ?? [];
  const parents = (name: string): readonly string[] => parentsOf.get(name) ?? [];
  const eligible = (name: string): boolean => {
    const entity = byName.get(name) as Entity;
    const kind = kindOf(name);
    return healthBucket(entity.healthState) === "Healthy" && impactOf(entity.impact) !== "Suppressed" && !keep.has(name) && kind !== "root" && kind !== "context" && parents(name).length === 1;
  };

  const memo = new Map<string, boolean>();
  const foldable = (name: string): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    memo.set(name, false); // a cycle is not a subtree
    const result = eligible(name) && children(name).every(foldable);
    memo.set(name, result);
    return result;
  };
  const sizes = new Map<string, number>();
  const sizeOf = (name: string): number => {
    const known = sizes.get(name);
    if (known !== undefined) return known;
    const size = 1 + children(name).reduce((sum, child) => sum + sizeOf(child), 0);
    sizes.set(name, size);
    return size;
  };

  // Which parents have enough below them to be worth a chip.
  const rootsOf = new Map<string, string[]>();
  for (const name of names) {
    if (!foldable(name)) continue;
    const owner = parents(name)[0] as string;
    (rootsOf.get(owner) ?? rootsOf.set(owner, []).get(owner)!).push(name);
  }
  const worth = new Set([...rootsOf].filter(([, roots]) => roots.reduce((sum, root) => sum + sizeOf(root), 0) >= 2).map(([owner]) => owner));

  const hiddenMemo = new Map<string, boolean>();
  const isHidden = (name: string): boolean => {
    const known = hiddenMemo.get(name);
    if (known !== undefined) return known;
    hiddenMemo.set(name, false);
    const owner = parents(name)[0];
    const result = foldable(name) && owner !== undefined && worth.has(owner) && (isHidden(owner) || !open.has(owner));
    hiddenMemo.set(name, result);
    return result;
  };
  const hidden = new Set(names.filter(isHidden));

  const groups = new Map<string, FoldGroup>();
  const below = (name: string, into: string[]): void => {
    into.push(name);
    for (const child of children(name)) below(child, into);
  };
  for (const owner of [...worth].sort()) {
    // A chip belongs to a parent that is drawn.
    if (hidden.has(owner)) continue;
    const roots = [...(rootsOf.get(owner) as string[])].sort();
    const all: string[] = [];
    for (const root of roots) below(root, all);
    groups.set(owner, { owner, roots, all });
  }
  return { groups, hidden };
}
