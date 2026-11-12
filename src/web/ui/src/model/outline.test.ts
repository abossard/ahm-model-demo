// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  expandAllOverrides,
  failingSignals,
  navigate,
  outlineRows,
  revealOverrides,
  ribbonRuns,
  rowAtOffset,
  rowOffsets,
  signalCounts,
  summarise,
  typeAheadRow,
  ROW_HEIGHT,
  ROW_HEIGHT_WITH_SIGNALS,
  type NavigationKey,
  type OutlineRow,
} from "./outline";
import type { Entity, EntitySignal, HealthState, Relationship } from "./types";
import { calmModel, denseIncidentModel, incidentModel } from "../../tests/viewModels";

function signal(name: string, state: HealthState, value: EntitySignal["value"] = 1): EntitySignal {
  return { name, displayName: name.toUpperCase(), kind: "metric", healthState: state, value, reportedAt: null, writable: false };
}

function entity(name: string, healthState: HealthState, signals: readonly EntitySignal[] = [], displayName = name): Entity {
  return {
    name,
    displayName,
    healthState,
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals,
    report: { eligible: true, signalName: null },
  };
}

/** "p>c" pairs. */
function links(pairs: string): Relationship[] {
  return pairs.split(" ").filter(Boolean).map((pair, index) => {
    const [parentEntityName = "", childEntityName = ""] = pair.split(">");
    return { name: `r${index}`, displayName: null, parentEntityName, childEntityName };
  });
}

/** "name:State" tokens. */
function entities(spec: string): Entity[] {
  return spec.split(" ").map((token) => {
    const [name = "", state = "Healthy"] = token.split(":");
    return entity(name, state as HealthState);
  });
}

const keys = (rows: readonly OutlineRow[]): string[] => rows.map((row) => row.key);

describe("outlineRows order", () => {
  it.each([
    ["worst first at every level", "r:Degraded a:Healthy b:Unhealthy c:Degraded d:Unknown", "r>a r>b r>c r>d", ["r", "b", "c", "d", "a"]],
    ["ties by name", "r:Degraded zed:Degraded amy:Degraded mid:Degraded", "r>zed r>amy r>mid", ["r", "amy", "mid", "zed"]],
    ["the model's root before other parts, whatever their state", "lone:Unknown r:Healthy x:Healthy", "r>x", ["r", "x", "lone"]],
    ["other parts worst first", "r:Healthy x:Healthy bad:Unhealthy ok:Unknown", "r>x", ["r", "bad", "ok"]],
  ] as readonly (readonly [string, string, string, readonly string[]])[])("%s", (_name, spec, pairs, expected) => {
    const rows = outlineRows(entities(spec), links(pairs), expandAllOverrides(entities(spec), links(pairs)));
    expect(keys(rows).filter((key) => expected.includes(key))).toEqual(expected);
  });

  it("numbers levels, positions and sibling counts like a tree", () => {
    const rows = outlineRows(entities("r:Degraded a:Degraded b:Unhealthy c:Degraded"), links("r>a r>b a>c"));
    expect(rows.map((row) => [row.key, row.level, row.position, row.setSize, row.parentKey])).toEqual([
      ["r", 1, 1, 1, null],
      ["b", 2, 1, 2, "r"],
      ["a", 2, 2, 2, "r"],
      ["c", 3, 1, 1, "a"],
    ]);
  });
});

describe("outlineRows in the order the viewer gave", () => {
  const SPEC = "r:Degraded a:Healthy b:Unhealthy c:Degraded lone:Unknown other:Healthy b1:Healthy b2:Unhealthy";
  const PAIRS = "r>a r>b r>c b>b1 b>b2";
  const chain = (...chains: readonly (readonly [string, string])[]) => ({ chains: chains.map(([of, names]) => ({ of, names: names.split(" ") })), places: {} });

  it.each([
    ["no order: worst first", null, ["r", "b", "b2", "b1", "c", "a", "lone", "other"]],
    ["the children of a parent stand in its chain, and take their rows below along", chain(["r", "a b c"]), ["r", "a", "b", "b2", "b1", "c", "lone", "other"]],
    ["only the children the chain names trade places", chain(["r", "a b"]), ["r", "a", "c", "b", "b2", "b1", "lone", "other"]],
    ["a chain a level down", chain(["b", "b1 b2"]), ["r", "b", "b1", "b2", "c", "a", "lone", "other"]],
    ["the parts at the top stand in the chain of the top", chain(["", "other lone"]), ["r", "b", "b2", "b1", "c", "a", "other", "lone"]],
    ["the model's own root stays first, whatever the chain of the top says", chain(["", "other lone r"]), ["r", "b", "b2", "b1", "c", "a", "other", "lone"]],
  ] as const)("%s", (_name, order, expected) => {
    const rows = outlineRows(entities(SPEC), links(PAIRS), expandAllOverrides(entities(SPEC), links(PAIRS)), new Set(), order);

    expect(keys(rows)).toEqual(expected);
  });

  it("numbers the places after the order", () => {
    const rows = outlineRows(entities(SPEC), links(PAIRS), new Map(), new Set(), chain(["r", "a c b"]));

    expect(rows.filter((row) => row.parentKey === "r").map((row) => [row.key, row.position, row.setSize])).toEqual([["a", 1, 3], ["c", 2, 3], ["b", 3, 3]]);
  });
});

