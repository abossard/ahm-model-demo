import type { JSX } from "react";
import { Badge, Text, makeStyles, tokens } from "@fluentui/react-components";
import type { Confidence } from "../model/types";
import { howSure } from "../model/wording";

const useStyles = makeStyles({
  root: { display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: tokens.spacingHorizontalS },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
});

const COLOR = { high: "success", medium: "warning", low: "danger" } as const;

/** How sure the assistant says it is, and what that means for what the user does next. Shown only when it said. */
export function HowSure({ confidence, testId }: { readonly confidence: Confidence | undefined; readonly testId: string }): JSX.Element | null {
  const styles = useStyles();
  if (confidence === undefined) return null;
  const sure = howSure(confidence);
  return (
    <div className={styles.root} data-testid={testId} data-confidence={confidence}>
      <Text>How sure</Text>
      <Badge appearance="tint" color={COLOR[confidence]}>
        {sure.label}
      </Badge>
      <Text className={styles.hint}>{sure.hint}</Text>
    </div>
  );
}
