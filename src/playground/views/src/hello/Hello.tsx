import { useState } from "react";
import { Button, Frame, NoticeBar, call, errorText, log, outputOf, type ViewContext } from "../kit";
import { clockTime, pingLine, pushPing, type PingRow } from "./logic";
import "./hello.css";

// Layer 1. A View is a page the server sent. It can reach the network never, and the server only through the host.
export function Hello({ app, player, first }: ViewContext) {
  const hello = outputOf<"hello_show">(first);
  const [pings, setPings] = useState(hello.pings);
  const [rows, setRows] = useState<PingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = app.getHostVersion();

  async function ping() {
    setBusy(true);
    setError(null);
    const started = performance.now();
    try {
      const out = await call(app, "hello_ping", { player });
      setPings(out.pings);
      setRows((all) => pushPing(all, { at: Date.now(), roundTripMs: Math.round(performance.now() - started), serverTime: out.serverTime }));
    } catch (reason) {
      log.warn("ping failed", { error: errorText(reason) });
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <section className="hello-lead">
        <p className="hello-greeting" data-testid="hello-greeting">{hello.greeting}</p>
        <p className="hello-sub">
          This rectangle is a web page the server sent. It cannot reach the network. It can only talk to this page.
        </p>
      </section>

      <dl className="hello-facts">
        <div><dt>Origin</dt><dd data-testid="hello-origin">{window.origin}</dd></div>
        <div><dt>Host</dt><dd>{host ? `${host.name} ${host.version}` : "unknown"}</dd></div>
        <div><dt>Server time at open</dt><dd>{clockTime(hello.serverTime)}</dd></div>
      </dl>

      <section className="hello-ping">
        <div className="hello-ping-head">
          <Button variant="primary" busy={busy} onClick={ping} data-testid="hello-ping">Ping the server</Button>
          <p className="hello-count" aria-live="polite"><strong data-testid="hello-count">{pings}</strong> <span>{pingLine(pings)}</span></p>
        </div>
        <NoticeBar error={error} />
        {rows.length > 0 ? (
          <ol className="hello-log" aria-label="Pings">
            {rows.map((row) => (
              <li key={row.at}>
                <span>View asked the host, the host asked the server</span>
                <span>{row.roundTripMs} ms</span>
                <span>server {clockTime(row.serverTime)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="hello-hint">Press the button. The wire drawer shows the four messages it sets off.</p>
        )}
      </section>
    </Frame>
  );
}
