import { memo, useEffect, useId, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  SkeletonItem,
  Spinner,
  Text,
  createCustomFocusIndicatorStyle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Add20Regular, ChevronRight16Regular, History24Regular } from "@fluentui/react-icons";
import { formatWhen } from "../model/duration";
import { plural } from "../model/wording";
import { historyFailure, sessionFailure } from "../model/errors";
import { orderSessions } from "../model/sessions";
import type { SessionSummary } from "../model/types";
import { actions, useStore } from "../store/store";
import { StartButtons } from "./TaskLauncher";
import { TechnicalLine } from "./TechnicalLine";
import { useWindowedRows } from "./useWindowedRows";
import { WorkspaceHeader } from "./WorkspaceHeader";

const ROW_HEIGHT = 60;
const TITLE_MAX = 120;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  create: { display: "flex", alignItems: "flex-end", columnGap: tokens.spacingHorizontalS, flexShrink: 0 },
  fixed: { flexShrink: 0 },
  field: { flex: 1, minWidth: 0 },
  scroller: {
    position: "relative",
    flex: 1,
    minHeight: "160px",
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
    boxSizing: "border-box",
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  button: {
    boxSizing: "border-box",
    width: "100%",
    border: "none",
    backgroundColor: "transparent",
    textAlign: "left",
    font: "inherit",
    paddingBlock: 0,
    height: "100%",
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    paddingInline: tokens.spacingHorizontalM,
    cursor: "pointer",
    color: tokens.colorNeutralForeground1,
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
    ...createCustomFocusIndicatorStyle({ outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: "-2px" }),
  },
  text: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", rowGap: "2px" },
  chevron: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  emptyIcon: { color: tokens.colorBrandForeground1, marginBottom: tokens.spacingVerticalXS },
  emptyTitle: { margin: 0, color: tokens.colorNeutralForeground1 },
  emptyText: { margin: 0, maxWidth: "34ch", textAlign: "center" },
  start: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, flexShrink: 0 },
  introHeading: { margin: 0, fontSize: tokens.fontSizeBase400, lineHeight: tokens.lineHeightBase400, fontWeight: tokens.fontWeightSemibold },
  intro: { margin: 0, maxWidth: "52ch", color: tokens.colorNeutralForeground2 },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
});

const SessionRow = memo(function SessionRow({
  session,
  top,
  position,
  total,
}: {
  readonly session: SessionSummary;
  readonly top: number;
  readonly position: number;
  readonly total: number;
}): JSX.Element {
  const styles = useStyles();
  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      className={styles.row}
      style={{ top }}
      data-testid={`session-row-${session.id}`}
    >
      <button
        type="button"
        className={styles.button}
        onClick={() => void actions.openSession(session.id)}
        data-testid={`session-open-${session.id}`}
      >
        <span className={styles.text}>
          <span className={styles.title} title={session.title}>
            {session.title}
          </span>
          <span className={styles.meta}>
            {plural(session.taskCount, "question")}, last asked {formatWhen(session.lastTaskAt ?? session.createdAt)}
          </span>
        </span>
        <ChevronRight16Regular className={`hp-row-chevron ${styles.chevron}`} aria-hidden="true" />
      </button>
    </div>
  );
});

function Rows({ listed }: { readonly listed: readonly SessionSummary[] }): JSX.Element {
  const styles = useStyles();
  // The newest Session comes first, whatever order the app listed them in.
  const sessions = useMemo(() => orderSessions(listed), [listed]);
  const heights = useMemo(() => sessions.map(() => ROW_HEIGHT), [sessions]);
  const rows = useWindowedRows(heights);
  if (sessions.length === 0) {
    return (
      <div className={styles.empty} data-testid="session-list-empty">
        <History24Regular className={styles.emptyIcon} aria-hidden="true" />
        <Text as="p" weight="semibold" className={styles.emptyTitle}>
          Nothing asked yet
        </Text>
        <Text as="p" className={styles.emptyText}>
          Each question and its answer is kept here, grouped by topic, so you can come back to it.
        </Text>
      </div>
    );
  }
  return (
    <div
      ref={rows.containerRef}
      className={styles.scroller}
      onScroll={rows.onScroll}
      role="list"
      aria-label="History"
      data-testid="session-list"
    >
      <div className={styles.spacer} style={{ height: rows.total }}>
        {sessions.slice(rows.first, rows.last).map((session, index) => (
          <SessionRow
            key={session.id}
            session={session}
            top={rows.top(rows.first + index)}
            position={rows.first + index + 1}
            total={sessions.length}
          />
        ))}
      </div>
    </div>
  );
}

