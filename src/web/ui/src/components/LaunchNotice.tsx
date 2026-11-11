import type { JSX } from "react";
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss16Regular } from "@fluentui/react-icons";
import { launchFailure } from "../model/errors";
import { actions, useStore } from "../store/store";
import { TechnicalLine } from "./TechnicalLine";

const useStyles = makeStyles({
  starting: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  note: { display: "block", marginTop: tokens.spacingVerticalXS },
});

/**
 * What the question the user is waiting to ask is doing, and why it stopped when it did: what was made, what was not,
 * and the one thing to do about it. It sits on top of the panel, whatever the panel shows.
 */
export function LaunchNotice(): JSX.Element | null {
  const styles = useStyles();
  const launch = useStore((state) => state.launch);
  const sessionId = useStore((state) => state.sessionId);
  const openSeq = useStore((state) => state.taskSeq);

  if (launch.kind === "idle") return null;
  if (launch.kind === "starting") {
    return (
      <div className={styles.starting} aria-busy="true" data-testid="launch-starting" data-step={launch.step}>
        <Spinner size="tiny" />
        <Text>Asking the assistant: {launch.label}</Text>
      </div>
    );
  }

  const shown = launchFailure(launch.error, launch.step, launch.made?.title ?? null);
  const running = launch.running;
  const isOpenHere = running !== null && running.sessionId === sessionId && running.seq === openSeq;
  // When the app has no room for a Session, or the Task that runs cannot be found, the list is where the user goes on.
  const listsSessions = (shown.action === "open-running" && running === null) || (launch.step === "session" && shown.action === null);
  return (
    <MessageBar
      intent={shown.action === null ? "error" : "warning"}
      role="alert"
      data-testid="task-start-error"
      data-code={launch.error.code}
    >
      <MessageBarBody>
        <MessageBarTitle>{shown.title}</MessageBarTitle>
        <span className={styles.note}>{shown.message}</span>
        {isOpenHere ? <span className={styles.note}>It is the question open here.</span> : null}
        {shown.note !== null ? <span className={styles.note}>{shown.note}</span> : null}
        <TechnicalLine text={shown.technical} />
      </MessageBarBody>
      <MessageBarActions
        containerAction={
          <Button
            appearance="transparent"
            size="small"
            icon={<Dismiss16Regular />}
            aria-label="Dismiss"
            onClick={() => actions.dismissLaunch()}
            data-testid="launch-dismiss"
          />
        }
      >
        {shown.action === "retry" ? (
          <Button size="small" onClick={() => void actions.retryStart()} data-testid="task-start-retry">
            Try again
          </Button>
        ) : null}
        {shown.action === "sign-in" ? (
          <Button size="small" onClick={() => void actions.signIn()} data-testid="task-start-sign-in">
            Sign in again
          </Button>
        ) : null}
        {shown.action === "open-running" && running !== null && !isOpenHere ? (
          <Button size="small" onClick={() => void actions.openRunningTask()} data-testid="open-running-task">
            Open it
          </Button>
        ) : null}
        {listsSessions ? (
          <Button
            size="small"
            onClick={() => {
              actions.dismissLaunch();
              void actions.openSession(null);
            }}
            data-testid="task-start-sessions"
          >
            Show History
          </Button>
        ) : null}
      </MessageBarActions>
    </MessageBar>
  );
}
