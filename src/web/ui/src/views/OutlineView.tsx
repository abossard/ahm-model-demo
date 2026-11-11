import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { FlatTree, FlatTreeItem, TreeItemLayout, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { FlatTreeProps } from "@fluentui/react-components";
import type { ChangeBadge } from "../model/changes";
import { chainSteps } from "../model/chainSteps";
import { visibleGraph } from "../model/collapse";
import { formatWhen } from "../model/duration";
import {
  INLINE_SIGNALS,
  ROW_HEIGHT,
  outlineRows,
  revealOverrides,
  ribbonRuns,
  rowAtOffset,
  rowOffsets,
  summarise,
  navigate,
  typeAheadRow,
  type OutlineRow,
} from "../model/outline";
import { diffTokens, impactOf, impactStyle, tokensFor } from "../model/palette";
import type { AsyncState, EntityDetail } from "../model/types";
import { actions, useStore } from "../store/store";
import { useWindowedRows } from "../components/useWindowedRows";
import { HealthBadge } from "../components/HealthBadge";
import { StateGlyph } from "../components/StateGlyph";
import { OutlineRibbon } from "./OutlineRibbon";
import { useOutlineState } from "./outlineState";
import type { ViewProps } from "./types";

/** Rows drawn beyond the ones on screen, so a quick scroll shows no gap. */
const OVERSCAN = 6;
/** How long a pause ends the letters typed to find a row. */
const TYPE_AHEAD_MS = 800;

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
  summary: {
    flex: "0 0 auto",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { flex: 1, minHeight: 0, display: "flex", position: "relative", "@media (max-width: 720px)": { flex: "1 0 320px" } },
  scroller: { flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", backgroundColor: tokens.colorNeutralBackground1 },
  empty: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingHorizontalL,
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
    pointerEvents: "none",
  },
  item: { overflow: "hidden", borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  // The chevron sits beside the first line, not between the two of a row that has failing signals.
  layout: {
    height: "100%",
    minHeight: 0,
    paddingRight: tokens.spacingHorizontalS,
    alignItems: "flex-start",
    "& .fui-TreeItemLayout__expandIcon": { alignSelf: "flex-start", height: `${ROW_HEIGHT}px` },
    // The name gives way to the counts on a narrow screen instead of the row running past its edge.
    "& .fui-TreeItemLayout__main": { flex: "1 1 0", minWidth: 0 },
  },
  selected: { backgroundColor: tokens.colorBrandBackground2, boxShadow: `inset 3px 0 0 ${tokens.colorBrandStroke1}` },
  highlighted: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: "-2px" },
  dimmed: { opacity: 0.5 },
  content: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", rowGap: "2px" },
  line: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, minWidth: 0, minHeight: `${ROW_HEIGHT}px`, whiteSpace: "nowrap" },
  name: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  loud: { fontWeight: tokens.fontWeightSemibold },
  quiet: { color: tokens.colorNeutralForeground2 },
  removed: { textDecorationLine: "line-through" },
  spacer: { flex: "1 1 0", minWidth: 0 },
  state: { flex: "0 0 auto", display: "inline-flex" },
  chip: {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    columnGap: "3px",
    paddingLeft: "7px",
    paddingRight: "7px",
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    fontSize: "11px",
    lineHeight: "16px",
    fontWeight: tokens.fontWeightSemibold,
  },
  muted: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  counts: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  count: { display: "inline-flex", alignItems: "center", columnGap: "3px" },
  reference: { flex: "0 0 auto", color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase300 },
  signals: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalL, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", fontSize: tokens.fontSizeBase200 },
  signal: { display: "inline-flex", alignItems: "center", columnGap: "4px", minWidth: 0 },
  step: {
    flex: "0 0 auto",
    display: "grid",
    placeItems: "center",
    width: "20px",
    height: "20px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: "11px",
    fontWeight: tokens.fontWeightBold,
  },
});

