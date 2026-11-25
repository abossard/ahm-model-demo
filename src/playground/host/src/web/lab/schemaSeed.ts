// A calculation: a starting document for the tool runner, read from a tool's JSON Schema.
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  minLength?: number;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
};

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null;
}

function seedValue(schema: Schema, player: unknown): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const first = variants.find((variant) => variant.type !== "null") ?? variants[0];
    return first ? seedValue(first, player) : null;
  }
  const type = Array.isArray(schema.type) ? (schema.type.find((item) => item !== "null") ?? "null") : schema.type;
  switch (type) {
    case "string": return "";
    case "number":
    case "integer": return schema.minimum !== undefined && schema.minimum > 0 ? schema.minimum : 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return seedObject(schema, player);
    default: return null;
  }
}

function seedObject(schema: Schema, player: unknown): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    if (!required.has(name)) continue;
    out[name] = name === "player" ? player : seedValue(child, player);
  }
  return out;
}

export function seedFromSchema(schema: unknown, player: unknown): Record<string, unknown> {
  return isSchema(schema) ? seedObject(schema, player) : {};
}

export type ToolAudience = "model" | "app";

// A calculation: who may call a tool, read from the `_meta.ui.visibility` the server put on it.
export function audienceOf(meta: Record<string, unknown> | undefined): readonly ToolAudience[] {
  const ui = meta?.ui;
  const visibility = typeof ui === "object" && ui !== null ? (ui as Record<string, unknown>).visibility : undefined;
  const list = Array.isArray(visibility) ? visibility.filter((item): item is ToolAudience => item === "model" || item === "app") : [];
  return list.length > 0 ? list : ["model", "app"];
}

export function isModelVisible(meta: Record<string, unknown> | undefined): boolean {
  return audienceOf(meta).includes("model");
}
