import { useEffect } from "react";
import type { JSX } from "react";
import {
  FluentProvider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  makeStyles,
  tokens,
  webDarkTheme,
  webLightTheme,
  type Theme,
} from "@fluentui/react-components";
import { healthVariables } from "../model/palette";
import { searchFromLocation } from "../model/selection";
import { timelineParams } from "../model/timelineUrl";
import { applyTheme, persistTheme, type ThemeName } from "../model/theme";
import { actions, useStore } from "../store/store";
import { GraphView } from "./GraphView";
import { SessionWorkspace } from "./SessionWorkspace";
import { TimelinePanel } from "../timeline/TimelinePanel";
import { StatusBar } from "./StatusBar";

// Fluent writes every key of its theme as a custom property, so the health palette rides along.
const FLUENT_THEMES: Readonly<Record<ThemeName, Partial<Theme>>> = {
  light: { ...webLightTheme, ...healthVariables("light") },
  dark: { ...webDarkTheme, ...healthVariables("dark") },
};

const useStyles = makeStyles({
  shell: { display: "flex", flexDirection: "column", height: ["100vh", "100dvh"] },
  // The full screen timeline is positioned against the body: it covers everything below the top bar.
  body: { flex: 1, display: "flex", minHeight: 0, position: "relative" },
  main: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    "@media (max-width: 720px)": { overflowY: "auto" },
  },
  placeholder: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    rowGap: tokens.spacingVerticalXXL,
    padding: tokens.spacingHorizontalXL,
  },
  placeholderRow: { display: "flex", columnGap: tokens.spacingHorizontalXL },
  placeholderCard: { width: "220px", height: "72px", borderRadius: tokens.borderRadiusXLarge },
});

const PLACEHOLDER_ROWS: readonly number[] = [1, 3, 4];

/** The user is signed in and can read no health model in their directory: say what decides that, not that something broke. */
function NoModels(): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.placeholder} data-testid="no-models">
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>No health models in your directory</MessageBarTitle>
          The app lists the health models your Azure account can read in the directory you signed in to. Ask for a reader role on a
          subscription or resource group that holds one, or sign out and sign in to another directory.
        </MessageBarBody>
      </MessageBar>
    </div>
  );
}

function TopologyPlaceholder({ loading }: { readonly loading: boolean }): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.placeholder} data-testid="topology-placeholder">
      {loading ? (
        <Skeleton aria-label="Loading the health model" className={styles.placeholder}>
          {PLACEHOLDER_ROWS.map((cards) => (
            <div className={styles.placeholderRow} key={cards}>
              {Array.from({ length: cards }, (_, index) => (
                <SkeletonItem key={index} className={styles.placeholderCard} />
              ))}
            </div>
          ))}
        </Skeleton>
      ) : null}
    </div>
  );
}

export function App(): JSX.Element {
  const styles = useStyles();
  const model = useStore((state) => state.model);
  const catalog = useStore((state) => state.catalog);
  const selected = useStore((state) => state.selected);
  const theme = useStore((state) => state.theme);
  const themeExplicit = useStore((state) => state.themeExplicit);
  const sessionId = useStore((state) => state.sessionId);
  const taskSeq = useStore((state) => state.taskSeq);
  const view = useStore((state) => state.view);
  const timelineOpen = useStore((state) => state.timelineOpen);
  const timelineView = useStore((state) => state.timelineView);
  const timelineFollow = useStore((state) => state.timelineFollow);
  const timelineFullscreen = useStore((state) => state.timelineFullscreen);

  useEffect(() => {
    // A link's view wins over the one this viewer chose last.
    actions.initializeView(window.location.search);
    actions.initializeTimeline(window.location.search);
    void actions.loadModelCatalog();
    void actions.restoreWorkspace(window.location.search);
  }, []);

  // The address names the model, view, Session and Task on screen, so a link opens all four.
  useEffect(() => {
    if (selected) {
      window.history.replaceState(null, "", searchFromLocation(selected, { session: sessionId, task: taskSeq }, view, timelineParams(timelineOpen, timelineView, timelineFollow, timelineFullscreen)));
    }
  }, [selected, sessionId, taskSeq, view, timelineOpen, timelineView, timelineFollow, timelineFullscreen]);

  useEffect(() => {
    applyTheme(theme, document);
    if (themeExplicit) persistTheme(theme, window);
  }, [theme, themeExplicit]);

  return (
    // Layout styles belong on the inner shell: the provider copies its own classes onto every portal.
    <FluentProvider theme={FLUENT_THEMES[theme]} data-testid="app-shell">
      <div className={styles.shell}>
        <StatusBar />
        <div className={styles.body}>
          <SessionWorkspace />
          <main className={styles.main}>
            {model.kind === "success" ? (
              <>
                <GraphView model={model.value} />
                {timelineOpen ? <TimelinePanel /> : null}
              </>
            ) : catalog.kind === "success" && catalog.value.models.length === 0 ? (
              <NoModels />
            ) : (
              <TopologyPlaceholder loading={model.kind !== "failure"} />
            )}
          </main>
        </div>
      </div>
    </FluentProvider>
  );
}
