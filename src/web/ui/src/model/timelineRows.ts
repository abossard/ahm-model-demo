import { severity, type EntityInfo, type StateCode } from "./timeline";

export type RowOrder = "structure" | "worst";

export const ROW_HEIGHT = { entity: 34, signal: 64 } as const;

export interface EntityRow {
  readonly kind: "entity";
  /** The path from a root to this row: an entity with several parents has a row, and a key, under each. */
  readonly key: string;
  readonly entity: string;
  readonly label: string;
  readonly depth: number;
  readonly signalCount: number;
  readonly childCount: number;
  /** It has signals or dependencies to open. */
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** It is related to another entity: it has a parent or a child. */
  readonly connected: boolean;
  /** The place among its siblings, signals first, for a screen reader that only holds the rows on screen. */
  readonly position: number;
  readonly size: number;
  readonly y: number;
  readonly h: number;
}

export interface SignalRow {
  readonly kind: "signal";
  readonly key: string;
  /** The key of the row of the entity that has the signal. */
  readonly parent: string;
  readonly entity: string;
  readonly signal: string;
  readonly label: string;
  readonly depth: number;
  readonly position: number;
  readonly size: number;
  readonly y: number;
  readonly h: number;
}

export type Row = EntityRow | SignalRow;

export interface RowModel {
  readonly rows: readonly Row[];
  readonly height: number;
  readonly indexByKey: ReadonlyMap<string, number>;
}

const SEP = "\u0001";

export const entityKey = (path: readonly string[]): string => `e:${path.join(SEP)}`;
export const signalKey = (rowKey: string, signal: string): string => `s:${rowKey}\u0000${signal}`;
/** The entity a row key of an entity names: the last step of its path. */
export const entityOfKey = (key: string): string => key.slice(2).split(SEP).at(-1) ?? "";

interface Tree {
  readonly byName: ReadonlyMap<string, EntityInfo>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Entities with a parent or a child. */
  readonly linked: ReadonlySet<string>;
  /** Where the tree starts: the related roots, then the entities that relate to nothing. */
  readonly roots: readonly string[];
}

/**
 * The model's relationships as a tree. The roots are the entities without a parent; those that relate to nothing come
 * last. An entity that only a cycle leads to would be unreachable, so the first of each such cycle is a root too.
 */
function treeOf(entities: readonly EntityInfo[]): Tree {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  const children = new Map<string, string[]>();
  const parented = new Set<string>();
  for (const entity of entities) {
    for (const parent of new Set(entity.parents)) {
      if (!byName.has(parent) || parent === entity.name) continue;
      children.set(parent, [...(children.get(parent) ?? []), entity.name]);
      parented.add(entity.name);
    }
  }
  const linked = new Set([...parented, ...children.keys()]);
  const roots = entities.filter((entity) => !parented.has(entity.name)).map((entity) => entity.name);
  const reached = new Set<string>();
  const reach = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const child of children.get(name) ?? []) reach(child);
  };
  roots.forEach(reach);
  for (const entity of entities) {
    if (reached.has(entity.name)) continue;
    roots.push(entity.name);
    reach(entity.name);
  }
  return { byName, children, linked, roots: [...roots.filter((name) => linked.has(name)), ...roots.filter((name) => !linked.has(name))] };
}

/** The dependencies of an entity on the way down from the roots: the ones already on the path are left out, so a cycle ends. */
const below = (tree: Tree, name: string, path: readonly string[]): readonly string[] => (tree.children.get(name) ?? []).filter((child) => !path.includes(child));

/** Every path from a root to an entity, in the order the rows show them when everything is open. */
function forEachPath(tree: Tree, visit: (path: readonly string[]) => void): void {
  const walk = (name: string, path: readonly string[]): void => {
    const here = [...path, name];
    visit(here);
    for (const child of below(tree, name, here)) walk(child, here);
  };
  for (const root of tree.roots) walk(root, []);
}

/** The rows of the roots that have dependencies: where the tree starts, so it opens to its first level. */
export function rootKeys(entities: readonly EntityInfo[]): readonly string[] {
  const tree = treeOf(entities);
  return tree.roots.filter((root) => tree.linked.has(root)).map((root) => entityKey([root]));
}

/** The key of every row an entity has when the whole tree is open. */
export function allKeys(entities: readonly EntityInfo[]): readonly string[] {
  const keys: string[] = [];
  forEachPath(treeOf(entities), (path) => keys.push(entityKey(path)));
  return keys;
}

export interface Reveal {
  /** The rows that are open already. */
  readonly open: ReadonlySet<string>;
  /** The row the viewer clicked, when the entity has more than one. */
  readonly prefer: string | null;
}

