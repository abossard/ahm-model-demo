import { countText, kindsOf, visibleLog, type LogLine, type LogRow } from "@playground/contracts";
import { useMemo, useState, type ReactNode } from "react";
import "./logview.css";

// The rows a log shows, and the chip row that steers them. One piece for every log in a View.
export function useLogFilter<T extends LogLine>(lines: readonly T[], label: string): { rows: LogRow<T>[]; bar: ReactNode } {
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const rows = useMemo(() => visibleLog(lines, off, query), [lines, off, query]);
  const kinds = kindsOf(lines);
  const toggle = (kind: string) => setOff((prev) => { const next = new Set(prev); if (!next.delete(kind)) next.add(kind); return next; });
  const bar = lines.length === 0 ? null : (
    <div className="logbar" role="group" aria-label={`Filter ${label}`}>
      {kinds.length > 1 && kinds.map((kind) => (
        <button key={kind} type="button" className="logchip" aria-pressed={!off.has(kind)} onClick={() => toggle(kind)}>{kind}</button>
      ))}
      <input className="logfind" type="search" value={query} placeholder="Filter" aria-label={`Filter ${label} by text`} onChange={(event) => setQuery(event.target.value)} />
    </div>
  );
  return { rows, bar };
}

export function Count({ count }: { count: number }) {
  return count > 1 ? <span className="logcount num" data-testid="log-count">{countText(count)}</span> : null;
}
