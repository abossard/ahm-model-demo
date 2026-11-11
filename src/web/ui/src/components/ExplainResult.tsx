import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { chainEntities } from "../model/explain";
import { sameModel } from "../model/selection";
import { formatSignalValue } from "../model/signalValue";
import type { ExplainResult as ExplainResultData, Task } from "../model/types";
import { actions, useStore } from "../store/store";
import { HealthBadge } from "./HealthBadge";
import { OffScreenTarget } from "./OffScreenTarget";

// On a phone the workspace is a sheet over the graph, so showing an entity means putting the sheet away.
const PHONE_QUERY = "(max-width: 720px)";

function showOnGraph(entity: string): void {
  actions.focusEntities({ highlight: entity, names: [entity] });
  if (typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches) {
    actions.setWorkspaceOpen(false);
  }
}

const useStyles = makeStyles({
  // A grid never squeezes its rows; the pane that holds the result scrolls.
  root: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridAutoRows: "max-content", alignContent: "start", rowGap: tokens.spacingVerticalM },
  headline: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, flexWrap: "wrap" },
  steps: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" },
  step: { display: "flex", columnGap: tokens.spacingHorizontalS, position: "relative", paddingBottom: tokens.spacingVerticalM },
  rail: { display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 24px" },
  marker: {
    width: "24px",
    height: "24px",
    borderRadius: tokens.borderRadiusCircular,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
  },
  line: { flex: 1, width: "2px", backgroundColor: tokens.colorNeutralStroke2, marginTop: "2px" },
  content: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", rowGap: "2px" },
  entity: { justifyContent: "flex-start", minWidth: 0, paddingInline: 0, fontWeight: tokens.fontWeightSemibold },
  facts: { display: "flex", flexWrap: "wrap", columnGap: tokens.spacingHorizontalM, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  // A rollup or threshold can be a whole sentence, so a fact wraps rather than leaving the pane.
  fact: { overflowWrap: "anywhere" },
  note: { fontSize: tokens.fontSizeBase200 },
});

function Fact({ label, value }: { readonly label: string; readonly value: string | number | null }): JSX.Element | null {
  const styles = useStyles();
  return value === null ? null : (
    <span className={styles.fact} title={typeof value === "number" ? String(value) : undefined}>
      {label}: {formatSignalValue(value)}
    </span>
  );
}

export function ExplainResult({
  task,
  result,
}: {
  readonly task: Task;
  readonly result: ExplainResultData;
}): JSX.Element {
  const styles = useStyles();
  const model = useStore((state) => state.model);
  const selected = useStore((state) => state.selected);
  const onScreen = selected !== null && sameModel(task.target, selected);
  const names = useMemo(() => chainEntities(result), [result]);
  const display = useMemo(
    () => new Map(model.kind === "success" ? model.value.entities.map((entity) => [entity.name, entity.displayName] as const) : []),
    [model],
  );

  // While this result is open, the whole chain is marked on the graph.
  useEffect(() => {
    if (!onScreen) return;
    actions.setChain(names);
    return () => actions.setChain([]);
  }, [onScreen, names]);

  return (
    <div className={styles.root} data-testid="explain-result">
      <div className={styles.headline}>
        <Text weight="semibold">{display.get(result.entity) ?? result.entity}</Text>
        <span data-testid="explain-state">
          <HealthBadge state={result.state} />
        </span>
      </div>
      <Text as="p" data-testid="explain-summary">
        {result.summary}
      </Text>
      <OffScreenTarget task={task} testId="explain" />
      {result.causes.length === 0 ? (
        <Text as="p" data-testid="explain-no-causes">
          This Explain task found no cause to trace.
        </Text>
      ) : null}
      <ol className={styles.steps} aria-label="Cause chain" data-testid="explain-chain">
        {result.causes.map((cause, index) => (
          <li key={`${index}-${cause.entity}-${cause.signal ?? ""}`} className={styles.step} data-testid={`explain-step-${index}`}>
            <div className={styles.rail}>
              <span className={styles.marker} aria-hidden="true">
                {index + 1}
              </span>
              {index < result.causes.length - 1 ? <span className={styles.line} /> : null}
            </div>
            <div className={styles.content}>
              <Button
                appearance="transparent"
                className={styles.entity}
                disabled={!onScreen}
                onClick={() => showOnGraph(cause.entity)}
                aria-label={`Show ${display.get(cause.entity) ?? cause.entity} on the graph`}
                data-testid={`explain-step-focus-${index}`}
              >
                {display.get(cause.entity) ?? cause.entity}
              </Button>
              <div className={styles.facts}>
                <HealthBadge state={cause.state} />
                <Fact label="Signal" value={cause.signal} />
                <Fact label="Threshold" value={cause.threshold} />
                <Fact label="Value" value={cause.value} />
                <Fact label="Rollup" value={cause.rollup} />
              </div>
              <Text className={styles.note}>{cause.note}</Text>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
