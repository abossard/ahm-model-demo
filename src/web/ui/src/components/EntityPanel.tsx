import type { JSX } from "react";
import {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  InlineDrawer,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular, Lightbulb20Regular } from "@fluentui/react-icons";
import { accessMessage } from "../model/errors";
import type { ReportOptions } from "../model/types";
import { actions, useStore } from "../store/store";
import { HealthBadge } from "./HealthBadge";
import { ReportForm } from "./ReportForm";
import { SignalHistory } from "./SignalHistory";

const useStyles = makeStyles({
  root: {
    "--fui-Drawer--size": "min(380px, 42vw)",
    // On a phone the panel is a sheet over the graph: beside it, neither would be readable.
    "@media (max-width: 720px)": {
      position: "fixed",
      inset: 0,
      zIndex: 100,
      width: "100%",
      maxWidth: "100%",
    },
  },
  body: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalL },
  summary: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalM },
  muted: { color: tokens.colorNeutralForeground2 },
  explain: { marginBottom: tokens.spacingVerticalM },
  heading: { margin: `0 0 ${tokens.spacingVerticalM}` },
});

export function EntityPanel({ options }: { readonly options: ReportOptions }): JSX.Element {
  const styles = useStyles();
  const selectedName = useStore((state) => state.selectedName);
  const detail = useStore((state) => state.detail);
  const title = detail.kind === "success" ? detail.value.entity.displayName : selectedName;

  return (
    <InlineDrawer
      open
      separator
      position="end"
      className={styles.root}
      role="complementary"
      aria-label="Entity detail"
      data-testid="entity-panel"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          heading={<span data-testid="entity-name">{title}</span>}
          action={
            <Button
              appearance="subtle"
              aria-label="Close panel"
              icon={<Dismiss24Regular />}
              onClick={() => actions.clearEntity()}
            />
          }
        >
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.explain}>
          <Button
            icon={<Lightbulb20Regular />}
            onClick={() => actions.prefillTask("explain")}
            data-testid="explain-entity"
          >
            Explain this entity
          </Button>
        </div>
        {detail.kind === "loading" ? <Spinner size="small" label="Loading entity…" /> : null}
        {detail.kind === "failure" ? (
          <MessageBar intent="error" role="alert">
            <MessageBarBody>{accessMessage(detail.error, "browse")}</MessageBarBody>
          </MessageBar>
        ) : null}
        {detail.kind === "success" ? (
          <div className={styles.body}>
            <div className={styles.summary}>
              <HealthBadge state={detail.value.entity.healthState} />
              <Text className={styles.muted}>{detail.value.entity.impact}</Text>
            </div>
            <SignalHistory detail={detail.value} />
            <section aria-labelledby="report-heading">
              <Text as="h3" id="report-heading" weight="bold" className={styles.heading}>
                Report health
              </Text>
              {detail.value.entity.report.eligible ? (
                <ReportForm
                  key={detail.value.entity.name}
                  entityName={detail.value.entity.name}
                  options={options}
                />
              ) : (
                <Text as="p" className={styles.muted} data-testid="report-ineligible">
                  This entity cannot receive health reports.
                </Text>
              )}
            </section>
          </div>
        ) : null}
      </DrawerBody>
    </InlineDrawer>
  );
}
