import { memo, useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  CheckmarkCircle16Filled,
  ChevronDown16Regular,
  ChevronRight16Regular,
  ErrorCircle16Filled,
  Info16Regular,
} from "@fluentui/react-icons";
import { groupChangesByEntity, writtenIds } from "../model/changes";
import type {
  ChangeDetail,
  ChangeOp,
  DiffChange,
  DiffView,
  Entity,
  VerificationRow,
  VerificationStatus,
} from "../model/types";
import { actions, useStore } from "../store/store";
import { useWindowedRows } from "./useWindowedRows";

const GROUP_HEIGHT = 36;
const CHANGE_HEIGHT = 70;
const FOOTER_HEIGHT = 26;
const DETAIL_HEAD_HEIGHT = 28;
const DETAIL_HEIGHT = 52;
const DETAIL_NOTE_HEIGHT = 28;
const DETAILS_SHOWN = 8;
const VALUE_LIMIT = 160;

type Row =
  | { readonly kind: "group"; readonly key: string; readonly label: string; readonly ids: readonly string[] }
  | { readonly kind: "change"; readonly change: DiffChange; readonly open: boolean };

/** A change shows a footer for its verification chips and what it applies with, and only when it has any. */
function hasFooter(change: DiffChange): boolean {
  return change.verification.length > 0 || change.dependsOn.length > 0;
}

function mainHeight(change: DiffChange): number {
  return CHANGE_HEIGHT + (hasFooter(change) ? FOOTER_HEIGHT : 0);
}

function rowHeight(row: Row): number {
  if (row.kind === "group") return GROUP_HEIGHT;
  const main = mainHeight(row.change);
  if (!row.open) return main;
  const shown = Math.min(DETAILS_SHOWN, row.change.details.length);
  const note = row.change.details.length > DETAILS_SHOWN ? DETAIL_NOTE_HEIGHT : 0;
  return main + DETAIL_HEAD_HEIGHT + Math.max(1, shown) * DETAIL_HEIGHT + note;
}

const OP_LABEL: Readonly<Record<ChangeOp, string>> = { add: "Add", change: "Change", remove: "Remove" };
const OP_COLOR: Readonly<Record<ChangeOp, "success" | "warning" | "danger">> = {
  add: "success",
  change: "warning",
  remove: "danger",
};
const KIND_LABEL = { entity: "Entity", signalDefinition: "Signal definition", relationship: "Relationship" } as const;
const STATUS_LABEL: Readonly<Record<VerificationStatus, string>> = {
  verified: "verified",
  failing: "failing",
  not_run: "not run",
};

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "none";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length <= VALUE_LIMIT ? text : `${text.slice(0, VALUE_LIMIT)}...`;
}

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
  row: { position: "absolute", left: 0, right: 0, boxSizing: "border-box" },
  group: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    paddingInline: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  groupLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  change: {
    display: "flex",
    flexDirection: "column",
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    overflow: "hidden",
  },
  changeMain: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: tokens.spacingHorizontalXS,
    flex: "0 0 auto",
    paddingInline: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalXS,
  },
  body: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", rowGap: "2px" },
  line: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, minWidth: 0 },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  kind: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  reason: {
    display: "-webkit-box",
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "18px",
    height: "36px",
    color: tokens.colorNeutralForeground2,
  },
  footer: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalXS, height: "24px", minWidth: 0 },
  needs: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  details: { display: "flex", flexDirection: "column", paddingInline: tokens.spacingHorizontalXL, paddingBottom: tokens.spacingVerticalXS },
  detailsHead: { height: `${DETAIL_HEAD_HEIGHT}px`, display: "flex", alignItems: "center", fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  detail: { height: `${DETAIL_HEIGHT}px`, display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase100 },
  detailPath: { fontWeight: tokens.fontWeightSemibold, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  detailValue: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tokens.colorNeutralForeground2 },
  verification: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, maxWidth: "min(460px, 80vw)", maxHeight: "300px", overflow: "auto" },
  verificationRow: { display: "flex", flexDirection: "column", rowGap: "2px", fontSize: tokens.fontSizeBase200 },
  mono: { fontFamily: tokens.fontFamilyMonospace, overflowWrap: "anywhere", color: tokens.colorNeutralForeground2 },
  applied: { opacity: 0.7 },
  empty: { padding: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3 },
});

