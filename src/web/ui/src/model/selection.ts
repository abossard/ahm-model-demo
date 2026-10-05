import type { ModelCatalog, ModelRef } from "./types";

export interface SelectionResolution {
  readonly selected: ModelRef | null;
  readonly unavailable: ModelRef | null;
}

export function selectionFromSearch(
  search: string,
  catalog: ModelCatalog,
): SelectionResolution {
  const params = new URLSearchParams(search);
  const name = params.get("model");
  const resourceGroup = params.get("resourceGroup");
  const requestedRef =
    typeof name === "string" && typeof resourceGroup === "string"
      ? {
          id: null,
          name,
          resourceGroup,
          location: null,
          provisioningState: null,
        }
      : null;
  const requested = catalog.models.find(
    (item) => item.name === name && item.resourceGroup === resourceGroup,
  );
  if (requested) return { selected: requested, unavailable: null };
  const selected =
    catalog.models.find(
      (item) =>
        item.name === catalog.default.name &&
        item.resourceGroup === catalog.default.resourceGroup,
    ) ??
    catalog.models[0] ??
    null;
  return {
    selected,
    unavailable: requestedRef && selected ? requestedRef : null,
  };
}

export function searchFromSelection(selection: ModelRef): string {
  const params = new URLSearchParams({
    model: selection.name,
    resourceGroup: selection.resourceGroup,
  });
  return `?${params.toString()}`;
}
