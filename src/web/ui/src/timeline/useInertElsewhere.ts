import { useEffect } from "react";
import type { RefObject } from "react";

/** What opens over the full-screen timeline marks itself with this: it is not covered, so it stays live. */
export const OVER_TIMELINE = "data-over-timeline";

/**
 * While `on`, what the element covers is inert: its siblings, and those of every ancestor up to the element it is
 * positioned in. The keyboard and a screen reader stay in the element, as they do for what the eye sees. What marks
 * itself `OVER_TIMELINE` is above the element, not under it, and stays as it is. A fixed element has no such
 * ancestor: `within` names the one to stop at, so what Fluent puts beside the page (its portals, its live region) stays live.
 */
export function useInertElsewhere(ref: RefObject<HTMLElement | null>, on: boolean, within?: string): void {
  useEffect(() => {
    const element = ref.current;
    if (!on || !element) return;
    const host = within === undefined ? element.offsetParent : element.closest(within);
    const held: HTMLElement[] = [];
    for (let node: HTMLElement = element; node.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node && sibling instanceof HTMLElement && !sibling.inert && !sibling.hasAttribute(OVER_TIMELINE)) {
          sibling.inert = true;
          held.push(sibling);
        }
      }
      if (node.parentElement === host) break;
    }
    return () => {
      for (const item of held) item.inert = false;
    };
  }, [ref, on, within]);
}