function VerificationChips({ change }: { readonly change: DiffChange }): JSX.Element | null {
  const styles = useStyles();
  if (change.verification.length === 0) return null;
  const byStatus = new Map<VerificationStatus, VerificationRow[]>();
  for (const row of change.verification) byStatus.set(row.status, [...(byStatus.get(row.status) ?? []), row]);
  return (
    <>
      {(["verified", "failing", "not_run"] as const)
        .filter((status) => byStatus.has(status))
        .map((status) => {
          const rows = byStatus.get(status) as VerificationRow[];
          return (
            <Popover key={status} positioning="below-start">
              <PopoverTrigger disableButtonEnhancement>
                <Button
                  size="small"
                  appearance="outline"
                  icon={status === "verified" ? <CheckmarkCircle16Filled /> : status === "failing" ? <ErrorCircle16Filled /> : <Info16Regular />}
                  aria-label={`Verification: ${rows.length} ${STATUS_LABEL[status]}`}
                  data-testid={`verification-${change.id}-${status}`}
                  data-status={status}
                >
                  {rows.length} {STATUS_LABEL[status]}
                </Button>
              </PopoverTrigger>
              <PopoverSurface data-testid={`verification-popover-${change.id}-${status}`}>
                <div className={styles.verification}>
                  {rows.map((row) => (
                    <div key={`${row.entity}/${row.signal}`} className={styles.verificationRow}>
                      <Text weight="semibold">
                        {row.entity} / {row.signal}
                      </Text>
                      <span>Verification: {STATUS_LABEL[row.status]}</span>
                      {row.query ? <span className={styles.mono}>Query: {row.query}</span> : null}
                      {row.value !== null ? <span>Value: {String(row.value)}</span> : null}
                      {row.error ? <span>Error: {row.error}</span> : null}
                    </div>
                  ))}
                </div>
              </PopoverSurface>
            </Popover>
          );
        })}
    </>
  );
}

