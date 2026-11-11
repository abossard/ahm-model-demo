// @vitest-environment node
import { describe, expect, it } from "vitest";
import { arrange } from "./arrange";
import { causePath } from "./causePath";
import { collinearOverlaps, routeSteps, throughCards, TRACK, type RouteEdge, type RouteNode, type Routing } from "./stepRouter";
import { calmModel, denseIncidentModel, incidentModel } from "../../tests/viewModels";
import type { Entity, Relationship } from "./types";

const W = 200;
const H = 72;

/** Nodes at "name:column:row" on a grid of 248 by 160. */
function grid(spec: string): RouteNode[] {
  return spec.split(" ").map((item) => {
    const [id, column, row] = item.split(":") as [string, string, string];
    return { id, x: Number(column) * 248, y: Number(row) * 160, width: W, height: H };
  });
}

function edges(pairs: string, labelWidth = 0): RouteEdge[] {
  return pairs.split(" ").filter(Boolean).map((pair) => {
    const [from, to] = pair.split(">") as [string, string];
    return { id: pair, from, to, labelWidth };
  });
}

function pillBoxes(routing: Routing, width: number): { x: number; y: number; width: number; height: number }[] {
  return routing.edges.filter((edge) => edge.label).map((edge) => ({ x: edge.label!.x - width / 2, y: edge.label!.y - 9, width, height: 18 }));
}

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("routeSteps basics", () => {
  const routing = routeSteps(grid("p:1:0 a:0:1 b:1:1 c:2:1"), edges("p>a p>b p>c"));
  it("leaves the parent at the middle of its bottom and enters each child at the middle of its top", () => {
    for (const edge of routing.edges) {
      const parent = routing.nodes.get(edge.from)!;
      const child = routing.nodes.get(edge.to)!;
      expect(edge.points[0]).toEqual({ x: parent.x + parent.width / 2, y: parent.y + parent.height });
      expect(edge.points.at(-1)).toEqual({ x: child.x + child.width / 2, y: child.y });
    }
  });

  it("draws only horizontal and vertical segments", () => {
    for (const edge of routing.edges) {
      edge.points.slice(1).forEach((point, index) => {
        const before = edge.points[index]!;
        expect(point.x === before.x || point.y === before.y).toBe(true);
      });
    }
  });

  it("gives the children of one parent one shared bus", () => {
    // The child straight below the parent needs no bus; the other two ride the same one.
    const busY = new Set(routing.edges.filter((edge) => edge.points.length > 2).map((edge) => edge.points[1]!.y));
    expect(busY.size).toBe(1);
  });

  it("returns every node and a box around everything", () => {
    expect(routing.nodes.size).toBe(4);
    for (const rect of routing.nodes.values()) {
      expect(rect.x).toBeGreaterThanOrEqual(routing.bounds.x);
      expect(rect.y + rect.height).toBeLessThanOrEqual(routing.bounds.y + routing.bounds.height + 1e-6);
    }
  });

  it("ignores an edge to an entity that is not drawn and an edge to itself", () => {
    const result = routeSteps(grid("p:0:0 a:0:1"), edges("p>a p>ghost a>a"));
    expect(result.edges.map((edge) => edge.id)).toEqual(["p>a"]);
  });

  it("copes with no nodes", () => {
    expect(routeSteps([], [])).toEqual({ nodes: new Map(), edges: [], bounds: { x: 0, y: 0, width: 0, height: 0 } });
  });
});

