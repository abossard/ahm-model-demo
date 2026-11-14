import { makeStyles, tokens } from "@fluentui/react-components";

/** Below this width of the graph area the toolbar's longer labels give way, so its controls stay on one row. */
export const COMPACT = 1120;

/** Out of sight, still read by a screen reader. */
export const visuallyHidden = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

/** A label beside its control, each at its natural width (Fluent's default gives the label a third). */
export const useInlineField = makeStyles({
  root: {
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
});
