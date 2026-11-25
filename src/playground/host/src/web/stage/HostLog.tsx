import { countText, kindsOf, visibleLog } from "@playground/contracts";
import { useMemo, useState } from "react";
import { confirmLink, declineLink } from "../app/actions";
import { useStore } from "../app/store";
import { formatClock } from "../drawer/wireModel";

export function HostLog() {
  const log = useStore((state) => state.hostLog);
  const pendingLink = useStore((state) => state.pendingLink);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const lines = useMemo(() => log.map((entry) => ({ ...entry, kind: entry.type })), [log]);
  const rows = useMemo(() => visibleLog(lines, off, query).reverse(), [lines, off, query]);
  const toggle = (kind: string) => setOff((prev) => { const next = new Set(prev); if (!next.delete(kind)) next.add(kind); return next; });
  return (
    <section className="hostlog" data-testid="host-log" aria-label="What the View asked of the host">
      <h2 className="section-title">What the View asked of the host</h2>
      {pendingLink && (
        <div className="link-confirm" role="alertdialog" aria-label="Open link" aria-describedby="link-confirm-text">
          <p id="link-confirm-text">The View asked the host to open <span className="mono">{pendingLink}</span> in a new tab.</p>
          <div className="link-confirm-actions">
            <button type="button" className="btn btn-primary" data-testid="link-confirm" onClick={confirmLink}>Open it</button>
            <button type="button" className="btn btn-quiet" data-testid="link-decline" onClick={declineLink}>Decline</button>
          </div>
        </div>
      )}
      {log.length === 0 ? (
        <p className="hostlog-empty">Nothing yet. A View reaches the host only through the bridge, and each request lands here.</p>
      ) : (
        <>
          <div className="hostlog-bar" role="group" aria-label="Filter the log">
            {kindsOf(lines).map((kind) => (
              <button key={kind} type="button" className="hostlog-chip mono" aria-pressed={!off.has(kind)} onClick={() => toggle(kind)}>{kind}</button>
            ))}
            <input className="hostlog-find" type="search" value={query} placeholder="Filter" aria-label="Filter the log by text" onChange={(event) => setQuery(event.target.value)} />
          </div>
          <ol className="hostlog-list">
            {rows.map(({ line: entry, count }) => (
              <li key={entry.id} data-type={entry.type} data-testid="host-log-entry">
                <span className="hostlog-time mono">{formatClock(entry.at).slice(0, 8)}</span>
                <span className="hostlog-type mono">{entry.type}</span>
                <span className="hostlog-text">{entry.text} {count > 1 && <span className="hostlog-count mono" data-testid="host-log-count">{countText(count)}</span>}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
