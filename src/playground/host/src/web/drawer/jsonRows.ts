// The rows of a collapsible JSON tree, as a calculation. The component only draws them.
export type NodeKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface TreeRow {
  path: string;
  depth: number;
  key: string | null;
  kind: NodeKind;
  // What follows the key: a scalar, or the shape of a container.
  text: string;
  expandable: boolean;
  expanded: boolean;
}

export const DEFAULT_OPEN_DEPTH = 3;
export const MAX_SCALAR_CHARS = 400;

export function kindOf(value: unknown): NodeKind {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return "object";
  }
}

function scalarText(value: unknown, kind: NodeKind): string {
  if (kind === "null") return "null";
  if (kind === "string") {
    const text = value as string;
    const shown = text.length > MAX_SCALAR_CHARS ? `${text.slice(0, MAX_SCALAR_CHARS)}… (${text.length} chars)` : text;
    return JSON.stringify(shown);
  }
  return String(value);
}

function containerText(value: unknown, kind: NodeKind, expanded: boolean): string {
  const size = kind === "array" ? (value as unknown[]).length : Object.keys(value as object).length;
  const [open, close] = kind === "array" ? ["[", "]"] : ["{", "}"];
  if (size === 0) return `${open}${close}`;
  const noun = kind === "array" ? (size === 1 ? "item" : "items") : size === 1 ? "key" : "keys";
  return expanded ? `${open}  ${size} ${noun}` : `${open} … ${close}  ${size} ${noun}`;
}

// `toggled` holds the paths the reader flipped away from the default (open to a depth, closed below it).
export function treeRows(root: unknown, toggled: ReadonlySet<string>, openDepth = DEFAULT_OPEN_DEPTH): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (value: unknown, key: string | null, path: string, depth: number) => {
    const kind = kindOf(value);
    if (kind !== "object" && kind !== "array") {
      rows.push({ path, depth, key, kind, text: scalarText(value, kind), expandable: false, expanded: false });
      return;
    }
    const entries: [string, unknown][] = kind === "array"
      ? (value as unknown[]).map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>);
    const expandable = entries.length > 0;
    const expanded = expandable && (depth < openDepth) !== toggled.has(path);
    rows.push({ path, depth, key, kind, text: containerText(value, kind, expanded), expandable, expanded });
    if (expanded) for (const [childKey, child] of entries) walk(child, childKey, `${path}${kind === "array" ? `[${childKey}]` : `.${childKey}`}`, depth + 1);
  };
  walk(root, null, "$", 0);
  return rows;
}

export function toggle(toggled: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(toggled);
  if (!next.delete(path)) next.add(path);
  return next;
}
