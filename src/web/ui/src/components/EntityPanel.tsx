import { useEffect } from "react";
import type { JSX } from "react";
import type { ReportOptions } from "../model/types";
import { useAppDispatch, useAppSelector } from "../store/store";
import {
  selectEntityDetail,
  selectSelectedName,
} from "../store/selectors";
import { clearEntity, loadEntityDetail } from "../store/entitySlice";
import { closePanel } from "../store/uiSlice";
import { SignalHistory } from "./SignalHistory";
import { ReportForm } from "./ReportForm";

export function EntityPanel({ options }: { readonly options: ReportOptions }): JSX.Element {
  const dispatch = useAppDispatch();
  const selectedName = useAppSelector(selectSelectedName);
  const detail = useAppSelector(selectEntityDetail);

  useEffect(() => {
    if (selectedName) dispatch(loadEntityDetail(selectedName));
  }, [dispatch, selectedName]);

  const close = (): void => {
    dispatch(clearEntity());
    dispatch(closePanel());
  };

  return (
    <aside className="entity-panel" aria-label="Entity detail" data-testid="entity-panel">
      <header className="panel-header">
        <h2 data-testid="entity-name">
          {detail.kind === "success" ? detail.value.entity.displayName : selectedName}
        </h2>
        <button type="button" className="panel-close" onClick={close} aria-label="Close panel">
          ×
        </button>
      </header>

      {detail.kind === "loading" ? <p className="muted">Loading entity…</p> : null}
      {detail.kind === "failure" ? (
        <p className="report-error" role="alert">
          {detail.error.message}
        </p>
      ) : null}
      {detail.kind === "success" ? (
        <div className="panel-body">
          <p className="entity-summary">
            <span className="state-pill" data-state={detail.value.entity.healthState}>
              {detail.value.entity.healthState}
            </span>
            <span className="muted">{detail.value.entity.impact}</span>
          </p>
          <SignalHistory detail={detail.value} />
          <section className="report-section" aria-labelledby="report-heading">
            <h3 id="report-heading">Report health</h3>
            {detail.value.entity.report.eligible ? (
              <ReportForm
                key={detail.value.entity.name}
                entityName={detail.value.entity.name}
                options={options}
              />
            ) : (
              <p className="muted" data-testid="report-ineligible">
                This entity cannot receive health reports.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </aside>
  );
}