const ChangeRow = memo(function ChangeRow({
  change,
  open,
  checked,
  applied,
  needs,
  top,
  height,
  position,
  total,
  onToggleOpen,
}: {
  readonly change: DiffChange;
  readonly open: boolean;
  readonly checked: boolean;
  readonly applied: boolean;
  readonly needs: readonly string[];
  readonly top: number;
  readonly height: number;
  readonly position: number;
  readonly total: number;
  readonly onToggleOpen: (id: string) => void;
}): JSX.Element {
  const styles = useStyles();
  const shown = change.details.slice(0, DETAILS_SHOWN);
  return (
    <div
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      className={mergeClasses(styles.row, styles.change, applied && styles.applied)}
      style={{ top, height }}
      data-testid={`change-${change.id}`}
      data-op={change.op}
      data-kind={change.kind}
    >
      <div className={styles.changeMain} style={{ height: mainHeight(change) }}>
        <Checkbox
          checked={checked}
          disabled={applied}
          onChange={() => actions.toggleChange(change.id)}
          aria-label={`Select change: ${OP_LABEL[change.op].toLowerCase()} ${KIND_LABEL[change.kind].toLowerCase()} ${change.name}`}
          data-testid={`change-select-${change.id}`}
        />
        <div className={styles.body}>
          <div className={styles.line}>
            <Badge appearance="tint" color={OP_COLOR[change.op]} data-testid={`change-op-${change.id}`}>
              {OP_LABEL[change.op]}
            </Badge>
            <span className={styles.kind}>{KIND_LABEL[change.kind]}</span>
            <span className={styles.name} title={change.name}>
              {change.name}
            </span>
            {applied ? (
              <Badge appearance="filled" color="success" data-testid={`change-applied-${change.id}`}>
                Applied
              </Badge>
            ) : null}
          </div>
          <div className={styles.reason} title={change.reason}>
            {change.reason}
          </div>
          {hasFooter(change) ? (
            <div className={styles.footer}>
              <VerificationChips change={change} />
              {needs.length > 0 ? (
                <span className={styles.needs} data-testid={`change-needs-${change.id}`}>
                  Applies with: {needs.join(", ")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button
          size="small"
          appearance="subtle"
          icon={open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details of ${change.name}`}
          onClick={() => onToggleOpen(change.id)}
          data-testid={`change-expand-${change.id}`}
        />
      </div>
      {open ? (
        <div className={styles.details} data-testid={`change-details-${change.id}`}>
          <div className={styles.detailsHead}>Details</div>
          {shown.length === 0 ? (
            <div className={styles.detail}>
              <span className={styles.detailValue}>No field details for this change.</span>
            </div>
          ) : (
            shown.map((detail: ChangeDetail) => (
              <div key={detail.path} className={styles.detail}>
                <span className={styles.detailPath} title={detail.path}>
                  {detail.path}
                </span>
                <span className={styles.detailValue}>before: {formatValue(detail.before)}</span>
                <span className={styles.detailValue}>after: {formatValue(detail.after)}</span>
              </div>
            ))
          )}
          {change.details.length > DETAILS_SHOWN ? (
            <div className={styles.detailsHead}>and {change.details.length - DETAILS_SHOWN} more fields</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function labelOf(entities: ReadonlyMap<string, Entity>, name: string | null): string {
  if (name === null) return "Signal definitions no entity uses";
  const entity = entities.get(name.toLowerCase());
  return entity && entity.displayName && entity.displayName !== entity.name
    ? `${entity.displayName} (${entity.name})`
    : name;
}

export function ChangeList({ view }: { readonly view: DiffView }): JSX.Element {
  const styles = useStyles();
  const selected = useStore((state) => state.selectedChanges);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const entities = useMemo(
    () =>
      new Map(
        [...view.base.entities, ...view.proposed.entities].map((entity) => [entity.name.toLowerCase(), entity] as const),
      ),
    [view],
  );
  const applied = useMemo(() => writtenIds(view.applies), [view]);
  const namesById = useMemo(() => new Map(view.changes.map((change) => [change.id, change.name] as const)), [view]);
  const rows = useMemo<readonly Row[]>(
    () =>
      groupChangesByEntity(view.changes).flatMap((group) => [
        {
          kind: "group" as const,
          key: group.entity ?? "",
          label: labelOf(entities, group.entity),
          ids: group.changes.map((change) => change.id),
        },
        ...group.changes.map((change) => ({ kind: "change" as const, change, open: open.has(change.id) })),
      ]),
    [view, entities, open],
  );
  const heights = useMemo(() => rows.map(rowHeight), [rows]);
  const window = useWindowedRows(heights);
  const chosen = useMemo(() => new Set(selected), [selected]);

  // A row cannot own its open state without losing it when it scrolls out of the window.
  const toggleOpen = useCallback(
    (id: string): void =>
      setOpen((previous) => {
        const next = new Set(previous);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  if (view.changes.length === 0) {
    return (
      <Text as="p" className={styles.empty} data-testid="change-list-empty">
        This Health model diff proposes no changes.
      </Text>
    );
  }

  return (
    <div
      ref={window.containerRef}
      className={styles.scroller}
      onScroll={window.onScroll}
      role="list"
      aria-label="Changes of the Health model diff"
      data-testid="change-list"
    >
      <div className={styles.spacer} style={{ height: window.total }}>
        {rows.slice(window.first, window.last).map((row, index) => {
          const position = window.first + index;
          if (row.kind === "group") {
            const picked = row.ids.filter((id) => chosen.has(id)).length;
            const free = row.ids.filter((id) => !applied.has(id));
            return (
              <div
                key={`group-${row.key}`}
                role="listitem"
                aria-posinset={position + 1}
                aria-setsize={rows.length}
                className={mergeClasses(styles.row, styles.group)}
                style={{ top: window.top(position), height: GROUP_HEIGHT }}
                data-testid={`change-group-${row.key || "other"}`}
              >
                <Checkbox
                  checked={picked === 0 ? false : picked === row.ids.length ? true : "mixed"}
                  disabled={free.length === 0}
                  onChange={() => (picked === row.ids.length ? actions.deselectChanges(row.ids) : actions.selectChanges(free))}
                  aria-label={`Select all changes of ${row.label}`}
                />
                <span className={styles.groupLabel} title={row.label}>
                  {row.label}
                </span>
                <Badge appearance="outline" size="small">
                  {row.ids.length}
                </Badge>
              </div>
            );
          }
          return (
            <ChangeRow
              key={row.change.id}
              change={row.change}
              open={row.open}
              checked={chosen.has(row.change.id)}
              applied={applied.has(row.change.id)}
              needs={row.change.dependsOn.map((id) => namesById.get(id) ?? id)}
              top={window.top(position)}
              height={heights[position] as number}
              position={position + 1}
              total={rows.length}
              onToggleOpen={toggleOpen}
            />
          );
        })}
      </div>
    </div>
  );
}
