import { memo, useMemo } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Handle, Position, useStore } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { Entity, EntitySignal, HealthState } from "../model/types";
import { SPARK_HEIGHT, SPARK_WIDTH, sparkline } from "../model/cardSignals";
import { stateName, type Span } from "../model/timeline";
import type { ChangeBadge } from "../model/changes";
import { cardTokens, diffTokens, impactOf, impactStyle, tokensFor } from "../model/palette";
import { StateGlyph } from "./StateGlyph";
import { EntityCardHeading, EntityHealthPill } from "./EntityCardHeading";
export { ICONS, pickIcon } from "./EntityCardHeading";
import { LEVEL_HEIGHT, type ZoomLevel } from "../model/zoomLevels";
import { HEALTH_SORT_ORDER } from "../model/ordering";
import { formatSignalValue } from "../model/signalValue";
import { actions, useStore as useAppStore } from "../store/store";
import { selectSparksOf, type SparkLine } from "../store/timelineSlice";
import { useAtMoment } from "../timeline/useAtMoment";

export const CARD_WIDTH = 260;
export const DOT_SIZE = 12;
/** Authored disclosure box, its required rendered minimum, and the header band that contains it. */
const TOGGLE_BOX = 26;
const TOGGLE_MIN_RENDERED = 25;
const HEADER_MIN = 54;
/** The row under the header that names a Limited or Suppressed impact. */
const CHIP_ROW = 26;

function StateDot({ state }: { readonly state: HealthState }): JSX.Element {
  return <StateGlyph state={state} size={12} className="entity-node__dot" />;
}

function MetricGlyph(): JSX.Element {
  const [a, b, c] = cardTokens.metricBars;
  return (
    <svg className="entity-node__metric" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="8" width="2.6" height="6" rx="0.6" fill={a} />
      <rect x="5.7" y="4.5" width="2.6" height="9.5" rx="0.6" fill={b} />
      <rect x="9.9" y="6.5" width="2.6" height="7.5" rx="0.6" fill={c} />
    </svg>
  );
}

const levelColour = (level: number): string => tokensFor(stateName(level)).dot;

/**
 * The signal's values over the hours that end at the selected moment, in the colour of the health of each stretch, with
 * a mark at the moment. Until the window is read it is a faint flat line of the same size.
 */
const Sparkline = memo(function Sparkline({ line, span }: { readonly line: SparkLine | undefined; readonly span: Span }): JSX.Element {
  const points = line?.points;
  const info = line?.info;
  const drawn = useMemo(() => sparkline(points ?? [], info, span), [points, info, span]);
  const empty = drawn.paths.length === 0;
  return (
    <svg
      className="entity-node__spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      aria-hidden="true"
      data-testid="sparkline"
      data-empty={empty ? "true" : undefined}
    >
      {empty ? <path className="entity-node__spark-empty" d={`M0 ${SPARK_HEIGHT / 2}H${SPARK_WIDTH}`} /> : null}
      {drawn.paths.map((path) => (
        <path key={path.level} d={path.d} stroke={levelColour(path.level)} data-level={path.level} />
      ))}
      <path className="entity-node__spark-moment" d={`M${SPARK_WIDTH - 0.5} 0V${SPARK_HEIGHT}`} />
      {drawn.marker ? <circle cx={drawn.marker.x} cy={drawn.marker.y} r={1.8} fill={levelColour(drawn.marker.level)} /> : null}
    </svg>
  );
});

