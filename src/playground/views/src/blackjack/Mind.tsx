import type { BlackjackView } from "@playground/contracts";
import { useMemo } from "react";
import { Count, useLogFilter } from "../logview/LogFilter";
import { mindRows, thinking } from "./logic";

export function Mind({ view }: { view: BlackjackView }) {
  const lines = useMemo(() => mindRows(view.dealerLog).map((row, i) => ({
    ...row, kind: [...view.dealerLog].reverse()[i]!.kind, text: [row.title, row.verdict, row.meta, row.note].filter(Boolean).join(" "),
  })), [view.dealerLog]);
  const { rows, bar } = useLogFilter(lines, "the dealer's mind");
  const live = thinking(view);
  return (
    <aside className="mind" aria-label="The dealer's mind">
      <h2>The dealer&rsquo;s mind</h2>
      <p className="muted">A language model orders the shoe and chooses hit or stand. Code checks every reply, deals the cards and pays.</p>
      {bar}
      <ol className="mind-list" data-testid="dealer-log" aria-live="polite">
        {live && (
          <li className="mind-row mind-live">
            <span className="pulse" aria-hidden="true" />
            <span>{live}</span>
          </li>
        )}
        {lines.length === 0 && !live && <li className="mind-empty muted">No calls yet. The dealer is called when the first bet is placed.</li>}
        {rows.map(({ line: row, count }) => (
          <li key={row.key} className="mind-row" data-tone={row.tone}>
            <span className="mind-head">
              <span className="mind-title">{row.title}</span>
              <span className={`badge badge-${row.tone}`}>{row.verdict}</span>
              <Count count={count} />
            </span>
            <span className="mind-meta num">{row.meta}</span>
            {row.note && <span className="mind-note">{row.note}</span>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