/**
 * The rows to open to show an entity with its signals: each ancestor on one path to it, then its own row. The path is the
 * preferred row's, else one that is open already, else the first. Empty when the model does not have the entity.
 */
export function revealKeys(entities: readonly EntityInfo[], name: string, reveal: Reveal): readonly string[] {
  const paths: (readonly string[])[] = [];
  forEachPath(treeOf(entities), (path) => {
    if (path.at(-1) === name) paths.push(path);
  });
  const keyed = paths.map((path) => ({ path, keys: path.map((_, index) => entityKey(path.slice(0, index + 1))) }));
  const chosen =
    keyed.find((item) => item.keys.at(-1) === reveal.prefer) ??
    keyed.find((item) => item.keys.slice(0, -1).every((key) => reveal.open.has(key))) ??
    keyed[0];
  return chosen?.keys ?? [];
}

export interface RowInput {
  readonly entities: readonly EntityInfo[];
  readonly order: RowOrder;
  /** The keys of the rows that are open. */
  readonly open: ReadonlySet<string>;
  /** The state to rank an entity by when the order is worst first. */
  readonly rank: (entity: string) => StateCode;
}

/** The flat list of rows, top to bottom, with the y of each: an open entity shows its signals, then its dependencies. */
export function buildRows(input: RowInput): RowModel {
  const tree = treeOf(input.entities);
  const rows: Row[] = [];
  const indexByKey = new Map<string, number>();
  let y = 0;
  const add = (row: Row): void => {
    indexByKey.set(row.key, rows.length);
    rows.push(row);
    y += row.h;
  };
  const ordered = (names: readonly string[]): readonly string[] =>
    input.order === "worst"
      ? [...names].sort(
          (a, b) => severity(input.rank(b)) - severity(input.rank(a)) || (tree.byName.get(a)?.displayName ?? "").localeCompare(tree.byName.get(b)?.displayName ?? ""),
        )
      : names;

  const visit = (name: string, path: readonly string[], position: number, size: number): void => {
    const entity = tree.byName.get(name) as EntityInfo;
    const here = [...path, name];
    const key = entityKey(here);
    const kids = ordered(below(tree, name, here));
    const expandable = entity.signals.length + kids.length > 0;
    const expanded = expandable && input.open.has(key);
    add({
      kind: "entity",
      key,
      entity: name,
      label: entity.displayName,
      depth: here.length - 1,
      signalCount: entity.signals.length,
      childCount: kids.length,
      expandable,
      expanded,
      connected: tree.linked.has(name),
      position,
      size,
      y,
      h: ROW_HEIGHT.entity,
    });
    if (!expanded) return;
    const inside = entity.signals.length + kids.length;
    entity.signals.forEach((signal, index) => {
      add({ kind: "signal", key: signalKey(key, signal.name), parent: key, entity: name, signal: signal.name, label: signal.displayName, depth: here.length, position: index + 1, size: inside, y, h: ROW_HEIGHT.signal });
    });
    kids.forEach((child, index) => visit(child, here, entity.signals.length + index + 1, inside));
  };

  const roots = [...ordered(tree.roots.filter((root) => tree.linked.has(root))), ...ordered(tree.roots.filter((root) => !tree.linked.has(root)))];
  roots.forEach((root, index) => visit(root, [], index + 1, roots.length));
  return { rows, height: y, indexByKey };
}

/** The entity that stands for the model: the first root that has dependencies. */
export function rootEntity(entities: readonly EntityInfo[]): EntityInfo | undefined {
  const [first] = treeOf(entities).roots;
  return entities.find((entity) => entity.name === first);
}

/** The index range of the rows that show in a viewport `height` tall scrolled by `top`, with `overscan` rows either side. */
export function visibleRows(model: RowModel, top: number, height: number, overscan = 2): readonly [number, number] {
  const { rows } = model;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const row = rows[mid] as Row;
    if (row.y + row.h <= top) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < rows.length && (rows[end] as Row).y < top + height) end += 1;
  return [Math.max(0, lo - overscan), Math.min(rows.length, end + overscan)];
}

/** The scroll offset that brings a row into view with a little context above it; null when it already shows. */
export function scrollToShow(row: Row, top: number, height: number): number | null {
  if (row.y >= top && row.y + row.h <= top + height) return null;
  return Math.max(0, row.y - ROW_HEIGHT.entity);
}

/** The next row to focus from `index` by `step`, skipping nothing: the list is already flat. */
export function moveFocus(model: RowModel, index: number, step: number): number {
  return Math.min(model.rows.length - 1, Math.max(0, index + step));
}
