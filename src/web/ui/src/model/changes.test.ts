import { describe, expect, it } from "vitest";
import {
  badgesByEntity,
  badgesForSide,
  changeIdsForEntity,
  endpointsOf,
  entitiesOfChanges,
  groupChangesByEntity,
  previewSelection,
  referencedDefinitions,
  unattachedVerification,
  unionSnapshots,
  writtenIds,
} from "./changes";
import type { ChangeBadge } from "./changes";
import type { ApplyOutcome, ChangeKind, ChangeOp, DiffChange, Entity, Relationship, VerificationRow } from "./types";

function change(
  id: string,
  op: ChangeOp,
  kind: ChangeKind,
  name: string,
  parts: Partial<Pick<DiffChange, "after" | "before" | "dependsOn" | "verification">> = {},
): DiffChange {
  return {
    id,
    op,
    kind,
    name,
    reason: `reason ${id}`,
    after: op === "remove" ? null : (parts.after ?? {}),
    before: parts.before ?? null,
    details: [],
    dependsOn: parts.dependsOn ?? [],
    verification: parts.verification ?? [],
  };
}

const watching = (definition: string): Record<string, unknown> => ({
  signalGroups: {
    azureResource: { signals: [{ name: "queue-depth", signalDefinitionName: definition }] },
    dependencies: { aggregationType: "WorstOf" },
  },
});

const row = (entity: string): VerificationRow => ({
  entity,
  signal: "queue-depth",
  status: "verified",
  query: null,
  value: 4,
  error: null,
});

/** A review: rename the API, add a queue entity with its signal definition and relationship. */
const REVIEW: readonly DiffChange[] = [
  change("c1", "change", "entity", "orders-api", { after: { displayName: "Orders API" }, before: { displayName: "API" } }),
  change("c2", "add", "signalDefinition", "sd-queue-depth", { verification: [row("order-queue")] }),
  change("c3", "add", "entity", "order-queue", { after: watching("sd-queue-depth"), dependsOn: ["c2", "c4"] }),
  change("c4", "add", "relationship", "orders-api-order-queue", {
    after: { parentEntityName: "orders-api", childEntityName: "order-queue" },
    dependsOn: ["c3"],
  }),
];

const idsOf = (changes: readonly DiffChange[]): string[] => changes.map((item) => item.id);

describe("referencedDefinitions", () => {
  it.each([
    { name: "every signal group", properties: watching("sd-a"), expected: ["sd-a"] },
    { name: "no signal groups", properties: { displayName: "x" }, expected: [] },
    { name: "a group without signals", properties: { signalGroups: { dependencies: {} } }, expected: [] },
    { name: "malformed groups", properties: { signalGroups: { azureResource: { signals: [7, { name: "n" }] } } }, expected: [] },
  ])("finds the definitions of $name", ({ properties, expected }) => {
    expect(referencedDefinitions(properties)).toEqual(expected);
  });
});

describe("endpointsOf", () => {
  it.each([
    { name: "an added relationship", item: REVIEW[3]!, expected: ["orders-api", "order-queue"] },
    { name: "an entity", item: REVIEW[0]!, expected: [null, null] },
    {
      name: "a removed relationship",
      item: change("r", "remove", "relationship", "x", { before: { parentEntityName: "a", childEntityName: "b" } }),
      expected: ["a", "b"],
    },
  ])("reads $name", ({ item, expected }) => {
    expect(endpointsOf(item)).toEqual(expected);
  });
});