describe("outlineRows with several parents", () => {
  const spec = entities("r:Degraded left:Degraded right:Healthy shared:Degraded");
  const pairs = links("r>left r>right left>shared right>shared");

  it("shows the entity in full under the first parent reached and as a reference under the others", () => {
    const rows = outlineRows(spec, pairs, new Map([["right", true]]));
    expect(rows.map((row) => [row.key, row.kind, row.shownUnder])).toEqual([
      ["r", "entity", null],
      ["left", "entity", null],
      ["shared", "entity", null],
      ["right", "entity", null],
      ["also:right:shared", "also", "left"],
    ]);
  });

  it("makes a reference a row without children or signals, so it cannot repeat what the full row says", () => {
    const withSignals = spec.map((item) => (item.name === "shared" ? { ...item, signals: [signal("lat", "Degraded")] } : item));
    const reference = outlineRows(withSignals, pairs, new Map([["right", true]])).find((row) => row.kind === "also") as OutlineRow;
    expect(reference).toMatchObject({ expandable: false, open: false, below: 0, failing: [], height: ROW_HEIGHT });
  });

  it("shows the entity in full under the first parent that is open, so a closed parent never hides it", () => {
    const rows = outlineRows(spec, pairs, new Map([["left", false], ["right", true]]));
    expect(rows.map((row) => [row.key, row.kind])).toEqual([["r", "entity"], ["left", "entity"], ["right", "entity"], ["shared", "entity"]]);
  });

  it("counts every entity once in the rows it shows in full", () => {
    const rows = outlineRows(incidentModel().entities, incidentModel().relationships, expandAllOverrides(incidentModel().entities, incidentModel().relationships));
    const full = rows.filter((row) => row.kind === "entity").map((row) => row.key);
    expect(new Set(full).size).toBe(full.length);
    expect(full).toHaveLength(incidentModel().entities.length);
  });
});

describe("outlineRows default collapse", () => {
  it.each([
    ["opens the path to a failing entity and closes healthy subtrees", "r:Degraded a:Degraded bad:Unhealthy ok:Healthy h1:Healthy h2:Healthy", "r>a r>ok a>bad ok>h1 ok>h2", ["r", "a", "bad", "ok"]],
    ["opens a subtree whose only trouble is an Unknown entity", "r:Healthy s:Unknown t:Unknown", "r>s s>t", ["r", "s", "t"]],
    ["keeps the root open on a calm model, with the rest closed", "r:Healthy a:Healthy b:Healthy", "r>a a>b", ["r", "a"]],
  ] as const)("%s", (_name, spec, pairs, expected) => {
    expect(keys(outlineRows(entities(spec), links(pairs)))).toEqual(expected);
  });

  it("lets the viewer's choice win over the default, either way", () => {
    const spec = entities("r:Degraded a:Degraded bad:Unhealthy ok:Healthy h1:Healthy");
    const pairs = links("r>a r>ok a>bad ok>h1");
    expect(keys(outlineRows(spec, pairs, new Map([["ok", true]])))).toContain("h1");
    expect(keys(outlineRows(spec, pairs, new Map([["a", false]])))).not.toContain("bad");
    expect(keys(outlineRows(spec, pairs, new Map([["r", false]])))).toEqual(["r"]);
  });

  it("reports what a closed row hides", () => {
    const rows = outlineRows(entities("r:Degraded ok:Healthy h1:Healthy h2:Healthy bad:Unhealthy"), links("r>ok r>bad ok>h1 ok>h2"));
    expect(rows.find((row) => row.key === "ok")).toMatchObject({ expandable: true, open: false, below: 2, belowTrouble: 0 });
    expect(rows.find((row) => row.key === "r")).toMatchObject({ below: 4, belowTrouble: 1 });
  });

  it("opens everything for expand all, and nothing but the defaults for an empty choice", () => {
    const model = incidentModel();
    const all = outlineRows(model.entities, model.relationships, expandAllOverrides(model.entities, model.relationships));
    const calm = outlineRows(calmModel().entities, calmModel().relationships);
    expect(summarise(all).entities).toBe(model.entities.length);
    expect(summarise(calm).entities).toBeLessThan(calmModel().entities.length);
    expect(summarise(calm).needAttention).toBeGreaterThan(0);
  });
});

