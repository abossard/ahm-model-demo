import type { JSX } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { diffTokens, impactStyle, tokensFor, type DiffMark } from "../model/palette";
import { StateGlyph } from "./StateGlyph";

const useStyles = makeStyles({
  root: {
    flex: "0 0 auto",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  item: { display: "inline-flex", alignItems: "center", columnGap: tokens.spacingHorizontalXS },
  mark: { fontWeight: tokens.fontWeightSemibold, paddingInline: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusCircular, border: "1px solid" },
  swatch: { display: "block" },
});

const STATES = ["Healthy", "Degraded", "Unhealthy", "Unknown"] as const;
const DIFF: readonly DiffMark[] = ["added", "changed", "removed"];
// What the two lesser impacts do to the entity above, in the words of the Azure documentation.
const IMPACT_HINT = {
  Limited: "A limited impact entity can turn its parent Degraded at most, never Unhealthy.",
  Suppressed: "A suppressed entity does not change the state of its parent.",
} as const;

interface LegendProps {
  /** Show the marks of a compared diff. */
  readonly diff?: boolean;
  /** What a lane, a chip or a cell means in the view on screen. */
  readonly notes?: readonly string[];
}

/** The one legend of every view: a shape per health state, the two impacts as line styles, diff marks, and the view's own notes. */
export function Legend({ diff = false, notes = [] }: LegendProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid="legend" role="group" aria-label="Legend">
      {STATES.map((state) => (
        <span className={styles.item} key={state} data-testid={`legend-${state}`}>
          <StateGlyph state={state} size={14} />
          {tokensFor(state).word}
        </span>
      ))}
      {(["Limited", "Suppressed"] as const).map((impact) => (
        <span className={styles.item} key={impact} data-testid={`legend-${impact}`} title={IMPACT_HINT[impact]}>
          <svg className={styles.swatch} width="28" height="8" aria-hidden="true">
            <line x1="1" x2="27" y1="4" y2="4" stroke="var(--edge)" strokeWidth="2" strokeDasharray={impactStyle[impact].dash} strokeLinecap={impactStyle[impact].cap} />
          </svg>
          {impactStyle[impact].word}
        </span>
      ))}
      {diff
        ? DIFF.map((mark) => (
            <span
              className={`${styles.item} ${styles.mark}`}
              key={mark}
              data-testid={`legend-${mark}`}
              style={{ background: diffTokens[mark].tint, color: diffTokens[mark].ink, borderColor: diffTokens[mark].line }}
            >
              <span aria-hidden="true">{diffTokens[mark].glyph}</span> {diffTokens[mark].word}
            </span>
          ))
        : null}
      {notes.map((note) => (
        <span className={styles.item} key={note}>
          {note}
        </span>
      ))}
    </div>
  );
}
