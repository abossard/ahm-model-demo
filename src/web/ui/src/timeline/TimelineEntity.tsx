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
import { selectEntityAt } from "../store/timelineSlice";
import { useStyles } from "./styles";
import { useAtMoment } from "./useAtMoment";

interface Props {
  readonly options: ReportOptions;
  /** Every state change of the selected entity, oldest first. */
  readonly changes: readonly Transition[];
  readonly offsetMin: number;
  /** None of the entity's rows is in the viewport of the tree. */
  readonly rowHidden: boolean;
}

/**
 * The selected entity above the plot: its state and impact, the question to ask about it, its health reports and every
 * change of its state. The changes are marked on its row, and listed here for the keyboard and a screen reader.
 *
 * Its state is the one the graph shows: the live model's now, the one it had at a selected moment. The detail that is
 * read when it is selected adds what the model does not carry: whether it takes health reports, and the reports it got.
 */
export function TimelineEntity({ options, changes, offsetMin, rowHidden }: Props): JSX.Element {
  const styles = useStyles();
  const selectedName = useStore((state) => state.selectedName);
  const detail = useStore((state) => state.detail);
  const shown = useAtMoment(selectEntityAt);
  const past = useStore((state) => state.timelinePinned !== null);
  const title = shown?.displayName ?? (detail.kind === "success" ? detail.value.entity.displayName : selectedName);
  // Now the strip fills in when the detail has been read, as one piece. A past moment needs nothing of the detail,
  // which is about now: neither its wait nor its failure is shown.
  const known = shown !== undefined && (past || detail.kind === "success");

  return (
    <section className={styles.entity} aria-label={`Selected entity: ${title}`} data-testid="entity-details">
      {known ? <HealthBadge state={shown.healthState} /> : null}
      <span className={styles.entityName} data-testid="entity-name">
        {title}
      </span>
      {known ? <Text size={200}>Impact: {shown.impact}</Text> : null}
      {rowHidden ? (
        <Button size="small" appearance="transparent" onClick={() => actions.showInTimeline(selectedName ?? "")} data-testid="entity-show-row">
          Its row is out of view: show it
        </Button>
      ) : null}
      {!past && detail.kind === "loading" ? <Spinner size="tiny" label="Loading entity…" labelPosition="after" /> : null}
      {!past && detail.kind === "failure" ? (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>{accessMessage(detail.error, "browse")}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.entityActions}>
        <ExplainAction />
        {detail.kind === "success" ? (
          <Dialog modalType="modal">
            <DialogTrigger disableButtonEnhancement>
              {/* A report says how the entity is doing now: there is none to send for a moment that has passed. */}
              <Button size="small" disabledFocusable={past} title={past ? "A health report is about now. Go back to now to send one." : undefined} data-testid="report-open">
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
