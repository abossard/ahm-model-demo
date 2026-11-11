import { memo } from "react";
import type { JSX } from "react";
import { Badge, Spinner } from "@fluentui/react-components";
import {
  CheckmarkCircle16Filled,
  DismissCircle16Filled,
  Clock16Regular,
} from "@fluentui/react-icons";
import type { TaskStatus } from "../model/types";

const LABELS: Readonly<Record<TaskStatus, string>> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

export const TaskStatusBadge = memo(function TaskStatusBadge({
  status,
}: {
  readonly status: TaskStatus;
}): JSX.Element {
  const color = status === "done" ? "success" : status === "failed" ? "danger" : status === "running" ? "brand" : "informative";
  const icon =
    status === "done" ? <CheckmarkCircle16Filled /> : status === "failed" ? <DismissCircle16Filled /> : status === "running" ? <Spinner size="extra-tiny" /> : <Clock16Regular />;
  return (
    <Badge appearance="tint" color={color} icon={icon} data-testid="task-status" data-status={status}>
      {LABELS[status]}
    </Badge>
  );
});
