import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { makeStyles } from "@fluentui/react-components";
import { presentActivity } from "../model/activity";
import { useStore } from "../store/store";

const KEPT = 10;

const useStyles = makeStyles({
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
});

/**
 * What a screen reader hears of a running Task: its status changes, the result and the end of the Task.
 * It stays mounted when the result replaces the timeline on screen, so the end is still announced.
 */
export function TimelineAnnouncer(): JSX.Element {
  const styles = useStyles();
  const events = useStore((state) => state.events);
  const status = useStore((state) => (state.task.kind === "success" ? state.task.value.status : null));
  const announced = useRef(0);
  const previous = useRef(status);
  const [lines, setLines] = useState<readonly string[]>([]);

  const say = (line: string): void => setLines((current) => [...current, line].slice(-KEPT));

  useEffect(() => {
    const fresh = events.filter((event) => event.seq > announced.current);
    if (fresh.length === 0) return;
    announced.current = fresh[fresh.length - 1]!.seq;
    // A Task that finished before it was opened replays its steps, and nobody waits for those.
    if (status !== "running" && status !== "queued") return;
    // A burst is announced by its last status or result; tool calls are never read out.
    const last = fresh
      .map((event) => presentActivity(event).announcement)
      .filter((text): text is string => text !== null)
      .at(-1);
    if (last !== undefined) say(last);
  }, [events, status]);

  useEffect(() => {
    if ((previous.current === "running" || previous.current === "queued") && status === "done") {
      say("The Task finished. Its result is ready.");
    }
    previous.current = status;
  }, [status]);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Activity timeline announcements"
      className={styles.visuallyHidden}
      data-testid="timeline-log"
    >
      {lines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
    </div>
  );
}
