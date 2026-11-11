import type { JSX } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  SkeletonItem,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { unattachedVerification } from "../model/changes";
import type { DiffView, Finding, FindingSeverity, Task, VerificationRow } from "../model/types";
import { actions, useStore } from "../store/store";
import { ApplyResult, SelectionBar } from "./ApplyPanel";
import { ChangeList } from "./ChangeList";
import { OffScreenTarget } from "./OffScreenTarget";

const SEVERITIES: readonly FindingSeverity[] = ["high", "medium", "low"];
const SEVERITY_COLOR = { high: "danger", medium: "warning", low: "informative" } as const;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, minHeight: 0, flex: 1 },
  // The parts around the change list keep their height; only the list takes what is left.
  top: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridAutoRows: "max-content", rowGap: tokens.spacingVerticalS, flex: "0 0 auto" },
  scroll: { maxHeight: "30vh", overflowY: "auto" },
  finding: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalXXS,
    fontSize: tokens.fontSizeBase200,
  },
  findingText: { flex: 1, minWidth: 0 },
  list: { listStyle: "none", margin: 0, padding: 0 },
  caption: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  applies: { margin: 0, paddingLeft: tokens.spacingHorizontalL, fontSize: tokens.fontSizeBase200 },
  rows: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS },
  row: { display: "flex", flexDirection: "column", rowGap: "2px", fontSize: tokens.fontSizeBase200, overflowWrap: "anywhere" },
  rowHead: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, flexWrap: "wrap" },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2 },
});

const STATUS_LABEL: Readonly<Record<VerificationRow["status"], string>> = {
  verified: "verified",
  failing: "failing",
  not_run: "not run",
};
const STATUS_COLOR = { verified: "success", failing: "danger", not_run: "informative" } as const;

function Findings({ view }: { readonly view: DiffView }): JSX.Element | null {
  const styles = useStyles();
  if (view.findings.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Findings" data-testid="findings">
      {SEVERITIES.flatMap((severity) =>
        view.findings
          .map((finding, index) => [finding, index] as const)
          .filter(([finding]) => finding.severity === severity)
          .map(([finding, index]: readonly [Finding, number]) => (
            <li key={index} className={styles.finding} data-testid={`finding-${index}`} data-severity={severity}>
              <Badge appearance="tint" color={SEVERITY_COLOR[severity]}>
                {severity}
              </Badge>
              <span className={styles.findingText}>
                {finding.entity ? <strong>{finding.entity}: </strong> : null}
                {finding.text}
              </span>
              {finding.changeIds.length > 0 ? (
                <Button
                  size="small"
                  appearance="subtle"
                  onClick={() => actions.selectChanges(finding.changeIds)}
                  aria-label={`Select the ${finding.changeIds.length} ${finding.changeIds.length === 1 ? "change" : "changes"} of this finding`}
                  data-testid={`finding-select-${index}`}
                >
                  Select {finding.changeIds.length}
                </Button>
              ) : null}
            </li>
          )),
      )}
    </ul>
  );
}

function VerificationSummary({ view }: { readonly view: DiffView }): JSX.Element | null {
  const styles = useStyles();
  if (view.verification.length === 0) return null;
  const count = (status: string): number => view.verification.filter((row) => row.status === status).length;
  const failing = count("failing");
  return (
    <Text className={styles.caption} data-testid="verification-summary">
      Verification: {count("verified")} verified, {failing} failing, {count("not_run")} not run.
      {failing > 0 ? " A failing signal does not block Apply." : ""}
    </Text>
  );
}

/** The Verification rows that belong to no change, such as those of a Review that proposes nothing. */
function VerificationRows({ view }: { readonly view: DiffView }): JSX.Element | null {
  const styles = useStyles();
  const rows = unattachedVerification(view.changes, view.verification);
  if (rows.length === 0) return null;
  return (
    <Accordion collapsible data-testid="verification-rows">
      <AccordionItem value="rows">
        <AccordionHeader size="small">Verification details ({rows.length})</AccordionHeader>
        <AccordionPanel>
          <ul className={styles.rows}>
            {rows.map((row) => (
              <li key={`${row.entity}/${row.signal}`} className={styles.row} data-status={row.status}>
                <span className={styles.rowHead}>
                  <Text weight="semibold">
                    {row.entity} / {row.signal}
                  </Text>
                  <Badge appearance="tint" size="small" color={STATUS_COLOR[row.status]}>
                    {STATUS_LABEL[row.status]}
                  </Badge>
                </span>
                {row.error ? <span>Error: {row.error}</span> : null}
                {row.value !== null ? <span>Value: {String(row.value)}</span> : null}
                {row.query ? <span className={styles.mono}>Query: {row.query}</span> : null}
              </li>
            ))}
          </ul>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

function EarlierApplies({ view }: { readonly view: DiffView }): JSX.Element | null {
  const styles = useStyles();
  if (view.applies.length === 0) return null;
  const names = new Map(view.changes.map((change) => [change.id, change.name] as const));
  return (
    <Accordion collapsible data-testid="earlier-applies">
      <AccordionItem value="applies">
        <AccordionHeader size="small">Earlier Apply outcomes ({view.applies.length})</AccordionHeader>
        <AccordionPanel>
          <ul className={styles.applies}>
            {view.applies.map((outcome, index) => (
              <li key={`${outcome.at ?? index}`} data-testid={`earlier-apply-${index}`} data-outcome={outcome.outcome}>
                {outcome.outcome === "applied" ? "Applied" : "Partly applied"}
                {outcome.at ? ` at ${outcome.at}` : ""}: {outcome.written.map((id) => names.get(id) ?? id).join(", ") || "nothing written"}
                {outcome.failed ? `. Stopped: ${outcome.failed.message}` : ""}
              </li>
            ))}
          </ul>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

export function DiffResult({ task }: { readonly task: Task }): JSX.Element {
  const styles = useStyles();
  const diff = useStore((state) => state.diff);

  if (diff.kind === "idle" || diff.kind === "loading") {
    return (
      <div data-testid="diff-loading">
        <Spinner size="small" label="Loading the Health model diff" />
        <SkeletonItem size={72} />
      </div>
    );
  }
  if (diff.kind === "failure") {
    return (
      <MessageBar intent="error" role="alert" data-testid="diff-error">
        <MessageBarBody>{diff.error.message}</MessageBarBody>
        <MessageBarActions>
          <Button size="small" onClick={() => void actions.openTask(task.seq)}>
            Retry
          </Button>
        </MessageBarActions>
      </MessageBar>
    );
  }
  const view = diff.value;
  // Without changes there is nothing to pick, compare or Apply, and the summary and findings are all there is to read.
  const proposes = view.changes.length > 0;
  return (
    <div className={styles.root} data-testid="diff-result">
      <div className={styles.top}>
        <OffScreenTarget task={task} testId="diff" />
        <div
          className={proposes ? styles.scroll : undefined}
          {...(proposes ? { tabIndex: 0, role: "region", "aria-label": "Summary and findings" } : {})}
        >
          <Text as="p" data-testid="diff-summary">
            {view.summary}
          </Text>
          <Findings view={view} />
          <VerificationSummary view={view} />
        </div>
        <VerificationRows view={view} />
        {proposes ? <SelectionBar view={view} /> : null}
        {proposes ? <ApplyResult view={view} /> : null}
      </div>
      <ChangeList view={view} />
      <div className={styles.top}>
        <EarlierApplies view={view} />
      </div>
    </div>
  );
}
