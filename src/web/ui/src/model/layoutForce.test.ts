import { describe, expect, it } from "vitest";
import { createForceLayoutSession, forceLayout } from "./layoutForce";
import type { GraphLayout } from "./layout";
import type { Entity, Relationship } from "./types";
import type { NodeSize, Point } from "./layout";

function entity(name: string): Entity {
  return {
    name,
    displayName: name,
    healthState: "Healthy",
    impact: "Unknown",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
  };
}

function rel(name: string, parent: string, child: string): Relationship {
  return { name, displayName: null, parentEntityName: parent, childEntityName: child };
}

const SIZE: NodeSize = { width: 120, height: 60 };
const sizeOf = (): NodeSize => SIZE;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pairwiseDistances(layout: GraphLayout, ids: readonly string[]): Map<string, number> {
  const byPair = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const leftId = ids[i] as string;
      const rightId = ids[j] as string;
      const left = layout.positions.get(leftId);
      const right = layout.positions.get(rightId);
      if (!left || !right) continue;
      byPair.set(`${leftId}:${rightId}`, Math.hypot(left.x - right.x, left.y - right.y));
    }
  }
  return byPair;
}

describe("forceLayout", () => {
  it("keeps finite output with cycles, self-loops and missing endpoints", async () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [
      rel("r1", "a", "b"),
      rel("r2", "b", "a"),
      rel("r3", "a", "a"),
      rel("r4", "ghost", "c"),
    ];
    const layout = await forceLayout(entities, relationships, sizeOf);
    expect(layout.positions.size).toBe(entities.length);
    for (const name of ["a", "b", "c"]) {
      const point = layout.positions.get(name);
      expect(Number.isFinite(point?.x)).toBe(true);
      expect(Number.isFinite(point?.y)).toBe(true);
    }
  });
});

