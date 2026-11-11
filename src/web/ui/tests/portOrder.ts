import type { Page } from "@playwright/test";

/**
 * Where the lines of the card graph meet the cards, against where the cards at their other ends
 * are: on one side of a card the points must run in the order of those cards, or two lines of it
 * cross where they leave or arrive. Returns every pair that does not, as text; none is the answer.
 */
export async function portViolations(page: Page, edges: readonly { readonly id: string; readonly from: string; readonly to: string }[], graph = "topology"): Promise<string[]> {
  return page.evaluate(
    ({ list, graphId }) => {
      const root = document.getElementById(graphId) as HTMLElement;
      const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
      for (const node of root.querySelectorAll<HTMLElement>(".react-flow__node")) {
        const id = node.getAttribute("data-id") ?? "";
        if (id.startsWith("__")) continue;
        const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform);
        rects.set(id, { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0), width: node.offsetWidth, height: node.offsetHeight });
      }
      const ends: { node: string; side: string; along: number; across: number; edge: string }[] = [];
      for (const edge of list) {
        const path = root.querySelector(`.react-flow__edge[data-id="${edge.id}"] .react-flow__edge-path`)?.getAttribute("d");
        const from = rects.get(edge.from);
        const to = rects.get(edge.to);
        if (!path || !from || !to) continue;
        const numbers = (path.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
        const start = { x: numbers[0] as number, y: numbers[1] as number };
        const end = { x: numbers[numbers.length - 2] as number, y: numbers[numbers.length - 1] as number };
        const sideOf = (point: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }): string => {
          const distances: [string, number][] = [
            ["top", Math.abs(point.y - rect.y)],
            ["bottom", Math.abs(point.y - (rect.y + rect.height))],
            ["left", Math.abs(point.x - rect.x)],
            ["right", Math.abs(point.x - (rect.x + rect.width))],
          ];
          return distances.sort((a, b) => a[1] - b[1])[0]?.[0] ?? "top";
        };
        const centre = (rect: { x: number; y: number; width: number; height: number }): { x: number; y: number } => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        const put = (node: string, point: { x: number; y: number }, rect: typeof from, other: typeof from): void => {
          const side = sideOf(point, rect);
          const horizontal = side === "top" || side === "bottom";
          ends.push({ node, side, along: horizontal ? point.x : point.y, across: horizontal ? centre(other).x : centre(other).y, edge: edge.id });
        };
        put(edge.from, start, from, to);
        put(edge.to, end, to, from);
      }
      const groups = new Map<string, typeof ends>();
      for (const end of ends) groups.set(`${end.node}|${end.side}`, [...(groups.get(`${end.node}|${end.side}`) ?? []), end]);
      const found: string[] = [];
      for (const [key, group] of groups) {
        const sorted = [...group].sort((a, b) => a.along - b.along);
        sorted.forEach((one, index) => {
          for (const other of sorted.slice(index + 1)) {
            if (other.along - one.along > 0.5 && other.across < one.across - 0.5) found.push(`${key}: ${one.edge} before ${other.edge} but its card is further on`);
          }
        });
      }
      return found;
    },
    { list: edges, graphId: graph },
  );
}