/** The signal rows of a card, each with its sparkline. One selector per card reads what is held for its signals. */
function SignalRows({ name, signals }: { readonly name: string; readonly signals: readonly EntitySignal[] }): JSX.Element {
  const select = useMemo(() => selectSparksOf(name), [name]);
  const sparks = useAtMoment(select);
  return (
    <>
      <div className="entity-node__divider" />
      <ul className="entity-node__rows">
        {signals.map((signal) => {
          const healthy = signal.healthState === "Healthy";
          const value = formatSignalValue(signal.value);
          return (
            <li className="entity-node__row" key={signal.name}>
              <StateDot state={signal.healthState} />
              <MetricGlyph />
              <span className="entity-node__row-name" title={signal.displayName || signal.name}>
                {signal.displayName || signal.name}
              </span>
              <Sparkline line={sparks.lines.get(signal.name)} span={sparks.window} />
              <span
                className="entity-node__row-value"
                title={signal.value === null ? undefined : String(signal.value)}
                style={{
                  fontWeight: healthy ? 400 : 600,
                  color: healthy ? cardTokens.muted : tokensFor(signal.healthState).label,
                }}
              >
                {value}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export interface EntityNodeData extends Record<string, unknown> {
  readonly entity: Entity;
  readonly displayRole: "card" | "dot";
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly hiddenCount: number;
  readonly hiddenStates: ReadonlyMap<HealthState, number>;
  /** What a compared Health model diff does to this entity. */
  readonly badge: ChangeBadge | null;
  /** The entity has a change the user ticked. */
  readonly marked: boolean;
  /** The entity is part of the open Explain result's cause chain. */
  readonly inChain: boolean;
  /** What the zoom shows of a card: the card, a name pill, or a dot. */
  readonly level: ZoomLevel;
  /** The card can be moved to another place with the keyboard: M picks it up. */
  readonly reorderable?: boolean;
  /** The card is being dragged: it stays where its place would be, dimmed. */
  readonly dragging?: boolean;
  /** A see-through copy that follows the pointer while the card is dragged; `blocked` while no place would take it. */
  readonly ghost?: "free" | "blocked";
}

const CHEVRON = `<path d="M4 6.5 8 10.5 12 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

function CollapseToggle({
  entity,
  collapsed,
  hiddenCount,
}: {
  readonly entity: Entity;
  readonly collapsed: boolean;
  readonly hiddenCount: number;
}): JSX.Element {
  const name = entity.displayName || entity.name;
  const label = collapsed ? `Expand ${name}, ${hiddenCount} hidden` : `Collapse ${name}`;
  // The card lives inside the React Flow viewport transform, so the authored 26px box renders at
  // 26 * zoom CSS pixels: a fitted 22-node graph took it to ~13px and the pointer target with it.
  // Counter-scaling holds the rendered target at its 25px minimum, capped at the largest box the
  // 54px header band still contains, so the target can never grow out of its own card. A transform
  // never reflows, so header, card, `measured` and edge geometry stay exactly as laid out.
  // Selecting `transform[2]` alone keeps panning out of this subscription; only a zoom change
  // re-renders a toggle.
  const zoom = useStore((state) => state.transform[2]);
  const scale =
    zoom > 0 && zoom * TOGGLE_BOX < TOGGLE_MIN_RENDERED
      ? Math.min(TOGGLE_MIN_RENDERED / (TOGGLE_BOX * zoom), (HEADER_MIN - 4) / TOGGLE_BOX)
      : 1;

  const toggle = (): void => {
    actions.toggleCollapse(entity.name);
    actions.announce(
      collapsed ? `${name} expanded.` : `${name} collapsed, ${hiddenCount} nodes hidden.`,
    );
  };

  return (
    <button
      type="button"
      className="entity-node__toggle nodrag"
      data-testid="collapse-toggle"
      style={scale === 1 ? undefined : { transform: `scale(${scale})` }}
      aria-expanded={!collapsed}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
      // The chevron sits inside the card's own `role="button"` region, so its keyboard activation
      // must not bubble up and open the detail panel as well.
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }}
    >
      <span
        className={`entity-node__chevron${collapsed ? " is-collapsed" : ""}`}
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: `<svg viewBox="0 0 16 16" width="16" height="16">${CHEVRON}</svg>`,
        }}
      />
    </button>
  );
}

/** Plain counts of what a collapsed card currently hides, grouped by health state. */
function HiddenSummary({
  hiddenCount,
  hiddenStates,
}: {
  readonly hiddenCount: number;
  readonly hiddenStates: ReadonlyMap<HealthState, number>;
}): JSX.Element {
  const buckets = HEALTH_SORT_ORDER.filter((state) => (hiddenStates.get(state) ?? 0) > 0).map(
    (state) => [state, hiddenStates.get(state) as number] as const,
  );
  const spoken = buckets.map(([state, count]) => `${count} ${state}`).join(", ");

  return (
    <div
      className="entity-node__hidden"
      data-testid="hidden-summary"
      role="group"
      aria-label={`${hiddenCount} hidden${spoken ? `: ${spoken}` : ""}`}
    >
      <span className="entity-node__hidden-count" data-testid="hidden-count">
        {hiddenCount}
      </span>
      <span className="entity-node__hidden-word">hidden</span>
      {buckets.map(([state, count]) => (
        <span className="entity-node__hidden-chip" key={state} data-state={state}>
          <StateDot state={state} />
          <span className="entity-node__hidden-chip-count">{count}</span>
        </span>
      ))}
    </div>
  );
}

export type EntityRfNode = Node<EntityNodeData, "entity">;

function EntityNodeImpl({ data }: NodeProps<EntityRfNode>): JSX.Element {
  const { entity, displayRole, selected, highlighted, hasChildren, collapsed, hiddenCount, hiddenStates, badge, marked, inChain, level, reorderable, dragging, ghost } = data;
  const moving = `${dragging ? " is-dragging" : ""}${ghost ? ` is-ghost${ghost === "blocked" ? " is-blocked" : ""}` : ""}`;
  const reorder = ghost ? { "aria-hidden": true as const } : { tabIndex: 0, ...(reorderable ? { "aria-keyshortcuts": "M" } : {}) };
  const token = tokensFor(entity.healthState);
  const name = entity.displayName || entity.name;
  const impact = impactOf(entity.impact);
  const cardSignals = useAppStore((state) => state.cardSignals);

  const activate = (): void => {
    actions.activateEntity(entity.name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };

  if (displayRole === "card" && level !== "card") {
    // Far out a card is a name pill or a dot of its state; it keeps the width of a card, so the
    // lines meet it where the card's would, and only its height changes.
    const height = LEVEL_HEIGHT[level];
    return (
      <div className="entity-node-shell entity-node-shell--lod" style={{ width: CARD_WIDTH }}>
        <Handle type="target" position={Position.Top} className="entity-node__handle" />
        <div
          className={`entity-node entity-node--${level}${selected ? " is-selected" : ""}${highlighted ? " is-highlighted" : ""}${inChain ? " is-chain" : ""}${marked ? " is-marked" : ""}${moving}`}
          data-entity={entity.name}
          data-role="card"
          data-lod={level}
          data-highlighted={highlighted ? "true" : undefined}
          data-badge={badge ?? undefined}
          data-chain={inChain ? "true" : undefined}
          data-marked={marked ? "true" : undefined}
          role="button"
          {...reorder}
          aria-label={`${name} (${entity.healthState}${impact === "Standard" ? "" : `, ${impactStyle[impact].word}`})${badge ? `, ${badge} in the proposed changes` : ""}`}
          title={`${name} · ${entity.healthState}`}
          style={{
            width: level === "pill" ? CARD_WIDTH : height,
            height,
            borderStyle: impact === "Suppressed" ? "dotted" : token.dashed ? "dashed" : "solid",
            borderColor: token.border,
            backgroundColor: token.fill,
          }}
          onClick={activate}
          onKeyDown={onKeyDown}
        >
          {level === "pill" ? (
            <>
              <StateGlyph state={entity.healthState} size={26} />
              <span className="entity-node__name">{name}</span>
              {impact === "Standard" ? null : <span aria-hidden="true">{impactStyle[impact].glyph}</span>}
              {badge ? (
                <span className="entity-node__lodmark" data-badge={badge} aria-hidden="true">
                  {diffTokens[badge].glyph}
                </span>
              ) : null}
            </>
          ) : (
            <StateGlyph state={entity.healthState} size={level === "dot" ? 28 : 58} />
          )}
        </div>
        <Handle type="source" position={Position.Bottom} className="entity-node__handle" />
      </div>
    );
  }

  return (
    <div className="entity-node-shell" style={{ width: displayRole === "dot" ? DOT_SIZE : CARD_WIDTH }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <div
        className={`entity-node${displayRole === "dot" ? " entity-node--dot" : ""}${selected ? " is-selected" : ""}${highlighted ? " is-highlighted" : ""}${inChain ? " is-chain" : ""}${marked ? " is-marked" : ""}${moving}`}
        data-entity={entity.name}
        data-role={displayRole}
        data-highlighted={highlighted ? "true" : undefined}
        data-badge={badge ?? undefined}
        data-chain={inChain ? "true" : undefined}
        data-marked={marked ? "true" : undefined}
        role="button"
        {...reorder}
        aria-label={`${name} (${entity.healthState}${displayRole === "dot" ? ", filtered" : ""}${impact === "Standard" ? "" : `, ${impactStyle[impact].word}`})${badge ? `, ${badge} in the proposed changes` : ""}`}
        style={{
          width: displayRole === "dot" ? DOT_SIZE : CARD_WIDTH,
          height: displayRole === "dot" ? DOT_SIZE : undefined,
          borderStyle: displayRole === "dot" ? "solid" : impact === "Suppressed" ? "dotted" : token.dashed ? "dashed" : "solid",
          borderColor: displayRole === "dot" ? "var(--unknown-border)" : token.border,
          backgroundColor: displayRole === "dot" ? "var(--unknown-dot)" : token.fill,
        }}
        onClick={activate}
        onKeyDown={onKeyDown}
      >
      {displayRole === "dot" ? (
        <span className="entity-node__dot-only" aria-hidden="true" />
      ) : (
        <>
          {badge ? (
            <span className="entity-node__badge" data-testid="change-badge" data-badge={badge}>
              {badge}
            </span>
          ) : null}
          <EntityCardHeading name={name}>
            <EntityHealthPill state={entity.healthState} />
            {hasChildren ? <CollapseToggle entity={entity} collapsed={collapsed} hiddenCount={hiddenCount} /> : null}
          </EntityCardHeading>
          {impact !== "Standard" ? (
            <div className="entity-node__chips">
              <span className="entity-node__chip" data-testid="impact-chip" data-impact={impact}>
                <span aria-hidden="true">{impactStyle[impact].glyph}</span> {impactStyle[impact].word}
              </span>
            </div>
          ) : null}
          {cardSignals && entity.signals.length > 0 ? <SignalRows name={entity.name} signals={entity.signals} /> : null}
          {collapsed && hiddenCount > 0 ? (
            <HiddenSummary hiddenCount={hiddenCount} hiddenStates={hiddenStates} />
          ) : null}
        </>
      )}
      </div>
      <Handle type="source" position={Position.Bottom} className="entity-node__handle" />
    </div>
  );
}

export const EntityNode = memo(EntityNodeImpl);

/** The size of a card as it renders: `signals` is whether it shows its signal rows (the toolbar's Signals). */
export function estimateNodeSize(
  entity: Entity,
  showsHiddenSummary = false,
  displayRole: "card" | "dot" = "card",
  signals = true,
): { readonly width: number; readonly height: number } {
  if (displayRole === "dot") {
    return { width: DOT_SIZE, height: DOT_SIZE };
  }
  const name = entity.displayName || entity.name;
  const pillWidth = 34 + tokensFor(entity.healthState).word.length * 6.6;
  const nameAvail = Math.max(80, CARD_WIDTH - 34 - pillWidth - 12 - 26);
  const nameLines = Math.max(1, Math.ceil((name.length * 6.9) / nameAvail));
  // Mirrors the rendered header exactly: `min-height: 54px`, else 10px padding twice plus the
  // wrapped name at its 17px line box.
  const headerHeight = Math.max(HEADER_MIN, 20 + nameLines * 17);
  const rowsHeight = signals && entity.signals.length > 0 ? 16 + entity.signals.length * 22 : 0;
  const chipHeight = impactOf(entity.impact) === "Standard" ? 0 : CHIP_ROW;
  return {
    width: CARD_WIDTH,
    height: headerHeight + chipHeight + rowsHeight + (showsHiddenSummary ? 28 : 0),
  };
}
