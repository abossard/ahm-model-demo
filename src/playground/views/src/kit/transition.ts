import { flushSync } from "react-dom";

interface TransitionDocument {
  startViewTransition?: (update: () => void) => unknown;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Runs a state update inside a View Transition, so the browser animates every element that carries a
// `view-transition-name` from where it was to where it is. Without the API, or with reduced motion, it just applies.
export function withTransition(update: () => void, doc: TransitionDocument = document, reduced: boolean = reducedMotion()): void {
  if (reduced || typeof doc.startViewTransition !== "function") return update();
  doc.startViewTransition(() => flushSync(update));
}
