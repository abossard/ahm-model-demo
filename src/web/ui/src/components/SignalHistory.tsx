import type { JSX } from "react";
import type { EntityDetail, SignalValue } from "../model/types";

function formatValue(value: SignalValue): string {
  if (value === null) return "—";
  return String(value);
}

function formatTime(value: string | null): string {
  return value ?? "—";
}

export function SignalHistory({ detail }: { readonly detail: EntityDetail }): JSX.Element {
  const { transitions, canonicalSignal } = detail;
  return (
    <div className="history">
      <section className="history-block" aria-labelledby="transitions-heading">
        <h4 id="transitions-heading">Health-state transitions</h4>
        {transitions.length === 0 ? (
          <p className="muted">No recorded transitions.</p>
        ) : (
          <ul className="history-list">
            {transitions.map((transition, index) => (
              <li key={index} data-testid="transition-row" className="history-row">
                <span className="state-pill" data-state={transition.healthState ?? "Unknown"}>
                  {transition.previousState ?? "—"} → {transition.healthState ?? "—"}
                </span>
                <time>{formatTime(transition.occurredAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="history-block" aria-labelledby="signal-heading">
        <h4 id="signal-heading">Signal history — {canonicalSignal.name}</h4>
        {canonicalSignal.history.length === 0 ? (
          <p className="muted">No signal history yet.</p>
        ) : (
          <ul className="history-list">
            {canonicalSignal.history.map((item, index) => (
              <li key={index} data-testid="signal-history-row" className="history-row">
                <span className="state-pill" data-state={item.healthState ?? "Unknown"}>
                  {item.healthState ?? "—"}
                </span>
                <span className="value">{formatValue(item.value)}</span>
                <time>{formatTime(item.occurredAt)}</time>
                {item.reason ? <span className="reason">{item.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
