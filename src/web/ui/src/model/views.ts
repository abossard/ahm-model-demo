/**
 * The ways to draw the health model on screen. A view is listed twice: its id and wording here,
 * where the store and the address bar can read them without React, and its component in
 * `views/registry.ts`. The two lists must agree; the registry's type enforces it.
 */
export const VIEW_IDS = ["swimlanes", "tidy", "cause", "zoom", "outline", "coverage"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

/** The view a model opens in when nothing says otherwise. One constant to change. */
export const DEFAULT_VIEW: ViewId = "cause";

export interface ViewMeta {
  readonly id: ViewId;
  readonly label: string;
  /** One sentence for a tooltip: when to use the view. */
  readonly description: string;
}

/**
 * The views the app offers, in the order of the switch (A to F of the design gallery). A new view
 * adds its line here, in its place in the order, and its component to `views/registry.ts`.
 */
export const VIEWS = [
  { id: "swimlanes", label: "Swimlanes", description: "To see how the model is built: one lane per layer, with each entity as a card and its connections between the lanes." },
  { id: "tidy", label: "Tidy arrange", description: "To read the model as a tree, like the designer in the Azure portal: parents above their children." },
  { id: "cause", label: "Cause path", description: "When something is wrong: follows the failing signal up to the root cause and folds away what is healthy." },
  { id: "zoom", label: "Semantic zoom", description: "For an overview of the whole model: every entity as a card, shrinking to names and then dots as you zoom out." },
  { id: "outline", label: "Outline", description: "To work through problems one by one: a list of entities, worst first, with failing signals shown inline." },
  { id: "coverage", label: "Coverage", description: "To see where the model is thin: the whole model as one band, each part as wide as what sits below it." },
] as const satisfies readonly ViewMeta[];

/** The ids of the views that are built. */
export type BuiltViewId = (typeof VIEWS)[number]["id"];

const BUILT: ReadonlySet<string> = new Set(VIEWS.map((view) => view.id));

export function isBuiltView(value: string | null | undefined): value is BuiltViewId {
  return typeof value === "string" && BUILT.has(value);
}

/** An address that names a built view wins; then the one this viewer chose last; then the default. */
export function viewFromSearch(search: string, stored: string | null = null): ViewId {
  const asked = new URLSearchParams(search).get("view");
  if (isBuiltView(asked)) return asked;
  if (isBuiltView(stored)) return stored;
  return DEFAULT_VIEW;
}

export const VIEW_STORAGE_KEY = "health-pulse-view";

export function readStoredView(getStorage: () => Storage): string | null {
  try {
    return getStorage().getItem(VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistView(view: ViewId, getStorage: () => Storage): void {
  try {
    getStorage().setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // The choice then lasts only as long as the page does.
  }
}
