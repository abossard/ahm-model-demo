import type { JSX } from "react";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectJourneyResult } from "../store/selectors";
import { runDemoRequest } from "../store/journeySlice";

export function JourneyPanel(): JSX.Element {
  const dispatch = useAppDispatch();
  const result = useAppSelector(selectJourneyResult);
  const warning =
    "This demo enqueues first, then writes PostgreSQL, then peeks the oldest visible queue message.";

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
      <p className="journey-description" data-testid="journey-description">
        {warning}
      </p>
      <p className="journey-description muted" data-testid="journey-scope">
        Runs against the configured application workload, even when another model is selected.
      </p>
      <p className="journey-description muted" data-testid="journey-hosting">
        The database is Azure Database for PostgreSQL Flexible Server, separate from the web
        Container App.
      </p>

      {result.kind === "success" ? (
        <dl className="journey-result" data-testid="journey-result">
          <div>
            <dt>Request ID</dt>
            <dd data-testid="journey-request-id">{result.value.request_id}</dd>
          </div>
          <div>
            <dt>Enqueued message ID</dt>
            <dd data-testid="journey-message-id">{result.value.just_enqueued.message_id}</dd>
          </div>
          <div>
            <dt>Enqueued at</dt>
            <dd data-testid="journey-enqueued-at">{result.value.just_enqueued.created_at}</dd>
          </div>
          <div>
            <dt>Queue head</dt>
            <dd data-testid="journey-queue-head-label">
              {result.value.queue_head?.label ?? "oldest visible / best-effort FIFO"}
            </dd>
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
          {result.error.message} Earlier queue/database side effects may already exist. Retry when
          ready. {result.error.requestId ? `Request ${result.error.requestId}. ` : ""}
          {result.error.operationId ? `Operation ${result.error.operationId}.` : ""}
        </p>
      ) : null}
    </section>
  );
}