describe("routeSteps rules", () => {
  it("runs a relationship that skips a row down the gap between cards, not through one", () => {
    const routing = routeSteps(grid("p:1:0 m:1:1 side:0:1 far:1:2"), edges("p>m p>side p>far m>far"));
    expect(throughCards(routing)).toEqual([]);
    // Straight down would hit the card in between, so the line detours through a gap.
    expect(routing.edges.find((edge) => edge.id === "p>far")!.points.length).toBeGreaterThanOrEqual(4);
  });

  it("spreads the arrivals of a child with several parents", () => {
    const routing = routeSteps(grid("a:0:0 b:2:0 c:1:1"), edges("a>c b>c"));
    const ends = routing.edges.map((edge) => edge.points.at(-1)!.x);
    expect(new Set(ends).size).toBe(2);
    const child = routing.nodes.get("c")!;
    for (const x of ends) {
      expect(x).toBeGreaterThan(child.x);
      expect(x).toBeLessThan(child.x + child.width);
    }
  });

  it.each([
    ["two parents whose children interleave", "a:0:0 b:1:0 x:0:1 y:1:1 z:2:1 w:3:1", "a>x a>z b>y b>w"],
    ["a fan of five parents each reaching far", "a:0:0 b:1:0 c:2:0 d:3:0 e:4:0 k:0:1 l:1:1 m:2:1 n:3:1 o:4:1", "a>o b>n c>m d>l e>k a>k e>o"],
  ] as const)("keeps buses of different parents apart where they overlap: %s", (_name, nodes, pairs) => {
    const routing = routeSteps(grid(nodes), edges(pairs));
    expect(collinearOverlaps(routing)).toBe(0);
    expect(throughCards(routing)).toEqual([]);
  });

  it("moves the rows below down when a gap needs more tracks than there is room for", () => {
    const wide = grid("a:0:0 b:1:0 c:2:0 d:3:0 e:4:0 k:0:1 l:1:1 m:2:1 n:3:1 o:4:1");
    const routing = routeSteps(wide, edges("a>o b>n c>m d>l e>k a>k e>o"));
    const before = wide.find((node) => node.id === "k")!;
    expect(routing.nodes.get("k")!.y).toBeGreaterThan(before.y);
    expect(routing.nodes.get("a")!.y).toBe(0);
  });

  it("keeps two risers in one corridor TRACK apart", () => {
    const nodes = grid("p:1:0 q:2:0 m:1:1 n:3:1 f:0:2 g:1:2");
    const routing = routeSteps(nodes, edges("p>f q>g p>m q>n"));
    const risers = routing.edges.flatMap((edge) => edge.points.slice(1).map((point, index) => [edge.points[index]!, point] as const)).filter(([a, b]) => a.x === b.x && Math.abs(a.y - b.y) > 160);
    for (const [index, [a]] of risers.entries()) for (const [b] of risers.slice(index + 1)) if (a.x !== b.x) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(TRACK - 1e-6);
  });
});

describe("routeSteps labels", () => {
  const PILL = 84;
  it("places a pill for every labelled edge, clear of the cards and of the other pills", () => {
    const nodes = grid("p:1:0 a:0:1 b:1:1 c:2:1 d:1:2");
    const routing = routeSteps(nodes, edges("p>a p>b p>c b>d", PILL));
    const boxes = pillBoxes(routing, PILL);
    expect(boxes).toHaveLength(4);
    for (const [index, box] of boxes.entries()) {
      for (const rect of routing.nodes.values()) expect(boxesOverlap(box, rect)).toBe(false);
      for (const other of boxes.slice(index + 1)) expect(boxesOverlap(box, other)).toBe(false);
    }
  });

  it("leaves unlabelled edges without a pill", () => {
    const routing = routeSteps(grid("p:0:0 a:0:1"), edges("p>a"));
    expect(routing.edges[0]!.label).toBeNull();
  });

  it("puts the pill of a child with three parents where its own line reaches it, not on a neighbour's", () => {
    const routing = routeSteps(grid("a:0:0 b:1:0 c:2:0 k:1:1"), edges("a>k b>k c>k", 60));
    const boxes = pillBoxes(routing, 60);
    expect(boxes).toHaveLength(3);
    for (const [index, box] of boxes.entries()) for (const other of boxes.slice(index + 1)) expect(boxesOverlap(box, other)).toBe(false);
  });
});