interface ItemProps {
  readonly row: OutlineRow;
  readonly top: number;
  readonly active: boolean;
  readonly selected: boolean;
  readonly highlighted: boolean;
  /** The changes of this entity are ticked in the change list of a Compare. */
  readonly marked: boolean;
  readonly step: number | null;
  readonly badge: ChangeBadge | null;
  /** For a reference row: what the parent it points to is called. */
  readonly shownUnder: string | null;
  /** When the selected entity last changed state; only the selected row says so. */
  readonly lastChange: string | null;
  readonly onActivateRow: (row: OutlineRow) => void;
  readonly onFocusRow: (key: string) => void;
}

function describe(row: OutlineRow, step: number | null, badge: ChangeBadge | null, shownUnder: string | null): string {
  const { entity } = row;
  const impact = impactOf(entity.impact);
  const parts = [`${entity.displayName || entity.name}, ${entity.healthState}`];
  if (impact !== "Standard") parts.push(impactStyle[impact].word);
  if (row.kind === "also") parts.push(shownUnder === null ? "also at the top" : `also under ${shownUnder}`);
  else {
    if (entity.signals.length > 0) parts.push(`${entity.signals.length} signal${entity.signals.length === 1 ? "" : "s"}`);
    for (const signal of row.failing) parts.push(`${signal.name} ${signal.value}, ${signal.state}`);
    if (row.expandable && !row.open) parts.push(`${row.below} below${row.belowTrouble > 0 ? `, ${row.belowTrouble} not healthy` : ", all healthy"}`);
  }
  if (badge) parts.push(`${badge} in the proposed changes`);
  if (step !== null) parts.push(`step ${step} of the chain`);
  return parts.join(", ");
}

