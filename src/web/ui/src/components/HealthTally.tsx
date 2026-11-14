import { useMemo } from "react";
import type { JSX } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { stateTokens } from "../model/palette";
import type { HealthState } from "../model/types";
import { selectModelAt } from "../store/timelineSlice";
import { useAtMoment } from "../timeline/useAtMoment";

/** The louder state first, so a problem leads the bar and the sentence. */
const ORDER: readonly HealthState[] = ["Unhealthy", "Degraded", "Unknown", "Deleted", "Healthy"];

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontVariantNumeric: "tabular-nums",
  },
  bar: {
    display: "flex",
    width: "96px",
    height: "6px",
    columnGap: "2px",
    borderRadius: tokens.borderRadiusCircular,
    overflow: "hidden",
    flexShrink: 0,
  },
  // On a phone the bar alone says it; the sentence stays for a screen reader.
  sentence: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    "@media (max-width: 720px)": { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" },
  },
});

/** How the entities of the model split over the health states at the selected moment: a bar in the state colours and a sentence. */
export function HealthTally(): JSX.Element | null {
  const styles = useStyles();
  const model = useAtMoment(selectModelAt);
  const counts = useMemo(() => {
    const result = new Map<HealthState, number>();
    for (const entity of model?.entities ?? []) result.set(entity.healthState, (result.get(entity.healthState) ?? 0) + 1);
    return result;
  }, [model?.entities]);
  const total = model?.entities.length ?? 0;
  if (total === 0) return null;
  const healthy = counts.get("Healthy") ?? 0;
  const others = ORDER.filter((state) => state !== "Healthy" && (counts.get(state) ?? 0) > 0).map(
    (state) => `${counts.get(state)} ${stateTokens[state].word.toLowerCase()}`,
  );
  // Only what needs a look is named: the bar already shows how much of the model it is.
  const sentence = others.length === 0 ? (healthy === 1 ? "Healthy" : `All ${total} healthy`) : others.join(", ");
  return (
    <span className={styles.root} data-testid="health-tally" title={`${total} entities`}>
      <span className={styles.bar} aria-hidden="true">
        {ORDER.map((state) => (
          <span
            key={state}
            className="hp-tally-segment"
            style={{ flexGrow: counts.get(state) ?? 0, backgroundColor: stateTokens[state].dot }}
          />
        ))}
      </span>
      <span className={styles.sentence}>{sentence}</span>
    </span>
  );
}
