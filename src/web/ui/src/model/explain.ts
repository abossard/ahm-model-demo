import type { ExplainResult } from "./types";

/** The entities an Explain result walks, the asked one first, each once. */
export function chainEntities(result: ExplainResult): readonly string[] {
  return [...new Set([result.entity, ...result.causes.map((cause) => cause.entity)])];
}
