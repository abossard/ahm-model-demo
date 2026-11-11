import { memo, useMemo } from "react";
import type { JSX } from "react";
import {
  Text,
  createCustomFocusIndicatorStyle,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { formatDuration, taskDuration } from "../model/duration";
import { isUnfinished, targetLabel, taskTitle } from "../model/tasks";
import type { TaskSummary } from "../model/types";
import { actions, useStore } from "../store/store";
import { StartButtons } from "./TaskLauncher";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { useEntityLabel } from "./useEntityLabel";
import { useNow } from "./useNow";
import { useWindowedRows } from "./useWindowedRows";

const ROW_HEIGHT = 68;

const useStyles = makeStyles({
  scroller: {
    position: "relative",
    flex: 1,
    minHeight: "160px",
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  spacer: { position: "relative", width: "100%" },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    height: `${ROW_HEIGHT}px`,
    boxSizing: "border-box",
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  button: {
    boxSizing: "border-box",
    width: "100%",
    border: "none",
    backgroundColor: "transparent",
    textAlign: "left",
    font: "inherit",
    paddingBlock: 0,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    rowGap: "2px",
    paddingInline: tokens.spacingHorizontalM,
    cursor: "pointer",
    color: tokens.colorNeutralForeground1,
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
    ...createCustomFocusIndicatorStyle({ outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: "-2px" }),
  },
  current: { backgroundColor: tokens.colorSubtleBackgroundSelected },
  line: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, minWidth: 0 },
  title: { fontWeight: tokens.fontWeightSemibold, whiteSpace: "nowrap", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  grow: { flex: 1 },
  meta: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  duration: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground2,
  },
});

const TaskRow = memo(function TaskRow({
  task,
  now,
  top,
  current,
  position,
  total,
}: {
  readonly task: TaskSummary;
  readonly now: number;
  readonly top: number;
  readonly current: boolean;
  readonly position: number;
  readonly total: number;
}): JSX.Element {
  const styles = useStyles();
  const elapsed = taskDuration(task, now);
  const entityLabel = useEntityLabel(task.target.entity);
  // The list has no result to read the state from, so an Explain is named by its entity alone.
  const title = taskTitle(task, entityLabel, null);
  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      className={styles.row}
      style={{ top }}
      data-testid={`task-row-${task.seq}`}
    >
      <button
        type="button"
        className={mergeClasses(styles.button, current && styles.current)}
        aria-current={current ? "true" : undefined}
        onClick={() => void actions.openTask(task.seq)}
        data-testid={`task-open-${task.seq}`}
      >
        <span className={styles.line}>
          <span className={styles.title} title={title}>
            {title}
          </span>
          <TaskStatusBadge status={task.status} />
          <span className={styles.grow} />
          {elapsed !== null ? <span className={styles.duration}>{formatDuration(elapsed)}</span> : null}
        </span>
        <span className={styles.meta} title={targetLabel(task.target)}>
          {targetLabel(task.target)}
        </span>
      </button>
    </div>
  );
});

export function TaskList({ tasks }: { readonly tasks: readonly TaskSummary[] }): JSX.Element {
  const styles = useStyles();
  const openSeq = useStore((state) => state.taskSeq);
  // The newest Task comes first, so the one that runs is never below the fold.
  const ordered = useMemo(() => [...tasks].sort((left, right) => right.seq - left.seq), [tasks]);
  const heights = useMemo(() => ordered.map(() => ROW_HEIGHT), [ordered]);
  const rows = useWindowedRows(heights);
  const now = useNow(ordered.some((task) => isUnfinished(task.status)));

  if (tasks.length === 0) {
    return (
      <div className={styles.empty} data-testid="task-list-empty">
        <Text>Nothing asked in this topic yet. Ask something and the answer opens here.</Text>
        <StartButtons />
        <Text size={200}>To ask about an entity, select it in the graph first.</Text>
      </div>
    );
  }

  return (
    <div
      ref={rows.containerRef}
      className={styles.scroller}
      onScroll={rows.onScroll}
      role="list"
      aria-label="Questions in this topic"
      data-testid="task-list"
    >
      <div className={styles.spacer} style={{ height: rows.total }}>
        {ordered.slice(rows.first, rows.last).map((task, index) => (
          <TaskRow
            key={task.seq}
            task={task}
            now={isUnfinished(task.status) ? now : 0}
            top={rows.top(rows.first + index)}
            current={task.seq === openSeq}
            position={rows.first + index + 1}
            total={ordered.length}
          />
        ))}
      </div>
    </div>
  );
}
