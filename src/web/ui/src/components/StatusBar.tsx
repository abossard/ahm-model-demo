import { useEffect } from "react";
import type { JSX } from "react";
import {
  Badge,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowSync20Regular,
  HeartPulse24Regular,
  PanelLeftContract20Regular,
  PanelLeftExpand20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
} from "@fluentui/react-icons";
import { accessMessage } from "../model/errors";
import { formatUpdated } from "../model/wording";
import { hasRunningTask } from "../model/tasks";
import { actions, useStore } from "../store/store";
import { HealthBadge } from "./HealthBadge";
import { ModelPicker } from "./ModelPicker";
import { LiveControl } from "../live/LiveControl";
import { TimelineToggle } from "../timeline/TimelineToggle";
import { TaskMenu, TaskNotifier } from "./TaskLauncher";
import { UserMenu } from "./UserMenu";

const useStyles = makeStyles({
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  status: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    color: tokens.colorBrandForeground1,
  },
  title: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS },
  name: { color: tokens.colorNeutralForeground1 },
  caption: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    minHeight: tokens.lineHeightBase200,
    color: tokens.colorNeutralForeground2,
  },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    minWidth: 0,
    color: tokens.colorNeutralForeground2,
  },
  refresh: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS },
});

function RefreshIndicator(): JSX.Element | null {
  const refreshing = useStore((state) => state.refreshing);
  return refreshing ? (
    <Spinner
      size="tiny"
      label="Refreshing…"
      labelPosition="after"
      role="status"
      data-testid="refresh-indicator"
    />
  ) : null;
}

function RefreshControls(): JSX.Element {
  const styles = useStyles();
  const countdown = useStore((state) => state.refreshCountdown);

  // After a health report is accepted the model is read again once its countdown ends.
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(actions.tickRefreshCountdown, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  return (
    <div className={styles.refresh}>
      <LiveControl />
      {countdown > 0 ? (
        <Badge appearance="tint" color="brand" shape="circular" data-testid="refresh-countdown">
          {countdown}
        </Badge>
      ) : null}
      <Button
        size="small"
        icon={<ArrowSync20Regular />}
        data-testid="refresh-now"
        onClick={() => {
          void actions.loadHealthModel({ fresh: true });
          void actions.refreshTimeline();
        }}
      >
        Refresh
      </Button>
    </div>
  );
}

function WorkspaceToggle(): JSX.Element {
  const open = useStore((state) => state.workspaceOpen);
  // A Task of the open Session runs, or one the user turned away from and that is followed in the background.
  const running = useStore(
    (state) =>
      state.watching !== null || (state.sessionDetail.kind === "success" && hasRunningTask(state.sessionDetail.value.tasks)),
  );
  // A Task ended while the user looked elsewhere: its toast fades, this mark stays until the result is opened.
  const finished = useStore((state) => state.notice !== null);
  return (
    <>
      <Button
        size="small"
        appearance={open ? "primary" : "secondary"}
        icon={open ? <PanelLeftContract20Regular /> : <PanelLeftExpand20Regular />}
        aria-expanded={open}
        aria-controls="session-workspace"
        aria-label={finished ? "History, an answer is ready" : running ? "History, the assistant is working" : "History"}
        onClick={() => actions.toggleWorkspace()}
        data-testid="workspace-toggle"
      >
        History
        {finished ? (
          <Badge size="extra-small" color="success" appearance="filled" aria-hidden="true" data-testid="workspace-finished" />
        ) : running ? (
          <Badge size="extra-small" color="brand" appearance="filled" aria-hidden="true" data-testid="workspace-running" />
        ) : null}
      </Button>
      <TaskMenu />
      <TaskNotifier />
    </>
  );
}

function ThemeControl(): JSX.Element {
  const theme = useStore((state) => state.theme);
  const next = theme === "dark" ? "light" : "dark";
  const label = theme === "dark" ? "Light theme" : "Dark theme";

  return (
    <Tooltip content={label} relationship="label">
      <Button
        size="small"
        appearance="subtle"
        data-testid="theme-toggle"
        icon={theme === "dark" ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />}
        onClick={() => actions.setTheme(next)}
      />
    </Tooltip>
  );
}

export function StatusBar(): JSX.Element {
  const styles = useStyles();
  const model = useStore((state) => state.model);
  const catalog = useStore((state) => state.catalog);
  const lastObservedAt = useStore((state) => state.lastObservedAt);
  const refreshError = useStore((state) => state.refreshError);
  const modelError = model.kind === "failure" ? model.error : refreshError;

  return (
    <>
      <header className={styles.bar} data-testid="status-bar">
        <div className={styles.status}>
          <WorkspaceToggle />
          <HeartPulse24Regular aria-hidden="true" />
          <div>
            <div className={styles.title}>
              <Text as="strong" size={500} weight="bold" className={styles.name} data-testid="model-name">
                {model.kind === "success" ? model.value.model.name : "Health Pulse"}
              </Text>
              {model.kind === "success" ? <HealthBadge state={model.value.model.healthState} /> : null}
            </div>
            <div className={styles.caption}>
              {model.kind === "loading" ? (
                <Spinner size="tiny" label="Loading…" labelPosition="after" />
              ) : null}
              {model.kind === "success" ? (
                <Text size={200} title={lastObservedAt ?? model.value.observedAt} data-testid="model-observed">
                  Updated {formatUpdated(lastObservedAt ?? model.value.observedAt)}
                </Text>
              ) : null}
              <RefreshIndicator />
            </div>
          </div>
        </div>
        <div className={styles.controls}>
          <ModelPicker />
          <RefreshControls />
          <TimelineToggle />
          <ThemeControl />
          <UserMenu />
        </div>
      </header>
      {modelError !== null ? (
        <MessageBar intent="error" role="alert" data-testid="status-error">
          <MessageBarBody>
            <MessageBarTitle>{model.kind === "success" ? "Health model not refreshed" : "Health model unavailable"}</MessageBarTitle>
            <span data-testid="status-error-message">{accessMessage(modelError, "browse")}</span>{" "}
            <span data-testid="status-last-observed">
              {lastObservedAt
                ? `Last updated ${formatUpdated(lastObservedAt)}`
                : "Not updated yet"}
            </span>
          </MessageBarBody>
          <MessageBarActions>
            {modelError.code === "unauthenticated" ? (
              <Button size="small" data-testid="status-sign-in" onClick={() => void actions.signIn()}>
                Sign in again
              </Button>
            ) : (
              <Button size="small" data-testid="status-retry" onClick={() => void actions.loadHealthModel()}>
                Try again
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      ) : null}
      {catalog.kind === "failure" ? (
        <MessageBar intent="error" role="alert" data-testid="catalog-error">
          <MessageBarBody>
            <MessageBarTitle>Health models unavailable</MessageBarTitle>
            {accessMessage(catalog.error, "browse")}
          </MessageBarBody>
          <MessageBarActions>
            {catalog.error.code === "unauthenticated" ? (
              <Button size="small" data-testid="catalog-sign-in" onClick={() => void actions.signIn()}>
                Sign in again
              </Button>
            ) : (
              <Button size="small" data-testid="catalog-retry" onClick={() => void actions.loadModelCatalog()}>
                Try again
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      ) : null}
    </>
  );
}