export function SessionList(): JSX.Element {
  const styles = useStyles();
  const sessions = useStore((state) => state.sessions);
  const creating = useStore((state) => state.creatingSession);
  const [title, setTitle] = useState("");
  const introId = useId();

  // Opening the list again shows what changed since: new Tasks, a new order.
  useEffect(() => {
    void actions.loadSessions();
  }, []);

  // The title stays in the field: a Session that was not created is asked for again with it.
  const create = (): void => {
    void actions.createSession(title.trim() === "" ? undefined : title.trim());
  };
  const failure = creating.kind === "failure" ? sessionFailure(creating.error) : null;
  const listFailure = sessions.kind === "failure" ? historyFailure(sessions.error) : null;

  return (
    <div className={styles.root} data-testid="session-list-view">
      <WorkspaceHeader title="History" titleTestId="session-list-heading" />
      <section className={styles.start} aria-labelledby={introId}>
        <Text as="h3" id={introId} className={styles.introHeading}>
          Ask the assistant
        </Text>
        <Text as="p" className={styles.intro}>
          It reads this model&apos;s signals and history and answers in plain words. A change it proposes reaches the model only when you apply it.
        </Text>
        <StartButtons />
        <Text className={styles.hint}>
          A question asked here starts a new topic in History. To ask about one entity, select it in the graph first.
        </Text>
      </section>
      <form
        className={styles.create}
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <Field label="Name of a new topic (optional)" className={styles.field}>
          <Input
            value={title}
            maxLength={TITLE_MAX}
            onChange={(_, data) => setTitle(data.value)}
            data-testid="session-title"
          />
        </Field>
        <Button
          type="submit"
          icon={creating.kind === "loading" ? <Spinner size="tiny" /> : <Add20Regular />}
          disabled={creating.kind === "loading"}
          data-testid="new-session"
        >
          New topic
        </Button>
      </form>
      {failure !== null ? (
        <MessageBar intent={failure.action === "retry" ? "warning" : "error"} role="alert" className={styles.fixed} data-testid="session-create-error">
          <MessageBarBody>
            <MessageBarTitle>{failure.title}</MessageBarTitle>
            {failure.message}
            <TechnicalLine text={failure.technical} />
          </MessageBarBody>
          {failure.action === "retry" ? (
            <MessageBarActions>
              <Button size="small" onClick={create} data-testid="session-create-retry">
                Try again
              </Button>
            </MessageBarActions>
          ) : null}
        </MessageBar>
      ) : null}
      {sessions.kind === "loading" || sessions.kind === "idle" ? (
        <div className={styles.fixed} aria-busy="true" aria-label="Loading History" data-testid="session-list-loading">
          <SkeletonItem size={40} />
        </div>
      ) : null}
      {sessions.kind === "failure" ? (
        <MessageBar intent="error" role="alert" className={styles.fixed} data-testid="session-list-error">
          <MessageBarBody>
            <MessageBarTitle>{listFailure?.title}</MessageBarTitle>
            {listFailure?.message}
            <TechnicalLine text={listFailure?.technical ?? null} />
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void actions.loadSessions()} data-testid="session-list-retry">
              Try again
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}
      {sessions.kind === "success" ? <Rows listed={sessions.value} /> : null}
    </div>
  );
}
