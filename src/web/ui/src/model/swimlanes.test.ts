// @vitest-environment node
import { describe, expect, it } from "vitest";
import { basisFor, linkKey } from "./compare";
import { layerOf } from "./layerOf";
import { contentKey, firstProblem, foldId, layoutSwimlanes, lineageOf, withParents, type SwimlaneLayout, type SwimlaneOnly, type SwimlaneOptions } from "./swimlanes";
import { pillOf } from "./swimlaneCard";
import { sharedTracks } from "./swimlaneRoute";
import { throughCards, type Rect } from "./stepRouter";
import type { Entity, Relationship } from "./types";
import { healthModel, realShapeModel } from "../../tests/fixture";
import { calmModel, denseIncidentModel, diffViewModel, incidentModel } from "../../tests/viewModels";

interface Model {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const MODELS: readonly (readonly [string, Model])[] = [
  ["the classic model", healthModel],
  ["the real-shape model", realShapeModel],
  ["the incident model", incidentModel()],
  ["the calm model", calmModel()],
  ["the dense model", denseIncidentModel()],
  ["the diff's proposed model", diffViewModel().proposed],
];

const BASE: SwimlaneOptions = { signals: true, labels: null, open: new Set(), keep: new Set() };

function lay(model: Model, options: Partial<SwimlaneOptions> = {}): SwimlaneLayout {
  return layoutSwimlanes({ entities: model.entities, relationships: model.relationships, layering: layerOf(model.entities, model.relationships) }, { ...BASE, ...options });
}

const rectsOf = (layout: SwimlaneLayout): Map<string, Rect> => new Map([...layout.cards.map((card) => [card.id, card.rect] as const), ...layout.folds.map((fold) => [fold.id, fold.rect] as const)]);
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const pillRect = (center: { x: number; y: number }, text: string): Rect => {
  const pill = pillOf(text) as NonNullable<ReturnType<typeof pillOf>>;
  return { x: center.x - pill.width / 2, y: center.y - pill.height / 2, width: pill.width, height: pill.height };
};

describe("layoutSwimlanes, what holds for every model", () => {
  const variants: readonly (readonly [string, Partial<SwimlaneOptions>])[] = [
    ["by default", {}],
    ["with labels and signals on", { labels: true }],
    ["with signals off", { signals: false }],
  ];

  describe.each(MODELS)("%s", (_name, model) => {
    it.each(variants)("draws every entity once, or folds it into a chip, %s", (_label, options) => {
      const layout = lay(model, options);
      const drawn = layout.cards.map((card) => card.id);
      expect(new Set(drawn).size).toBe(drawn.length);
      const folded = new Set(layout.folds.filter((fold) => !fold.open).flatMap((fold) => fold.members));
      for (const entity of model.entities) expect(drawn.includes(entity.name) !== folded.has(entity.name), entity.name).toBe(true);
    });

    it.each(variants)("puts no card or chip on another, and keeps all of them inside the bounds and their lane, %s", (_label, options) => {
      const layout = lay(model, options);
      const rects = [...rectsOf(layout)];
      for (const [index, [id, rect]] of rects.entries()) {
        for (const [other, otherRect] of rects.slice(index + 1)) expect(overlap(rect, otherRect), `${id} on ${other}`).toBe(false);
        expect(rect.x).toBeGreaterThanOrEqual(layout.bounds.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(layout.bounds.height);
      }
      for (const thing of [...layout.cards, ...layout.folds]) {
        const lane = layout.lanes[thing.lane];
        expect(lane, thing.id).toBeDefined();
        expect(thing.rect.y).toBeGreaterThanOrEqual((lane as NonNullable<typeof lane>).rect.y);
        expect(thing.rect.y + thing.rect.height).toBeLessThanOrEqual((lane as NonNullable<typeof lane>).rect.y + (lane as NonNullable<typeof lane>).rect.height);
      }
      layout.lanes.slice(1).forEach((lane, index) => expect(lane.rect.y).toBeGreaterThanOrEqual((layout.lanes[index] as NonNullable<(typeof layout.lanes)[number]>).rect.y + (layout.lanes[index] as NonNullable<(typeof layout.lanes)[number]>).rect.height - 1e-6));
    });

    it.each(variants)("draws no line through a card and no two lines of different edges along one track, %s", (_label, options) => {
      const layout = lay(model, options);
      const edges = layout.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, points: edge.points, label: edge.label }));
      expect(throughCards({ nodes: rectsOf(layout), edges, bounds: layout.bounds })).toEqual([]);
      expect(sharedTracks(edges)).toBe(0);
    });

    it.each(variants)("ends every line on the two cards it connects, in right angles, %s", (_label, options) => {
      const layout = lay(model, options);
      const rects = rectsOf(layout);
      for (const edge of layout.edges) {
        const [first, last] = [edge.points[0], edge.points.at(-1)] as [NonNullable<(typeof edge.points)[number]>, NonNullable<(typeof edge.points)[number]>];
        const onCard = (point: typeof first, id: string): boolean => {
          const rect = rects.get(id) as Rect;
          return point.x >= rect.x && point.x <= rect.x + rect.width && (Math.abs(point.y - rect.y) < 1e-6 || Math.abs(point.y - rect.y - rect.height) < 1e-6);
        };
        expect((onCard(first, edge.from) && onCard(last, edge.to)) || (onCard(first, edge.to) && onCard(last, edge.from)), edge.id).toBe(true);
        edge.points.forEach((point, index) => index === 0 || expect(point.x === (edge.points[index - 1] as typeof point).x || point.y === (edge.points[index - 1] as typeof point).y, edge.id).toBe(true));
      }
    });

    it.each(variants)("puts label pills clear of cards and of each other, %s", (_label, options) => {
      const layout = lay(model, options);
      const rects = [...rectsOf(layout)];
      const pills = layout.edges.filter((edge) => edge.label !== null).map((edge) => [edge.id, pillRect(edge.label as NonNullable<typeof edge.label>, edge.text)] as const);
      for (const [index, [id, pill]] of pills.entries()) {
        for (const [card, rect] of rects) expect(overlap(pill, rect), `${id} on ${card}`).toBe(false);
        for (const [other, rect] of pills.slice(index + 1)) expect(overlap(pill, rect), `${id} on ${other}`).toBe(false);
      }
    });

    it("is the same layout whatever order the entities and relationships come in", () => {
      const expected = lay(model);
      const shuffled = lay({ entities: [...model.entities].reverse(), relationships: [...model.relationships].reverse() });
      const round = (layout: SwimlaneLayout): unknown => JSON.parse(JSON.stringify(layout, (_key, value: unknown) => (typeof value === "number" ? Math.round(value * 100) / 100 : value)));
      expect(round(shuffled)).toEqual(round(expected));
    });
  });
});

