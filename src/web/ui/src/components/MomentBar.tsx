import { useEffect } from "react";
import type { JSX } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { History20Regular } from "@fluentui/react-icons";
import { showingMoment } from "../model/wording";
import { actions } from "../store/store";
import { selectedMoment } from "../store/timelineSlice";
import { useAtMoment } from "../timeline/useAtMoment";
import { useNow } from "./useNow";

const useStyles = makeStyles({
  bar: {
    flex: "0 0 auto",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorPaletteYellowBackground2,
    borderBottom: `1px solid ${tokens.colorPaletteYellowBorder2}`,
  },
  when: { display: "inline-flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: "tabular-nums" },
  note: { fontSize: tokens.fontSizeBase200 },
});

/** Something that takes Escape for itself is open, or has the focus: a dialog, a menu, a text being typed. */
function escapeIsTaken(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-popper-placement], [data-fullscreen="true"], .is-reordering')) return true;
  const target = event.target;
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Says which time the page shows while a past moment is selected, and returns to now. It sits under the top bar, above
 * the graph and above a timeline that fills the window, so it is there whatever else is on screen. Escape returns to
 * now from anywhere, after everything that closes with Escape has closed.
 */
export function MomentBar(): JSX.Element | null {
  const styles = useStyles();
  const moment = useAtMoment(selectedMoment);
  const now = useNow(moment !== null);

  useEffect(() => {
    if (moment === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !escapeIsTaken(event)) actions.selectMoment(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moment === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (moment === null) return null;
  return (
    // A group, not a status: the plot says where the moment is when it rests, and a drag is not read out move by move.
    <div className={styles.bar} role="group" aria-label="Past moment shown" data-testid="moment-bar">
      <span className={styles.when} data-testid="moment-shown">
        <History20Regular aria-hidden="true" />
        {showingMoment(moment, Math.max(now, moment))}
      </span>
      <Text className={styles.note}>Everything on this page is as it was then.</Text>
      <Button size="small" appearance="primary" onClick={() => actions.selectMoment(null)} data-testid="moment-now">
        Back to now
      </Button>
    </div>
  );
}
