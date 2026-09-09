import type { ChangeEvent, JSX } from "react";
import {
  CONNECTION_POLICY_CHOICES,
  EDGE_STYLE_CHOICES,
  type ConnectionPolicy,
  type EdgeStyle,
} from "../model/edgeRouting";
import { LAYOUT_CHOICES, type LayoutId } from "../model/layout";
import { SORT_CHOICES, type SortKey } from "../model/ordering";
import { useAppDispatch, useAppSelector } from "../store/store";
import {
  selectAnnouncement,
  selectConnectionPolicy,
  selectEdgeStyle,
  selectLayoutId,
  selectSortKey,
  selectSortReversed,
} from "../store/selectors";
import {
  announce,
  openSearch,
  setConnectionPolicy,
  setEdgeStyle,
  setLayout,
  setSortKey,
  toggleSortDirection,
} from "../store/uiSlice";

interface GraphToolbarProps {
  readonly visibleCount: number;
}

export function GraphToolbar({ visibleCount }: GraphToolbarProps): JSX.Element {
  const dispatch = useAppDispatch();
  const layoutId = useAppSelector(selectLayoutId);
  const sortKey = useAppSelector(selectSortKey);
  const sortReversed = useAppSelector(selectSortReversed);
  const edgeStyle = useAppSelector(selectEdgeStyle);
  const connectionPolicy = useAppSelector(selectConnectionPolicy);
  const announcement = useAppSelector(selectAnnouncement);

  const onLayout = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as LayoutId;
    const engine = LAYOUT_CHOICES.find((item) => item.id === next);
    dispatch(setLayout(next));
    dispatch(announce(`Layout changed to ${engine?.label ?? next}. ${visibleCount} nodes visible.`));
  };

  const onEdgeStyle = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as EdgeStyle;
    dispatch(setEdgeStyle(next));
    dispatch(
      announce(
        `Edge style changed to ${
          EDGE_STYLE_CHOICES.find((item) => item.id === next)?.label ?? next
        }.`,
      ),
    );
  };

  const onConnectionPolicy = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as ConnectionPolicy;
    dispatch(setConnectionPolicy(next));
    dispatch(
      announce(
        `Connection points changed to ${
          CONNECTION_POLICY_CHOICES.find((item) => item.id === next)?.label ?? next
        }.`,
      ),
    );
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
        <span className="graph-toolbar__label">Edge style</span>
        <select data-testid="edge-style-picker" value={edgeStyle} onChange={onEdgeStyle}>
          {EDGE_STYLE_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <label className="graph-toolbar__field">
        <span className="graph-toolbar__label">Connection points</span>
        <select
          data-testid="connection-policy-picker"
          value={connectionPolicy}
          onChange={onConnectionPolicy}
        >
          {CONNECTION_POLICY_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
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
