import { useEffect } from "react";
import type { JSX } from "react";
import {
  Badge,
  Button,
  Field,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Select,
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
import { hasRunningTask } from "../model/tasks";
import { actions, useStore } from "../store/store";
import { HealthBadge } from "./HealthBadge";
import { ModelPicker } from "./ModelPicker";
import { UserMenu } from "./UserMenu";
import { useInlineField } from "./inlineField";

const AUTO_REFRESH_CHOICES: readonly { readonly ms: number; readonly label: string }[] = [
  { ms: 0, label: "Off" },
  { ms: 60_000, label: "Every 1 min" },
  { ms: 300_000, label: "Every 5 min" },
];

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
  const inlineField = useInlineField();
  const autoRefreshMs = useStore((state) => state.autoRefreshMs);
  const countdown = useStore((state) => state.refreshCountdown);

  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    const timer = setInterval(() => void actions.loadHealthModel(), autoRefreshMs);
    return () => clearInterval(timer);
  }, [autoRefreshMs]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(actions.tickRefreshCountdown, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  return (
    <div className={styles.refresh}>
      {countdown > 0 ? (
        <Badge appearance="tint" color="brand" shape="circular" data-testid="refresh-countdown">
          {countdown}
        </Badge>
      ) : null}
      <Button
        size="small"
        icon={<ArrowSync20Regular />}
        data-testid="refresh-now"
        onClick={() => void actions.loadHealthModel()}
      >
        Refresh
      </Button>
      <Field label="Auto-refresh" orientation="horizontal" size="small" className={inlineField.root}>
        <Select
          size="small"
          data-testid="auto-refresh"
          value={autoRefreshMs}
          onChange={(_, data) => actions.setAutoRefresh(Number(data.value))}
        >
          {AUTO_REFRESH_CHOICES.map((choice) => (
            <option key={choice.ms} value={choice.ms}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function WorkspaceToggle(): JSX.Element {
  const open = useStore((state) => state.workspaceOpen);
  const running = useStore(
    (state) => state.sessionDetail.kind === "success" && hasRunningTask(state.sessionDetail.value.tasks),
  );
  return (
    <Button
      size="small"
      appearance={open ? "primary" : "secondary"}
      icon={open ? <PanelLeftContract20Regular /> : <PanelLeftExpand20Regular />}
      aria-expanded={open}
      aria-controls="session-workspace"
      aria-label={running ? "Sessions, a Task is running" : "Sessions"}
      onClick={() => actions.toggleWorkspace()}
      data-testid="workspace-toggle"
    >
      Sessions
      {running ? (
        <Badge size="extra-small" color="brand" appearance="filled" aria-hidden="true" data-testid="workspace-running" />
      ) : null}
    </Button>
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
                <Text size={200} data-testid="model-observed">
                  Observed {model.value.observedAt}
                </Text>
              ) : null}
              <RefreshIndicator />
            </div>
          </div>
        </div>
        <div className={styles.controls}>
          <ModelPicker />
          <RefreshControls />
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
                ? `Last successful observation ${lastObservedAt}`
                : "No successful observation yet"}
            </span>
          </MessageBarBody>
          <MessageBarActions>
            {modelError.code === "unauthenticated" ? (
              <Button size="small" data-testid="status-sign-in" onClick={() => void actions.signIn()}>
                Sign in again
              </Button>
            ) : (
              <Button size="small" data-testid="status-retry" onClick={() => void actions.loadHealthModel()}>
                Retry
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
                Retry catalog
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      ) : null}
    </>
  );
}