describe("groupChangesByEntity", () => {
  it("groups an entity with the signal definitions it references and the relationships that touch it", () => {
    const groups = groupChangesByEntity(REVIEW);
    expect(groups.map((group) => [group.entity, idsOf(group.changes)])).toEqual([
      ["orders-api", ["c1"]],
      ["order-queue", ["c3", "c2", "c4"]],
    ]);
  });

  it.each([
    {
      name: "a relationship between two changed entities goes to the child",
      changes: [
        change("a", "add", "entity", "parent"),
        change("b", "add", "entity", "child"),
        change("r", "add", "relationship", "parent-child", { after: { parentEntityName: "parent", childEntityName: "child" } }),
      ],
      expected: [["parent", ["a"]], ["child", ["b", "r"]]],
    },
    {
      name: "a relationship to an unchanged child goes to the changed parent",
      changes: [
        change("a", "change", "entity", "parent"),
        change("r", "add", "relationship", "parent-child", { after: { parentEntityName: "parent", childEntityName: "child" } }),
      ],
      expected: [["parent", ["a", "r"]]],
    },
    {
      name: "a relationship between two unchanged entities makes its own group",
      changes: [change("r", "remove", "relationship", "x-y", { before: { parentEntityName: "x", childEntityName: "y" } })],
      expected: [["y", ["r"]]],
    },
    {
      name: "a signal definition nobody references comes last, without an owner",
      changes: [change("s", "add", "signalDefinition", "sd-orphan"), change("e", "add", "entity", "alone")],
      expected: [["alone", ["e"]], [null, ["s"]]],
    },
    {
      name: "a signal definition falls back to the entity its verification names",
      changes: [change("s", "add", "signalDefinition", "sd-x", { verification: [row("db")] })],
      expected: [["db", ["s"]]],
    },
    {
      name: "names compare without case",
      changes: [change("e", "add", "entity", "Order-Queue"), change("s", "add", "signalDefinition", "SD-QUEUE", { verification: [] }), change("r", "add", "relationship", "r", { after: { parentEntityName: "x", childEntityName: "order-queue" } })],
      expected: [["Order-Queue", ["e", "r"]], [null, ["s"]]],
    },
  ])("$name", ({ changes, expected }) => {
    expect(groupChangesByEntity(changes).map((group) => [group.entity, idsOf(group.changes)])).toEqual(expected);
  });

  it("returns nothing for an empty diff", () => {
    expect(groupChangesByEntity([])).toEqual([]);
  });
});

describe("badgesByEntity", () => {
  it("badges added, changed and removed entities and the ends of changed relationships", () => {
    const badges = badgesByEntity([
      ...REVIEW,
      change("c5", "remove", "entity", "legacy"),
      change("c6", "remove", "relationship", "x", { before: { parentEntityName: "orders-api", childEntityName: "legacy" } }),
      change("c7", "add", "relationship", "y", { after: { parentEntityName: "root", childEntityName: "orders-api" } }),
    ]);
    expect(Object.fromEntries(badges)).toEqual({
      "orders-api": "changed",
      "order-queue": "added",
      legacy: "removed",
      root: "changed",
    });
  });

  it("keeps the badge of an entity that is also touched by a relationship", () => {
    expect(badgesByEntity(REVIEW).get("order-queue")).toBe("added");
  });

  it("badges the entity a changed signal definition is verified on", () => {
    const badges = badgesByEntity([change("s", "change", "signalDefinition", "sd", { verification: [row("db")] })]);
    expect(Object.fromEntries(badges)).toEqual({ db: "changed" });
  });
});

describe("changeIdsForEntity and entitiesOfChanges", () => {
  it.each([
    { entity: "orders-api", expected: ["c1", "c4"] },
    { entity: "order-queue", expected: ["c2", "c3", "c4"] },
    { entity: "ORDER-QUEUE", expected: ["c2", "c3", "c4"] },
    { entity: "unknown", expected: [] },
  ])("finds the changes of $entity", ({ entity, expected }) => {
    expect(changeIdsForEntity(REVIEW, entity)).toEqual(expected);
  });

  it.each([
    { ids: ["c1"], expected: ["orders-api"] },
    { ids: ["c4"], expected: ["orders-api", "order-queue"] },
    { ids: ["c2"], expected: ["order-queue"] },
    { ids: [], expected: [] },
  ])("marks $expected for $ids", ({ ids, expected }) => {
    expect(entitiesOfChanges(REVIEW, ids)).toEqual(expected);
  });
});

