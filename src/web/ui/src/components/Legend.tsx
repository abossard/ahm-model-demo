import { useId } from "react";
import type { JSX } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { ChevronDown16Regular } from "@fluentui/react-icons";
import { diffTokens, impactStyle, tokensFor, type DiffMark } from "../model/palette";
import { StateGlyph } from "./StateGlyph";
import { useDisclosure } from "./useDisclosure";

const useStyles = makeStyles({
  root: {
    flex: "0 0 auto",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
  },
  item: { display: "inline-flex", alignItems: "center", columnGap: tokens.spacingHorizontalXS },
  mark: { fontWeight: tokens.fontWeightSemibold, paddingInline: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusCircular, border: "1px solid" },
  swatch: { display: "block", flexShrink: 0 },
  // A phone keeps the key to one row: the graph needs the height more than the lessons.
  // As tall as a line of the key, so the row keeps the height it had without the toggle.
  toggle: { marginInlineStart: "auto", minWidth: "auto", height: "20px", paddingBlock: 0, color: tokens.colorNeutralForeground2, "@container graph (max-width: 720px)": { display: "none" } },
  lessons: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    columnGap: tokens.spacingHorizontalXXL,
    rowGap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM}`,
    maxWidth: "1180px",
    "@container graph (max-width: 720px)": { display: "none" },
  },
  lesson: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXS, maxWidth: "46ch" },
  heading: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  text: { margin: 0, lineHeight: tokens.lineHeightBase300 },
  samples: { display: "flex", flexWrap: "wrap", columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXXS },
  notes: { margin: 0, paddingInlineStart: tokens.spacingHorizontalL, display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXXS },
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

/**
 * The one legend of every view. Its row is the key: a shape per health state and, while comparing, the diff marks.
 * "How to read this" opens three short lessons: what a card is, how health flows up the lines, and what the view on
 * screen adds. They start closed, the toggle inviting a first-time viewer, and stay as the viewer leaves them.
 */
export function Legend({ diff = false, notes = [] }: LegendProps): JSX.Element {
  const styles = useStyles();
  const [open, toggle, fresh] = useDisclosure("graph-key");
  const regionId = useId();
  return (
    <div className={styles.root} data-testid="legend" role="group" aria-label="Legend">
      <div className={styles.row}>
        {STATES.map((state) => (
          <span className={styles.item} key={state} data-testid={`legend-${state}`}>
            <StateGlyph state={state} size={14} />
            {tokensFor(state).word}
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
        <Button
          className={`hp-invite ${styles.toggle}`}
          size="small"
          appearance="transparent"
          icon={<ChevronDown16Regular className="hp-chevron" data-open={open || undefined} />}
          iconPosition="after"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={toggle}
          data-fresh={fresh || undefined}
          data-testid="legend-toggle"
        >
          {fresh ? "New here? How to read this" : "How to read this"}
        </Button>
      </div>
      <div className="hp-reveal" data-open={open || undefined} id={regionId} inert={!open} data-testid="legend-lessons">
        <div>
          <div className={styles.lessons}>
            <section className={styles.lesson}>
              <h3 className={styles.heading}>Each card is a part of your workload</h3>
              <p className={styles.text}>
                A user flow, a service or an Azure resource. Its colour and shape say how healthy it is, so a state never rests on colour alone.
              </p>
            </section>
            <section className={styles.lesson}>
              <h3 className={styles.heading}>Health flows up the lines</h3>
              <p className={styles.text}>A line takes the colour of the card below it. A broken child turns its parent Degraded or Unhealthy, unless the line says otherwise:</p>
              <div className={styles.samples}>
                {(["Limited", "Suppressed"] as const).map((impact) => (
                  <span className={styles.item} key={impact} data-testid={`legend-${impact}`} title={IMPACT_HINT[impact]}>
                    <svg className={styles.swatch} width="28" height="8" aria-hidden="true">
                      <line x1="1" x2="27" y1="4" y2="4" stroke="var(--edge)" strokeWidth="2" strokeDasharray={impactStyle[impact].dash} strokeLinecap={impactStyle[impact].cap} />
                    </svg>
                    {impact === "Limited" ? "Limited impact: Degraded at most" : "Suppressed: changes nothing above"}
                  </span>
                ))}
              </div>
            </section>
            <section className={styles.lesson}>
              <h3 className={styles.heading}>{notes.length > 0 ? "In this view" : "Ask why"}</h3>
              {notes.length > 0 ? (
                <ul className={styles.notes}>
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              <p className={styles.text}>Click a card to see its signals and ask the assistant why it is in its state.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
