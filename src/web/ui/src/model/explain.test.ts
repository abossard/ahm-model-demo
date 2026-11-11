import { describe, expect, it } from "vitest";
import { chainEntities } from "./explain";
import type { ExplainCause, ExplainResult } from "./types";

function cause(entity: string): ExplainCause {
  return { entity, signal: null, state: "Degraded", threshold: null, value: null, rollup: null, note: "n" };
}

function result(entity: string, causes: readonly string[]): ExplainResult {
  return { kind: "explain", entity, state: "Degraded", summary: "s", causes: causes.map(cause) };
}

describe("chainEntities", () => {
  it.each([
    { name: "the asked entity then its causes", input: result("web", ["web", "api", "db"]), expected: ["web", "api", "db"] },
    { name: "the asked entity when the chain omits it", input: result("web", ["api"]), expected: ["web", "api"] },
    { name: "each entity once", input: result("web", ["api", "api", "web"]), expected: ["web", "api"] },
    { name: "only the asked entity for an empty chain", input: result("web", []), expected: ["web"] },
  ])("lists $name", ({ input, expected }) => {
    expect(chainEntities(input)).toEqual(expected);
  });
});