const Item = memo(function Item({ row, top, active, selected, highlighted, marked, step, badge, shownUnder, lastChange, onActivateRow, onFocusRow }: ItemProps): JSX.Element {
  const styles = useStyles();
  const { entity } = row;
  const name = entity.displayName || entity.name;
  const impact = impactOf(entity.impact);
  const attention = entity.healthState !== "Healthy" && entity.healthState !== "Deleted";
  const diff = badge ? diffTokens[badge] : null;
  const reference = row.kind === "also";
  return (
    <FlatTreeItem
      value={row.key}
      {...(row.parentKey === null ? {} : { parentValue: row.parentKey })}
      itemType={row.expandable ? "branch" : "leaf"}
      aria-level={row.level}
      aria-posinset={row.position}
      aria-setsize={row.setSize}
      aria-selected={selected}
      aria-label={describe(row, step, badge, shownUnder)}
      tabIndex={active ? 0 : -1}
      className={styles.item}
      style={{ position: "absolute", top, left: 0, right: 0, height: row.height }}
      data-testid="outline-row"
      data-key={row.key}
      data-entity={entity.name}
      data-kind={row.kind}
      data-state={entity.healthState}
      data-step={step ?? undefined}
      data-badge={badge ?? undefined}
      data-highlighted={highlighted ? "true" : undefined}
      data-marked={marked ? "true" : undefined}
      data-dimmed={row.dimmed ? "true" : undefined}
      onClick={(event) => {
        // A click on the row opens the entity; only the chevron and the arrow keys open and close it.
        event.preventDefault();
        onActivateRow(row);
      }}
      onKeyDown={(event) => {
        if (event.key !== " " || event.target !== event.currentTarget) return;
        event.preventDefault();
        onActivateRow(row);
      }}
      onFocus={() => onFocusRow(row.key)}
    >
      <TreeItemLayout className={mergeClasses(styles.layout, selected && styles.selected, highlighted && styles.highlighted, row.dimmed && styles.dimmed)}>
        <span className={styles.content}>
          <span className={styles.line}>
            {reference ? (
              <>
                <span className={styles.reference} aria-hidden="true">
                  ↗
                </span>
                <StateGlyph state={entity.healthState} size={14} />
              </>
            ) : (
              <span className={styles.state}>
                <HealthBadge state={entity.healthState} />
              </span>
            )}
            <span className={mergeClasses(styles.name, attention && !reference ? styles.loud : styles.quiet, badge === "removed" && styles.removed)} data-testid="outline-name">
              {name}
            </span>
            {impact === "Standard" ? null : (
              <span className={styles.chip} data-testid="outline-impact" data-impact={impact}>
                <span aria-hidden="true">{impactStyle[impact].glyph}</span>
                {impactStyle[impact].word}
              </span>
            )}
            {diff && badge ? (
              <span className={styles.chip} data-testid="outline-badge" data-badge={badge} style={{ backgroundColor: diff.tint, color: diff.ink, borderColor: diff.line }}>
                <span aria-hidden="true">{diff.glyph}</span>
                {diff.word}
              </span>
            ) : null}
            {reference ? (
              <span className={styles.muted} data-testid="outline-also">
                also under {shownUnder ?? "the top"}
              </span>
            ) : null}
            <span className={styles.spacer} />
            {lastChange ? (
              <span className={styles.muted} data-testid="outline-last-change">
                Last change {lastChange}
              </span>
            ) : null}
            {reference || row.counts.length === 0 ? null : (
              <span className={styles.counts} data-testid="outline-counts" aria-hidden="true">
                {row.counts.map((count) => (
                  <span className={styles.count} key={count.state} data-state={count.state} title={`${count.count} ${tokensFor(count.state).word} signal${count.count === 1 ? "" : "s"}`}>
                    <StateGlyph state={count.state} size={12} />
                    {count.count}
                  </span>
                ))}
              </span>
            )}
            {row.expandable && !row.open ? (
              <span className={styles.muted} data-testid="outline-below">
                {row.below} below{row.belowTrouble > 0 ? `, ${row.belowTrouble} not healthy` : ", all healthy"}
              </span>
            ) : null}
            {step === null ? null : (
              <span className={styles.step} data-testid="outline-step" aria-hidden="true">
                {step}
              </span>
            )}
          </span>
          {row.failing.length > 0 ? (
            <span className={styles.signals} data-testid="outline-signals" aria-hidden="true">
              {row.failing.slice(0, INLINE_SIGNALS).map((signal, index) => (
                <span className={styles.signal} key={`${signal.name}:${index}`} data-state={signal.state} style={{ color: tokensFor(signal.state).label }}>
                  <StateGlyph state={signal.state} size={12} />
                  <span>{signal.name}</span>
                  <b>{signal.value}</b>
                </span>
              ))}
              {row.failing.length > INLINE_SIGNALS ? <span className={styles.muted}>+{row.failing.length - INLINE_SIGNALS} more</span> : null}
            </span>
          ) : null}
        </span>
      </TreeItemLayout>
    </FlatTreeItem>
  );
});

/** The newest of an entity's transitions, as a date for the selected row. */
function latestChange(detail: AsyncState<EntityDetail>): { readonly name: string; readonly when: string } | null {
  if (detail.kind !== "success") return null;
  const times = detail.value.transitions.map((transition) => transition.occurredAt).filter((time): time is string => time !== null && !Number.isNaN(Date.parse(time)));
  if (times.length === 0) return null;
  const newest = times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest));
  return { name: detail.value.entity.name, when: formatWhen(newest) };
}

