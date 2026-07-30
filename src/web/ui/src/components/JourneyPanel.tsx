import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectJourneyResult } from "../store/selectors";
import { runDemoRequest } from "../store/journeySlice";

export function JourneyPanel(): JSX.Element {
  const dispatch = useAppDispatch();
  const result = useAppSelector(selectJourneyResult);

  return (
    <section className="journey" aria-label="Request journey" data-testid="journey">
      <div className="journey-head">
        <h3>Request journey</h3>
        <button
          type="button"
          className="primary"
          onClick={() => void dispatch(runDemoRequest())}
          disabled={result.kind === "loading"}
        >
          {result.kind === "loading" ? "Running…" : "Run request journey"}
        </button>
      </div>

      {result.kind === "success" ? (
        <dl className="journey-result" data-testid="journey-result">
          <div>
            <dt>Request ID</dt>
            <dd data-testid="journey-request-id">{result.value.request_id}</dd>
          </div>
          <div>
            <dt>Queue head</dt>
            <dd data-testid="journey-queue-head">
              {result.value.queue_head?.request_id ?? "none"}
            </dd>
          </div>
          <div>
            <dt>PostgreSQL rows</dt>
            <dd data-testid="journey-row-count">{result.value.row_count}</dd>
          </div>
        </dl>
      ) : null}
      {result.kind === "failure" ? (
        <p className="report-error" role="alert">
          {result.error.message}
        </p>
      ) : null}
    </section>
  );
}
