import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectLastObservedAt, selectModel } from "../store/selectors";
import { loadHealthModel } from "../store/modelSlice";

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
        {model.kind === "loading" ? <span className="muted">Loading…</span> : null}
        {model.kind === "success" ? (
          <span data-testid="model-observed">Observed {model.value.observedAt}</span>
        ) : null}
      </div>
    </div>
  );
}
