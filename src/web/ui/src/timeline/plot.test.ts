import { describe, expect, it } from "vitest";
import { EMPTY_TIMELINE, type EntityInfo, type StateHistory, type TimelineData } from "../model/timeline";
import { createEntityBands } from "./plot";

const ENTITY: EntityInfo = { name: "db", displayName: "Database", parents: [], state: 1, signals: [] };
const QUIET: StateHistory = { transitions: [], covered: [{ from: 0, to: 1000 }], error: null };
const data = (now: number): TimelineData => ({ ...EMPTY_TIMELINE, entities: [ENTITY], states: { db: QUIET }, now });

describe("the bands of an entity's row", () => {
  it.each([
    { name: "the same now", now: 2000, entity: ENTITY, expected: [{ a: 0, b: 2000, state: 1 }], same: true },
    { name: "a later now", now: 5000, entity: ENTITY, expected: [{ a: 0, b: 5000, state: 1 }], same: false },
    { name: "a new state", now: 2000, entity: { ...ENTITY, state: 3 as const }, expected: [{ a: 0, b: 2000, state: 3 }], same: false },
  ])("of a quiet history reach now and are made again for $name", ({ now, entity, expected, same }) => {
    const bandsOf = createEntityBands();
    const first = bandsOf(data(2000), ENTITY);

    const next = bandsOf(data(now), entity);

    expect(next).toEqual(expected);
    expect(next === first).toBe(same);
  });
});
