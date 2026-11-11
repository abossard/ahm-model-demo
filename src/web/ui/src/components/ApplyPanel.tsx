import { useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { previewSelection } from "../model/changes";
import { forbiddenFor } from "../model/errors";
import type { ApplyOutcome, DiffView } from "../model/types";
import { actions, useStore } from "../store/store";

const useStyles = makeStyles({
  bar: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXS },
  row: { display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS },
  grow: { flex: 1 },
  caption: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  names: { margin: 0, paddingLeft: tokens.spacingHorizontalL, maxHeight: "200px", overflow: "auto" },
  needed: { color: tokens.colorNeutralForeground3 },
});

function nameLookup(view: DiffView): (id: string) => string {
  const names = new Map(view.changes.map((change) => [change.id, change.name] as const));
  return (id) => names.get(id) ?? id;
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

function ApplyDialog({
  view,
  open,
  onClose,
  written,
  added,
}: {
  readonly view: DiffView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly written: readonly string[];
  readonly added: readonly string[];
}): JSX.Element {
  const styles = useStyles();
  const nameOf = nameLookup(view);
  const needed = new Set(added);
  return (
    <Dialog open={open} onOpenChange={(_, data) => (data.open ? undefined : onClose())}>
      <DialogSurface data-testid="apply-dialog">
        <DialogBody>
          <DialogTitle>Apply to {view.target.name}?</DialogTitle>
          <DialogContent>
            <Text as="p">
              Apply writes {plural(written.length)} to the live health model{" "}
              <strong data-testid="apply-dialog-target">
                {view.target.name} ({view.target.resourceGroup})
              </strong>
              . It cannot be undone from the app.
            </Text>
            <ul className={styles.names} aria-label="Changes Apply writes">
              {written.map((id) => (
                <li key={id}>
                  {nameOf(id)}
                  {needed.has(id) ? <span className={styles.needed}> (needed by a selected change)</span> : null}
                </li>
              ))}
            </ul>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} data-testid="apply-cancel">
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => {
                onClose();
                void actions.applySelected();
              }}
              data-testid="apply-confirm"
            >
              Apply {plural(written.length)}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function SelectionBar({ view }: { readonly view: DiffView }): JSX.Element {
  const styles = useStyles();
  const selected = useStore((state) => state.selectedChanges);
  const compare = useStore((state) => state.compare);
  const applying = useStore((state) => state.apply.kind === "loading");
  const [confirming, setConfirming] = useState(false);
  const preview = useMemo(() => previewSelection(view.changes, selected), [view, selected]);
  const nameOf = nameLookup(view);
  const blocked = !view.appliable
    ? "This Health model diff cannot be applied."
    : selected.length === 0
      ? "Select the changes to apply."
      : null;

  return (
    <div className={styles.bar} data-testid="selection-bar">
      <div className={styles.row}>
        <Text weight="semibold" data-testid="selection-count" role="status">
          {selected.length} of {view.changes.length} selected
        </Text>
        <Button size="small" appearance="subtle" onClick={() => actions.selectAllChanges()} data-testid="select-all">
          Select all
        </Button>
        <Button size="small" appearance="subtle" disabled={selected.length === 0} onClick={() => actions.clearChanges()} data-testid="clear-selection">
          Clear
        </Button>
        <span className={styles.grow} />
        <Switch
          label="Compare"
          checked={compare}
          onChange={(_, data) => actions.setCompare(data.checked)}
          data-testid="compare-toggle"
        />
      </div>
      <div className={styles.row}>
        <Button
          appearance="primary"
          disabled={blocked !== null || applying}
          {...(applying ? { icon: <Spinner size="tiny" /> } : {})}
          onClick={() => setConfirming(true)}
          data-testid="apply-button"
        >
          {applying ? "Applying" : `Apply ${plural(preview.written.length)}`}
        </Button>
        {blocked ? (
          <Text className={styles.caption} data-testid="apply-blocked">
            {blocked}
          </Text>
        ) : null}
      </div>
      {preview.added.length > 0 ? (
        <Text className={styles.caption} data-testid="apply-added">
          Added automatically because a selected change needs them: {preview.added.map(nameOf).join(", ")}.
        </Text>
      ) : null}
      <ApplyDialog
        view={view}
        open={confirming}
        onClose={() => setConfirming(false)}
        written={preview.written}
        added={preview.added}
      />
    </div>
  );
}

function OutcomeSummary({ view, outcome }: { readonly view: DiffView; readonly outcome: ApplyOutcome }): JSX.Element {
  const nameOf = nameLookup(view);
  const written = outcome.written.map(nameOf).join(", ");
  if (outcome.outcome === "applied") {
    return (
      <MessageBar intent="success" data-testid="apply-result" data-outcome="applied">
        <MessageBarBody>
          <MessageBarTitle>Applied</MessageBarTitle>
          {plural(outcome.written.length)} written to {view.target.name}: {written}.
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="warning" data-testid="apply-result" data-outcome="partial">
      <MessageBarBody>
        <MessageBarTitle>Partly applied</MessageBarTitle>
        {outcome.written.length} of {outcome.expanded.length} changes written to {view.target.name}
        {outcome.written.length > 0 ? ` (${written})` : ""}.{" "}
        {outcome.failed ? `Apply stopped at ${nameOf(outcome.failed.changeId)}: ${outcome.failed.message}` : "Apply stopped early."}
      </MessageBarBody>
    </MessageBar>
  );
}

export function ApplyResult({ view }: { readonly view: DiffView }): JSX.Element | null {
  const apply = useStore((state) => state.apply);
  if (apply.kind === "idle") return null;
  if (apply.kind === "loading") {
    return <Spinner size="small" label="Applying the selected changes" role="status" data-testid="apply-running" />;
  }
  if (apply.kind === "success") return <OutcomeSummary view={view} outcome={apply.value} />;
  const { code, message } = apply.error;
  if (code === "base_changed") {
    return (
      <MessageBar intent="error" data-testid="apply-result" data-outcome="base_changed">
        <MessageBarBody>
          <MessageBarTitle>The model changed after this Review</MessageBarTitle>
          This Health model diff was computed against an earlier Base model, so nothing was written. Start a new Review
          to compare against the current model.
        </MessageBarBody>
        <MessageBarActions>
          <Button
            size="small"
            onClick={() => {
              void actions.openTask(null);
              actions.prefillTask("review");
            }}
            data-testid="apply-new-review"
          >
            Start a new Review
          </Button>
        </MessageBarActions>
      </MessageBar>
    );
  }
  // Azure RBAC decides where the signed-in user may write, so a refusal is about their role, not about the app.
  const refused = code === "forbidden" ? forbiddenFor("apply", view.target.name) : null;
  return (
    <MessageBar intent="error" data-testid="apply-result" data-outcome={code}>
      <MessageBarBody>
        <MessageBarTitle>{refused?.title ?? "Nothing was applied"}</MessageBarTitle>
        {refused?.message ?? message}
      </MessageBarBody>
    </MessageBar>
  );
}
