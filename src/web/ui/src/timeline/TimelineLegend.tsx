import type { JSX } from "react";
import { MARK } from "./tooltip";
import { useStyles } from "./styles";

const COLOURS = [
  { state: "Healthy", word: "Healthy" },
  { state: "Degraded", word: "Degraded" },
  { state: "Unhealthy", word: "Unhealthy" },
  { state: "Unknown", word: "Unknown or no data" },
] as const;

/** What the colours and marks of the plot mean. The bars of an entity and the line of a signal share one set of colours. */
export function TimelineLegend({ standby }: { readonly standby: boolean }): JSX.Element {
  const styles = useStyles();
  return (
    <ul className={styles.legend} aria-label="Legend" data-testid="tl-legend">
      {COLOURS.map((item) => (
        <li className={styles.legendItem} key={item.state} data-testid={`tl-legend-${item.state}`}>
          <span className="tl-swatch" data-state={item.state} aria-hidden="true" />
          {item.word}
        </li>
      ))}
      {standby ? (
        <li className={styles.legendItem} data-testid="tl-legend-Deleted">
          <span className="tl-swatch" data-state="Deleted" aria-hidden="true" />
          Standby
        </li>
      ) : null}
      <li className={styles.legendItem} data-testid="tl-legend-line">
        A signal's line turns orange past its Degraded threshold and red past its Unhealthy one.
      </li>
      <li className={styles.legendItem} data-testid="tl-legend-annotation">
        <span className="tl-mark" data-mark="annotation" aria-hidden="true">{MARK.annotation}</span>
        Annotation
      </li>
      <li className={styles.legendItem} data-testid="tl-legend-report">
        <span className="tl-mark" aria-hidden="true">{MARK.report}</span>
        Health report
      </li>
      <li className={styles.legendItem} data-testid="tl-legend-change">
        <span className="tl-mark" aria-hidden="true">{MARK.change}</span>
        State change (selected entity)
      </li>
      <li className={styles.legendItem} data-testid="tl-legend-incident">
        <span className="tl-swatch" data-state="Unhealthy" aria-hidden="true" />
        Incident (model Degraded or Unhealthy)
      </li>
      <li className={styles.legendItem} data-testid="tl-legend-pinned">
        <span className="tl-pin" aria-hidden="true" />
        Pinned moment
      </li>
    </ul>
  );
}
