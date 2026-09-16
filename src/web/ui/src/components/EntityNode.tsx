import { memo, useCallback } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Handle, Position, useStore } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { Entity, HealthState, SignalValue } from "../model/types";
import { cardTokens, tokensFor } from "../model/palette";
import { HEALTH_SORT_ORDER } from "../model/ordering";
import { useAppDispatch } from "../store/store";
import { selectEntity } from "../store/entitySlice";
import { announce, openPanel, toggleCollapse } from "../store/uiSlice";

export const CARD_WIDTH = 260;
/** Authored disclosure box, its required rendered minimum, and the header band that contains it. */
const TOGGLE_BOX = 26;
const TOGGLE_MIN_RENDERED = 25;
const HEADER_MIN = 54;

const STROKE = `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;

const ICONS: Readonly<Record<string, string>> = {
  root: `<circle cx="12" cy="12" r="8.4" ${STROKE}/><path d="M4.2 12h3l2-3.6 2.8 7.2 1.8-3.6h4" ${STROKE}/>`,
  flow: `<circle cx="5.5" cy="6" r="2" ${STROKE}/><circle cx="5.5" cy="18" r="2" ${STROKE}/><circle cx="18.5" cy="12" r="2" ${STROKE}/><path d="M7.5 6h3a4 4 0 0 1 4 4M7.5 18h3a4 4 0 0 0 4-4" ${STROKE}/>`,
  web: `<circle cx="12" cy="12" r="8.4" ${STROKE}/><path d="M3.6 12h16.8M12 3.6c3 3 3 13.8 0 16.8M12 3.6c-3 3-3 13.8 0 16.8" ${STROKE}/>`,
  app: `<rect x="4" y="4.5" width="16" height="6" rx="1.2" ${STROKE}/><rect x="4" y="13.5" width="16" height="6" rx="1.2" ${STROKE}/><path d="M7.2 7.5h.01M7.2 16.5h.01" ${STROKE}/>`,
  db: `<ellipse cx="12" cy="6" rx="7" ry="2.8" ${STROKE}/><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" ${STROKE}/><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" ${STROKE}/>`,
  queue: `<rect x="4" y="5" width="16" height="3" rx="1" ${STROKE}/><rect x="4" y="10.5" width="16" height="3" rx="1" ${STROKE}/><rect x="4" y="16" width="10" height="3" rx="1" ${STROKE}/>`,
  ship: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${STROKE}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${STROKE}/>`,
  analytics: `<path d="M4 20h16" ${STROKE}/><path d="M6.5 20v-6M12 20V6.5M17.5 20v-9" ${STROKE}/>`,
  bolt: `<path d="M13 2.5 5.5 13.5H11l-1 8 8.5-12H12z" ${STROKE}/>`,
  cache: `<rect x="3.5" y="4" width="17" height="16" rx="2" ${STROKE}/><path d="M8 4v16M3.5 9.5h4M3.5 14.5h4" ${STROKE}/>`,
  shield: `<path d="M12 3l7 2.6v5.2c0 4.6-3 7.9-7 9.2-4-1.3-7-4.6-7-9.2V5.6z" ${STROKE}/><path d="M8.8 12.2l2.2 2.2 4-4.6" ${STROKE}/>`,
  cube: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${STROKE}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${STROKE}/>`,
};

function pickIcon(label: string): string {
  const t = label.toLowerCase();
  const has = (...words: readonly string[]): boolean => words.some((word) => t.includes(word));
  if (has("root")) return "root";
  if (has("front door", "frontend", "web ", "website", "cdn", "web app")) return "web";
  if (has("api", "function", "serverless", "endpoint")) return "bolt";
  if (has("event", "grid")) return "bolt";
  if (has("cache", "redis")) return "cache";
  if (has("database", "sql", "cosmos", "db", "store", "storage")) return "db";
  if (has("queue", "message", "dead-letter", "service bus", "event hub", "hub")) return "queue";
  if (has("ship", "carrier", "logistics", "delivery", "sink")) return "ship";
  if (has("analytics", "report", "pipeline", "ingest", "index", "search", "batch", "scheduler")) return "analytics";
  if (has("security", "defender", "firewall", "waf", "auth", "identity", "entra", "key vault", "secret", "safety")) return "shield";
  if (has("kubernetes", "container", "aks", "pod", "cluster")) return "cube";
  if (has("model", "nested")) return "cube";
  if (has("app", "hosting", "compute", "vm", "worker", "processor", "agent", "tool")) return "app";
  if (has("shop", "commerce", "checkout", "catalog", "order", "payment", "fraud", "flow", "gateway")) return "flow";
  return "cube";
}

function StateDot({ state }: { readonly state: HealthState }): JSX.Element {
  const token = tokensFor(state);
  return (
    <svg className="entity-node__dot" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="6" fill={token.dot} />
      {state === "Healthy" ? (
        <path
          d="M3.3 6 l1.9 1.9 l3.4 -3.9"
          fill="none"
          stroke={cardTokens.pillFill}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
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

function formatValue(value: SignalValue): string {
  return value === null ? "" : String(value);
}

export interface EntityNodeData extends Record<string, unknown> {
  readonly entity: Entity;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly hiddenCount: number;
  readonly hiddenStates: ReadonlyMap<HealthState, number>;
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
  const dispatch = useAppDispatch();
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
    dispatch(toggleCollapse(entity.name));
    dispatch(
      announce(collapsed ? `${name} expanded.` : `${name} collapsed, ${hiddenCount} nodes hidden.`),
    );
  };

  return (
    <button
      type="button"
      className="entity-node__toggle"
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
  const { entity, selected, highlighted, hasChildren, collapsed, hiddenCount, hiddenStates } = data;
  const token = tokensFor(entity.healthState);
  const dispatch = useAppDispatch();
  const name = entity.displayName || entity.name;

  const activate = useCallback(() => {
    dispatch(selectEntity(entity.name));
    dispatch(openPanel());
  }, [dispatch, entity.name]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    },
    [activate],
  );

  return (
    <div className="entity-node-shell" style={{ width: CARD_WIDTH }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <div
        className={`entity-node${selected ? " is-selected" : ""}${highlighted ? " is-highlighted" : ""}`}
        data-entity={entity.name}
        data-highlighted={highlighted ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-label={`${name} — ${entity.healthState}`}
        style={{
          width: CARD_WIDTH,
          borderStyle: token.dashed ? "dashed" : "solid",
          borderColor: token.border,
          backgroundColor: token.fill,
        }}
        onClick={activate}
        onKeyDown={onKeyDown}
      >
      <div className="entity-node__header">
        <span
          className="entity-node__icon"
          style={{ color: cardTokens.muted }}
          aria-hidden="true"
          dangerouslySetInnerHTML={{
            __html: `<svg viewBox="0 0 24 24" width="20" height="20">${ICONS[pickIcon(name)] ?? ICONS.cube}</svg>`,
          }}
        />
        <span className="entity-node__name">{name}</span>
        <span className="entity-node__pill" style={{ borderColor: token.border }}>
          <StateDot state={entity.healthState} />
          <span className="entity-node__pill-word">{token.word}</span>
        </span>
        {hasChildren ? (
          <CollapseToggle entity={entity} collapsed={collapsed} hiddenCount={hiddenCount} />
        ) : null}
      </div>
      {entity.signals.length > 0 ? (
        <>
          <div className="entity-node__divider" />
          <ul className="entity-node__rows">
            {entity.signals.map((signal) => {
              const healthy = signal.healthState === "Healthy";
              const value = formatValue(signal.value);
              return (
                <li className="entity-node__row" key={signal.name}>
                  <StateDot state={signal.healthState} />
                  <MetricGlyph />
                  <span className="entity-node__row-name">{signal.displayName || signal.name}</span>
                  <span
                    className="entity-node__row-value"
                    style={{
                      fontWeight: healthy ? 400 : 600,
                      color: healthy ? cardTokens.muted : tokensFor(signal.healthState).dot,
                    }}
                  >
                    {value}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {collapsed && hiddenCount > 0 ? (
        <HiddenSummary hiddenCount={hiddenCount} hiddenStates={hiddenStates} />
      ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="entity-node__handle" />
    </div>
  );
}

export const EntityNode = memo(EntityNodeImpl);

export function estimateNodeSize(
  entity: Entity,
  showsHiddenSummary = false,
): { readonly width: number; readonly height: number } {
  const name = entity.displayName || entity.name;
  const pillWidth = 34 + tokensFor(entity.healthState).word.length * 6.6;
  const nameAvail = Math.max(80, CARD_WIDTH - 34 - pillWidth - 12 - 26);
  const nameLines = Math.max(1, Math.ceil((name.length * 6.9) / nameAvail));
  // Mirrors the rendered header exactly: `min-height: 54px`, else 10px padding twice plus the
  // wrapped name at its 17px line box.
  const headerHeight = Math.max(HEADER_MIN, 20 + nameLines * 17);
  const rowsHeight = entity.signals.length > 0 ? 16 + entity.signals.length * 22 : 0;
  return {
    width: CARD_WIDTH,
    height: headerHeight + rowsHeight + (showsHiddenSummary ? 28 : 0),
  };
}
