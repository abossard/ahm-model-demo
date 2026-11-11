import type { JSX } from "react";
import { Button, MessageBar, MessageBarActions, MessageBarBody } from "@fluentui/react-components";
import { sameModel } from "../model/selection";
import { taskLabel } from "../model/tasks";
import type { Task } from "../model/types";
import { actions, useStore } from "../store/store";

/** Says so when the open Task ran on a model other than the one on screen, and offers to open it. */
export function OffScreenTarget({ task, testId }: { readonly task: Task; readonly testId: string }): JSX.Element | null {
  const selected = useStore((state) => state.selected);
  const catalog = useStore((state) => state.catalog);
  if (selected !== null && sameModel(task.target, selected)) return null;
  const target = catalog.kind === "success" ? catalog.value.models.find((item) => sameModel(item, task.target)) : undefined;
  return (
    <MessageBar intent="info" data-testid={`${testId}-off-screen`}>
      <MessageBarBody>
        This {taskLabel(task.type)} task ran on {task.target.name}, which is not the model on screen.
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" disabled={target === undefined} onClick={() => target && actions.chooseModel(target)} data-testid={`${testId}-open-target`}>
          Open target model
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}
