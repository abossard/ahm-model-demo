import { useEffect } from "react";
import type { JSX } from "react";
import { Button, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import { Pause16Regular, Play16Regular } from "@fluentui/react-icons";
import { actions, useStore } from "../store/store";
import type { LiveStatus } from "../store/liveSlice";
import "./live.css";

const WORDS: Readonly<Record<LiveStatus, string>> = {
  off: "Not live",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  paused: "Paused",
  polling: "Refreshing every minute",
};

const useStyles = makeStyles({
  root: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS },
  dot: { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: tokens.colorNeutralForeground3, flexShrink: 0 },
  live: { backgroundColor: "var(--healthy-dot, #4c9a2a)" },
  waiting: { backgroundColor: "var(--degraded-dot, #c26a00)" },
  word: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, whiteSpace: "nowrap" },
  hidden: { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" },
});

/**
 * Keeps the open model live and shows how: the stream is opened while a model is on screen and closed when it changes.
 * Pause stops it, so the graph holds still to be read; resume takes a snapshot and goes on. Entities that change are
 * announced to a screen reader in a polite live region.
 */
export function LiveControl(): JSX.Element {
  const styles = useStyles();
  const selectedKey = useStore((state) => (state.selected ? `${state.selected.subscriptionId}/${state.selected.resourceGroup}/${state.selected.name}` : ""));
  const loaded = useStore((state) => state.model.kind === "success");
  const status = useStore((state) => state.liveStatus);
  const announcement = useStore((state) => state.liveAnnouncement);
  const error = useStore((state) => state.liveError);

  useEffect(() => {
    if (!loaded || selectedKey === "") return;
    actions.startLive();
    return () => actions.stopLive();
  }, [selectedKey, loaded]);

  const paused = status === "paused";
  const dot = status === "live" ? styles.live : status === "connecting" || status === "reconnecting" || status === "polling" ? styles.waiting : "";
  return (
    <div className={styles.root} data-testid="live-control" data-status={status}>
      <span className={`${styles.dot} ${dot}`} aria-hidden="true" />
      <span className={styles.word} data-testid="live-status" title={error?.message}>
        {WORDS[status]}
      </span>
      {status !== "off" ? (
        <Tooltip content={paused ? "Resume live updates" : "Pause live updates"} relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={paused ? <Play16Regular /> : <Pause16Regular />}
            onClick={() => (paused ? actions.resumeLive() : actions.pauseLive())}
            data-testid="live-toggle"
          />
        </Tooltip>
      ) : null}
      <span className={styles.hidden} role="status" aria-live="polite" data-testid="live-announcement">
        {announcement}
      </span>
    </div>
  );
}
