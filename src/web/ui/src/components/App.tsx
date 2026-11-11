import { useEffect } from "react";
import type { JSX } from "react";
import {
  FluentProvider,
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
import { applyTheme, persistTheme, type ThemeName } from "../model/theme";
import { actions, useStore } from "../store/store";
import { EntityPanel } from "./EntityPanel";
import { GraphView } from "./GraphView";
import { SessionWorkspace } from "./SessionWorkspace";
import { StatusBar } from "./StatusBar";

// Fluent writes every key of its theme as a custom property, so the health palette rides along.
const FLUENT_THEMES: Readonly<Record<ThemeName, Partial<Theme>>> = {
  light: { ...webLightTheme, ...healthVariables("light") },
  dark: { ...webDarkTheme, ...healthVariables("dark") },
};

const useStyles = makeStyles({
  shell: { display: "flex", flexDirection: "column", height: ["100vh", "100dvh"] },
  body: { flex: 1, display: "flex", minHeight: 0 },
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
  const selected = useStore((state) => state.selected);
  const panelOpen = useStore((state) => state.selectedName !== null);
  const theme = useStore((state) => state.theme);
  const themeExplicit = useStore((state) => state.themeExplicit);
  const sessionId = useStore((state) => state.sessionId);
  const taskSeq = useStore((state) => state.taskSeq);

  useEffect(() => {
    void actions.loadModelCatalog();
    void actions.restoreWorkspace(window.location.search);
  }, []);

  // The address names the model, Session and Task on screen, so a link opens all three.
  useEffect(() => {
    if (selected) {
      window.history.replaceState(null, "", searchFromLocation(selected, { session: sessionId, task: taskSeq }));
    }
  }, [selected, sessionId, taskSeq]);

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
              <GraphView model={model.value} />
            ) : (
              <TopologyPlaceholder loading={model.kind !== "failure"} />
            )}
          </main>
          {panelOpen && model.kind === "success" ? (
            <EntityPanel options={model.value.reportOptions} />
          ) : null}
        </div>
      </div>
    </FluentProvider>
  );
}