describe("createForceLayoutSession", () => {
  it("does not mutate caller-owned entities, relationships or remembered positions", async () => {
    const entities = Object.freeze([entity("a"), entity("b"), entity("c")]);
    const relationships = Object.freeze([
      rel("r1", "a", "b"),
      rel("r2", "b", "c"),
    ]);
    const remembered = new Map<string, Point>([
      ["a", { x: 10, y: 20 }],
      ["b", { x: 80, y: 25 }],
    ]);
    const before = {
      entities: JSON.stringify(entities),
      relationships: JSON.stringify(relationships),
      remembered: JSON.stringify([...remembered.entries()]),
    };
    const frames: number[] = [];
    const session = createForceLayoutSession({
      reducedMotion: false,
      onError: (error) => {
        throw error;
      },
      onFrame: (layout) => {
        frames.push(layout.positions.size);
      },
    });

    session.update(entities, relationships, sizeOf, remembered);
    await sleep(80);
    session.setDrag("a", { x: 20, y: 40 });
    await sleep(40);
    session.setDrag("a", null);
    session.settle();
    session.dispose();

    expect(frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(entities)).toBe(before.entities);
    expect(JSON.stringify(relationships)).toBe(before.relationships);
    expect(JSON.stringify([...remembered.entries()])).toBe(before.remembered);
  });

  it("stops publishing frames after dispose", async () => {
    const entities = [entity("a"), entity("b")];
    const relationships = [rel("r1", "a", "b")];
    let published = 0;
    const session = createForceLayoutSession({
      reducedMotion: false,
      onError: (error) => {
        throw error;
      },
      onFrame: () => {
        published += 1;
      },
    });

    session.update(entities, relationships, sizeOf, new Map());
    await sleep(120);
    expect(published).toBeGreaterThan(0);

    const beforeDispose = published;
    session.dispose();
    await sleep(120);
    expect(published).toBe(beforeDispose);
  });

  it("reduced motion publishes a settled frame without continuous animation", async () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [rel("r1", "a", "b"), rel("r2", "b", "c")];
    let published = 0;
    const session = createForceLayoutSession({
      reducedMotion: true,
      onError: (error) => {
        throw error;
      },
      onFrame: () => {
        published += 1;
      },
    });

    session.update(entities, relationships, sizeOf, new Map());
    const firstWindow = published;
    await sleep(150);
    const secondWindow = published;
    session.dispose();

    expect(firstWindow).toBeGreaterThan(0);
    expect(secondWindow).toBe(firstWindow);
  });

  it("reduced motion drag publishes the requested top-left immediately", async () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [rel("r1", "a", "b"), rel("r2", "a", "c")];
    const frames: GraphLayout[] = [];
    const session = createForceLayoutSession({
      reducedMotion: true,
      onError: (error) => {
        throw error;
      },
      onFrame: (layout) => {
        frames.push(layout);
      },
    });

    session.update(entities, relationships, sizeOf, new Map());
    const settled = frames.at(-1)?.positions.get("a");
    expect(settled).toBeDefined();
    const requested = { x: (settled?.x ?? 0) + 240, y: (settled?.y ?? 0) + 90 };
    session.setDrag("a", requested);
    const published = frames.at(-1)?.positions.get("a");
    expect(published).toEqual(requested);
    session.setDrag("a", null);
    session.dispose();
  });

  it("produces deterministic geometry for repeated identical static and reduced-motion calculations", async () => {
    const entities = [entity("a"), entity("b"), entity("c"), entity("d")];
    const relationships = [rel("r1", "a", "b"), rel("r2", "b", "c"), rel("r3", "a", "d")];
    const staticA = await forceLayout(entities, relationships, sizeOf);
    const staticB = await forceLayout(entities, relationships, sizeOf);
    const ids = entities.map((item) => item.name);
    const staticPairsA = pairwiseDistances(staticA, ids);
    const staticPairsB = pairwiseDistances(staticB, ids);
    expect(staticPairsA.size).toBe(staticPairsB.size);
    for (const [pair, distance] of staticPairsA) {
      expect(Math.abs((staticPairsB.get(pair) as number) - distance)).toBeLessThanOrEqual(1e-6);
    }

    const reducedSnapshot = async (): Promise<GraphLayout> => {
      const frames: GraphLayout[] = [];
      const session = createForceLayoutSession({
        reducedMotion: true,
        onError: (error) => {
          throw error;
        },
        onFrame: (layout) => {
          frames.push(layout);
        },
      });
      session.update(entities, relationships, sizeOf, new Map());
      session.dispose();
      return frames.at(-1) as GraphLayout;
    };

    const reducedA = await reducedSnapshot();
    const reducedB = await reducedSnapshot();
    const reducedPairsA = pairwiseDistances(reducedA, ids);
    const reducedPairsB = pairwiseDistances(reducedB, ids);
    expect(reducedPairsA.size).toBe(reducedPairsB.size);
    for (const [pair, distance] of reducedPairsA) {
      expect(Math.abs((reducedPairsB.get(pair) as number) - distance)).toBeLessThanOrEqual(1e-6);
    }
  });

  it("cools to idle and stops publishing within the interaction bound", async () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [rel("r1", "a", "b"), rel("r2", "b", "c")];
    let published = 0;
    const session = createForceLayoutSession({
      reducedMotion: false,
      onError: (error) => {
        throw error;
      },
      onFrame: () => {
        published += 1;
      },
    });
    session.update(entities, relationships, sizeOf, new Map());
    let last = -1;
    let stableReads = 0;
    let stable = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(120);
      if (published === last) stableReads += 1;
      else stableReads = 0;
      last = published;
      if (stableReads >= 2) {
        stable = true;
        break;
      }
    }
    const afterCooling = published;
    session.dispose();

    expect(stable).toBe(true);
    expect(afterCooling).toBeGreaterThan(0);
    expect(afterCooling).toBeLessThanOrEqual(360);
  });

  it("seeds new arrivals from remembered survivors even when the survivor appears later in order", async () => {
    const remembered = new Map<string, Point>([
      ["survivor", { x: 1000, y: 800 }],
      ["anchor", { x: -1000, y: -800 }],
    ]);
    const frames: GraphLayout[] = [];
    const session = createForceLayoutSession({
      reducedMotion: false,
      onError: (error) => {
        throw error;
      },
      onFrame: (layout) => {
        frames.push(layout);
      },
    });

    session.update([entity("survivor"), entity("anchor")], [], sizeOf, remembered);
    await sleep(80);
    const marker = frames.length;
    session.update(
      [entity("new"), entity("survivor"), entity("anchor")],
      [rel("r1", "new", "survivor")],
      sizeOf,
      new Map(frames.at(-1)?.positions ?? []),
    );
    let firstAfterArrival: GraphLayout | undefined;
    for (let i = 0; i < 20; i += 1) {
      await sleep(16);
      if (frames.length > marker) {
        firstAfterArrival = frames[marker] as GraphLayout;
        break;
      }
    }
    expect(firstAfterArrival).toBeDefined();
    const seeded = firstAfterArrival as GraphLayout;
    const newcomer = seeded.positions.get("new") as Point;
    const survivor = seeded.positions.get("survivor") as Point;
    session.dispose();

    const toSurvivor = Math.hypot(newcomer.x - survivor.x, newcomer.y - survivor.y);
    const toOrigin = Math.hypot(newcomer.x, newcomer.y);
    expect(toSurvivor).toBeLessThan(toOrigin);
  });
});
