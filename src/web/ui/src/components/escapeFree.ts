/**
 * Whether nothing else takes this Escape. Fluent dialogs, menus, popovers and tooltips call `preventDefault` on the
 * Escape that closes them, and the window sees it after them. A move being reordered is not Fluent, so it is read from
 * the page.
 */
export function escapeIsFree(event: KeyboardEvent, doc: Document = document): boolean {
  return !event.defaultPrevented && doc.querySelector(".is-reordering") === null;
}
