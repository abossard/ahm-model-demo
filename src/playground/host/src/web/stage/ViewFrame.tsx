import type { LayerId } from "@playground/contracts";
import { useEffect, useRef, useState } from "react";
import { inviteUrl, mountLayer, setDisplay, setViewTheme, unmounted } from "../app/actions";
import { entryFor, resourceOf, SANDBOX_NOTE } from "../app/entry";
import { useStore } from "../app/store";
import { CopyButton } from "../drawer/CopyButton";
import type { MountedView } from "../app/wireApi";

type Status = { phase: "mounting" } | { phase: "running" } | { phase: "failed"; message: string };

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 1600;

export function ViewFrame({ layer, tableId }: { layer: LayerId; tableId: string | null }) {
  const connection = useStore((state) => state.connection);
  const player = useStore((state) => state.player);
  const display = useStore((state) => state.display);
  const theme = useStore((state) => state.viewTheme);
  const height = useStore((state) => state.viewHeight);
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>({ phase: "mounting" });
  const [attempt, setAttempt] = useState(0);
  const tool = player ? entryFor(layer, player, tableId).tool : null;

  useEffect(() => {
    const element = frame.current;
    if (!element || connection !== "ready") return;
    let cancelled = false;
    let view: MountedView | null = null;
    setStatus({ phase: "mounting" });
    mountLayer(element, layer, tableId).then(
      (mounted) => {
        if (cancelled) {
          void mounted.close();
          return;
        }
        view = mounted;
        setStatus({ phase: "running" });
      },
      (error: unknown) => !cancelled && setStatus({ phase: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      cancelled = true;
      if (view) {
        unmounted(view);
        void view.close();
      }
    };
  }, [connection, layer, tableId, attempt]);

  useEffect(() => {
    if (display !== "fullscreen") return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDisplay("inline");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [display]);

  const invite = inviteUrl();
  const px = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height ?? 360));
  return (
    <section className="frame" data-testid="view-section" data-display={display} data-layer={layer} aria-label="View">
      <header className="frame-bar">
        <dl className="frame-facts">
          <div><dt>Resource</dt><dd className="mono">{tool ? resourceOf(tool) : "…"}</dd></div>
          <div><dt>Opened by</dt><dd className="mono">{tool ?? "…"}</dd></div>
          <div><dt>Sandbox</dt><dd className="mono">{SANDBOX_NOTE.origin}, {SANDBOX_NOTE.connect}</dd></div>
        </dl>
        <div className="frame-actions">
          {invite && <CopyButton testId="invite-link" what="invite link" text={() => invite}>Copy invite link</CopyButton>}
          <button type="button" className="btn btn-quiet" aria-pressed={theme === "light"} onClick={() => setViewTheme(theme === "dark" ? "light" : "dark")} title="Sends host-context-changed to the View">
            View theme: {theme}
          </button>
          <button type="button" className="btn btn-quiet" aria-pressed={display === "fullscreen"} onClick={() => setDisplay(display === "fullscreen" ? "inline" : "fullscreen")}>
            {display === "fullscreen" ? "Exit full screen" : "Full screen"}
          </button>
        </div>
      </header>
      <div className="frame-body" style={display === "fullscreen" ? undefined : { height: px }}>
        <iframe
          ref={frame} data-testid="view-frame" title={tool ? `${resourceOf(tool)} View` : "View"}
          sandbox="allow-scripts" referrerPolicy="no-referrer" allow=""
        />
        {connection === "failed" && (
          <div className="frame-note"><p>The page could not reach the MCP server, so there is no View to open. The wire shows the failed request.</p></div>
        )}
        {connection === "connecting" && <div className="frame-note"><p>Connecting to the MCP server.</p></div>}
        {connection === "ready" && status.phase === "mounting" && <div className="frame-note frame-note-quiet"><p>Reading the View from the server.</p></div>}
        {status.phase === "failed" && (
          <div className="frame-note" role="alert">
            <p>The View did not open: {status.message}</p>
            <button type="button" className="btn" onClick={() => setAttempt((count) => count + 1)}>Try again</button>
          </div>
        )}
      </div>
    </section>
  );
}
