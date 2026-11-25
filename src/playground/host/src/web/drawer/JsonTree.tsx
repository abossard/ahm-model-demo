import { useMemo, useState } from "react";
import { toggle, treeRows } from "./jsonRows";

export function JsonTree({ value }: { value: unknown }) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => treeRows(value, toggled), [value, toggled]);
  return (
    <div className="json" role="group" aria-label="Message as a JSON tree">
      {rows.map((row) => {
        const style = { paddingInlineStart: `${row.depth * 14}px` };
        const content = (
          <>
            <span className="json-caret" aria-hidden="true">{row.expandable ? (row.expanded ? "▾" : "▸") : ""}</span>
            {row.key !== null && <span className="json-key">{row.key}<span className="json-colon">:</span></span>}
            <span className={`json-val json-${row.kind}`}>{row.text}</span>
          </>
        );
        return row.expandable ? (
          <button key={row.path} type="button" className="json-row" style={style} aria-expanded={row.expanded} onClick={() => setToggled((current) => toggle(current, row.path))}>
            {content}
          </button>
        ) : (
          <div key={row.path} className="json-row json-leaf" style={style}>{content}</div>
        );
      })}
    </div>
  );
}
