import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

export interface WindowedRows {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  /** The rows to draw: from `first` up to, not including, `last`. */
  readonly first: number;
  readonly last: number;
  readonly top: (index: number) => number;
  readonly total: number;
}

function offsetsOf(heights: readonly number[]): readonly number[] {
  const offsets: number[] = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index + 1] = (offsets[index] as number) + (heights[index] as number);
  }
  return offsets;
}

/** The row that holds a vertical position: the last whose top is at or above it. */
function rowAt(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] as number) <= position) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/**
 * Windowing for rows whose heights are known up front, so a list that grows draws only what the
 * scroll container shows. The container scrolls; the caller positions each row at `top(index)`
 * inside a spacer of height `total`.
 */
export function useWindowedRows(heights: readonly number[], overscan = 8): WindowedRows {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, height: 480 });
  const offsets = useMemo(() => offsetsOf(heights), [heights]);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    setView((previous) =>
      previous.scrollTop === element.scrollTop && previous.height === element.clientHeight
        ? previous
        : { scrollTop: element.scrollTop, height: element.clientHeight },
    );
  }, []);

  useLayoutEffect(measure);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const count = heights.length;
  const first = count === 0 ? 0 : Math.max(0, rowAt(offsets, view.scrollTop) - overscan);
  const last =
    count === 0 ? 0 : Math.min(count, rowAt(offsets, view.scrollTop + view.height) + 1 + overscan);

  return {
    containerRef,
    onScroll: measure,
    first,
    last,
    top: (index) => offsets[index] as number,
    total: offsets[count] as number,
  };
}
