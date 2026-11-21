import type { JSX } from "react";
import {
  Badge, Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
  Spinner, Text, makeStyles, tokens,
} from "@fluentui/react-components";
import { streamFailure } from "../model/errors";
import { WORDS } from "../model/wording";
import { actions, useStore } from "../store/store";
import { ActivityList } from "./ActivityList";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalXS,
  },
});

export function ActivityTimeline({
  onReading,
}: {
  /** Told when the reader scrolls away from the newest step and when they come back. */
  readonly onReading?: (reading: boolean) => void;
}): JSX.Element {
  const styles = useStyles();
  const events = useStore((state) => state.events);
  const stream = useStore((state) => state.stream);
  const streamError = useStore((state) => state.streamError);
  const taskSeq = useStore((state) => state.taskSeq);
  const closed = stream === "error" ? streamFailure(streamError) : null;
  const heading = stream === "live" ? WORDS.stepsRunning : WORDS.stepsDone;
  return (
    <section className={styles.root} aria-label={heading} data-testid="timeline" data-stream={stream}>
      <div className={styles.head}>
        <Text weight="semibold" size={300}>
          {heading}
        </Text>
        {stream === "live" ? (
          <Badge appearance="tint" color="brand" icon={<Spinner size="extra-tiny" />} data-testid="timeline-live">
            Working
          </Badge>
        ) : null}
      </div>
      {closed !== null ? (
        <MessageBar intent="warning" role="alert" data-testid="timeline-error" data-code={streamError?.code}>
          <MessageBarBody>
            <MessageBarTitle>{closed.title}</MessageBarTitle>
            {closed.message}
          </MessageBarBody>
          {closed.action === "retry" ? (
            <MessageBarActions>
              <Button size="small" onClick={() => void actions.openTask(taskSeq)} data-testid="timeline-reconnect">
                Reconnect
              </Button>
            </MessageBarActions>
          ) : null}
        </MessageBar>
      ) : null}
      <ActivityList events={events} onReading={onReading}
        emptyMessage={stream === "error" ? "No update arrived before the live view stopped."
          : stream === "ended" ? "No steps were recorded." : "The assistant is getting started."}
      />
    </section>
  );
}