describe("layoutSwimlanes, lanes", () => {
  it.each([
    ["the incident model", incidentModel(), ["root", "flows", "systems", "resources", "context"], [1, 3, 4, 4, 5]],
    ["the classic model", healthModel, ["root", "flows", "resources", "context"], [1, 2, 1, 2]],
    ["the real-shape model", realShapeModel, ["root", "resources", "context"], [1, 1, 3]],
  ] as const)("%s: the lanes in order, with how many entities each holds", (_name, model, kinds, counts) => {
    const layout = lay(model);
    expect(layout.lanes.map((lane) => lane.kind)).toEqual(kinds);
    expect(layout.lanes.map((lane) => lane.count)).toEqual(counts);
  });

  it("keeps an entity in its lane when the Health filter hides others, and draws no lane that has nothing left", () => {
    const model = incidentModel();
    const layering = layerOf(model.entities, model.relationships);
    const shown = model.entities.filter((entity) => entity.healthState === "Degraded" || entity.healthState === "Unhealthy");
    const layout = layoutSwimlanes({ entities: shown, relationships: model.relationships, layering }, BASE);
    const full = lay(model);
    const kindOf = (result: SwimlaneLayout, id: string): string => result.lanes[result.cards.find((card) => card.id === id)?.lane ?? -1]?.kind ?? "";
    for (const card of layout.cards) expect(kindOf(layout, card.id), card.id).toBe(kindOf(full, card.id));
    expect(layout.lanes.map((lane) => lane.kind)).toEqual(["root", "flows", "systems", "resources"]);
  });

  const tree = (...pairs: readonly (readonly [string, string])[]): Model => {
    const names = [...new Set(pairs.flat())];
    const entities: Entity[] = names.map((name) => ({ name, displayName: name, healthState: "Healthy", impact: "Standard", canvasPosition: null, discoveredBy: null, parents: [], children: [], unlinked: false, latestEvaluationAt: null, latestTransitionAt: null, signals: [], report: { eligible: true, signalName: null } }));
    return { entities, relationships: pairs.map(([parent, child]) => ({ name: `${parent}-${child}`, displayName: null, parentEntityName: parent, childEntityName: child })) };
  };

  it.each([
    ["one lane under a chip", tree(["r", "p"], ["p", "a"], ["p", "b"]), ["root", "flows"]],
    ["two lanes under a chip", tree(["r", "p"], ["p", "q"], ["q", "a"], ["q", "b"]), ["root", "flows"]],
  ] as const)("draws no lane that a chip folded away, and every card and chip is in a lane that is there: %s", (_name, model, kinds) => {
    const layout = lay(model, { foldAbove: 1 });
    expect(layout.folds.length).toBeGreaterThan(0);
    expect(layout.lanes.map((lane) => lane.kind)).toEqual(kinds);
    for (const lane of layout.lanes) for (const value of [lane.rect.x, lane.rect.y, lane.rect.width, lane.rect.height]) expect(Number.isFinite(value), lane.kind).toBe(true);
    for (const thing of [...layout.cards, ...layout.folds]) expect(layout.lanes[thing.lane], thing.id).toBeDefined();
    expect(Number.isFinite(layout.bounds.height)).toBe(true);
    expect(layout.bounds.height).toBeGreaterThanOrEqual(Math.max(...layout.lanes.map((lane) => lane.rect.y + lane.rect.height)));
  });

  it("lists the cards lane by lane, row by row, left to right", () => {
    const layout = lay(incidentModel());
    const keys = layout.cards.map((card) => [card.lane, card.row, card.rect.x]);
    expect(keys).toEqual([...keys].sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number) || (a[2] as number) - (b[2] as number)));
  });

  it("draws an unlinked entity, which has no line, in the context lane", () => {
    const layout = lay(diffViewModel().proposed);
    expect(layout.lanes[layout.cards.find((card) => card.id === "pager-webhook")?.lane ?? -1]?.kind).toBe("context");
    expect(layout.edges.some((edge) => edge.from === "pager-webhook" || edge.to === "pager-webhook")).toBe(false);
  });
});