export function OutlineView({ entities, relationships, selectedName, highlightedName, chainNames, badges, marked, onActivate }: ViewProps): JSX.Element {
  const styles = useStyles();
  const selectedHealth = useStore((state) => state.selectedHealth);
  const excludedEntityMode = useStore((state) => state.excludedEntityMode);
  const focusNames = useStore((state) => state.focusNames);
  const focusSeq = useStore((state) => state.focusSeq);
  const detail = useStore((state) => state.detail);
  const overrides = useOutlineState((state) => state.overrides);
  const setOpen = useOutlineState((state) => state.setOpen);

  const visible = useMemo(
    () => visibleGraph(entities, relationships, new Set(), { selectedHealth: new Set(selectedHealth), excludedEntityMode }),
    [entities, relationships, selectedHealth, excludedEntityMode],
  );
  const rows = useMemo(() => outlineRows(visible.entities, visible.relationships, overrides, visible.dotNames), [visible, overrides]);
  const byName = useMemo(() => new Map(visible.entities.map((entity) => [entity.name, entity] as const)), [visible]);
  const steps = useMemo(() => chainSteps(chainNames, byName.keys()), [chainNames, byName]);
  const summary = useMemo(() => summarise(rows), [rows]);
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  const runs = useMemo(() => ribbonRuns(rows), [rows]);
  const openKeys = useMemo(() => rows.filter((row) => row.open).map((row) => row.key), [rows]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  // Whatever the viewer is looking for must be in the outline: open the rows above it, once.
  const modelKey = useMemo(() => entities.map((entity) => entity.name).join("|"), [entities]);
  const reveal = useMemo(() => {
    const lower = new Map(entities.map((entity) => [entity.name.toLowerCase(), entity.name] as const));
    const names = [selectedName, highlightedName, ...focusNames, ...steps.keys()].filter((name): name is string => !!name);
    for (const key of badges?.keys() ?? []) {
      const name = lower.get(key);
      if (name) names.push(name);
    }
    return names;
  }, [entities, selectedName, highlightedName, focusNames, steps, badges]);
  const revealKey = reveal.join("|");
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    if (revealRef.current.length === 0) return;
    const next = revealOverrides(visible.entities, visible.relationships, overridesRef.current, revealRef.current);
    if ([...next].some(([name, open]) => overridesRef.current.get(name) !== open)) useOutlineState.getState().replace(next);
    // `revealKey` and `modelKey` name what the others hold, so a refresh of the same model reopens nothing the viewer closed.
  }, [revealKey, modelKey]);

  // The row that takes the Tab key; the arrow keys move it. It is always drawn, so Tab finds it again.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeIndex = Math.max(0, rows.findIndex((row) => row.key === activeKey));

  const heights = useMemo(() => rows.map((row) => row.height), [rows]);
  const windowed = useWindowedRows(heights, OVERSCAN);
  const { containerRef, onScroll } = windowed;
  const scroller = containerRef.current;
  const drawn = useMemo(() => {
    const indices = new Set<number>();
    for (let index = windowed.first; index < Math.min(windowed.last, rows.length); index += 1) indices.add(index);
    if (rows.length > 0) indices.add(activeIndex);
    return [...indices].sort((a, b) => a - b);
  }, [windowed.first, windowed.last, rows.length, activeIndex]);

  const scrollTo = useCallback((index: number, align: "nearest" | "center"): void => {
    const element = containerRef.current;
    const top = offsetsRef.current[index];
    const bottom = offsetsRef.current[index + 1];
    if (!element || top === undefined || bottom === undefined) return;
    if (align === "center") element.scrollTop = Math.max(0, top - (element.clientHeight - (bottom - top)) / 2);
    else if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    onScroll();
  }, [containerRef, onScroll]);

  // Moving to a row: it becomes the one Tab finds, scrolls into view, and takes focus once it is drawn.
  const pendingFocus = useRef<string | null>(null);
  const focusRow = useCallback((index: number, align: "nearest" | "center" = "nearest"): void => {
    const row = rowsRef.current[index];
    if (!row) return;
    setActiveKey(row.key);
    pendingFocus.current = row.key;
    scrollTo(index, align);
  }, [scrollTo]);
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null || !scroller) return;
    const element = [...scroller.querySelectorAll<HTMLElement>("[data-key]")].find((item) => item.dataset["key"] === key);
    if (!element) return;
    pendingFocus.current = null;
    element.focus();
  });

  // A search result: scroll to it once the rows above it are open.
  const lastFocus = useRef(focusSeq);
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    if (focusSeq === 0 || focusNames.length === 0 || focusSeq <= lastFocus.current) return;
    lastFocus.current = focusSeq;
    pendingScroll.current = focusNames[0] ?? null;
  }, [focusSeq, focusNames]);
  useEffect(() => {
    const name = pendingScroll.current;
    if (name === null) return;
    const index = rows.findIndex((row) => row.kind === "entity" && row.entity.name === name);
    if (index < 0) return;
    pendingScroll.current = null;
    setActiveKey(rows[index]?.key ?? null);
    scrollTo(index, "center");
  }, [rows, focusSeq, scrollTo]);

  const typed = useRef({ text: "", at: 0 });
  const onNavigation: NonNullable<FlatTreeProps["onNavigation"]> = (event, data) => {
    if (data.type === "Click") return;
    // The arrows, Home, End and letters are ours: Fluent would walk the rows that are drawn, not the list.
    event.preventDefault();
    const current = rowsRef.current;
    const from = current.findIndex((row) => row.key === data.value);
    if (data.type === "TypeAhead") {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > TYPE_AHEAD_MS ? data.event.key : typed.current.text + data.event.key, at: now };
      const text = typed.current.text;
      focusRow(typeAheadRow(current, from, /^(.)\1+$/.test(text) ? text.slice(0, 1) : text));
      return;
    }
    focusRow(navigate(current, from, data.type));
  };
  const onOpenChange: NonNullable<FlatTreeProps["onOpenChange"]> = (_event, data) => {
    const name = String(data.value);
    setOpen(name, data.open);
    actions.announce(`${byName.get(name)?.displayName || name} ${data.open ? "expanded" : "collapsed"}.`);
  };

  // A reference row stands for the full row; opening it goes there.
  const onActivateRow = useCallback(
    (row: OutlineRow): void => {
      onActivate(row.entity.name);
      if (row.kind !== "also") return;
      const index = rowsRef.current.findIndex((item) => item.kind === "entity" && item.key === row.entity.name);
      if (index >= 0) focusRow(index, "center");
    },
    [onActivate, focusRow],
  );
  const onFocusRow = useCallback((key: string): void => setActiveKey(key), []);
  const onJump = useCallback(
    (offset: number): void => {
      const index = rowAtOffset(offsetsRef.current, offset);
      setActiveKey(rowsRef.current[index]?.key ?? null);
      scrollTo(index, "center");
    },
    [scrollTo],
  );

  const change = useMemo(() => latestChange(detail), [detail]);
  const labelOf = (name: string | null): string | null => (name === null ? null : (byName.get(name)?.displayName || name));

  return (
    <div className={styles.root} data-testid="outline-view">
      <div className={styles.summary} data-testid="outline-summary">
        {summary.rows} row{summary.rows === 1 ? "" : "s"}, {summary.needAttention} entit{summary.needAttention === 1 ? "y needs" : "ies need"} attention
        {summary.references > 0 ? `, ${summary.references} also under another parent` : ""}.
      </div>
      <div className={styles.body}>
        <div className={styles.scroller} ref={containerRef} onScroll={onScroll} data-testid="outline-scroller">
          <FlatTree
            aria-label="Health model outline"
            size="small"
            openItems={openKeys}
            onOpenChange={onOpenChange}
            onNavigation={onNavigation}
            style={{ position: "relative", height: windowed.total }}
            data-testid="outline-tree"
          >
            {drawn.map((index) => {
              const row = rows[index] as OutlineRow;
              const name = row.entity.name;
              const lower = name.toLowerCase();
              return (
                <Item
                  key={row.key}
                  row={row}
                  top={windowed.top(index)}
                  active={index === activeIndex}
                  selected={name === selectedName}
                  highlighted={name === highlightedName || (marked?.has(lower) ?? false)}
                  marked={marked?.has(lower) ?? false}
                  step={steps.get(name) ?? null}
                  badge={badges?.get(lower) ?? null}
                  shownUnder={row.kind === "also" ? labelOf(row.shownUnder) : null}
                  lastChange={name === selectedName && change?.name === name ? change.when : null}
                  onActivateRow={onActivateRow}
                  onFocusRow={onFocusRow}
                />
              );
            })}
          </FlatTree>
        </div>
        <OutlineRibbon runs={runs} total={windowed.total} viewTop={scroller?.scrollTop ?? 0} viewHeight={scroller?.clientHeight ?? 0} onJump={onJump} />
        {entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="outline">
            This health model has no entities.
          </div>
        ) : visible.entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="outline">
            The Health filter hides every entity.
          </div>
        ) : null}
      </div>
    </div>
  );
}
