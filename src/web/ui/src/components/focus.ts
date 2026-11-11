/** What a Task start may take focus from: the Session workspace and the buttons that start Tasks. */
const OWN = "#session-workspace, [data-task-launcher]";

/**
 * Whether moving focus now would not take it from anything the user is doing: nothing holds it, or it sits in the
 * workspace or on the button that started the Task. Someone typing in the search or a field keeps their place.
 */
export function focusIsFree(doc: Document = document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || active.closest(OWN) !== null;
}

/** Moves focus to the first element a selector finds, when focus is free. */
export function focusFirst(root: ParentNode | null, selector: string): void {
  if (!focusIsFree()) return;
  root?.querySelector<HTMLElement>(selector)?.focus();
}
