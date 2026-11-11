import type { JSX } from "react";
import { Button, Link, Spinner, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Lightbulb20Regular } from "@fluentui/react-icons";
import { sameModel } from "../model/selection";
import { isUnfinished } from "../model/tasks";
import { whyQuestion } from "../model/wording";
import { actions, useStore } from "../store/store";

const useStyles = makeStyles({
  root: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
});

/**
 * The action area of the selected entity: one click asks why the entity has its state. While that question starts or runs
 * the same button says so, and opens it. A note for the assistant stays possible, as the way into the form instead of the way through.
 */
export function ExplainAction(): JSX.Element {
  const styles = useStyles();
  const starting = useStore((state) => state.launch.kind === "starting" && state.launch.input.type === "explain");
  // The Explain of this entity that runs in the open Session, if any: clicking again would only be refused.
  const runningSeq = useStore((state) => {
    if (state.sessionDetail.kind !== "success" || state.selected === null) return null;
    const { selected, selectedName } = state;
    return (
      state.sessionDetail.value.tasks.find(
        (task) => isUnfinished(task.status) && task.type === "explain" && task.target.entity === selectedName && sameModel(task.target, selected),
      )?.seq ?? null
    );
  });
  const running = runningSeq !== null;
  // The question names the state the entity has now, because that is what the user is looking at.
  const question = useStore((state) => {
    const entity = state.model.kind === "success" ? state.model.value.entities.find((item) => item.name === state.selectedName) : undefined;
    return whyQuestion(entity?.healthState ?? null);
  });

  return (
    <div className={styles.root} data-testid="entity-actions">
      <Button
        icon={starting || running ? <Spinner size="tiny" /> : <Lightbulb20Regular />}
        disabledFocusable={starting}
        aria-busy={starting}
        onClick={() => {
          if (!running) return void actions.startTask({ type: "explain" });
          actions.setWorkspaceOpen(true);
          void actions.openTask(runningSeq);
        }}
        data-task-launcher=""
        data-testid="explain-entity"
      >
        {starting ? "Asking the assistant" : running ? "Show what the assistant is doing" : question}
      </Button>
      {starting || running ? null : (
        <Link as="button" onClick={() => actions.prefillTask("explain")} data-testid="explain-add-instruction">
          Add a note
        </Link>
      )}
      <Text className={styles.hint}>The assistant checks its signals and what it depends on.</Text>
    </div>
  );
}
