import { useEffect, useMemo, useRef } from "react";
import type { JSX } from "react";
import {
  Button,
  Field,
  Input,
  Spinner,
  Tab,
  TabList,
  Text,
  Textarea,
  makeStyles,
  tokens,
  useId,
} from "@fluentui/react-components";
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
import { NOW_NOTE, momentWords } from "../model/wording";
import { actions, useStore } from "../store/store";
import { selectMomentMinute } from "../store/timelineSlice";
import { useAtMoment } from "../timeline/useAtMoment";

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
  const repositoryRef = useRef<HTMLInputElement>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const focusForm = useStore((state) => state.focusForm);
  const draft = useStore((state) => state.draft);
  const selected = useStore((state) => state.selected);
  const entity = useStore((state) => state.selectedName);
  const catalog = useStore((state) => state.catalog);
  const model = useStore((state) => state.model);
  const starts = useStore((state) => state.launch.kind === "starting");
  const sessionTitle = useStore((state) =>
    state.sessionId !== null && state.sessionDetail.kind === "success" ? state.sessionDetail.value.session.title : null,
  );
  const runningSeq = useStore((state) =>
    state.sessionDetail.kind === "success"
      ? (state.sessionDetail.value.tasks.find((task) => isUnfinished(task.status))?.seq ?? null)
      : null,
  );
  const running = runningSeq !== null;
  const catalogValue = catalog.kind === "success" ? catalog.value : null;
  // The past moment the page shows, to the minute: an Explain asks about it, which the form says.
  const moment = useAtMoment(selectMomentMinute);

  const ready = useMemo(
    () => buildTaskInput(draft, { selected, entity, catalog: catalogValue, moment }),
    [draft, selected, entity, catalogValue, moment],
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
  // Every other reason a Task cannot start is shown at the field it is about.
  const blocked = running ? "The assistant is still working on something. Ask the next question when it is done." : null;

  const submit = (): void => {
    if (ready.input !== null && !running && !starts) void actions.startTask(draft);
  };

  // A form opened on purpose puts the reader at the field they came for: what to design, or what to tell the agent.
  useEffect(() => {
    if (!focusForm) return;
    (draft.type === "design" ? repositoryRef.current : instructionRef.current)?.focus();
    actions.formFocused();
  }, [focusForm, draft.type]);

  const explainNeedsEntity = draft.type === "explain" && entity === null;
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
      aria-label="Ask the assistant"
      data-testid="task-form"
    >
      <Field label="What do you want to know?">
        <TabList
          selectedValue={draft.type}
          onTabSelect={(_, data) => actions.updateDraft({ type: data.value as TaskType })}
          appearance="subtle"
          aria-label="What do you want to know?"
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
      {moment !== null && draft.type !== "explain" ? (
        <Text className={styles.description} data-testid="task-about-now">
          {NOW_NOTE}
        </Text>
      ) : null}

      {draft.type === "design" ? (
        <>
          <Field
            label="Model for the design"
            hint={design === null ? null : "Designs are saved in this separate model, so your live model is not touched."}
            validationState={catalogValue && design === null ? "error" : "none"}
            validationMessage={catalogValue && design === null ? NO_DESIGN_MODEL : null}
          >
            <Input
              readOnly
              value={catalogValue ? (design === null ? "No separate design model" : targetLabel(design)) : "Loading the health models"}
              data-testid="task-target"
            />
          </Field>
          <Field label="Resource group of your workload" hint="The resource group of this deployment.">
            <Input readOnly value={catalogValue?.default?.resourceGroup ?? ""} data-testid="task-workload" />
          </Field>
          <Field
            label="GitHub repository (optional)"
            validationState={repositoryError ? "error" : "none"}
            validationMessage={repositoryError}
            hint="A public repository the assistant can read to learn about your workload."
          >
            <Input
              input={{ ref: repositoryRef }}
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
            label="Model"
            hint={selected ? "The health model you are looking at." : null}
            validationState={selected ? "none" : "warning"}
            validationMessage={selected ? null : "Choose a health model first."}
          >
            <Input readOnly value={selected ? targetLabel(selected) : ""} data-testid="task-target" />
          </Field>
          {draft.type === "explain" ? (
            <Field
              label="Entity"
              validationState={explainNeedsEntity ? "warning" : "none"}
              validationMessage={explainNeedsEntity ? "Select an entity in the graph first." : null}
              hint={explainNeedsEntity ? null : "The entity selected in the graph."}
            >
              <Input readOnly value={entityLabel ?? ""} data-testid="task-entity" />
            </Field>
          ) : null}
          {draft.type === "explain" && moment !== null ? (
            <Field label="Moment" hint="The past moment the page shows. The assistant explains the state the entity had then.">
              <Input readOnly value={momentWords(moment, null)} data-testid="task-moment" />
            </Field>
          ) : null}
        </>
      )}

      <Field
        label="Note for the assistant (optional)"
        hint={`${draft.instruction.length} of ${INSTRUCTION_MAX} characters`}
        validationState={instructionError ? "error" : "none"}
        validationMessage={instructionError}
      >
        <Textarea
          textarea={{ ref: instructionRef }}
          rows={5}
          resize="vertical"
          maxLength={INSTRUCTION_MAX}
          value={draft.instruction}
          onChange={(_, data) => actions.updateDraft({ instruction: data.value })}
          data-testid="task-instruction-input"
        />
      </Field>

      <div className={styles.actions}>
        <Button
          appearance="primary"
          type="submit"
          disabled={ready.input === null || running || starts}
          {...(starts ? { icon: <Spinner size="tiny" /> } : {})}
          data-testid="task-submit"
        >
          {starts ? "Asking" : typeInfo.submit}
        </Button>
        {blocked !== null ? (
          <Text className={styles.hint} data-testid="task-hint">
            {blocked}
          </Text>
        ) : (
          <Text className={styles.hint} data-testid="task-session-hint">
            {sessionTitle === null ? "Your question is kept in History." : `Kept with "${sessionTitle}" in History.`}
          </Text>
        )}
        {running && runningSeq !== null ? (
          <Button size="small" appearance="subtle" onClick={() => void actions.openTask(runningSeq)} data-testid="show-running-task">
            Show it
          </Button>
        ) : null}
      </div>
    </form>
  );
}
