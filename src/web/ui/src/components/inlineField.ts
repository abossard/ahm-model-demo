import { makeStyles, tokens } from "@fluentui/react-components";

/** A label beside its control, each at its natural width (Fluent's default gives the label a third). */
export const useInlineField = makeStyles({
  root: {
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
});
