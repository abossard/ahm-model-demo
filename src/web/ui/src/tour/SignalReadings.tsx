import { useMemo } from "react";
import { Button } from "@fluentui/react-components";
import { Warning20Regular } from "@fluentui/react-icons";
import { tokensFor } from "../model/palette";
import { formatSignalValue } from "../model/signalValue";
import type { Entity, EntitySignal } from "../model/types";
import { actions, useStore } from "../store/store";
import type { StopId } from "./stops";

export interface TourReading {
  readonly entity: Entity;
  readonly signal: EntitySignal;
  readonly status: "error" | "waiting" | "reported";
}

/** A health report arrives only when someone sends one. The builder tour watches signals Azure evaluates. */
export function signalReadings(entities: readonly Entity[]): TourReading[] {
  const rows: TourReading[] = [];
  for (const entity of entities) {
    if (entity.healthState === "Deleted") continue;
    for (const signal of entity.signals) {
      if (signal.writable || signal.kind === "External" || signal.healthState === "Deleted") continue;
      const waiting = (!signal.healthState || signal.healthState === "Unknown") && signal.value == null && !signal.reportedAt;
      rows.push({ entity, signal, status: signal.evaluationError ? "error" : waiting ? "waiting" : "reported" });
    }
  }
  const order = { error: 0, waiting: 1, reported: 2 };
  return rows.sort((a, b) => order[a.status] - order[b.status]);
}

function summary(rows: readonly TourReading[]) {
  const errors = rows.filter(row => row.status === "error").length;
  const waiting = rows.filter(row => row.status === "waiting").length;
  const reported = rows.length - errors - waiting;
  return [
    errors && (errors === 1 ? "1 signal has an evaluation error." : `${errors} signals have evaluation errors.`),
    waiting && (waiting === 1 ? "1 signal is waiting for its first reading." : `${waiting} signals are waiting for their first reading.`),
    reported && (reported === 1 ? "1 signal has reported." : `${reported} signals have reported.`),
  ].filter(Boolean).join(" ") || "Azure hasn’t listed any monitored signals for this model yet.";
}

function ReadingRow({ row, onInspect }: { row: TourReading; onInspect: (row: TourReading) => void }) {
  const { entity, signal, status } = row;
  const name = signal.displayName || signal.name;
  const owner = entity.displayName || entity.name;
  const value = formatSignalValue(signal.value);
  return <li data-signal-status={status}>
    <button type="button" className="tour-reading" data-tour-entity={entity.name} data-tour-signal={signal.name}
      aria-label={`Show ${name} on ${owner} in the timeline`} onClick={() => onInspect(row)}>
      <strong>{name}</strong>
      <span>{owner} <span aria-hidden="true">↗</span></span>
    </button>
    {status === "error" ? <p className="tour-reading-error">
      <Warning20Regular aria-hidden="true" /><span><strong>Evaluation error</strong> · {signal.evaluationError}</span>
    </p> : <p>{status === "waiting" ? "Waiting for first reading" :
      `Reported · ${tokensFor(signal.healthState).word}${value ? ` · ${value}` : ""}`}</p>}
  </li>;
}

export function SignalReadings({ entities, stop, historical, onInspect }: {
  entities: readonly Entity[]; stop: StopId; historical: boolean; onInspect: (row: TourReading) => void;
}) {
  const rows = useMemo(() => signalReadings(entities), [entities]);
  const live = useStore(state => state.liveStatus);
  const refreshing = useStore(state => state.refreshing);
  const refreshError = useStore(state => state.refreshError);
  const detailed = stop === "readings";
  if (historical) return detailed || stop === "overview" ? <div className="tour-readings">
    <p>You’re looking at a past moment. Return to now to check the latest readings.</p>
    <Button size="small" onClick={() => actions.selectMoment(null)}>Show latest readings</Button>
  </div> : null;
  const firstError = rows.find(row => row.status === "error");
  if (!detailed && stop !== "overview" && !firstError) return null;
  const visible = detailed ? rows : firstError ? [firstError] : [];
  return <section className="tour-readings" aria-label="Signal readings">
    <p role="status" data-testid="tour-readiness-summary">{summary(rows)}</p>
    {visible.length > 0 && <ul aria-label="Signals">{visible.slice(0, 4).map(row =>
      <ReadingRow key={`${row.entity.name}/${row.signal.name}`} row={row} onInspect={onInspect} />)}</ul>}
    {visible.length > 4 && <details>
      <summary>{visible.length - 4} more {visible.length === 5 ? "signal" : "signals"}</summary>
      <ul aria-label="More signals">{visible.slice(4).map(row =>
        <ReadingRow key={`${row.entity.name}/${row.signal.name}`} row={row} onInspect={onInspect} />)}</ul>
    </details>}
    {detailed && <div className="tour-readings-refresh">
      {live === "paused" && <span>Live updates are paused.</span>}
      {(live === "reconnecting" || live === "connecting") && <span>Connecting to live updates…</span>}
      {live === "off" && <span>Live updates are off.</span>}
      <Button size="small" disabled={refreshing} onClick={() => void actions.loadHealthModel({ fresh: true })}>
        {refreshing ? "Checking readings…" : "Check readings now"}
      </Button>
      {refreshError && <span role="status">Couldn’t refresh the readings. {refreshError.message}</span>}
    </div>}
  </section>;
}
