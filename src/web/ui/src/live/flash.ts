const FLASH_MS = 2200;
const CLASS = "live-changed";

/**
 * Marks the nodes of changed entities for a moment, so a change is noticed and not announced by movement: a class that
 * the stylesheet turns into a calm outline, and into a still one under `prefers-reduced-motion`. It reaches the graph
 * through the attributes its nodes carry, so no view needs to know about it.
 */
export function flashEntities(names: readonly string[], root: ParentNode = document): void {
  const timers = (flashEntities as unknown as { timers: Map<Element, number> }).timers;
  for (const name of names) {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(name) : name.replace(/["\\]/g, "\\$&");
    for (const element of root.querySelectorAll(`.react-flow__node[data-id="${escaped}"], [data-entity-name="${escaped}"], [data-testid="tl-label-entity"][data-row="${escaped}"]`)) {
      window.clearTimeout(timers.get(element));
      element.classList.remove(CLASS);
      void (element as HTMLElement).offsetWidth;
      element.classList.add(CLASS);
      timers.set(element, window.setTimeout(() => element.classList.remove(CLASS), FLASH_MS));
    }
  }
}
(flashEntities as unknown as { timers: Map<Element, number> }).timers = new Map();
