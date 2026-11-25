import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { arrivalOf } from "../app/arrivals";
import { resetFilters, selectEvent, setDrawerOpen } from "../app/actions";
import { useStore } from "../app/store";
import { Filters } from "./Filters";
import { MessageDetail } from "./MessageDetail";
import { useNow, useWireEvents } from "./useWireEvents";
import { WireRow } from "./WireRow";
import { applyFilters, filtersActive, LANES, pairEvents, relatedTo, visibleRows } from "./wireModel";

const LEGEND = [
  { flow: "view-to-host", label: "View → Host" },
  { flow: "host-to-view", label: "Host → View" },
  { flow: "host-to-server", label: "Host → Server" },
  { flow: "server-to-host", label: "Server → Host" },
  { flow: "error", label: "Error" },
] as const;

export function WireDrawer() {
  const wire = useStore((state) => state.wire);
  const { open, selectedId, filters, paused } = useStore((state) => state.drawer);
  const events = useWireEvents(wire);
  const asideRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [atTail, setAtTail] = useState(true);
  const seen = useRef<Set<string> | null>(null);

  const shown = useMemo(() => applyFilters(events, filters), [events, filters]);
  const pairing = useMemo(() => pairEvents(events), [events]);
  const { rows, hidden } = useMemo(() => visibleRows(shown), [shown]);
  const selected = useMemo(() => events.find((event) => event.id === selectedId) ?? null, [events, selectedId]);
  const related = useMemo(() => relatedTo(selected, events, pairing), [selected, events, pairing]);
  const anyPending = rows.some((event) => pairing.pending.has(event.id));
  const now = useNow(open && !paused && anyPending);

  // Rows that were not on screen at the last render slide in. The first render of a session is quiet.
  const fresh = seen.current === null ? new Set<string>() : new Set(rows.filter((event) => !seen.current!.has(event.id)).map((event) => event.id));
  useEffect(() => {
    seen.current = new Set(rows.map((event) => event.id));
  });

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (open && list && stuck.current) list.scrollTop = list.scrollHeight;
  }, [open, rows.length]);

  if (!open) return null;

  const close = () => {
    setDrawerOpen(false);
    queueMicrotask(() => document.querySelector<HTMLElement>('[data-testid="wire-chip"]')?.focus());
  };

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const nearEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
    stuck.current = nearEnd;
    setAtTail(nearEnd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (selectedId) selectEvent(null);
      else close();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (event.target as HTMLElement).closest(".rows")) {
      event.preventDefault();
      const index = rows.findIndex((row) => row.id === selectedId);
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        selectEvent(next.id);
        queueMicrotask(() => listRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus());
      }
    }
  };

  const waited = (id: string) => {
    const arrived = arrivalOf(id);
    return arrived === null ? null : Math.max(0, now - arrived);
  };

  return (
    <aside ref={asideRef} id="wire-drawer" className="drawer" data-testid="wire-drawer" aria-label="The wire" data-paused={paused} onKeyDown={onKeyDown}>
      <header className="drawer-head">
        <div>
          <h2 ref={titleRef} tabIndex={-1} className="drawer-title">The wire</h2>
          <p className="drawer-count" data-testid="wire-count">
            {filtersActive(filters) ? `${shown.length} of ${events.length}` : events.length} messages, both hops
          </p>
        </div>
        <button type="button" className="btn btn-quiet" onClick={close} aria-label="Close the wire" aria-keyshortcuts="`">Close <kbd>`</kbd></button>
      </header>

      <ul className="legend" aria-label="Colour key">
        {LEGEND.map((item) => <li key={item.flow} data-flow={item.flow}><span className="swatch" aria-hidden="true" />{item.label}</li>)}
      </ul>

      <Filters shown={shown} selectedTrace={selected?.trace ?? null} />

      <div className="lane-head" aria-hidden="true">
        {LANES.map((lane) => <span key={lane.party}>{lane.label}</span>)}
      </div>

      <div className="rows" ref={listRef} onScroll={onScroll} role="group" aria-label="Messages, oldest first">
        <div className="rows-inner">
        <div className="lane-lines" aria-hidden="true"><span /><span /><span /></div>
        {hidden > 0 && <p className="rows-note">{hidden} older messages are hidden to keep the list fast. Copy all still has them.</p>}
        {rows.length === 0 && (
          <div className="rows-empty">
            {events.length === 0 ? (
              <p>Nothing has crossed the wire yet. Press a button in a View and watch it travel.</p>
            ) : (
              <p>No message matches. {events.length - shown.length} are hidden by the filters. <button type="button" className="link" onClick={resetFilters}>Reset filters</button></p>
            )}
          </div>
        )}
        {rows.map((event) => (
          <WireRow
            key={event.id} event={event} selected={event.id === selectedId} fresh={fresh.has(event.id) && !paused}
            relation={event.id === related.partner ? "partner" : related.sameTrace.has(event.id) ? "trace" : null}
            pending={pairing.pending.has(event.id)} waitedMs={pairing.pending.has(event.id) ? waited(event.id) : null} onSelect={selectEvent}
          />
        ))}
        </div>
      </div>

      {!atTail && <button type="button" className="btn tail-btn" onClick={() => { const list = listRef.current; if (list) { list.scrollTop = list.scrollHeight; stuck.current = true; setAtTail(true); } }}>Jump to latest</button>}

      {selected && <MessageDetail event={selected} events={events} pairing={pairing} waitedMs={pairing.pending.has(selected.id) ? waited(selected.id) : null} />}
    </aside>
  );
}