describe("layoutSwimlanes, cards, labels and signals", () => {
  it("shows labels on a model that is not dense, and not on one that is, unless asked", () => {
    expect(lay(incidentModel()).edges.filter((edge) => edge.text !== "").length).toBeGreaterThan(10);
    expect(lay(denseIncidentModel()).edges.filter((edge) => edge.text !== "")).toHaveLength(0);
    expect(lay(denseIncidentModel(), { labels: true }).edges.filter((edge) => edge.text !== "").length).toBeGreaterThan(10);
    expect(lay(incidentModel(), { labels: false }).edges.filter((edge) => edge.text !== "")).toHaveLength(0);
  });

  it("lists every signal in a model that is not dense, and only the ones that are not healthy in one that is", () => {
    const rows = (layout: SwimlaneLayout, id: string): readonly string[] => layout.cards.find((card) => card.id === id)?.spec.rows.map((row) => row.name) ?? [];
    expect(rows(lay(incidentModel()), "container-app")).toHaveLength(6);
    expect(rows(lay(incidentModel(), { signals: false }), "container-app")).toEqual([]);
    expect(rows(lay(denseIncidentModel()), "res-sql-orders")).toEqual(["Connection failures"]);
    expect(lay(denseIncidentModel()).cards.find((card) => card.id === "res-sql-orders")?.spec.summary).toBe("+1 healthy signal");
  });

  it("sizes a card by its content, so two entities with different names and signals get different cards", () => {
    const layout = lay(incidentModel());
    const sizes = new Set(layout.cards.map((card) => `${Math.round(card.rect.width)}x${Math.round(card.rect.height)}`));
    expect(sizes.size).toBeGreaterThan(4);
  });

  it("gives a diff badge a chip on its card", () => {
    const layout = lay(incidentModel(), { badges: new Map([["foundry-account", "changed"]]) });
    expect(layout.cards.find((card) => card.id === "foundry-account")?.spec.chips.map((chip) => chip.word)).toEqual(["Changed"]);
  });
});

