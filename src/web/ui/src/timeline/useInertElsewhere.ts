import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * While `on`, what the element covers is inert: its siblings, and those of every ancestor up to the element it is
 * positioned in. The keyboard and a screen reader stay in the element, as they do for what the eye sees.
 */
export function useInertElsewhere(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!on || !element) return;
    const host = element.offsetParent;
    const held: HTMLElement[] = [];
    for (let node: HTMLElement = element; node.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node && sibling instanceof HTMLElement && !sibling.inert) {
          sibling.inert = true;
          held.push(sibling);
        }
      }
      if (node.parentElement === host) break;
    }
    return () => {
      for (const item of held) item.inert = false;
    };
  }, [ref, on]);
}
