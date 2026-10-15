import { useEffect, useId, useRef, useState, type ChangeEvent, type JSX } from "react";
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
  selectExcludedEntityMode,
  selectEdgeStyle,
  selectLayoutId,
  selectSelectedHealth,
  selectSortKey,
  selectSortReversed,
} from "../store/selectors";
import {
  announce,
  openSearch,
  setExcludedEntityMode,
  setConnectionPolicy,
  setEdgeStyle,
  setLayout,
  toggleSelectedHealth,
  setSortKey,
  toggleSortDirection,
} from "../store/uiSlice";
import type { HealthState } from "../model/types";
import type { ExcludedEntityMode, HealthFilterState } from "../store/uiSlice";
import { tokensFor } from "../model/palette";

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
  const selectedHealth = useAppSelector(selectSelectedHealth);
  const excludedEntityMode = useAppSelector(selectExcludedEntityMode);
  const [healthOpen, setHealthOpen] = useState(false);
  const popupId = useId();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

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

  useEffect(() => {
    if (!healthOpen) return;
    const onWindow = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popupRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setHealthOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setHealthOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("mousedown", onWindow);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onWindow);
      window.removeEventListener("keydown", onKey);
    };
  }, [healthOpen]);

  const healthStates: readonly HealthFilterState[] = ["Healthy", "Degraded", "Unhealthy", "Unknown"];

  const toggleHealth = (state: HealthFilterState): void => {
    dispatch(toggleSelectedHealth(state));
    const nextSelected = selectedHealth.includes(state)
      ? selectedHealth.filter((item) => item !== state)
      : [...selectedHealth, state];
    dispatch(
      announce(
        `Health filter updated: ${nextSelected.length > 0 ? nextSelected.join(", ") : "none selected"}.`,
      ),
    );
  };

  const onMode = (mode: ExcludedEntityMode): void => {
    dispatch(setExcludedEntityMode(mode));
    dispatch(announce(mode === "hide" ? "Excluded health states are hidden." : "Excluded health states are gray dots."));
  };

  const optionLabel = (state: HealthState): string => tokensFor(state).word;

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
      <div className="graph-toolbar__field graph-toolbar__field--health">
        <button
          type="button"
          ref={buttonRef}
          className="graph-toolbar__health"
          data-testid="health-filter-toggle"
          aria-expanded={healthOpen}
          aria-controls={popupId}
          onClick={() => setHealthOpen((open) => !open)}
        >
          Health
        </button>
        {healthOpen ? (
          <div
            id={popupId}
            ref={popupRef}
            className="graph-toolbar__health-popup"
            data-testid="health-filter-popup"
          >
            <fieldset className="graph-toolbar__health-list">
              <legend className="graph-toolbar__health-legend">Health state</legend>
              {healthStates.map((state) => (
                <label key={state} className="graph-toolbar__health-option">
                  <input
                    type="checkbox"
                    checked={selectedHealth.includes(state)}
                    onChange={() => toggleHealth(state)}
                  />
                  <span
                    className="graph-toolbar__health-swatch"
                    style={{ background: tokensFor(state).dot }}
                    aria-hidden="true"
                  />
                  <span>{optionLabel(state)}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="graph-toolbar__health-list">
              <legend className="graph-toolbar__health-legend">Not selected entities</legend>
              <label className="graph-toolbar__health-option">
                <input
                  type="radio"
                  name="excluded-mode"
                  checked={excludedEntityMode === "hide"}
                  onChange={() => onMode("hide")}
                />
                <span>Hide with edges</span>
              </label>
              <label className="graph-toolbar__health-option">
                <input
                  type="radio"
                  name="excluded-mode"
                  checked={excludedEntityMode === "dot"}
                  onChange={() => onMode("dot")}
                />
                <span>Gray dot</span>
              </label>
            </fieldset>
          </div>
        ) : null}
      </div>
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
