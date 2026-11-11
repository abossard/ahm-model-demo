import { DEFAULT_VIEW, type ViewId } from "./views";
import type { ModelCatalog, ModelRef, ModelSelection } from "./types";

export interface SelectionResolution {
  readonly selected: ModelRef | null;
  readonly unavailable: ModelSelection | null;
}

export function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.name === right.name &&
    left.resourceGroup === right.resourceGroup &&
    left.subscriptionId === right.subscriptionId
  );
}

export function selectionFromSearch(
  search: string,
  catalog: ModelCatalog,
): SelectionResolution {
  const params = new URLSearchParams(search);
  const name = params.get("model");
  const resourceGroup = params.get("resourceGroup");
  const subscriptionId = params.get("subscription");
  const requested: ModelSelection | null =
    name !== null && resourceGroup !== null && subscriptionId !== null
      ? { name, resourceGroup, subscriptionId }
      : null;
  const found = requested
    ? catalog.models.find((item) => sameModel(item, requested))
    : undefined;
  if (found) return { selected: found, unavailable: null };
  const selected =
    (catalog.default ? catalog.models.find((item) => sameModel(item, catalog.default!)) : undefined) ??
    catalog.models[0] ??
    null;
  return {
    selected,
    unavailable: requested && selected ? requested : null,
  };
}

export function searchFromSelection(selection: ModelSelection): string {
  const params = new URLSearchParams({
    model: selection.name,
    resourceGroup: selection.resourceGroup,
    subscription: selection.subscriptionId,
  });
  return `?${params.toString()}`;
}

export interface WorkspaceLocation {
  readonly session: string | null;
  readonly task: number | null;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The Session and Task a link opens; a Task without its Session is ignored. */
export function workspaceFromSearch(search: string): WorkspaceLocation {
  const params = new URLSearchParams(search);
  const session = params.get("session");
  if (session === null || !SESSION_ID.test(session)) return { session: null, task: null };
  const task = params.get("task");
  return { session, task: task !== null && /^[1-9][0-9]{0,8}$/.test(task) ? Number(task) : null };
}

/**
 * The address bar for the model on screen, the view when it is not the default one, and, when one
 * is open, its Session and Task. The view comes before the Session so a link still ends with it.
 */
export function searchFromLocation(
  selection: ModelSelection | null,
  workspace: WorkspaceLocation,
  view: ViewId = DEFAULT_VIEW,
  extra: Readonly<Record<string, string>> = {},
): string {
  const params = selection
    ? new URLSearchParams(searchFromSelection(selection))
    : new URLSearchParams();
  if (view !== DEFAULT_VIEW) params.set("view", view);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  if (workspace.session !== null) {
    params.set("session", workspace.session);
    if (workspace.task !== null) params.set("task", String(workspace.task));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
