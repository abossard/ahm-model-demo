// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CAUSE_RULE, causePath, openToReveal, type CauseRule, type FoldedGroup } from "./causePath";
import type { Entity, HealthState, Relationship } from "./types";
import { calmModel, denseIncidentModel, incidentModel } from "../../tests/viewModels";

function entity(name: string, healthState: HealthState, impact = "Standard"): Entity {
  return {
    name,
    displayName: name,
    healthState,
    impact,
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: "s" },
  };
}

/** `states`: "root=Degraded a=Unhealthy:Limited"; `edges`: "root>a root>b". */
function graph(states: string, edges: string): { entities: Entity[]; relationships: Relationship[] } {
  const entities = states.split(" ").map((item) => {
    const [name, rest] = item.split("=") as [string, string];
    const [state, impact] = rest.split(":") as [HealthState, string | undefined];
    return entity(name, state, impact);
  });
  const relationships = edges
    .split(" ")
    .filter(Boolean)
    .map((pair, index) => {
      const [parent, child] = pair.split(">") as [string, string];
      return { name: `r${index}`, displayName: null, parentEntityName: parent, childEntityName: child };
    });
  return { entities, relationships };
}

const chips = (groups: readonly FoldedGroup[]): string[] => groups.map((group) => `${group.owner}: ${group.label}`);

describe("causePath on the incident-shaped live model", () => {
  const model = incidentModel();
  const result = causePath(model.entities, model.relationships);

  it("draws what needs attention and the way up to the root", () => {
    expect(result.draw.slice().sort()).toEqual(
      ["flow-run-agent-tasks", "hm-contosodemo", "hosted-agent", "session-storage", "system-agent-runtime", "system-session-store"],
    );
    expect(result.calm).toBe(false);
    expect(result.alarms).toBe(6);
    expect(result.root).toBe("hm-contosodemo");
  });

  it("numbers the chain from the failing leaf to the root, through the worst driver", () => {
    expect(result.chain).toEqual(["session-storage", "system-session-store", "flow-run-agent-tasks", "hm-contosodemo"]);
  });

  it("folds the rest into chips under the part they belong to", () => {
    expect(chips(result.folded)).toEqual([
      "hm-contosodemo: +3 healthy",
      "hm-contosodemo: +1 not in rollup",
      "flow-run-agent-tasks: +4 healthy",
      "hm-contosodemo: +3 not connected",
    ]);
  });
});

describe("causePath on a model with nothing wrong", () => {
  const model = calmModel();
  const result = causePath(model.entities, model.relationships);

  it("is calm: the root alone, no chain, and chips for everything", () => {
    expect(result.calm).toBe(true);
    expect(result.draw).toEqual(["hm-contosodemo"]);
    expect(result.chain).toEqual([]);
    expect(result.alarms).toBe(0);
    expect(chips(result.folded)).toEqual([
      "hm-contosodemo: +12 healthy",
      "hm-contosodemo: +1 not in rollup",
      "hm-contosodemo: +3 not connected",
    ]);
  });

  it("opens a chip in place: what it holds is drawn, what is below it folds again", () => {
    const opened = causePath(model.entities, model.relationships, { open: new Set(["hm-contosodemo|healthy"]) });
    expect(opened.draw.slice().sort()).toEqual(
      ["flow-run-agent-tasks", "flow-send-health-reports", "flow-view-health-model", "hm-contosodemo", "platform-context"],
    );
    const group = opened.folded.find((item) => item.id === "hm-contosodemo|healthy") as FoldedGroup;
    expect(group).toMatchObject({ open: true, count: 4, label: "hide" });
    expect(chips(opened.folded.filter((item) => !item.open))).toContain("flow-run-agent-tasks: +8 healthy");
  });

  it("opens the chips a search result sits behind", () => {
    const open = openToReveal(model.entities, model.relationships, {}, ["container-app"]);
    expect([...open].sort()).toEqual(["flow-run-agent-tasks|healthy", "hm-contosodemo|healthy", "system-app-hosting|healthy"]);
    expect(causePath(model.entities, model.relationships, { open }).draw).toContain("container-app");
  });

  it("opens the unconnected chip for a part that hangs under nothing", () => {
    const open = openToReveal(model.entities, model.relationships, {}, ["discover-app-insights"]);
    expect([...open]).toEqual(["#unconnected"]);
  });

  it("draws an Explain chain even when everything on it is healthy, numbered from its last entity", () => {
    const result2 = causePath(model.entities, model.relationships, { explainChain: ["System-Session-Store", "session-storage"] });
    expect(result2.chain).toEqual(["session-storage", "system-session-store"]);
    expect(result2.draw).toEqual(expect.arrayContaining(["session-storage", "system-session-store", "flow-run-agent-tasks", "hm-contosodemo"]));
  });
});

