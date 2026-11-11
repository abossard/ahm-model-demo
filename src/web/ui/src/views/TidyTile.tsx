import { memo } from "react";
import type { JSX } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ChangeBadge } from "../model/changes";
import { diffTokens, impactOf, impactStyle, tokensFor } from "../model/palette";
import { tileSignals, SIGNAL_GLYPHS, type Fold } from "../model/tidy";
import type { Entity } from "../model/types";
import { ICONS, pickIcon } from "../components/EntityNode";
import { StateGlyph } from "../components/StateGlyph";

const useStyles = makeStyles({
  shell: { position: "relative", pointerEvents: "none" },
  tile: {
    position: "relative",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    width: "100%",
    height: "100%",
    paddingTop: "8px",
    paddingBottom: "8px",
    paddingLeft: "12px",
    paddingRight: "10px",
    borderRadius: tokens.borderRadiusLarge,
    textAlign: "left",
    cursor: "pointer",
    fontFamily: tokens.fontFamilyBase,
    color: tokens.colorNeutralForeground1,
    pointerEvents: "all",
    outlineStyle: "none",
    ":focus-visible": { boxShadow: `0 0 0 2px ${tokens.colorStrokeFocus1}, 0 0 0 4px ${tokens.colorStrokeFocus2}` },
  },
  selected: { boxShadow: `0 0 0 2px ${tokens.colorBrandStroke1}` },
  highlighted: { boxShadow: `0 0 0 3px ${tokens.colorBrandStroke1}` },
  marked: { boxShadow: `0 0 0 3px ${tokens.colorPaletteMarigoldBorderActive}` },
  chain: { outlineStyle: "dashed", outlineWidth: "2px", outlineColor: tokens.colorBrandStroke1, outlineOffset: "3px" },
  dimmed: { opacity: 0.5 },
  bar: { position: "absolute", left: "4px", top: "8px", bottom: "8px", width: "3px", borderRadius: "2px" },
  top: { display: "flex", alignItems: "flex-start", columnGap: tokens.spacingHorizontalS, minWidth: 0 },
  icon: { flex: "0 0 auto", display: "flex", width: "16px", height: "16px", marginTop: "1px", color: tokens.colorNeutralForeground3 },
  name: {
    flex: "1 1 0",
    minWidth: 0,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    overflowWrap: "anywhere",
    fontSize: "12.5px",
    lineHeight: "16px",
    fontWeight: tokens.fontWeightSemibold,
  },
  removed: { textDecorationLine: "line-through" },
  glyph: { flex: "0 0 auto", display: "flex", marginTop: "1px" },
  bottom: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, minHeight: "18px", minWidth: 0 },
  signals: { display: "inline-flex", alignItems: "center", columnGap: "3px", flex: "0 0 auto" },
  quiet: { fontSize: "10.5px", color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  chips: { marginLeft: "auto", display: "inline-flex", columnGap: "4px", minWidth: 0 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: "3px",
    paddingLeft: "6px",
    paddingRight: "6px",
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    fontSize: "10px",
    lineHeight: "16px",
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
  },
  step: {
    position: "absolute",
    top: "-9px",
    left: "-9px",
    zIndex: 2,
    display: "grid",
    placeItems: "center",
    width: "20px",
    height: "20px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: "11px",
    fontWeight: tokens.fontWeightBold,
    pointerEvents: "none",
  },
  // At the bottom edge: the lines and their label pills arrive at the top.
  badge: {
    position: "absolute",
    bottom: "-10px",
    left: "14px",
    zIndex: 2,
    paddingLeft: "8px",
    paddingRight: "8px",
    border: "1px solid",
    borderRadius: tokens.borderRadiusCircular,
    fontSize: "10.5px",
    lineHeight: "16px",
    fontWeight: tokens.fontWeightSemibold,
    pointerEvents: "none",
  },
  toggle: {
    position: "absolute",
    right: "10px",
    bottom: "-10px",
    zIndex: 2,
    display: "inline-flex",
    alignItems: "center",
    columnGap: "2px",
    height: "20px",
    minWidth: "26px",
    paddingLeft: "4px",
    paddingRight: "6px",
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontFamily: tokens.fontFamilyBase,
    fontSize: "10.5px",
    fontWeight: tokens.fontWeightSemibold,
    cursor: "pointer",
    pointerEvents: "all",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":focus-visible": { boxShadow: `0 0 0 2px ${tokens.colorStrokeFocus1}, 0 0 0 4px ${tokens.colorStrokeFocus2}`, outlineStyle: "none" },
  },
  fold: {
    border: `1.5px dashed ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    justifyContent: "center",
    rowGap: "6px",
  },
  foldChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    columnGap: tokens.spacingHorizontalS,
    paddingTop: 0,
    paddingBottom: 0,
    borderRadius: tokens.borderRadiusCircular,
  },
  foldWord: { fontSize: "12.5px", fontWeight: tokens.fontWeightSemibold },
});

const CHEVRON_DOWN = "M3.5 6 8 10.5 12.5 6";
const CHEVRON_RIGHT = "M6 3.5 10.5 8 6 12.5";

function Chevron({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d={open ? CHEVRON_DOWN : CHEVRON_RIGHT} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface TidyTileData extends Record<string, unknown> {
  readonly entity: Entity;
  readonly selected: boolean;
  readonly highlighted: boolean;
  /** Its number on an open Explain chain, or null. */
  readonly step: number | null;
  readonly badge: ChangeBadge | null;
  readonly marked: boolean;
  /** The Health filter excludes it and shows excluded entities faint. */
  readonly dimmed: boolean;
  /** Present when the entity has children to collapse or a collapse to undo. */
  readonly collapse: { readonly collapsed: boolean; readonly hiddenCount: number } | null;
  readonly onActivate: (name: string) => void;
  readonly onToggle: (entity: Entity, collapsed: boolean, hiddenCount: number) => void;
  readonly onFocusNode: (id: string, element: HTMLElement) => void;
}

export interface TidyFoldData extends Record<string, unknown> {
  readonly fold: Fold;
  /** What the members are called under: the parent's name. */
  readonly parentLabel: string;
  readonly onToggleFold: (parent: string, open: boolean) => void;
  readonly onFocusNode: (id: string, element: HTMLElement) => void;
}

export type TidyRfNode = Node<TidyTileData, "tile"> | Node<TidyFoldData, "fold">;

function spoken(entity: Entity, step: number | null, badge: ChangeBadge | null, dimmed: boolean): string {
  const impact = impactOf(entity.impact);
  const signals = tileSignals(entity);
  return [
    `${entity.displayName || entity.name}, ${entity.healthState}`,
    impact === "Standard" ? "" : impactStyle[impact].word,
    signals.total > 0 ? `${signals.total} signal${signals.total === 1 ? "" : "s"}` : "",
    badge ? `${badge} in the proposed changes` : "",
    step === null ? "" : `step ${step} of the chain`,
    dimmed ? "excluded by the Health filter" : "",
  ]
    .filter((part) => part !== "")
    .join(", ");
}

function TileImpl({ data, id }: NodeProps<Node<TidyTileData, "tile">>): JSX.Element {
  const styles = useStyles();
  const { entity, selected, highlighted, step, badge, marked, dimmed, collapse, onActivate, onToggle, onFocusNode } = data;
  const token = tokensFor(entity.healthState);
  const impact = impactOf(entity.impact);
  const name = entity.displayName || entity.name;
  const signals = tileSignals(entity);
  const diff = badge ? diffTokens[badge] : null;
  const loud = entity.healthState === "Degraded" || entity.healthState === "Unhealthy";
  const border =
    badge === "removed" ? "dashed" : badge !== null ? "solid" : impact === "Suppressed" ? "dotted" : token.dashed ? "dashed" : "solid";
  return (
    <div className={styles.shell} style={{ width: "100%", height: "100%" }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <button
        type="button"
        className={mergeClasses(styles.tile, selected && styles.selected, highlighted && styles.highlighted, marked && styles.marked, step !== null && styles.chain, dimmed && styles.dimmed)}
        data-testid="tidy-tile"
        data-entity={entity.name}
        data-state={entity.healthState}
        data-selected={selected ? "true" : undefined}
        data-highlighted={highlighted ? "true" : undefined}
        data-step={step ?? undefined}
        data-badge={badge ?? undefined}
        data-marked={marked ? "true" : undefined}
        data-dimmed={dimmed ? "true" : undefined}
        aria-label={spoken(entity, step, badge, dimmed)}
        aria-current={selected ? "true" : undefined}
        title={`${name}: ${token.word}`}
        style={{
          borderStyle: border,
          borderWidth: entity.healthState === "Unhealthy" ? 2 : loud || badge !== null ? 1.6 : 1,
          borderColor: diff ? diff.line : token.border,
          backgroundColor: badge === "removed" ? diff?.tint : token.fill,
        }}
        onClick={() => onActivate(entity.name)}
        onFocus={(event) => onFocusNode(id, event.currentTarget)}
      >
        {loud ? <span className={styles.bar} style={{ backgroundColor: token.dot }} aria-hidden="true" /> : null}
        <span className={styles.top}>
          <span className={styles.icon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" width="16" height="16">${ICONS[pickIcon(name)] ?? ICONS["cube"]}</svg>` }} />
          <span className={mergeClasses(styles.name, badge === "removed" && styles.removed)}>{name}</span>
          <span className={styles.glyph} aria-hidden="true">
            <StateGlyph state={entity.healthState} size={16} />
          </span>
        </span>
        <span className={styles.bottom}>
          {signals.total > 0 ? (
            <span className={styles.signals} data-testid="tidy-signals" title={`${signals.total} signal${signals.total === 1 ? "" : "s"}`} aria-hidden="true">
              {signals.glyphs.map((state, index) => (
                <StateGlyph key={index} state={state} size={10} />
              ))}
              <span className={styles.quiet}>{signals.more > 0 ? `+${signals.more}` : signals.total}</span>
            </span>
          ) : (
            <span className={styles.quiet}>{entity.children.length > 0 || collapse !== null ? "rolls up" : "no signals"}</span>
          )}
          {impact === "Standard" ? null : (
            <span className={styles.chips}>
              <span className={styles.chip} data-testid="tidy-impact" data-impact={impact} aria-hidden="true">
                <span>{impactStyle[impact].glyph}</span>
                {impact}
              </span>
            </span>
          )}
        </span>
      </button>
      {step === null ? null : (
        <span className={styles.step} data-testid="tidy-step" aria-hidden="true">
          {step}
        </span>
      )}
      {diff && badge ? (
        <span className={styles.badge} data-testid="tidy-badge" data-badge={badge} aria-hidden="true" style={{ backgroundColor: diff.tint, color: diff.ink, borderColor: diff.line }}>
          {diff.glyph} {diff.word}
        </span>
      ) : null}
      {collapse ? (
        <button
          type="button"
          className={styles.toggle}
          data-testid="tidy-collapse"
          aria-expanded={!collapse.collapsed}
          aria-label={collapse.collapsed ? `Expand ${name}, ${collapse.hiddenCount} hidden` : `Collapse ${name}`}
          onClick={() => onToggle(entity, collapse.collapsed, collapse.hiddenCount)}
        >
          <Chevron open={!collapse.collapsed} />
          {collapse.collapsed ? <span>{collapse.hiddenCount}</span> : null}
        </button>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="entity-node__handle" />
    </div>
  );
}

function FoldImpl({ data, id }: NodeProps<Node<TidyFoldData, "fold">>): JSX.Element {
  const styles = useStyles();
  const { fold, parentLabel, onToggleFold, onFocusNode } = data;
  const count = fold.members.length;
  const word = `${count} healthy`;
  const names = fold.members.slice(0, 12).join(", ") + (count > 12 ? `, and ${count - 12} more` : "");
  return (
    <div className={styles.shell} style={{ width: "100%", height: "100%" }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <button
        type="button"
        className={mergeClasses(styles.tile, styles.fold, fold.open && styles.foldChip)}
        data-testid="tidy-fold"
        data-fold={fold.parent}
        data-open={fold.open ? "true" : undefined}
        aria-expanded={fold.open}
        aria-label={fold.open ? `Fold the ${word} entities under ${parentLabel}` : `${word} entities under ${parentLabel} are folded: ${names}. Show them`}
        title={names}
        onClick={() => onToggleFold(fold.parent, !fold.open)}
        onFocus={(event) => onFocusNode(id, event.currentTarget)}
      >
        {fold.open ? (
          <>
            <Chevron open />
            <span className={styles.foldWord}>Fold {word}</span>
          </>
        ) : (
          <>
            <span className={styles.top} style={{ justifyContent: "center", alignItems: "center" }}>
              <Chevron open={false} />
              <span className={styles.foldWord}>{word}</span>
            </span>
            <span className={styles.signals} style={{ justifyContent: "center" }} aria-hidden="true">
              {Array.from({ length: Math.min(count, SIGNAL_GLYPHS + 2) }, (_unused, index) => (
                <StateGlyph key={index} state="Healthy" size={10} />
              ))}
              {count > SIGNAL_GLYPHS + 2 ? <span className={styles.quiet}>+{count - SIGNAL_GLYPHS - 2}</span> : null}
            </span>
          </>
        )}
      </button>
    </div>
  );
}

export const TidyTile = memo(TileImpl);
export const TidyFold = memo(FoldImpl);
