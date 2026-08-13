import type { ModelCatalog, ModelRef } from "./types";

export function selectionFromSearch(
  search: string,
  catalog: ModelCatalog,
): ModelRef | null {
  const params = new URLSearchParams(search);
  const name = params.get("model");
  const resourceGroup = params.get("resourceGroup");
  const requested = catalog.models.find(
    (item) => item.name === name && item.resourceGroup === resourceGroup,
  );
  if (requested) return requested;
  return (
    catalog.models.find(
      (item) =>
        item.name === catalog.default.name &&
        item.resourceGroup === catalog.default.resourceGroup,
    ) ??
    catalog.models[0] ??
    null
  );
}

export function searchFromSelection(selection: ModelRef): string {
  const params = new URLSearchParams({
    model: selection.name,
    resourceGroup: selection.resourceGroup,
  });
  return `?${params.toString()}`;
}