describe("causePath in Compare, where what the diff changes needs attention", () => {
  const calm = calmModel();
  const incident = incidentModel();
  const changed = new Set(["container-app", "discovered-app-topology"]);

  it("draws a changed part and its ancestors in a model with nothing wrong, and folds the rest", () => {
    const result = causePath(calm.entities, calm.relationships, { changed });
    expect(result.draw.slice().sort()).toEqual(["container-app", "discovered-app-topology", "flow-run-agent-tasks", "flow-send-health-reports", "flow-view-health-model", "hm-contosodemo", "system-app-hosting"]);
    const folded = result.folded.flatMap((group) => group.names);
    expect([...result.draw, ...folded].sort()).toEqual(calm.entities.map((item) => item.name).sort());
    expect(new Set(folded).size).toBe(folded.length);
    // Health is what it was: the model is calm, and the diff is not a failure.
    expect(result.calm).toBe(true);
    expect(result.chain).toEqual([]);
  });

  it("keeps the failing parts too, and the chain to the root", () => {
    const result = causePath(incident.entities, incident.relationships, { changed });
    expect(result.draw).toEqual(expect.arrayContaining(["session-storage", "system-session-store", "container-app", "system-app-hosting"]));
    expect(result.chain[0]).toBe("session-storage");
  });

  it.each([
    { name: "a name the model does not have", changed: new Set(["nope"]) },
    { name: "no names", changed: new Set<string>() },
  ])("draws what it draws without a diff for $name", ({ changed: names }) => {
    expect(causePath(incident.entities, incident.relationships, { changed: names })).toEqual(causePath(incident.entities, incident.relationships));
  });

  it("is the same whatever the order of the changed names", () => {
    const forward = causePath(calm.entities, calm.relationships, { changed: new Set(["container-app", "session-storage"]) });
    const backward = causePath(calm.entities, calm.relationships, { changed: new Set(["session-storage", "container-app"]) });
    expect(forward).toEqual(backward);
  });
});

describe("causePath drivers", () => {
  const BEST_OF: CauseRule = { rollup: "BestOf", unknownCounts: false };
  const UNKNOWN_COUNTS: CauseRule = { ...DEFAULT_CAUSE_RULE, unknownCounts: true };
  it.each([
    ["a degraded child drives", "root=Degraded a=Degraded b=Healthy", "root>a root>b", DEFAULT_CAUSE_RULE, ["a", "root"]],
    ["the worst of two drives first", "root=Unhealthy a=Degraded b=Unhealthy", "root>a root>b", DEFAULT_CAUSE_RULE, ["b", "root"]],
    ["a Suppressed child never drives", "root=Healthy a=Unhealthy:Suppressed b=Healthy", "root>a root>b", DEFAULT_CAUSE_RULE, []],
    ["a Limited child drives as Degraded and loses to a really Degraded one on state alone", "root=Degraded a=Unhealthy:Limited b=Degraded", "root>a root>b", DEFAULT_CAUSE_RULE, ["a", "root"]],
    ["the walk goes on down to the leaf", "root=Degraded a=Degraded b=Degraded", "root>a a>b", DEFAULT_CAUSE_RULE, ["b", "a", "root"]],
    ["an Unknown child does not drive by default", "root=Unknown a=Unknown", "root>a", DEFAULT_CAUSE_RULE, []],
    ["an Unknown child drives where Unknown counts and nothing is worse", "root=Unknown a=Unknown b=Healthy", "root>a root>b", UNKNOWN_COUNTS, ["a", "root"]],
    ["an Unknown child yields to a Degraded sibling", "root=Degraded a=Unknown b=Degraded", "root>a root>b", UNKNOWN_COUNTS, ["b", "root"]],
    ["under BestOf a healthy sibling stops the walk", "root=Healthy a=Degraded b=Healthy", "root>a root>b", BEST_OF, []],
    ["under BestOf the best of the unhealthy siblings drives", "root=Degraded a=Degraded b=Unhealthy", "root>a root>b", BEST_OF, ["a", "root"]],
    ["a root that is itself degraded is a chain of one", "root=Degraded a=Healthy", "root>a", DEFAULT_CAUSE_RULE, ["root"]],
    ["two parents: the chain goes through the worse one", "root=Unhealthy a=Degraded b=Unhealthy c=Unhealthy", "root>a root>b a>c b>c", DEFAULT_CAUSE_RULE, ["c", "b", "root"]],
  ] as const)("%s", (_name, states, edges, rule, chain) => {
    const { entities, relationships } = graph(states, edges);
    expect(causePath(entities, relationships, { rule }).chain).toEqual(chain);
  });
});

