import type { DebugEvent } from "@playground/contracts";
import { selectEvent, setDetailMode, setFilters } from "../app/actions";
import { useStore } from "../app/store";
import { CopyButton } from "./CopyButton";
import { JsonTree } from "./JsonTree";
import {
  arrowCaption, curlOf, flowOf, formatBytes, formatClock, formatDuration, hopLabel, prettyJson, rowLabel,
  type Pairing,
} from "./wireModel";

function describeHttp(event: DebugEvent): string | null {
  const { http } = event;
  if (!http) return null;
  return `${http.method} ${http.path} → ${http.status}${http.contentType ? ` (${http.contentType.split(";")[0]})` : ""}${http.streamed ? ", arrived on a stream" : ""}`;
}

export function MessageDetail(props: { event: DebugEvent; events: readonly DebugEvent[]; pairing: Pairing; waitedMs: number | null }) {
  const { event, events, pairing } = props;
  const detail = useStore((state) => state.drawer.detail);
  const tracing = useStore((state) => state.drawer.filters.trace);
  const label = rowLabel(event);
  const partnerId = pairing.replyOf.get(event.id) ?? pairing.requestOf.get(event.id) ?? null;
  const partner = partnerId ? events.find((item) => item.id === partnerId) ?? null : null;
  const pending = pairing.pending.has(event.id);
  const sameTrace = event.trace ? events.filter((item) => item.trace === event.trace) : [];
  const curl = curlOf(event, location.origin);
  const http = describeHttp(event);

  return (
    <section className="detail" data-testid="wire-detail" aria-label="Selected message">
      <header className="detail-head">
        <span className="detail-flow" data-flow={flowOf(event)} aria-hidden="true" />
        <h3 className="detail-title">
          <span className="mono">{label.primary}</span>
          {label.secondary && <span className="detail-tool mono">{label.secondary}</span>}
        </h3>
        <button type="button" className="btn btn-quiet" onClick={() => selectEvent(null)} aria-label="Close message">Close</button>
      </header>

      <dl className="facts">
        <div><dt>Hop</dt><dd>{hopLabel(event.hop)}</dd></div>
        <div><dt>Direction</dt><dd>{arrowCaption(event)}, {event.kind}</dd></div>
        <div><dt>Recorded</dt><dd className="mono">{formatClock(event.at)}</dd></div>
        <div><dt>Size</dt><dd className="mono">{formatBytes(event.bytes)} ({event.bytes} bytes){event.truncated ? ", payload clipped here" : ""}</dd></div>
        {event.rpcId !== null && <div><dt>JSON-RPC id</dt><dd className="mono">#{event.rpcId}</dd></div>}
        {event.durationMs !== null && <div><dt>Took</dt><dd className="mono">{formatDuration(event.durationMs)} since its request on this hop</dd></div>}
        {pending && <div><dt>Waiting</dt><dd className="mono">{props.waitedMs === null ? "no reply yet" : `no reply after ${formatDuration(props.waitedMs)}`}</dd></div>}
        {http && <div><dt>HTTP</dt><dd className="mono">{http}</dd></div>}
        {event.view && <div><dt>View</dt><dd className="mono">{event.view}</dd></div>}
        <div><dt>Tab</dt><dd className="mono">{event.sid}</dd></div>
        {event.trace && <div><dt>Trace</dt><dd className="mono">{event.trace}</dd></div>}
      </dl>

      {(partner || sameTrace.length > 1 || curl) && (
        <div className="links" aria-label="Correlation">
          {partner && (
            <button type="button" className="btn" data-testid="wire-jump-partner" onClick={() => selectEvent(partner.id)}>
              {event.kind === "request" ? "Go to its reply" : "Go to its request"} #{partner.rpcId}
            </button>
          )}
          {sameTrace.length > 1 && (
            <button type="button" className="btn" aria-pressed={tracing === event.trace} onClick={() => setFilters({ trace: tracing === event.trace ? null : event.trace })}>
              {tracing === event.trace ? "Show every trace" : `Only this trace (${sameTrace.length} messages)`}
            </button>
          )}
        </div>
      )}

      {sameTrace.length > 1 && (
        <ol className="trace-steps" aria-label="Messages of this trace">
          {sameTrace.map((item) => (
            <li key={item.id}>
              <button type="button" data-current={item.id === event.id} data-flow={flowOf(item)} onClick={() => selectEvent(item.id)}>
                <span className="mono">{item.hop === "view-host" ? "hop 1" : "hop 2"}</span> {arrowCaption(item)} <span className="mono">{rowLabel(item).primary}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="detail-tools">
        <div className="seg" role="group" aria-label="Payload view">
          <button type="button" aria-pressed={detail === "tree"} onClick={() => setDetailMode("tree")}>Tree</button>
          <button type="button" aria-pressed={detail === "text"} onClick={() => setDetailMode("text")}>Text</button>
        </div>
        <CopyButton testId="wire-copy-message" what="message" text={() => prettyJson(event.payload)}>Copy message</CopyButton>
        {curl && (
          <CopyButton testId="wire-copy-curl" what="curl command" text={() => curl.command} title={curl.truncated ? "The payload is clipped in the drawer, so the command replays the clipped copy" : "Send this request again from a shell"}>
            Copy as curl
          </CopyButton>
        )}
      </div>

      {event.payload === null || event.payload === undefined
        ? <p className="detail-empty">No JSON-RPC message in this exchange. The HTTP status above is all there is.</p>
        : detail === "tree" ? <JsonTree value={event.payload} /> : <pre className="json-text" tabIndex={0}>{prettyJson(event.payload)}</pre>}
    </section>
  );
}
