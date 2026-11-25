import type { DebugEvent } from "@playground/contracts";
import { memo, useEffect, useRef } from "react";
import { flowOf, formatBytes, formatClock, laneSpan, rowLabel, rowTiming } from "./wireModel";

export interface WireRowProps {
  event: DebugEvent;
  selected: boolean;
  relation: "partner" | "trace" | null;
  pending: boolean;
  waitedMs: number | null;
  fresh: boolean;
  onSelect(id: string): void;
}

// The lane arrow: from the centre of one lane to the centre of the other, as a share of the lane area.
function arrowStyle(event: DebugEvent): { left: string; width: string; direction: "ltr" | "rtl" } {
  const { from, to } = laneSpan(event);
  const left = Math.min(from, to);
  return { left: `${left * 33.333 + 16.667}%`, width: `${Math.abs(to - from) * 33.333}%`, direction: to >= from ? "ltr" : "rtl" };
}

export const WireRow = memo(function WireRow({ event, selected, relation, pending, waitedMs, fresh, onSelect }: WireRowProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const label = rowLabel(event);
  const timing = rowTiming(event, pending, waitedMs);
  const arrow = arrowStyle(event);
  return (
    <button
      ref={ref} type="button" className="row" data-testid="wire-row" data-id={event.id}
      data-flow={flowOf(event)} data-hop={event.hop} data-kind={event.kind} data-method={event.method ?? ""} data-tool={event.tool ?? ""}
      data-selected={selected} data-relation={relation ?? undefined} data-pending={pending} data-fresh={fresh}
      aria-pressed={selected}
      aria-label={`${event.hop === "view-host" ? "View and host" : "Host and server"}, ${event.from} to ${event.to}, ${event.kind} ${label.primary}${label.secondary ? ` ${label.secondary}` : ""}`}
      onClick={() => onSelect(event.id)}
    >
      <span className="row-time">{formatClock(event.at).slice(3)}</span>
      <span className="row-body">
        <span className="row-top">
          <span className="row-label">
            <span className="row-method">{label.primary}</span>
            {label.secondary && <span className="row-tool">{label.secondary}</span>}
          </span>
          <span className="row-meta">
            {event.rpcId !== null && <span>#{event.rpcId}</span>}
            <span>{formatBytes(event.bytes)}</span>
            {timing && <span className={pending ? "row-wait" : "row-ms"}>{timing}</span>}
            {event.truncated && <span className="row-clip">clipped</span>}
          </span>
        </span>
        <span className="row-track" aria-hidden="true">
          <span className="arrow" data-direction={arrow.direction} data-dashed={event.kind === "http" || event.kind === "notification"} style={{ left: arrow.left, width: arrow.width }} />
        </span>
      </span>
    </button>
  );
});
