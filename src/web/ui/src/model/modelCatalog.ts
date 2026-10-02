import type { ModelRef } from "./types";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function sortModelsByNameThenGroup(
  models: readonly ModelRef[],
): readonly ModelRef[] {
  return [...models].sort((left, right) => {
    const byName = normalized(left.name).localeCompare(normalized(right.name));
    if (byName !== 0) return byName;
    return normalized(left.resourceGroup).localeCompare(
      normalized(right.resourceGroup),
    );
  });
}

export function filterModels(
  models: readonly ModelRef[],
  query: string,
): readonly ModelRef[] {
  const needle = normalized(query);
  if (!needle) return models;
  return models.filter(
    (item) =>
      normalized(item.name).includes(needle) ||
      normalized(item.resourceGroup).includes(needle),
  );
}
