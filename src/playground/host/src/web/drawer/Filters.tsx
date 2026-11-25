import type { DebugEvent, Hop, WireKind } from "@playground/contracts";
import { clearWire, resetFilters, setFilters, togglePause } from "../app/actions";
import { useStore } from "../app/store";
import { CopyButton } from "./CopyButton";
import { exportEvents, filtersActive } from "./wireModel";

const HOPS: readonly { value: Hop | "all"; label: string }[] = [
  { value: "all", label: "Both hops" },
  { value: "view-host", label: "View ↔ Host" },
  { value: "host-server", label: "Host ↔ Server" },
];
const KINDS: readonly (WireKind | "all")[] = ["all", "request", "response", "error", "notification", "http"];

export function Filters(props: { shown: readonly DebugEvent[]; selectedTrace: string | null }) {
  const { filters, paused } = useStore((state) => state.drawer);
  const active = filtersActive(filters);
  const traceTarget = filters.trace ?? props.selectedTrace;
  return (
    <div className="filters" role="toolbar" aria-label="Wire controls">
      <div className="filters-row">
        <button type="button" className="btn" data-testid="wire-pause" aria-pressed={paused} onClick={togglePause}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className="btn" data-testid="wire-clear" onClick={clearWire}>Clear</button>
        <CopyButton testId="wire-copy" what="messages as JSON" text={() => exportEvents(props.shown)} title="Copy the messages in view as JSON">
          Copy all
        </CopyButton>
        {paused && <span className="paused-note" role="status">Paused. The list stands still; messages keep arriving.</span>}
      </div>
      <div className="filters-row">
        <label className="field field-grow">
          <span className="sr-only">Filter messages by text</span>
          <input
            type="search" data-testid="wire-filter-text" placeholder="Filter: method, tool, trace, #id, payload" value={filters.text}
            onChange={(event) => setFilters({ text: event.target.value })} spellCheck={false} autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="sr-only">Hop</span>
          <select data-testid="wire-filter-hop" value={filters.hop} onChange={(event) => setFilters({ hop: event.target.value as Hop | "all" })}>
            {HOPS.map((hop) => <option key={hop.value} value={hop.value}>{hop.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="sr-only">Kind</span>
          <select data-testid="wire-filter-kind" value={filters.kind} onChange={(event) => setFilters({ kind: event.target.value as WireKind | "all" })}>
            {KINDS.map((kind) => <option key={kind} value={kind}>{kind === "all" ? "All kinds" : kind}</option>)}
          </select>
        </label>
      </div>
      <div className="filters-row filters-toggles">
        <label className="check">
          <input type="checkbox" data-testid="wire-hide-longpolls" checked={filters.hideLongPolls} onChange={(event) => setFilters({ hideLongPolls: event.target.checked })} />
          Hide long-polls
        </label>
        <label className="check">
          <input
            type="checkbox" data-testid="wire-filter-trace" checked={filters.trace !== null} disabled={traceTarget === null}
            onChange={(event) => setFilters({ trace: event.target.checked ? traceTarget : null })}
          />
          This trace only
        </label>
        {active && <button type="button" className="btn btn-quiet" onClick={resetFilters}>Reset filters</button>}
      </div>
    </div>
  );
}
