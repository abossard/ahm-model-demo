import type { JSX } from "react";
import { Text, makeStyles, tokens } from "@fluentui/react-components";
import { formatSignalValue } from "../model/signalValue";
import type { EntityDetail, SignalValue } from "../model/types";
import { HealthBadge } from "./HealthBadge";

const useStyles = makeStyles({
  heading: {
    margin: `0 0 ${tokens.spacingVerticalS}`,
    color: tokens.colorNeutralForeground2,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalXS,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  time: {
    marginLeft: "auto",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
  },
  value: { fontVariantNumeric: "tabular-nums", fontWeight: tokens.fontWeightSemibold },
  reason: { color: tokens.colorNeutralForeground2 },
});

function formatValue(value: SignalValue): string {
  return value === null ? "no value" : formatSignalValue(value);
}

function formatTime(value: string | null): string {
  return value ?? "no time recorded";
}

/** The health reports sent for an entity: the history of the signal that carries them. */
export function SignalHistory({ detail }: { readonly detail: EntityDetail }): JSX.Element {
  const styles = useStyles();
  const { canonicalSignal } = detail;
  return (
    <section aria-labelledby="signal-heading">
      <Text as="h4" block id="signal-heading" weight="bold" size={200} className={styles.heading}>
        History of the signal {canonicalSignal.name}
      </Text>
      {canonicalSignal.history.length === 0 ? (
        <Text as="p" className={styles.reason}>
          No history for this signal yet.
        </Text>
      ) : (
        <ul className={styles.list}>
          {canonicalSignal.history.map((item, index) => (
            <li key={index} data-testid="signal-history-row" className={styles.row}>
              <HealthBadge state={item.healthState ?? "Unknown"}>{item.healthState ?? "unknown"}</HealthBadge>
              <span className={styles.value}>{formatValue(item.value)}</span>
              <time className={styles.time}>{formatTime(item.occurredAt)}</time>
              {item.reason ? <span className={styles.reason}>{item.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
