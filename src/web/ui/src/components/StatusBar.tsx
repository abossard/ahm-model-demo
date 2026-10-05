import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import {
  selectAutoRefreshMs,
  selectChatOpen,
  selectLastObservedAt,
  selectModel,
  selectModelCatalog,
  selectModelRefreshing,
  selectRefreshCountdown,
  selectSelectedModel,
  selectTheme,
  selectUnavailableSelection,
} from "../store/selectors";
import { loadHealthModel } from "../store/modelSlice";
import { chooseModel, loadModelCatalog } from "../store/catalogSlice";
import { setAutoRefresh, setTheme, tickRefreshCountdown, toggleChat } from "../store/uiSlice";
import type { ModelRef } from "../model/types";
import { filterModels, sortModelsByNameThenGroup } from "../model/modelCatalog";

const AUTO_REFRESH_CHOICES: readonly { readonly ms: number; readonly label: string }[] = [
  { ms: 0, label: "Off" },
  { ms: 60_000, label: "Every 1 min" },
  { ms: 300_000, label: "Every 5 min" },
];

function RefreshControls(): JSX.Element {
  const dispatch = useAppDispatch();
  const refreshing = useAppSelector(selectModelRefreshing);
  const autoRefreshMs = useAppSelector(selectAutoRefreshMs);
  const countdown = useAppSelector(selectRefreshCountdown);

  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    const timer = setInterval(() => void dispatch(loadHealthModel()), autoRefreshMs);
    return () => clearInterval(timer);
  }, [dispatch, autoRefreshMs]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => {
      dispatch(tickRefreshCountdown());
      if (countdown === 1) void dispatch(loadHealthModel());
    }, 1000);
    return () => clearTimeout(timer);
  }, [dispatch, countdown]);

  return (
    <>
      {countdown > 0 ? (
        <span data-testid="refresh-countdown" className="refresh-countdown">
          {countdown}
        </span>
      ) : null}
      {refreshing ? (
        <span data-testid="refresh-indicator" className="muted" role="status">
          Refreshing…
        </span>
      ) : null}
      <button
        type="button"
        className="refresh-now"
        data-testid="refresh-now"
        onClick={() => void dispatch(loadHealthModel())}
      >
        Refresh
      </button>
      <label className="model-picker">
        <span className="model-picker__label">Auto-refresh</span>
        <select
          data-testid="auto-refresh"
          value={autoRefreshMs}
          onChange={(event) => dispatch(setAutoRefresh(Number(event.target.value)))}
        >
          {AUTO_REFRESH_CHOICES.map((choice) => (
            <option key={choice.ms} value={choice.ms}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function ModelPicker(): JSX.Element | null {
  const dispatch = useAppDispatch();
  const catalog = useAppSelector(selectModelCatalog);
  const selected = useAppSelector(selectSelectedModel);
  const unavailableSelection = useAppSelector(selectUnavailableSelection);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const key = (item: ModelRef): string => `${item.resourceGroup}/${item.name}`;
  const optionId = (item: ModelRef): string =>
    `model-option-${key(item).replaceAll("/", "__")}`;
  const sorted =
    catalog.kind === "success" ? sortModelsByNameThenGroup(catalog.value.models) : [];
  const filtered = filterModels(sorted, query);
  const selectedLabel = selected
    ? `${selected.name} (${selected.resourceGroup})`
    : "";
  const listboxId = "model-picker-listbox";
  const statusId = "model-picker-status";
  const activeItem = filtered[active] ?? null;
  const announcement =
    filtered.length === 0
      ? `No models match "${query}". Current selection remains ${selectedLabel}.`
      : `Current selection ${selectedLabel}. ${filtered.length} result${filtered.length === 1 ? "" : "s"}.`;

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const node = rootRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const pick = (item: ModelRef): void => {
    dispatch(chooseModel(item));
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") return;
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query.length > 0) {
        setQuery("");
      } else {
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      if (filtered.length > 0) {
        setActive((current) => (current + 1) % filtered.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      if (filtered.length > 0) {
        setActive((current) => (current - 1 + filtered.length) % filtered.length);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (activeItem) pick(activeItem);
    }
  };

  if (catalog.kind === "failure") {
    return (
      <div className="model-picker model-picker--error" role="alert">
        <span className="model-picker__label">{catalog.error.message}</span>
        <button
          type="button"
          className="refresh-now"
          data-testid="catalog-retry"
          onClick={() => void dispatch(loadModelCatalog())}
        >
          Retry catalog
        </button>
      </div>
    );
  }

  if (catalog.kind !== "success" || !selected) return null;

  return (
    <div className="model-picker model-picker--combobox" ref={rootRef}>
      <span className="model-picker__label">Health model</span>
      <input
        ref={inputRef}
        type="search"
        className="model-picker__search"
        data-testid="model-picker-search"
        placeholder="Search model or group"
        value={query}
        role="combobox"
        aria-label="Search health models"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-describedby={statusId}
        {...(open && activeItem ? { "aria-activedescendant": optionId(activeItem) } : {})}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="model-picker__selected" data-testid="model-picker-selected">
        Selected: {selectedLabel}
      </span>
      {unavailableSelection ? (
        <span
          className="model-picker__warning"
          role="status"
          data-testid="model-picker-unavailable-selection"
        >
          Requested {unavailableSelection.name} ({unavailableSelection.resourceGroup}) is unavailable. Selected: {selectedLabel}.
        </span>
      ) : null}
      <input type="hidden" data-testid="model-picker" value={key(selected)} readOnly />
      {open ? (
        <div
          className="model-picker__list"
          role="listbox"
          id={listboxId}
          aria-label="Health models"
        >
          {filtered.map((item, index) => (
            <button
              type="button"
              key={key(item)}
              id={optionId(item)}
              role="option"
              aria-selected={key(item) === key(selected)}
              data-testid={`model-picker-option-${key(item)}`}
              className={`model-picker__option${index === active ? " is-active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(item)}
            >
              {item.name} ({item.resourceGroup})
            </button>
          ))}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <span className="model-picker__empty" data-testid="model-picker-empty" role="status">
          No models match this search.
        </span>
      ) : null}
      <span className="sr-only" role="status" id={statusId} data-testid="model-picker-status">
        {announcement}
      </span>
    </div>
  );
}

function ThemeControl(): JSX.Element {
  const dispatch = useAppDispatch();
  const theme = useAppSelector(selectTheme);
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="refresh-now"
      data-testid="theme-toggle"
      onClick={() => dispatch(setTheme(next))}
    >
      {theme === "dark" ? "Light theme" : "Dark theme"}
    </button>
  );
}

export function StatusBar(): JSX.Element {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectModel);
  const lastObservedAt = useAppSelector(selectLastObservedAt);
  const chatOpen = useAppSelector(selectChatOpen);

  if (model.kind === "failure") {
    return (
      <div className="status-bar status-bar--error" role="alert" data-testid="status-error">
        <div className="status-main">
          <strong>Health model unavailable</strong>
          <span data-testid="status-error-message">{model.error.message}</span>
        </div>
        <div className="status-meta">
          <ModelPicker />
          <span data-testid="status-last-observed">
            {lastObservedAt
              ? `Last successful observation ${lastObservedAt}`
              : "No successful observation yet"}
          </span>
          <button
            type="button"
            className="primary"
            data-testid="status-retry"
            onClick={() => void dispatch(loadHealthModel())}
          >
            Retry
          </button>
          <ThemeControl />
          <span className="assistant-scope" data-testid="assistant-scope">
            Assistant scope: configured application model
          </span>
          <button
            type="button"
            className="refresh-now"
            onClick={() => dispatch(toggleChat())}
            data-testid="chat-toggle"
          >
            {chatOpen ? "Close copilot" : "Open copilot"}
          </button>
          <RefreshControls />
        </div>
      </div>
    );
  }

  return (
    <div className="status-bar" data-testid="status-bar">
      <div className="status-main">
        <strong data-testid="model-name">
          {model.kind === "success" ? model.value.model.name : "Health Pulse"}
        </strong>
        {model.kind === "success" ? (
          <span className="state-pill" data-state={model.value.model.healthState}>
            {model.value.model.healthState}
          </span>
        ) : null}
      </div>
      <div className="status-meta">
        <ModelPicker />
        {model.kind === "loading" ? <span className="muted">Loading…</span> : null}
        {model.kind === "success" ? (
          <span data-testid="model-observed">Observed {model.value.observedAt}</span>
        ) : null}
        <ThemeControl />
        <span className="assistant-scope" data-testid="assistant-scope">
          Assistant scope: configured application model
        </span>
        <button
          type="button"
          className="refresh-now"
          onClick={() => dispatch(toggleChat())}
          data-testid="chat-toggle"
        >
          {chatOpen ? "Close copilot" : "Open copilot"}
        </button>
        <RefreshControls />
      </div>
    </div>
  );
}
