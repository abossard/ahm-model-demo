import { useEffect } from "react";
import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import {
  selectAutoRefreshMs,
  selectLastObservedAt,
  selectModel,
  selectModelCatalog,
  selectModelRefreshing,
  selectRefreshCountdown,
  selectSelectedModel,
} from "../store/selectors";
import { loadHealthModel } from "../store/modelSlice";
import { chooseModel } from "../store/catalogSlice";
import { setAutoRefresh, tickRefreshCountdown } from "../store/uiSlice";
import type { ModelRef } from "../model/types";

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

  if (catalog.kind !== "success" || !selected) return null;

  const key = (item: ModelRef): string => `${item.resourceGroup}/${item.name}`;

  return (
    <label className="model-picker">
      <span className="model-picker__label">Health model</span>
      <select
        data-testid="model-picker"
        value={key(selected)}
        onChange={(event) => {
          const next = catalog.value.models.find(
            (item) => key(item) === event.target.value,
          );
          if (next) dispatch(chooseModel(next));
        }}
      >
        {catalog.value.models.map((item) => (
          <option key={key(item)} value={key(item)}>
            {item.name} ({item.resourceGroup})
          </option>
        ))}
      </select>
    </label>
  );
}

export function StatusBar(): JSX.Element {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectModel);
  const lastObservedAt = useAppSelector(selectLastObservedAt);

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
        <RefreshControls />
      </div>
    </div>
  );
}
