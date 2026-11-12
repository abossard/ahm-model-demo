import { startTransition, useEffect, useRef, useState } from "react";
import { useStore, type Store } from "../store/store";

/**
 * Everything on the page that follows the selected moment is drawn together, one moment at a time. A drag moves the
 * moment once a frame, and the plot draws its line itself. What follows it (the graph, the tree, the strip, the top
 * bar) is rendered as one transition, in the time the frames leave. While that is rendered the moment may move on:
 * the newest one is rendered next. So readers that take several frames to draw still follow a drag, a few moments
 * behind and all showing the same one, and never hold it up.
 */
interface Follower {
  /** What it shows is not what the store says. */
  readonly behind: () => boolean;
  /** Renders what the store says. */
  readonly show: () => void;
}

const followers = new Set<Follower>();
/** A moment is being rendered, or is about to be. */
let passing = false;
let settling = false;

/** Renders the newest moment for every follower that is behind, once every reader has heard of it. */
function pass(): void {
  if (passing) return;
  passing = true;
  queueMicrotask(() => {
    const late = [...followers].filter((follower) => follower.behind());
    if (late.length === 0) passing = false;
    else startTransition(() => late.forEach((follower) => follower.show()));
  });
}

/** A moment was drawn, or a follower left: once every effect of that commit has run, the next moment is rendered if there is one. */
function passed(): void {
  if (settling) return;
  settling = true;
  queueMicrotask(() => {
    settling = false;
    passing = false;
    if ([...followers].some((follower) => follower.behind())) pass();
  });
}

/**
 * Reads what depends on the selected moment (`selectModelAt` and the selectors made from it) so that moving the moment
 * never waits for the reader: see above. Selecting a moment, returning to now and every other change of the store are
 * rendered at once, as `useStore` does.
 *
 * `selector` must be the same function on every render: one that is declared outside the component.
 */
export function useAtMoment<T>(selector: (state: Store) => T): T {
  // In a box, so that every value that is set is committed and its effect runs, also one equal to the value before it.
  const [shown, setShown] = useState(() => ({ value: selector(useStore.getState()) }));
  const latest = useRef(shown.value);
  const drawn = useRef(shown.value);

  useEffect(() => {
    drawn.current = shown.value;
    passed();
  }, [shown]);

  useEffect(() => {
    const follower: Follower = { behind: () => !Object.is(latest.current, drawn.current), show: () => setShown({ value: latest.current }) };
    followers.add(follower);
    const read = (state: Store, moving: boolean): void => {
      const next = selector(state);
      if (Object.is(next, latest.current)) return;
      latest.current = next;
      if (moving) pass();
      else setShown({ value: next });
    };
    read(useStore.getState(), false);
    const unsubscribe = useStore.subscribe((state, before) => read(state, state.timelinePinned !== null && before.timelinePinned !== null && state.timelinePinned !== before.timelinePinned));
    return () => {
      unsubscribe();
      followers.delete(follower);
      passed();
    };
  }, [selector]);

  return shown.value;
}