describe("previewSelection", () => {
  it.each([
    { selected: [], written: [], added: [] },
    { selected: ["c1"], written: ["c1"], added: [] },
    { selected: ["c3"], written: ["c2", "c3", "c4"], added: ["c2", "c4"] },
    { selected: ["c4"], written: ["c3", "c4"], added: ["c3"] },
    { selected: ["c2", "c3", "c4"], written: ["c2", "c3", "c4"], added: [] },
    { selected: ["gone"], written: [], added: [] },
  ])("writes $written for $selected", ({ selected, written, added }) => {
    expect(previewSelection(REVIEW, selected)).toEqual({ written, added });
  });
});

describe("badgesForSide", () => {
  const badges = new Map<string, ChangeBadge>([
    ["new", "added"],
    ["old", "removed"],
    ["both", "changed"],
  ]);

  it.each([
    { side: "base" as const, expected: { old: "removed", both: "changed" } },
    { side: "proposed" as const, expected: { new: "added", both: "changed" } },
  ])("draws only what exists on the $side side", ({ side, expected }) => {
    expect(Object.fromEntries(badgesForSide(badges, side))).toEqual(expected);
  });
});

describe("unionSnapshots", () => {
  const entity = (name: string, displayName = name): Entity => ({ name, displayName }) as Entity;
  const link = (name: string): Relationship =>
    ({ name, displayName: null, parentEntityName: "a", childEntityName: "b" }) as Relationship;

  it("lists each entity and relationship once and prefers the Proposed model's copy", () => {
    const union = unionSnapshots(
      { entities: [entity("a", "A before"), entity("gone")], relationships: [link("ab"), link("gone-link")] },
      { entities: [entity("a", "A after"), entity("new")], relationships: [link("ab"), link("new-link")] },
    );
    expect(union.entities.map((item) => [item.name, item.displayName])).toEqual([
      ["a", "A after"],
      ["gone", "gone"],
      ["new", "new"],
    ]);
    expect(union.relationships.map((item) => item.name)).toEqual(["ab", "gone-link", "new-link"]);
  });

  it("returns an empty graph for two empty sides", () => {
    expect(unionSnapshots({ entities: [], relationships: [] }, { entities: [], relationships: [] })).toEqual({
      entities: [],
      relationships: [],
    });
  });
});

describe("writtenIds", () => {
  const outcome = (written: string[]): ApplyOutcome => ({ outcome: "applied", written, failed: null, expanded: written });

  it.each([
    { name: "no outcomes", applies: [], expected: [] },
    { name: "one outcome", applies: [outcome(["c1", "c2"])], expected: ["c1", "c2"] },
    { name: "outcomes that repeat a change", applies: [outcome(["c1"]), outcome(["c1", "c3"])], expected: ["c1", "c3"] },
    { name: "an outcome that wrote nothing", applies: [outcome([])], expected: [] },
  ])("collects the changes of $name", ({ applies, expected }) => {
    expect([...writtenIds(applies)].sort()).toEqual(expected);
  });
});

describe("unattachedVerification", () => {
  const row = (entity: string, signal: string): VerificationRow => ({
    entity,
    signal,
    status: "failing",
    query: null,
    value: null,
    error: "not found",
  });

  it.each([
    { name: "a diff without changes", changes: [], rows: [row("a", "cpu")], expected: ["a/cpu"] },
    {
      name: "rows a change shows",
      changes: [change("c1", "add", "signalDefinition", "sd", { verification: [row("a", "cpu")] })],
      rows: [row("a", "cpu"), row("a", "memory")],
      expected: ["a/memory"],
    },
    { name: "no rows", changes: [change("c1", "add", "entity", "a")], rows: [], expected: [] },
  ])("keeps only the rows of $name that no change shows", ({ changes, rows, expected }) => {
    expect(unattachedVerification(changes, rows).map((item) => `${item.entity}/${item.signal}`)).toEqual(expected);
  });
});
