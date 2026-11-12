import { useEffect, useRef } from "react";
import type { CSSProperties, JSX, KeyboardEvent, PointerEvent } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { actions, useStore } from "../store/store";
import {
  WORKSPACE_DEFAULT_WIDTH,
  WORKSPACE_MAX_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from "../store/uiSlice";
import { LaunchNotice } from "./LaunchNotice";
import { NewTaskView } from "./NewTaskView";
import { SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { OVER_TIMELINE } from "../timeline/useInertElsewhere";
import { WorkspaceHeader } from "./WorkspaceHeader";

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

// Layout never sets `display` on the aside itself, so the `hidden` attribute still hides it.
const useStyles = makeStyles({
  root: {
    position: "relative",
    flex: "0 0 auto",
    width: "min(var(--workspace-width), 60vw)",
    minHeight: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    // On a phone the workspace is a sheet over the graph: beside it, neither would be readable.
    "@media (max-width: 720px)": {
      position: "fixed",
      inset: 0,
      zIndex: 110,
      width: "100%",
      maxWidth: "100%",
      borderRight: "none",
    },
  },
  // Over the full-screen timeline, which fills the body: the panel is a sheet on its left edge, above it.
  over: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 40,
    maxWidth: "100%",
    boxShadow: tokens.shadow28,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    boxSizing: "border-box",
    padding: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
  },
  handle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: "-4px",
    width: "8px",
    cursor: "col-resize",
    touchAction: "none",
    zIndex: 5,
    ":hover": { backgroundColor: tokens.colorNeutralStroke1Hover },
    ":focus-visible": { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: "-2px" },
    "@media (max-width: 720px)": { display: "none" },
  },
});

function ResizeHandle({ asideRef }: { readonly asideRef: { readonly current: HTMLElement | null } }): JSX.Element {
  const styles = useStyles();
  const width = useStore((state) => state.workspaceWidth);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const left = asideRef.current?.getBoundingClientRect().left ?? 0;
    actions.setWorkspaceWidth(event.clientX - left);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const next =
      event.key === "ArrowLeft"
        ? width - step
        : event.key === "ArrowRight"
          ? width + step
          : event.key === "Home"
            ? WORKSPACE_MIN_WIDTH
            : event.key === "End"
              ? WORKSPACE_MAX_WIDTH
              : null;
    if (next === null) return;
    event.preventDefault();
    actions.setWorkspaceWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant panel"
      aria-valuemin={WORKSPACE_MIN_WIDTH}
      aria-valuemax={WORKSPACE_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      className={styles.handle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
      onDoubleClick={() => actions.setWorkspaceWidth(WORKSPACE_DEFAULT_WIDTH)}
      data-testid="workspace-resize"
    />
  );
}

/** What the panel shows while a one-click start has no topic yet: it is being made, or could not be. */
function StartingView(): JSX.Element {
  const failed = useStore((state) => state.launch.kind === "failed");
  const label = useStore((state) => (state.launch.kind === "idle" ? "" : state.launch.label));
  return (
    <div data-testid="launch-view">
      <WorkspaceHeader
        title={label}
        titleTestId="launch-heading"
        {...(failed ? { back: { label: "History", testId: "session-back", onClick: () => actions.dismissLaunch() } } : {})}
      />
      <LaunchNotice />
    </div>
  );
}

export function SessionWorkspace(): JSX.Element {
  const styles = useStyles();
  const open = useStore((state) => state.workspaceOpen);
  const width = useStore((state) => state.workspaceWidth);
  const inSession = useStore((state) => state.sessionId !== null);
  const launching = useStore((state) => state.launch.kind !== "idle");
  const form = useStore((state) => state.workspaceTab === "new");
  const over = useStore((state) => state.timelineOpen && state.timelineFullscreen);
  const asideRef = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // Over the full-screen timeline the panel takes the focus when it opens and gives it back when it closes: the keyboard
  // and a screen reader meet it where it appears, and leave it where they were.
  useEffect(() => {
    const aside = asideRef.current;
    if (!over || !open || !aside) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !aside.contains(active)) {
      // A toast fades: the timeline is where to come back to, not the link that opened the panel.
      opener.current = active.closest(".fui-Toaster, .fui-Toast") === null ? active : null;
      aside.focus({ preventScroll: true });
    }
    return () => {
      const back = opener.current;
      opener.current = null;
      if (document.activeElement !== document.body && !aside.contains(document.activeElement)) return;
      // What opened it may be gone (a toast) or be the page itself: the timeline is where the user was.
      const target = back !== null && back !== document.body && back.isConnected ? back : document.querySelector<HTMLElement>('#timeline-panel [data-testid="tl-stage"]');
      target?.focus({ preventScroll: true });
    };
  }, [over, open]);

  return (
    <aside
      id="session-workspace"
      ref={asideRef}
      className={mergeClasses(styles.root, over && styles.over)}
      tabIndex={-1}
      {...(over ? { [OVER_TIMELINE]: "" } : {})}
      style={{ "--workspace-width": `${width}px` } as CSSProperties}
      aria-label="Assistant"
      hidden={!open}
      data-testid="session-workspace"
    >
      {open ? (
        <div className={styles.panel}>
          {inSession ? <SessionView /> : form ? <NewTaskView /> : launching ? <StartingView /> : <SessionList />}
        </div>
      ) : null}
      {open ? <ResizeHandle asideRef={asideRef} /> : null}
    </aside>
  );
}
