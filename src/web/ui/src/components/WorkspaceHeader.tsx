import type { JSX } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { ChevronLeft20Regular, PanelLeftContract20Regular } from "@fluentui/react-icons";
import { actions } from "../store/store";

const useStyles = makeStyles({
  root: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  back: { flex: "0 0 auto", marginLeft: `calc(-1 * ${tokens.spacingHorizontalS})` },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: tokens.fontWeightSemibold,
  },
});

export interface HeaderBack {
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: string;
}

/** The one row on top of the workspace: where back goes, where the user is, and the way to collapse the pane. */
export function WorkspaceHeader({
  title,
  titleTestId,
  back,
}: {
  readonly title: string;
  readonly titleTestId: string;
  readonly back?: HeaderBack;
}): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      {back ? (
        <Button
          appearance="subtle"
          size="small"
          icon={<ChevronLeft20Regular />}
          className={styles.back}
          onClick={back.onClick}
          data-testid={back.testId}
        >
          {back.label}
        </Button>
      ) : null}
      <Text as="h2" size={back ? 300 : 400} className={styles.title} title={title} data-testid={titleTestId}>
        {title}
      </Text>
      <Button
        appearance="subtle"
        size="small"
        icon={<PanelLeftContract20Regular />}
        aria-label="Close the Session workspace"
        onClick={() => actions.setWorkspaceOpen(false)}
        data-testid="workspace-close"
      />
    </div>
  );
}
