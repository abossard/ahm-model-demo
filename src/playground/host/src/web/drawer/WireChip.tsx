import { setDrawerOpen } from "../app/actions";
import { useStore } from "../app/store";
import { useWireEvents } from "./useWireEvents";

export function WireChip() {
  const wire = useStore((state) => state.wire);
  const { open, paused } = useStore((state) => state.drawer);
  const events = useWireEvents(wire);
  if (open) return null;
  const last = events.at(-1);
  return (
    <button
      type="button" className="chip" data-testid="wire-chip" data-paused={paused} aria-expanded={false} aria-controls="wire-drawer"
      aria-keyshortcuts="`" aria-label={`Open the wire. ${events.length} messages so far.`} onClick={() => setDrawerOpen(true)}
    >
      <svg className="radar" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1" opacity=".5" />
        <line className="radar-sweep" x1="12" y1="12" x2="12" y2="2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="chip-name">Wire</span>
      <span className="chip-count" data-testid="wire-chip-count">{events.length}</span>
      <span key={last?.id ?? "none"} className="chip-blink" aria-hidden="true" />
      <kbd aria-hidden="true">`</kbd>
    </button>
  );
}
