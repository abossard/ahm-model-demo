import type { TraderView } from "@playground/contracts";
import { Button } from "../kit";
import { useMemo } from "react";
import { Count, useLogFilter } from "../logview/LogFilter";
import { formatCredits, logKind, rankScores } from "./logic";
import type { TraderScore } from "@playground/contracts";

export function Log({ log }: { log: TraderView["log"] }) {
  const lines = useMemo(() => log.map((entry) => ({ ...entry, kind: logKind(entry.text) })), [log]);
  const { rows, bar } = useLogFilter(lines, "the log");
  return (
    <section className="panel" aria-label="Log">
      <h2>Log</h2>
      {log.length === 0 ? (
        <p className="muted">Nothing yet. Buy something, then fly.</p>
      ) : (
        <>
          {bar}
          <ol className="log" data-testid="log">
            {rows.map(({ line, count }, i) => (
              <li key={`${line.day}-${i}`}>
                <span className="num day-tag">D{line.day}</span>
                <span>{line.text} <Count count={count} /></span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function Scores({ scores, pilot, onRefresh }: { scores: readonly TraderScore[]; pilot: string; onRefresh(): void }) {
  const ranked = rankScores(scores, pilot);
  return (
    <section className="panel" aria-label="Top pilots">
      <div className="panel-bar">
        <h2>Top pilots</h2>
        <Button variant="quiet" className="btn-small" onClick={onRefresh}>Refresh</Button>
      </div>
      {ranked.length === 0 ? (
        <p className="muted">No finished runs yet. Yours could be first.</p>
      ) : (
        <ol className="scores" data-testid="scores">
          {ranked.map((score) => (
            <li key={`${score.rank}-${score.handle}`} className={score.mine ? "mine" : ""} aria-current={score.mine ? "true" : undefined}>
              <span className="num rank">{score.rank}</span>
              <span className="who">{score.handle}</span>
              <span className="num">{formatCredits(score.netWorth)}</span>
              <span className="num day-tag">D{score.day}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
