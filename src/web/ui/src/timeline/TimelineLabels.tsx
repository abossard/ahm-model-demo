import type { JSX } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { ChevronDown12Regular, ChevronRight12Regular } from "@fluentui/react-icons";
import { StateGlyph } from "../components/StateGlyph";
import { impactOf, impactStyle, tokensFor } from "../model/palette";
import { stateName, type StateCode } from "../model/timeline";
import type { Row, RowModel } from "../model/timelineRows";
import type { SignalFacts } from "../model/timelineTree";
import { useStyles } from "./styles";

/** What the tree says about the rows, as of the instant it shows: now, or the pinned moment. */
export interface TreeFacts {
  readonly entity: (name: string) => { readonly state: StateCode; readonly impact: string };
  readonly signal: (entity: string, signal: string) => SignalFacts;
}

interface Props {
  readonly model: RowModel;
  readonly range: readonly [number, number];
  readonly facts: TreeFacts;
  /** The entity that is selected: every row it has is marked. */
  readonly selectedEntity: string | null;
  readonly focusKey: string | null;
  readonly onToggle: (key: string) => void;
  readonly onSelect: (row: Row) => void;
  readonly onFocus: (key: string) => void;
}

const INDENT = 14;
const BASE = 8;
/** The width of a row's chevron and its gap: a signal's glyph stands where the glyph of a dependency does. */
const CHEVRON = 22;

function Word({ state, className }: { readonly state: StateCode | null; readonly className?: string }): JSX.Element {
  const name = state === null ? "None" : stateName(state);
  return (
    <span className={mergeClasses("tl-state", className)} data-state={name} data-testid="tl-state-word">
      {state === null ? "no data" : tokensFor(name).word}
    </span>
  );
}

/**
 * The tree: it carries the health. An entity names its state, a signal its state and its latest value with the unit.
 * An open entity shows its signals first, then its dependencies. The rows are HTML, so a screen reader and the keyboard meet a tree.
 */
export function TimelineLabels(props: Props): JSX.Element {
  const styles = useStyles();
  const items: JSX.Element[] = [];
  for (let i = props.range[0]; i < Math.min(props.range[1], props.model.rows.length); i += 1) {
    const row = props.model.rows[i];
    if (!row) continue;
    const common = {
      id: `tl-row-${i}`,
      role: "treeitem",
      style: { top: row.y, paddingLeft: BASE + row.depth * INDENT + (row.kind === "signal" ? CHEVRON : 0) },
      "aria-level": row.depth + 1,
      "aria-posinset": row.position,
      "aria-setsize": row.size,
      "data-key": row.key,
      "data-testid": `tl-label-${row.kind}`,
      "data-row": row.entity,
    };
    const focused = row.key === props.focusKey;
    if (row.kind === "entity") {
      const fact = props.facts.entity(row.entity);
      const impact = impactOf(fact.impact);
      const selected = row.entity === props.selectedEntity;
      items.push(
        <div
          {...common}
          key={row.key}
          aria-selected={selected}
          {...(row.expandable ? { "aria-expanded": row.expanded } : {})}
          title={row.connected ? row.label : `${row.label}: not connected to any other entity`}
          className={mergeClasses(styles.row, styles.entityRow, selected && styles.selected, focused && styles.focused)}
          onClick={() => {
            props.onFocus(row.key);
            props.onSelect(row);
          }}
        >
          {row.expandable ? (
            <button
              type="button"
              tabIndex={-1}
              className={styles.chevron}
              aria-label={`${row.expanded ? "Hide" : "Show"} the signals and dependencies of ${row.label}`}
              data-testid="tl-expand"
              onClick={(event) => {
                event.stopPropagation();
                props.onFocus(row.key);
                props.onToggle(row.key);
              }}
            >
              {row.expanded ? <ChevronDown12Regular /> : <ChevronRight12Regular />}
            </button>
          ) : (
            <span className={styles.chevron} aria-hidden="true" />
          )}
          <StateGlyph state={stateName(fact.state)} size={13} />
          <span className={styles.nameBlock}>
            <span className={styles.name}>{row.label}</span>
            {row.connected ? null : (
              <span className={mergeClasses(styles.muted, styles.note)} data-testid="tl-unconnected">
                Not connected
              </span>
            )}
          </span>
          {impact !== "Standard" ? (
            <span className={styles.chip} data-testid="tl-impact">
              {impactStyle[impact].glyph} {impactStyle[impact].word}
            </span>
          ) : null}
          <Word state={fact.state} className={styles.word} />
        </div>,
      );
    } else {
      const fact = props.facts.signal(row.entity, row.signal);
      items.push(
        <div
          {...common}
          key={row.key}
          title={fact.rule ? `${row.label}: ${fact.rule}` : row.label}
          className={mergeClasses(styles.row, styles.signalRow, focused && styles.focused)}
          onClick={() => {
            props.onFocus(row.key);
            props.onSelect(row);
          }}
        >
          <div className={styles.line}>
            {fact.state === null ? <span className={styles.glyphSpace} aria-hidden="true" /> : <StateGlyph state={stateName(fact.state)} size={12} />}
            <span className={styles.name}>{row.label}</span>
            <Word state={fact.state} className={styles.word} />
          </div>
          <div className={mergeClasses(styles.line, styles.valueLine)}>
            <span className={styles.value} data-testid="tl-value">
              {fact.value ?? ""}
            </span>
          </div>
        </div>,
      );
    }
  }
  return <>{items}</>;
}