describe("layoutSwimlanes, a dense model", () => {
  const model = denseIncidentModel();

  it("folds the healthy parts into chips, wraps long lanes into rows, and is far narrower than a single row of cards", () => {
    const layout = lay(model);
    expect(layout.dense).toBe(true);
    expect(layout.folds.length).toBeGreaterThan(5);
    expect(layout.cards.length + layout.folds.length).toBeLessThan(model.entities.length);
    expect(new Set([...layout.cards, ...layout.folds].map((item) => item.row)).size).toBeGreaterThan(layout.lanes.length - 1);
    const naive = model.entities.length * 200;
    expect(layout.bounds.width).toBeLessThan(naive / 4);
    expect(layout.bounds.width).toBeLessThan(3500);
    expect(layout.shortages).toBe(0);
  });

  it("is not dense, and folds nothing, when the model is small or folding is off", () => {
    expect(lay(incidentModel()).dense).toBe(false);
    expect(lay(incidentModel()).folds).toEqual([]);
    expect(lay(model, { foldAbove: 0 }).dense).toBe(false);
  });

  it("puts a chip under its owner with a line to it, and says how many it stands for", () => {
    const layout = lay(model);
    for (const fold of layout.folds) {
      expect(layout.edges.some((edge) => edge.from === fold.owner && edge.to === fold.id && edge.relationship === null), fold.id).toBe(true);
      expect(fold.members.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("draws what a chip stood for when it is open, and keeps the chip to close it again", () => {
    const closed = lay(model);
    const fold = closed.folds[0] as NonNullable<(typeof closed.folds)[number]>;
    const opened = lay(model, { open: new Set([fold.owner]) });
    expect(opened.folds.find((item) => item.id === foldId(fold.owner))?.open).toBe(true);
    expect(opened.cards.length).toBeGreaterThan(closed.cards.length);
    const roots = fold.members.filter((member) => opened.cards.some((card) => card.id === member));
    expect(roots.length).toBeGreaterThan(0);
  });

  it("never folds what is kept, such as the chain of an Explain result", () => {
    const folded = lay(model).folds.flatMap((fold) => fold.members);
    const kept = folded[0] as string;
    const layout = lay(model, { keep: new Set([kept]) });
    expect(layout.cards.some((card) => card.id === kept)).toBe(true);
  });

  it("lays out in a generous time (a note, not a limit: the numbers go to the log)", () => {
    const times: string[] = [];
    for (const [name, subject] of [["17 entities", incidentModel()], ["81 entities", model]] as const) {
      lay(subject);
      const start = performance.now();
      for (let run = 0; run < 3; run += 1) lay(subject);
      const ms = (performance.now() - start) / 3;
      times.push(`${name}: ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(5000);
    }
    console.info(`swimlane layout, mean of 3 warm runs: ${times.join(", ")}`);
  });
});

describe("firstProblem, withParents, lineageOf and contentKey", () => {
  const layout = lay(incidentModel());
  const byName = new Map(incidentModel().entities.map((entity) => [entity.name, entity] as const));

  it("opens on the deepest part that is unhealthy, else degraded, and on nothing when all is well", () => {
    expect(firstProblem(layout, byName)).toBe("session-storage");
    const calm = calmModel();
    expect(firstProblem(lay(calm), new Map(calm.entities.map((entity) => [entity.name, entity] as const)))).toBeNull();
  });

  it("brings a card with the cards that draw a line into it", () => {
    expect(withParents(layout, "session-storage")).toEqual(["session-storage", "system-session-store"]);
    expect(withParents(layout, "hm-contosodemo")).toEqual(["hm-contosodemo"]);
  });

  it("follows an entity up to the root, every way there is", () => {
    const edges = layout.edges.filter((edge) => lineageOf(layout, ["system-app-hosting"]).has(edge.id)).map((edge) => `${edge.from}>${edge.to}`).sort();
    expect(edges).toEqual(["flow-run-agent-tasks>system-app-hosting", "flow-send-health-reports>system-app-hosting", "flow-view-health-model>system-app-hosting", "hm-contosodemo>flow-run-agent-tasks", "hm-contosodemo>flow-send-health-reports", "hm-contosodemo>flow-view-health-model"]);
  });

  it("changes when a state, a value, a name or a link changes, and not when the same model comes again", () => {
    const model = incidentModel();
    const key = contentKey(model.entities, model.relationships);
    expect(contentKey(incidentModel().entities, incidentModel().relationships)).toBe(key);
    expect(contentKey(model.entities.map((entity, index) => (index === 3 ? { ...entity, healthState: "Unhealthy" as const } : entity)), model.relationships)).not.toBe(key);
    expect(contentKey(model.entities.map((entity, index) => (index === 3 ? { ...entity, displayName: "Renamed" } : entity)), model.relationships)).not.toBe(key);
    expect(contentKey(model.entities, model.relationships.slice(1))).not.toBe(key);
    expect(contentKey(model.entities.map((entity) => (entity.signals.length ? { ...entity, signals: entity.signals.map((item, index) => (index === 0 ? { ...item, value: 123456 } : item)) } : entity)), model.relationships)).not.toBe(key);
  });
});

describe("layoutSwimlanes in Compare, one side of a layout made for both", () => {
  const view = diffViewModel();
  const sides = [
    { side: "base" as const, snapshot: view.base },
    { side: "proposed" as const, snapshot: view.proposed },
  ];
  const onlyOf = (snapshot: Model): SwimlaneOnly => ({
    entities: new Set(snapshot.entities.map((item) => item.name)),
    links: new Set(snapshot.relationships.map((item) => linkKey(item.parentEntityName, item.childEntityName))),
  });

  describe.each(sides)("the $side side", ({ side, snapshot }) => {
    const basis = basisFor(view, side);
    const rival = basisFor(view, side === "base" ? "proposed" : "base").entities;
    const together = lay(basis, { rival });
    const mine = lay(basis, { only: onlyOf(snapshot), rival });

    it("draws exactly the cards it has", () => {
      expect(mine.cards.map((card) => card.id).sort()).toEqual(snapshot.entities.map((item) => item.name).sort());
    });

    it("puts each card where the layout of both sides puts it, in the same lanes", () => {
      const places = rectsOf(together);
      for (const card of mine.cards) expect(card.rect, card.id).toEqual(places.get(card.id));
      expect(mine.lanes.map((lane) => lane.rect)).toEqual(together.lanes.map((lane) => lane.rect));
      expect(mine.bounds).toEqual(together.bounds);
    });

    it("gives an entity the same room on both sides, even where one version is bigger", () => {
      const other = lay(basisFor(view, side === "base" ? "proposed" : "base"), { rival: basis.entities, only: onlyOf(side === "base" ? view.proposed : view.base) });
      const rooms = new Map(other.cards.map((card) => [card.id, card.rect] as const));
      for (const card of mine.cards) if (rooms.has(card.id)) expect(card.rect, card.id).toEqual(rooms.get(card.id));
    });

    it("counts in each lane the entities this side has", () => {
      const names = new Set(snapshot.entities.map((item) => item.name));
      const layering = layerOf(basis.entities, basis.relationships);
      for (const lane of mine.lanes) {
        const expected = layering.lanes.find((item) => item.kind === lane.kind)?.names.filter((name) => names.has(name)).length;
        expect(lane.count, lane.kind).toBe(expected);
      }
    });

    it("draws exactly the lines it has, on the routes of both sides", () => {
      const links = onlyOf(snapshot).links;
      const wanted = together.edges.filter((edge) => links.has(linkKey(edge.from, edge.to)));
      expect(mine.edges.map((edge) => edge.id).sort()).toEqual(wanted.map((edge) => edge.id).sort());
      for (const edge of mine.edges) expect(edge.points).toEqual(together.edges.find((item) => item.id === edge.id)?.points);
    });

    it("puts no line through a card", () => {
      const edges = mine.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, points: edge.points, label: edge.label }));
      expect(throughCards({ nodes: rectsOf(mine), edges, bounds: mine.bounds })).toEqual([]);
    });
  });

  describe("a chip", () => {
    const model = denseIncidentModel();
    const whole = lay(model, { foldAbove: 600 });
    const chips = whole.folds.filter((fold) => !fold.open);
    const chip = chips[0];

    it("is drawn in the dense layout the other tests rely on", () => {
      expect(chip).toBeDefined();
    });

    it.each([
      { name: "keeps the members this side has", keepEvery: 2 },
      { name: "is gone when the side has none of its members", keepEvery: 0 },
    ])("$name", ({ keepEvery }) => {
      const members = new Set(chip?.members ?? []);
      const kept = new Set(model.entities.map((item) => item.name).filter((name) => !members.has(name)));
      (chip?.members ?? []).forEach((name, index) => keepEvery > 0 && index % keepEvery === 0 && kept.add(name));
      const mine = lay(model, { foldAbove: 600, only: { entities: kept, links: new Set(model.relationships.map((item) => linkKey(item.parentEntityName, item.childEntityName))) } });
      const found = mine.folds.find((fold) => fold.id === chip?.id);
      const expected = (chip?.members ?? []).filter((_name, index) => keepEvery > 0 && index % keepEvery === 0);
      expect(found?.members ?? []).toEqual(expected.sort());
      expect(mine.edges.some((edge) => edge.to === chip?.id)).toBe(expected.length > 0);
    });
  });
});
