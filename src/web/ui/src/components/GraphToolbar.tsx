import type { ChangeEvent, JSX } from "react";
import { LAYOUT_CHOICES, type LayoutId } from "../model/layout";
import { SORT_CHOICES, type SortKey } from "../model/ordering";
import { useAppDispatch, useAppSelector } from "../store/store";
import {
  selectAnnouncement,
  selectLayoutId,
  selectSortKey,
  selectSortReversed,
} from "../store/selectors";
import { announce, openSearch, setLayout, setSortKey, toggleSortDirection } from "../store/uiSlice";

interface GraphToolbarProps {
  readonly visibleCount: number;
}

export function GraphToolbar({ visibleCount }: GraphToolbarProps): JSX.Element {
  const dispatch = useAppDispatch();
  const layoutId = useAppSelector(selectLayoutId);
  const sortKey = useAppSelector(selectSortKey);
  const sortReversed = useAppSelector(selectSortReversed);
  const announcement = useAppSelector(selectAnnouncement);

  const onLayout = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as LayoutId;
    const engine = LAYOUT_CHOICES.find((item) => item.id === next);
    dispatch(setLayout(next));
    dispatch(announce(`Layout changed to ${engine?.label ?? next}. ${visibleCount} nodes visible.`));
  };

  return (
    <div className="graph-toolbar" data-testid="graph-toolbar">
      <label className="graph-toolbar__field">
        <span className="graph-toolbar__label">Layout</span>
        <select data-testid="layout-picker" value={layoutId} onChange={onLayout}>
          {LAYOUT_CHOICES.map((engine) => (
            <option key={engine.id} value={engine.id}>
              {engine.label}
            </option>
          ))}
        </select>
      </label>
      <label className="graph-toolbar__field">
        <span className="graph-toolbar__label">Order</span>
        <select
          data-testid="sort-key"
          value={sortKey}
          onChange={(event) => dispatch(setSortKey(event.target.value as SortKey))}
        >
          {SORT_CHOICES.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="graph-toolbar__reverse"
        data-testid="sort-reverse"
        aria-pressed={sortReversed}
        aria-label={sortReversed ? "Sort descending" : "Sort ascending"}
        onClick={() => dispatch(toggleSortDirection())}
      >
        {sortReversed ? "↓" : "↑"}
      </button>
      <button
        type="button"
        className="graph-toolbar__search"
        data-testid="search-open"
        onClick={() => dispatch(openSearch())}
      >
        Search…
      </button>
      <span
        className="graph-toolbar__status"
        data-testid="graph-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement}
      </span>
    </div>
  );
}
