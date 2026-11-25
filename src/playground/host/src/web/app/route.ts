import { LAYERS, type LayerId } from "@playground/contracts";

export type Route =
  | { page: "home"; highlight: LayerId | null }
  | { page: "layer"; layer: LayerId; tableId: string | null };

const TABLE_ID = /^[a-z0-9-]{6,40}$/;
const TABLE_LAYERS: readonly LayerId[] = [3, 5];

export function layerPath(layer: LayerId, tableId: string | null = null): string {
  const slug = LAYERS.find((item) => item.id === layer)!.slug;
  return tableId && TABLE_LAYERS.includes(layer) ? `/${slug}/${tableId}` : `/${slug}`;
}

// A calculation: the route of a URL path. Anything unknown is home.
export function parseRoute(path: string): Route {
  const [slug, tableId, ...rest] = path.split("/").filter(Boolean);
  const layer = LAYERS.find((item) => item.slug === slug);
  if (!layer || rest.length > 0) return { page: "home", highlight: null };
  const table = tableId && TABLE_ID.test(tableId) && TABLE_LAYERS.includes(layer.id) ? tableId : null;
  if (tableId && !table) return { page: "layer", layer: layer.id, tableId: null };
  return { page: "layer", layer: layer.id, tableId: table };
}

// A calculation: a locked layer lands on the ladder with that rung highlighted.
export function resolveRoute(route: Route, unlocked: LayerId): Route {
  return route.page === "layer" && route.layer > unlocked ? { page: "home", highlight: route.layer } : route;
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.page === "home" && b.page === "home") return a.highlight === b.highlight;
  return a.page === "layer" && b.page === "layer" && a.layer === b.layer && a.tableId === b.tableId;
}

// The table id a game View reports with app.updateModelContext({ structuredContent: { tableId } }).
export function tableIdFromContext(value: unknown): string | null {
  const read = (item: unknown): string | null => {
    if (typeof item !== "object" || item === null) return null;
    const id = (item as Record<string, unknown>).tableId;
    return typeof id === "string" && TABLE_ID.test(id) ? id : null;
  };
  const structured = typeof value === "object" && value !== null ? (value as Record<string, unknown>).structuredContent : null;
  return read(structured) ?? read(value);
}
