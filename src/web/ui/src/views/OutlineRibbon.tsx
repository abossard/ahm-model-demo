import type { JSX } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import type { RibbonRun } from "../model/outline";
import { tokensFor } from "../model/palette";

const useStyles = makeStyles({
  root: {
    position: "relative",
    flex: "0 0 14px",
    width: "14px",
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: "pointer",
  },
  mark: { position: "absolute", left: "2px", right: "2px", minHeight: "1px" },
  loud: { minHeight: "3px" },
  window: {
    position: "absolute",
    left: 0,
    right: 0,
    minHeight: "6px",
    boxSizing: "border-box",
    border: `1.5px solid ${tokens.colorBrandStroke1}`,
    borderRadius: "2px",
    backgroundColor: "color-mix(in srgb, var(--colorBrandBackground) 14%, transparent)",
    pointerEvents: "none",
  },
});

interface OutlineRibbonProps {
  readonly runs: readonly RibbonRun[];
  /** Height of the whole list. */
  readonly total: number;
  /** Where the window the viewer sees starts, and how tall it is, in the list's own height. */
  readonly viewTop: number;
  readonly viewHeight: number;
  readonly onJump: (offset: number) => void;
}

const percent = (part: number, whole: number): string => `${(part / Math.max(whole, 1)) * 100}%`;

/**
 * The whole list squeezed into a strip: one mark per row in its state's colour, so where the
 * trouble is shows at a glance, and a frame round the part on screen. A click jumps there. It is
 * a pointer aid only; the tree is the way in for the keyboard and for screen readers.
 */
export function OutlineRibbon({ runs, total, viewTop, viewHeight, onJump }: OutlineRibbonProps): JSX.Element {
  const styles = useStyles();
  return (
    <div
      className={styles.root}
      data-testid="outline-ribbon"
      aria-hidden="true"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onJump(((event.clientY - box.top) / Math.max(box.height, 1)) * total);
      }}
    >
      {runs.map((run) => {
        const loud = run.state !== "Healthy";
        return (
          <span
            key={run.y}
            className={loud ? `${styles.mark} ${styles.loud}` : styles.mark}
            data-testid="outline-mark"
            data-state={run.state}
            style={{ top: percent(run.y, total), height: percent(run.height, total), backgroundColor: tokensFor(run.state).dot, opacity: loud ? 1 : 0.35 }}
          />
        );
      })}
      <span className={styles.window} data-testid="outline-window" style={{ top: percent(viewTop, total), height: percent(viewHeight, total) }} />
    </div>
  );
}