describe("causePath folding", () => {
  it.each([
    ["healthy, suppressed and retired parts fold apart", "root=Degraded a=Degraded h=Healthy s=Unhealthy:Suppressed d=Deleted", "root>a root>h root>s root>d", ["root: +1 healthy", "root: +1 more", "root: +1 not in rollup"]],
    ["unknown parts fold as unknown when nothing is degraded", "root=Healthy a=Healthy u=Unknown", "root>a root>u", ["root: +1 healthy", "root: +1 unknown"]],
    ["a part nothing reaches folds under the root as not connected", "root=Degraded a=Degraded x=Healthy y=Healthy", "root>a x>y", ["root: +2 not connected"]],
    ["a hidden part hangs under its nearest drawn ancestor", "root=Degraded a=Degraded h=Healthy k=Healthy", "root>a a>h h>k", ["a: +2 healthy"]],
    ["nothing hidden, no chip", "root=Degraded a=Degraded", "root>a", []],
  ] as const)("%s", (_name, states, edges, expected) => {
    const { entities, relationships } = graph(states, edges);
    expect(chips(causePath(entities, relationships).folded)).toEqual(expected);
  });

  it("keeps a shared part drawn once and counts each hidden part once", () => {
    const { entities, relationships } = graph("root=Degraded a=Degraded b=Healthy c=Healthy", "root>a root>b a>c b>c");
    const result = causePath(entities, relationships);
    expect(result.draw).toEqual(["root", "a"]);
    expect(result.folded.reduce((sum, group) => sum + group.count, 0)).toBe(2);
  });

  it("does not depend on the order of the input", () => {
    const { entities, relationships } = graph("root=Degraded a=Degraded b=Degraded c=Healthy d=Healthy", "root>a root>b a>c b>c b>d");
    const forward = causePath(entities, relationships);
    const shuffled = causePath([...entities].reverse(), [...relationships].reverse());
    expect(new Set(shuffled.draw)).toEqual(new Set(forward.draw));
    expect(shuffled.chain).toEqual(forward.chain);
    expect(new Set(chips(shuffled.folded))).toEqual(new Set(chips(forward.folded)));
  });
});

describe("causePath on the dense model", () => {
  const model = denseIncidentModel();
  const result = causePath(model.entities, model.relationships);

  it("shrinks 81 entities to the parts that need attention", () => {
    expect(model.entities).toHaveLength(81);
    expect(result.draw.length).toBeGreaterThan(15);
    expect(result.draw.length).toBeLessThan(40);
    expect(result.chain.at(-1)).toBe("root");
    expect(result.chain[0]).toMatch(/^res-/);
  });

  it("accounts for every entity: drawn or inside exactly one chip", () => {
    const folded = result.folded.flatMap((group) => group.names);
    expect(new Set(folded).size).toBe(folded.length);
    expect(result.draw.length + folded.length).toBe(81);
  });

  it("opens every chip in a handful of rounds, never losing an entity", () => {
    let open = new Set<string>();
    for (let round = 0; round < 12; round += 1) {
      const next = causePath(model.entities, model.relationships, { open });
      const closed = next.folded.filter((group) => !group.open);
      if (closed.length === 0) break;
      open = new Set([...open, ...closed.map((group) => group.id)]);
    }
    const all = causePath(model.entities, model.relationships, { open });
    expect(all.draw).toHaveLength(81);
  });
});
