/**
 * The number of each entity on an open Explain chain. `chainNames` holds the asked entity first;
 * the last name is the cause the chain ends in and takes 1, the asked entity the highest. Names
 * match the model's entities regardless of case, and a name the model does not have is skipped.
 */
export function chainSteps(chainNames: readonly string[], entityNames: Iterable<string>): ReadonlyMap<string, number> {
  const actual = new Map<string, string>();
  for (const name of entityNames) actual.set(name.toLowerCase(), name);
  const found: string[] = [];
  for (const name of chainNames) {
    const entity = actual.get(name.toLowerCase());
    if (entity !== undefined && !found.includes(entity)) found.push(entity);
  }
  return new Map(found.map((name, index) => [name, found.length - index] as const));
}