describe("outlineRows on dirty data", () => {
  it.each([
    ["a cycle below the root", "r:Degraded a:Degraded b:Degraded", "r>a a>b b>a", ["r", "a", "b", "also:b:a"]],
    ["a cycle with no root at all", "a:Degraded b:Degraded", "a>b b>a", ["a", "b", "also:b:a"]],
    ["an entity that is its own parent", "r:Degraded a:Degraded", "r>a a>a", ["r", "a"]],
    ["a relationship to an entity the model lacks", "r:Degraded a:Degraded", "r>a r>ghost ghost>a", ["r", "a"]],
    ["the same relationship twice", "r:Degraded a:Degraded", "r>a r>a", ["r", "a"]],
  ] as const)("ends on %s", (_name, spec, pairs, expected) => {
    const rows = outlineRows(entities(spec), links(pairs), expandAllOverrides(entities(spec), links(pairs)));
    expect(keys(rows)).toEqual(expected);
  });

  it("starts at an unreached cycle but not at what a closed parent hides", () => {
    const spec = entities("r:Healthy h:Healthy x:Degraded y:Degraded");
    expect(keys(outlineRows(spec, links("r>h h>x x>y y>x"), new Map([["h", false]])))).toEqual(["r", "h"]);
    expect(keys(outlineRows(spec, links("x>y y>x")))).toEqual(["h", "r", "x", "y", "also:y:x"]);
  });

  it("has no rows for an empty model", () => {
    expect(outlineRows([], [])).toEqual([]);
  });
});

describe("the shared models", () => {
  it.each([
    ["incident", incidentModel()],
    ["calm", calmModel()],
    ["dense", denseIncidentModel()],
  ] as const)("opens the %s model with every Degraded and Unhealthy entity in view and some healthy rows closed", (_name, model) => {
    const rows = outlineRows(model.entities, model.relationships);
    const shown = new Set(rows.map((row) => row.key));
    for (const item of model.entities.filter((candidate) => candidate.healthState === "Unhealthy" || candidate.healthState === "Degraded")) expect(shown.has(item.name)).toBe(true);
    expect(rows.filter((row) => row.expandable && !row.open).length).toBeGreaterThan(0);
  });

  it("shows the dense model's shared entities once in full and as references elsewhere", () => {
    const model = denseIncidentModel();
    const rows = outlineRows(model.entities, model.relationships, expandAllOverrides(model.entities, model.relationships));
    const summary = summarise(rows);
    expect(summary.entities).toBe(81);
    expect(summary.references).toBeGreaterThan(8);
  });
});

describe("failingSignals and signalCounts", () => {
  const item = entity("a", "Degraded", [signal("ok", "Healthy", 5), signal("slow", "Degraded", 4.090909090909091), signal("down", "Unhealthy", 12), signal("none", "Unknown", null), signal("odd", "Healthy")]);

  it("lists the signals that are not Healthy, worst first, with a readable value", () => {
    expect(failingSignals(item)).toEqual([
      { name: "DOWN", value: "12", state: "Unhealthy" },
      { name: "SLOW", value: "4.091", state: "Degraded" },
      { name: "NONE", value: "no data", state: "Unknown" },
    ]);
  });

  it("counts signals by state, worst first, leaving out empty states", () => {
    expect(signalCounts(item)).toEqual([
      { state: "Unhealthy", count: 1 },
      { state: "Degraded", count: 1 },
      { state: "Unknown", count: 1 },
      { state: "Healthy", count: 2 },
    ]);
    expect(signalCounts(entity("b", "Healthy"))).toEqual([]);
  });

  it("gives a row with failing signals the taller height", () => {
    const rows = outlineRows([item, entity("b", "Healthy")], links(""));
    expect(rows.map((row) => row.height)).toEqual([ROW_HEIGHT_WITH_SIGNALS, ROW_HEIGHT]);
  });
});

