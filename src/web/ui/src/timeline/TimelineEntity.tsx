import type { JSX } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  MessageBar,
  MessageBarBody,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Text,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { ExplainAction } from "../components/ExplainAction";
import { HealthBadge } from "../components/HealthBadge";
import { ReportForm } from "../components/ReportForm";
import { SignalHistory } from "../components/SignalHistory";
import { accessMessage } from "../model/errors";
import { stateName, type Transition } from "../model/timeline";
import { formatInstant } from "../model/timelineScale";
import type { ReportOptions } from "../model/types";
import { actions, useStore } from "../store/store";
import { useStyles } from "./styles";

interface Props {
  readonly options: ReportOptions;
  /** Every state change of the selected entity, oldest first. */
  readonly changes: readonly Transition[];
  readonly offsetMin: number;
}

/**
 * The selected entity above the plot: its state and impact, the question to ask about it, its health reports and every
 * change of its state. The changes are marked on its row, and listed here for the keyboard and a screen reader.
 */
export function TimelineEntity({ options, changes, offsetMin }: Props): JSX.Element {
  const styles = useStyles();
  const selectedName = useStore((state) => state.selectedName);
  const detail = useStore((state) => state.detail);
  // The name the graph gives it, until the detail is read.
  const known = useStore((state) => (state.model.kind === "success" ? state.model.value.entities.find((entity) => entity.name === state.selectedName)?.displayName : undefined));
  const title = detail.kind === "success" ? detail.value.entity.displayName : (known ?? selectedName);

  return (
    <section className={styles.entity} aria-label="Selected entity" data-testid="entity-details">
      {detail.kind === "success" ? <HealthBadge state={detail.value.entity.healthState} /> : null}
      <span className={styles.entityName} data-testid="entity-name">
        {title}
      </span>
      {detail.kind === "success" ? <Text size={200}>Impact: {detail.value.entity.impact}</Text> : null}
      {detail.kind === "loading" ? <Spinner size="tiny" label="Loading entity…" labelPosition="after" /> : null}
      {detail.kind === "failure" ? (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>{accessMessage(detail.error, "browse")}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.entityActions}>
        <ExplainAction />
        {detail.kind === "success" ? (
          <Dialog modalType="modal">
            <DialogTrigger disableButtonEnhancement>
              <Button size="small" data-testid="report-open">
                Send a health report
              </Button>
            </DialogTrigger>
            <DialogSurface aria-describedby={undefined} data-testid="report-dialog">
              <DialogBody>
                <DialogTitle>Send a health report</DialogTitle>
                <DialogContent className={styles.formBody}>
                  {detail.value.entity.report.eligible ? (
                    <>
                      <Text as="p" size={200}>
                        Tells Azure Monitor how this entity is doing, until the report expires.
                      </Text>
                      <ReportForm key={detail.value.entity.name} entityName={detail.value.entity.name} options={options} />
                    </>
                  ) : (
                    <Text as="p" data-testid="report-ineligible">
                      This entity cannot take health reports.
                    </Text>
                  )}
                  <SignalHistory detail={detail.value} />
                </DialogContent>
                <DialogActions>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="secondary" data-testid="report-close">
                      Close
                    </Button>
                  </DialogTrigger>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        ) : null}
        <Popover positioning="below-end" trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <Button size="small" data-testid="entity-changes">
              State changes ({changes.length})
            </Button>
          </PopoverTrigger>
          <PopoverSurface aria-label="State changes" data-testid="entity-changes-list">
            {changes.length === 0 ? (
              <Text as="p">No state changes in this history.</Text>
            ) : (
              <ul className={styles.changes}>
                {[...changes].reverse().map((change) => (
                  <li key={`${change.t}-${change.to}`} className={styles.change} data-testid="transition-row">
                    <HealthBadge state={stateName(change.to)}>
                      {stateName(change.from)} to {stateName(change.to)}
                    </HealthBadge>
                    <time>{formatInstant(change.t, offsetMin)}</time>
                    {change.reason ? <span>{change.reason}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </PopoverSurface>
        </Popover>
        <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close details" onClick={() => actions.clearEntity()} data-testid="entity-close" />
      </div>
    </section>
  );
}