function arranged(entities: readonly Entity[], relationships: readonly Relationship[]): Routing {
  const names = new Set(entities.map((entity) => entity.name));
  const drawn = relationships.filter((item) => names.has(item.parentEntityName) && names.has(item.childEntityName));
  const layout = arrange(entities.map((entity) => ({ name: entity.name, width: W, height: H })), drawn, "tb");
  const nodes = entities.map((entity) => ({ id: entity.name, ...layout.positions.get(entity.name)!, width: W, height: H }));
  return routeSteps(nodes, drawn.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName, labelWidth: item.displayName ? 70 : 0 })));
}

describe("routeSteps on arranged models", () => {
  const dense = denseIncidentModel();
  const incident = incidentModel();
  const calm = calmModel();
  const subset = (model: ReturnType<typeof incidentModel>): Entity[] => {
    const result = causePath(model.entities, model.relationships);
    const names = new Set(result.draw);
    return model.entities.filter((entity) => names.has(entity.name));
  };
  it.each([
    ["the incident model, everything", incident.entities, incident.relationships],
    ["the incident model, cause path", subset(incident), incident.relationships],
    ["the calm model, everything", calm.entities, calm.relationships],
    ["the dense model, everything", dense.entities, dense.relationships],
    ["the dense model, cause path", subset(dense), dense.relationships],
  ] as const)("%s: no line through a card, no shared line between parents, every relationship routed", (_name, entities, relationships) => {
    const routing = arranged(entities, relationships);
    const names = new Set(entities.map((entity) => entity.name));
    const expected = relationships.filter((item) => names.has(item.parentEntityName) && names.has(item.childEntityName)).length;
    expect(routing.edges).toHaveLength(expected);
    expect(throughCards(routing)).toEqual([]);
    expect(collinearOverlaps(routing)).toBe(0);
  });

  it("is deterministic", () => {
    const first = arranged(dense.entities, dense.relationships);
    const second = arranged(dense.entities, dense.relationships);
    expect(second.edges).toEqual(first.edges);
  });
});

describe("routeSteps ports follow the order of the neighbours", () => {
  // Every edge of a parent leaves by the one stem at the middle of its bottom, so only the arrival has an order.
  const ARRIVALS = [
    ["parents in a row above, listed out of order", "p3:3:0 p1:1:0 p2:2:0 c:2:1", "p3>c p1>c p2>c", ["p1", "p2", "p3"]],
    ["parents on two rows, one skipping a row", "far:0:0 near:3:1 c:2:2", "near>c far>c", ["far", "near"]],
    ["parents on two rows, the near one standing left", "far:4:0 near:0:1 c:2:2", "far>c near>c", ["near", "far"]],
    ["a child below four parents, the far ones ordered by the corridor they ride", "a:0:0 b:1:1 d:4:1 e:5:0 c:3:2", "e>c d>c a>c b>c", ["b", "a", "e", "d"]],
  ] as const;

  it.each(ARRIVALS)("%s", (_name, spec, pairs, expected) => {
    const routing = routeSteps(grid(spec), edges(pairs));
    const arriving = routing.edges.filter((edge) => edge.to === "c");
    // Where the last horizontal run of an edge starts is where it comes from: its parent, or the corridor a long edge rides.
    const approach = (edge: (typeof arriving)[number]): number => edge.points.at(-3)?.x ?? edge.points[0]?.x ?? 0;
    const ports = arriving.map((edge) => ({ from: edge.from, port: edge.points.at(-1)?.x ?? 0, approach: approach(edge) }));
    const byPort = [...ports].sort((left, right) => left.port - right.port);

    expect(byPort.map((item) => item.from)).toEqual(expected);
    expect(byPort.map((item) => item.approach)).toEqual([...byPort.map((item) => item.approach)].sort((a, b) => a - b));
    expect(new Set(ports.map((item) => item.port)).size).toBe(ports.length);
  });

  it("starts every edge of a parent at the same stem, so none of them can cross where they leave", () => {
    const routing = routeSteps(grid("p:2:0 a:0:1 b:1:1 c:3:1 d:4:1"), edges("p>d p>a p>c p>b"));

    expect(new Set(routing.edges.map((edge) => `${edge.points[0]?.x}:${edge.points[0]?.y}`)).size).toBe(1);
  });
});
