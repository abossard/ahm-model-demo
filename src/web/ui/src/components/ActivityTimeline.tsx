import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Badge,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowDown16Regular,
  CheckmarkCircle16Regular,
  DismissCircle16Filled,
  DocumentCheckmark16Regular,
  ErrorCircle16Regular,
  Flag16Regular,
  MoreHorizontal16Regular,
  TextDescription16Regular,
  Wrench16Regular,
} from "@fluentui/react-icons";
import { presentActivity, type ActivityIcon } from "../model/activity";
import { streamFailure } from "../model/errors";
import { formatOffset } from "../model/duration";
import { WORDS } from "../model/wording";
import type { ActivityEvent } from "../model/types";
import { actions, useStore } from "../store/store";
import { useWindowedRows } from "./useWindowedRows";

const ROW_HEIGHT = 36;
const PIN_SLACK = 12;

const ICONS: Readonly<Record<ActivityIcon, JSX.Element>> = {
  status: <Flag16Regular />,
  text: <TextDescription16Regular />,
  tool: <Wrench16Regular />,
  toolOk: <CheckmarkCircle16Regular />,
  toolFailed: <ErrorCircle16Regular />,
  result: <DocumentCheckmark16Regular />,
  error: <DismissCircle16Filled />,
};

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  scroller: {
    position: "relative",
    flex: 1,
    minHeight: "120px",
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  spacer: { position: "relative", width: "100%" },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    height: `${ROW_HEIGHT}px`,
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    paddingInline: tokens.spacingHorizontalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    color: tokens.colorNeutralForeground2,
  },
  success: { color: tokens.colorStatusSuccessForeground1 },
  danger: { color: tokens.colorStatusDangerForeground1 },
  // Two lines fit the fixed row, and what tells two similar tool calls apart sits at the end of a summary.
  title: {
    flex: 1,
    minWidth: 0,
    display: "-webkit-box",
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    overflowWrap: "anywhere",
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "16px",
  },
  offset: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  detail: {
    margin: 0,
    maxWidth: "min(520px, 80vw)",
    maxHeight: "280px",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  detailHeading: { margin: `0 0 ${tokens.spacingVerticalXS}` },
  empty: { padding: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3 },
  jump: { position: "absolute", right: tokens.spacingHorizontalM, bottom: tokens.spacingVerticalS, zIndex: 2 },
  frame: { position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
});

const EventRow = memo(function EventRow({
  event,
  offset,
  top,
  position,
  total,
}: {
  readonly event: ActivityEvent;
  readonly offset: number;
  readonly top: number;
  /** One-based place in the whole timeline, which a screen reader cannot get from the rows that are drawn. */
  readonly position: number;
  readonly total: number;
}): JSX.Element {
  const styles = useStyles();
  const shown = presentActivity(event);
  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      className={mergeClasses(
        styles.row,
        shown.tone === "success" && styles.success,
        shown.tone === "danger" && styles.danger,
      )}
      style={{ top }}
      data-testid={`timeline-event-${event.seq}`}
      data-kind={event.kind}
    >
      <span aria-hidden="true">{ICONS[shown.icon]}</span>
      <span className={styles.title} title={shown.title}>
        {shown.title}
      </span>
      <span className={styles.offset}>{formatOffset(offset)}</span>
      {shown.detail !== null ? (
        <Popover positioning="below-end">
          <PopoverTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreHorizontal16Regular />}
              aria-label={`Show ${shown.icon === "text" ? "more" : "technical"} details of ${shown.title}`}
              data-testid={`timeline-details-${event.seq}`}
            />
          </PopoverTrigger>
          <PopoverSurface data-testid={`timeline-popover-${event.seq}`}>
            <Text as="p" weight="semibold" size={200} className={styles.detailHeading}>
              {shown.icon === "text" ? "More detail" : "Technical details"}
            </Text>
            <pre className={styles.detail}>{shown.detail}</pre>
          </PopoverSurface>
        </Popover>
      ) : null}
    </div>
  );
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
  const heights = useMemo(() => events.map(() => ROW_HEIGHT), [events.length]);
  const rows = useWindowedRows(heights);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const started = events[0] ? Date.parse(events[0].ts) : 0;

  const scrollToEnd = (): void => {
    const element = rows.containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  // Stay on the newest step unless the user scrolled up to read an earlier one.
  useLayoutEffect(() => {
    if (pinned.current) scrollToEnd();
    else if (events.length > 0) setBehind(true);
  }, [events.length]);

  const onScroll = (): void => {
    rows.onScroll();
    const element = rows.containerRef.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK;
    if (pinned.current) setBehind(false);
    onReading?.(!pinned.current);
  };

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
      <div className={styles.frame}>
        <div
          ref={rows.containerRef}
          className={styles.scroller}
          onScroll={onScroll}
          role="list"
          aria-label="Steps"
          tabIndex={0}
          data-testid="timeline-scroller"
        >
          {events.length === 0 ? (
            <Text as="p" className={styles.empty} data-testid="timeline-empty">
              {stream === "error"
                ? "No update arrived before the live view stopped."
                  : stream === "ended"
                    ? "No steps were recorded."
                    : "The assistant is getting started."}
            </Text>
          ) : (
            <div className={styles.spacer} style={{ height: rows.total }}>
              {events.slice(rows.first, rows.last).map((event, index) => (
                <EventRow
                  key={event.seq}
                  event={event}
                  offset={Date.parse(event.ts) - started}
                  top={rows.top(rows.first + index)}
                  position={rows.first + index + 1}
                  total={events.length}
                />
              ))}
            </div>
          )}
        </div>
        {behind ? (
          <Button
            size="small"
            appearance="primary"
            icon={<ArrowDown16Regular />}
            className={styles.jump}
            onClick={() => {
              pinned.current = true;
              setBehind(false);
              scrollToEnd();
              onReading?.(false);
            }}
            data-testid="timeline-jump"
          >
            Latest step
          </Button>
        ) : null}
      </div>
    </section>
  );
}
