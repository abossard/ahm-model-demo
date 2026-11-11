import { describe, expect, it } from "vitest";
import type { TimelineResponse } from "../model/timeline";
import { CACHE_SCHEMA, unwrap, wrap } from "./overviewCache";

const RESPONSE = { model: "m", entities: [], states: [], series: [], annotations: [], reports: [], failures: [] } as unknown as TimelineResponse;
const DAY = 24 * 3600 * 1000;

describe("what the browser cache keeps", () => {
  it("gives back what it was given", () => {
    expect(unwrap(wrap(RESPONSE, 1000), 2000)).toBe(RESPONSE);
  });

  it.each([
    { name: "another schema", entry: { ...wrap(RESPONSE, 1000), schema: CACHE_SCHEMA + 1 } },
    { name: "an entry older than 30 days", entry: wrap(RESPONSE, 0), now: 31 * DAY },
    { name: "nothing", entry: undefined },
    { name: "a string", entry: "x" },
    { name: "an entry without a time", entry: { schema: CACHE_SCHEMA, response: RESPONSE } },
    { name: "an entry whose response is not an overview", entry: { schema: CACHE_SCHEMA, savedAt: 1, response: { states: 3 } } },
  ])("reads $name as no entry", ({ entry, now }) => {
    expect(unwrap(entry, now ?? 2000)).toBeNull();
  });
});
