import { useMemo } from "react";
import type { JSX } from "react";
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Tab,
  TabList,
  Text,
  Textarea,
  makeStyles,
  tokens,
  useId,
} from "@fluentui/react-components";
import { startFailure } from "../model/errors";
import {
  INSTRUCTION_MAX,
  NO_DESIGN_MODEL,
  TASK_TYPES,
  buildTaskInput,
  designModelOf,
  instructionProblem,
  isUnfinished,
  repositoryProblem,
  targetLabel,
} from "../model/tasks";
import type { TaskType } from "../model/types";
import { actions, useStore } from "../store/store";

const useStyles = makeStyles({
  // A grid never squeezes its rows, so a long form scrolls instead of overlapping.
  form: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridAutoRows: "max-content",
    alignContent: "start",
    rowGap: tokens.spacingVerticalM,
    overflowY: "auto",
    minHeight: 0,
    paddingBottom: tokens.spacingVerticalM,
  },
  description: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  actions: { display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
});

export function TaskForm(): JSX.Element {
  const styles = useStyles();
  const descriptionId = useId("task-type-description");
  const draft = useStore((state) => state.draft);
  const selected = useStore((state) => state.selected);
  const entity = useStore((state) => state.selectedName);
  const catalog = useStore((state) => state.catalog);
  const model = useStore((state) => state.model);
  const starting = useStore((state) => state.starting);
  const runningSeq = useStore((state) =>
    state.sessionDetail.kind === "success"
      ? (state.sessionDetail.value.tasks.find((task) => isUnfinished(task.status))?.seq ?? null)
      : null,
  );
  const running = runningSeq !== null;
  const catalogValue = catalog.kind === "success" ? catalog.value : null;

  const ready = useMemo(
    () => buildTaskInput(draft, { selected, entity, catalog: catalogValue }),
    [draft, selected, entity, catalogValue],
  );
  const entityLabel = useMemo(
    () =>
      entity !== null && model.kind === "success"
        ? (model.value.entities.find((item) => item.name === entity)?.displayName ?? entity)
        : entity,
    [entity, model],
  );
  const design = draft.type === "design" ? designModelOf(catalogValue) : null;
  const typeInfo = TASK_TYPES.find((item) => item.type === draft.type) ?? TASK_TYPES[0]!;
  const repositoryError = draft.type === "design" ? repositoryProblem(draft.repositoryUrl) : null;
  const instructionError = instructionProblem(draft.instruction);
  const starts = starting.kind === "loading";
  // Every other reason a Task cannot start is shown at the field it is about.
  const blocked = running ? "A Task is running in this Session. Start the next one when it finishes." : null;

  const failure = starting.kind === "failure" ? { ...startFailure(starting.error), code: starting.error.code } : null;

  const submit = (): void => {
    if (ready.input !== null && !running && !starts) void actions.startTask(ready.input);
  };

  const explainNeedsEntity = draft.type === "explain" && entity === null;
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
      aria-label="New Task"
      data-testid="task-form"
    >
      <Field label="Task type">
        <TabList
          selectedValue={draft.type}
          onTabSelect={(_, data) => actions.updateDraft({ type: data.value as TaskType })}
          appearance="subtle"
          aria-label="Task type"
          aria-describedby={descriptionId}
          data-testid="task-type"
        >
          {TASK_TYPES.map((item) => (
            <Tab key={item.type} value={item.type} data-testid={`task-type-${item.type}`}>
              {item.label}
            </Tab>
          ))}
        </TabList>
      </Field>
      <Text id={descriptionId} className={styles.description} data-testid="task-type-description">
        {typeInfo.description}
      </Text>

      {draft.type === "design" ? (
        <>
          <Field
            label="Target model"
            hint={design === null ? null : "The design model of this deployment. The live model is not touched."}
            validationState={catalogValue && design === null ? "error" : "none"}
            validationMessage={catalogValue && design === null ? NO_DESIGN_MODEL : null}
          >
            <Input
              readOnly
              value={catalogValue ? (design === null ? "No design model" : targetLabel(design)) : "Loading the health models"}
              data-testid="task-target"
            />
          </Field>
          <Field label="Workload resource group" hint="The resource group of this deployment.">
            <Input readOnly value={catalogValue?.default.resourceGroup ?? ""} data-testid="task-workload" />
          </Field>
          <Field
            label="Repository (optional)"
            validationState={repositoryError ? "error" : "none"}
            validationMessage={repositoryError}
            hint="A public GitHub repository the design can read."
          >
            <Input
              type="url"
              inputMode="url"
              placeholder="https://github.com/owner/repository"
              value={draft.repositoryUrl}
              onChange={(_, data) => actions.updateDraft({ repositoryUrl: data.value })}
              data-testid="task-repository"
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Target model"
            hint={selected ? "The model on screen." : null}
            validationState={selected ? "none" : "warning"}
            validationMessage={selected ? null : "Choose a health model first."}
          >
            <Input readOnly value={selected ? targetLabel(selected) : ""} data-testid="task-target" />
          </Field>
          {draft.type === "explain" ? (
            <Field
              label="Entity"
              validationState={explainNeedsEntity ? "warning" : "none"}
              validationMessage={explainNeedsEntity ? "Select an entity in the graph to explain it." : null}
              hint={explainNeedsEntity ? null : "The entity selected in the graph."}
            >
              <Input readOnly value={entityLabel ?? ""} data-testid="task-entity" />
            </Field>
          ) : null}
        </>
      )}

      <Field
        label="Task instruction (optional)"
        hint={`${draft.instruction.length} of ${INSTRUCTION_MAX} characters`}
        validationState={instructionError ? "error" : "none"}
        validationMessage={instructionError}
      >
        <Textarea
          rows={5}
          resize="vertical"
          maxLength={INSTRUCTION_MAX}
          value={draft.instruction}
          onChange={(_, data) => actions.updateDraft({ instruction: data.value })}
          data-testid="task-instruction-input"
        />
      </Field>

      {failure !== null ? (
        <MessageBar
          intent={failure.action === "retry" || failure.code === "task_running" ? "warning" : "error"}
          role="alert"
          data-testid="task-start-error"
          data-code={failure.code}
        >
          <MessageBarBody>
            <MessageBarTitle>{failure.title}</MessageBarTitle>
            {failure.message}
          </MessageBarBody>
          <MessageBarActions>
            {failure.action === "retry" ? (
              <Button size="small" onClick={submit} disabled={starts || ready.input === null} data-testid="task-start-retry">
                Try again
              </Button>
            ) : null}
            {failure.action === "new-session" ? (
              <Button size="small" onClick={() => void actions.openSession(null)} data-testid="task-start-new-session">
                Start a new Session
              </Button>
            ) : null}
            {failure.code === "task_running" && runningSeq !== null ? (
              <Button size="small" onClick={() => void actions.openTask(runningSeq)} data-testid="open-running-task">
                Open the running Task
              </Button>
            ) : null}
          </MessageBarActions>
        </MessageBar>
      ) : null}

      <div className={styles.actions}>
        <Button
          appearance="primary"
          type="submit"
          disabled={ready.input === null || running || starts}
          {...(starts ? { icon: <Spinner size="tiny" /> } : {})}
          data-testid="task-submit"
        >
          {starts ? "Starting" : `Start ${typeInfo.label}`}
        </Button>
        {blocked !== null ? (
          <Text className={styles.hint} data-testid="task-hint">
            {blocked}
          </Text>
        ) : null}
        {running && runningSeq !== null ? (
          <Button size="small" appearance="subtle" onClick={() => void actions.openTask(runningSeq)} data-testid="show-running-task">
            Show running Task
          </Button>
        ) : null}
      </div>
    </form>
  );
}
