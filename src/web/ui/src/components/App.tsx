import { useEffect, useState } from "react";
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
import { MomentBar } from "./MomentBar";
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
/** How long the selected moment has to rest before the address names it: a drag moves it every frame. */
const ADDRESS_REST_MS = 250;

/** The selected moment once it rests, which is when the address is written. */
function useRestingMoment(): number | null {
  const [resting, setResting] = useState(() => useStore.getState().timelinePinned);
  useEffect(() => {
    let timer = 0;
    setResting(useStore.getState().timelinePinned);
    const unsubscribe = useStore.subscribe((state, before) => {
      if (state.timelinePinned === before.timelinePinned) return;
      window.clearTimeout(timer);
      // Selecting a moment and returning to now are named at once: only a moment that moves waits until it rests.
      if (state.timelinePinned === null || before.timelinePinned === null) setResting(state.timelinePinned);
      else timer = window.setTimeout(() => setResting(state.timelinePinned), ADDRESS_REST_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  return resting;
}

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
  const timelineFollowPaused = useStore((state) => state.timelineFollowPaused);
  const timelineFullscreen = useStore((state) => state.timelineFullscreen);
  const moment = useRestingMoment();

  useEffect(() => {
    // A link's view wins over the one this viewer chose last.
    actions.initializeView(window.location.search);
    actions.initializeTimeline(window.location.search);
    void actions.loadModelCatalog();
    void actions.restoreWorkspace(window.location.search);
  }, []);

  // The address names the model, view, Session and Task on screen, and the moment the page shows, so a link opens all of it.
  useEffect(() => {
    if (selected) {
      const timeline = timelineParams(timelineOpen, timelineView, timelineFollow || (moment !== null && timelineFollowPaused), timelineFullscreen, moment);
      window.history.replaceState(null, "", searchFromLocation(selected, { session: sessionId, task: taskSeq }, view, timeline));
    }
  }, [selected, sessionId, taskSeq, view, timelineOpen, timelineView, timelineFollow, timelineFollowPaused, timelineFullscreen, moment]);

  useEffect(() => {
    applyTheme(theme, document);
    if (themeExplicit) persistTheme(theme, window);
  }, [theme, themeExplicit]);

  return (
    // Layout styles belong on the inner shell: the provider copies its own classes onto every portal.
    <FluentProvider theme={FLUENT_THEMES[theme]} data-testid="app-shell">
      <div className={styles.shell}>
        <StatusBar />
        <MomentBar />
        <div className={styles.body}>
          <SessionWorkspace />
          <main className={styles.main}>
            {model.kind === "success" ? (
              <>
                <GraphView />
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
