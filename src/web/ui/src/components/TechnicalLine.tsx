import type { JSX } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  line: { display: "block", marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, overflowWrap: "anywhere" },
});

/** The code and reference of an error, small and last: for whoever reports the problem, not for whoever reads the message. */
export function TechnicalLine({ text }: { readonly text: string | null }): JSX.Element | null {
  const styles = useStyles();
  return text === null ? null : (
    <span className={styles.line} data-testid="technical-details">
      Technical details: {text}
    </span>
  );
}
