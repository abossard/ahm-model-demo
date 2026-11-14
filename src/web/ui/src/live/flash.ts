const FLASH_MS = 2200;
const CLASS = "live-changed";
const running = new WeakMap<Element, Animation>();

/**
 * Marks the nodes of changed entities for a moment, so a change is noticed and not announced by movement: a class that
 * the stylesheet turns into a calm outline, whose colour fades out. It reaches the graph through the attributes its
 * nodes carry, so no view needs to know about it.
 */
export function flashEntities(names: readonly string[], root: ParentNode = document): void {
  for (const name of names) {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(name) : name.replace(/["\\]/g, "\\$&");
    for (const element of root.querySelectorAll(`.react-flow__node[data-id="${escaped}"], [data-entity-name="${escaped}"], [data-testid="tl-label-entity"][data-row="${escaped}"]`)) {
      running.get(element)?.cancel();
      element.classList.add(CLASS);
      const fade = element.animate({ outlineColor: "transparent" }, { duration: FLASH_MS, easing: "ease-out", fill: "forwards" });
      fade.onfinish = () => {
        element.classList.remove(CLASS);
        fade.cancel();
      };
      running.set(element, fade);
    }
  }
}