describe("navigate", () => {
  // r > [b (open) > [c], a (closed)], and z, a part of its own
  const rows = outlineRows(entities("r:Degraded b:Unhealthy c:Unhealthy a:Healthy h:Healthy z:Healthy"), links("r>b r>a b>c a>h"));
  const names = keys(rows);

  it.each([
    ["ArrowDown", "r", "b"],
    ["ArrowDown", "a", "z"],
    ["ArrowDown", "z", "z"],
    ["ArrowUp", "b", "r"],
    ["ArrowUp", "r", "r"],
    ["Home", "c", "r"],
    ["End", "r", "z"],
    ["ArrowRight", "r", "b"],
    ["ArrowRight", "a", "a"],
    ["ArrowRight", "c", "c"],
    ["ArrowLeft", "c", "b"],
    ["ArrowLeft", "b", "r"],
    ["ArrowLeft", "r", "r"],
  ] as readonly (readonly [NavigationKey, string, string])[])("%s from %s goes to %s", (key, from, to) => {
    expect(names[navigate(rows, names.indexOf(from), key)]).toBe(to);
  });

  it("stays put with no rows", () => {
    expect(navigate([], 0, "ArrowDown")).toBe(0);
    expect(navigate([], 0, "End")).toBe(0);
  });
});

describe("typeAheadRow", () => {
  const rows = outlineRows(entities("root:Degraded alpha:Degraded alpine:Degraded beta:Degraded"), links("root>alpha root>alpine root>beta"));
  const names = keys(rows);

  it.each([
    ["a", "root", "alpha"],
    ["a", "alpha", "alpine"],
    ["a", "alpine", "alpha"],
    ["alp", "alpha", "alpha"],
    ["alpi", "alpha", "alpine"],
    ["B", "root", "beta"],
    ["x", "root", "root"],
    ["", "alpha", "alpha"],
  ])("typing %j from %s lands on %s", (prefix, from, to) => {
    expect(names[typeAheadRow(rows, names.indexOf(from), prefix)]).toBe(to);
  });
});

describe("revealOverrides", () => {
  const spec = entities("r:Degraded bad:Unhealthy ok:Healthy mid:Healthy leaf:Healthy");
  const pairs = links("r>bad r>ok ok>mid mid>leaf");

  it("opens the closed ancestors of an entity and leaves open ones alone", () => {
    const next = revealOverrides(spec, pairs, new Map(), ["leaf"]);
    expect([...next.entries()].sort()).toEqual([["mid", true], ["ok", true]]);
    expect(keys(outlineRows(spec, pairs, next))).toContain("leaf");
  });

  it("keeps the viewer's other choices", () => {
    expect(revealOverrides(spec, pairs, new Map([["bad", false]]), ["leaf"]).get("bad")).toBe(false);
  });

  it("ends on a cycle and ignores a name the model lacks", () => {
    const cyclic = revealOverrides(entities("a:Healthy b:Healthy"), links("a>b b>a"), new Map(), ["a", "ghost"]);
    expect(cyclic.size).toBeLessThanOrEqual(2);
  });
});

describe("the ribbon and row offsets", () => {
  const rows = outlineRows(entities("r:Degraded b:Unhealthy c:Unhealthy d:Healthy e:Healthy"), links("r>b r>c r>d r>e"), new Map([["r", true]]));

  it("gives each row its place in the list, with the total last", () => {
    expect(rowOffsets(rows)).toEqual([0, 36, 72, 108, 144, 180]);
  });

  it.each([
    [0, 0],
    [35, 0],
    [36, 1],
    [143, 3],
    [179, 4],
    [500, 4],
  ])("finds the row at height %s: %s", (position, index) => {
    expect(rowAtOffset(rowOffsets(rows), position)).toBe(index);
  });

  it("merges neighbouring rows in one state into one mark and covers the whole list", () => {
    const runs = ribbonRuns(rows);
    expect(runs.map((run) => [run.state, run.y, run.height])).toEqual([["Degraded", 0, 36], ["Unhealthy", 36, 72], ["Healthy", 108, 72]]);
    expect(runs.reduce((sum, run) => sum + run.height, 0)).toBe(rowOffsets(rows).at(-1));
  });
});
