import { useRef } from "react";
import type { CSSProperties, JSX, KeyboardEvent, PointerEvent } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { actions, useStore } from "../store/store";
import {
  WORKSPACE_DEFAULT_WIDTH,
  WORKSPACE_MAX_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from "../store/uiSlice";
import { SessionList } from "./SessionList";
import { SessionView } from "./SessionView";

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
      aria-label="Resize the Session workspace"
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

export function SessionWorkspace(): JSX.Element {
  const styles = useStyles();
  const open = useStore((state) => state.workspaceOpen);
  const width = useStore((state) => state.workspaceWidth);
  const inSession = useStore((state) => state.sessionId !== null);
  const asideRef = useRef<HTMLElement | null>(null);

  return (
    <aside
      id="session-workspace"
      ref={asideRef}
      className={styles.root}
      style={{ "--workspace-width": `${width}px` } as CSSProperties}
      aria-label="Session workspace"
      hidden={!open}
      data-testid="session-workspace"
    >
      {open ? (
        <div className={styles.panel}>
          {inSession ? <SessionView /> : <SessionList />}
        </div>
      ) : null}
      {open ? <ResizeHandle asideRef={asideRef} /> : null}
    </aside>
  );
}
