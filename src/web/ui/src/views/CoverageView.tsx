import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { ChangeBadge } from "../model/changes";
import { visibleGraph } from "../model/collapse";
import { noEntitiesText } from "../model/compare";
import { coverage, neighbour, type Direction } from "../model/coverage";
import { layoutCoverage, type LaidCell } from "../model/coverageLayout";
import { diffTokens, impactOf, impactStyle, tokensFor } from "../model/palette";
import type { ReorderWorld } from "../model/reorder";
import type { Entity } from "../model/types";
import { StateGlyph } from "../components/StateGlyph";
import { useStore } from "../store/store";
import type { ViewProps } from "./types";
import { useReorder } from "./useReorder";

const FALLBACK_WIDTH = 1200;
const PADDING = 16;
const KEYS: Readonly<Record<string, Direction>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "first",
  End: "last",
};

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  bar: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1 },
  scroll: { flex: 1, minHeight: 0, overflow: "auto", padding: tokens.spacingHorizontalM },
  empty: { padding: tokens.spacingHorizontalXL, textAlign: "center", color: tokens.colorNeutralForeground2 },
});

/** The width the view can draw in: its container's, measured. */
function useWidth(): { readonly ref: (node: HTMLDivElement | null) => void; readonly width: number } {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = (): void => {
      const next = Math.floor(node.clientWidth - 2 * PADDING);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "function") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(node);
    }
  }, []);
  return { ref, width };
}

interface CellProps {
  readonly cell: LaidCell;
  readonly entity: Entity;
  readonly parts: number;
  readonly step: number | null;
  /** What the diff of a Compare does to the entity. */
  readonly badge: ChangeBadge | null;
  /** The entity's changes are ticked in the change list of a Compare. */
  readonly marked: boolean;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly active: boolean;
  readonly strips: boolean;
  readonly otherParents: number;
  /** The cell can be moved among its siblings: M picks it up, and so does a drag. */
  readonly reorderable?: boolean;
  /** It is being moved: it stays where its place would be, dimmed. */
  readonly dragging?: boolean;
  /** A see-through copy that follows the pointer, drawn at this corner; `blocked` while no place would take it. */
  readonly ghost?: { readonly x: number; readonly y: number; readonly blocked: boolean };
  readonly onActivate: (name: string) => void;
  readonly onZoom: (name: string) => void;
  readonly onFocusCell: (name: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<SVGGElement>, name: string) => void;
  readonly onGrab?: (name: string, event: ReactPointerEvent<Element>) => void;
}

function Cell({ cell, entity, parts, step, badge, marked, selected, highlighted, active, strips, otherParents, reorderable, dragging, ghost, onActivate, onZoom, onFocusCell, onKeyDown, onGrab }: CellProps): JSX.Element {
  const token = tokensFor(entity.healthState);
  const impact = impactOf(entity.impact);
  const loud = entity.healthState === "Degraded" || entity.healthState === "Unhealthy";
  const name = entity.displayName || entity.name;
  const dash = impact === "Suppressed" ? impactStyle.Suppressed.dash : impact === "Limited" ? impactStyle.Limited.dash : token.dashed ? "4 3" : undefined;
  const diff = badge ? diffTokens[badge] : null;
  const fill = badge === "removed" && diff ? diff.tint : strips && entity.healthState !== "Healthy" ? `url(#coverage-${entity.healthState})` : token.fill;
  const struck = badge === "removed" || entity.healthState === "Deleted";
  const spoken = `${name}, ${entity.healthState}${impact === "Standard" ? "" : `, ${impactStyle[impact].word}`}${parts > 0 ? `, ${parts} leaf parts below` : ""}${badge ? `, ${badge} in the proposed changes` : ""}${step === null ? "" : `, step ${step} of the chain`}`;
  return (
    <g
      className={mergeClasses("coverage-cell", dragging && "is-dragging", ghost && "is-ghost", ghost?.blocked && "is-blocked")}
      data-state={entity.healthState}
      data-step={step ?? undefined}
      data-badge={badge ?? undefined}
      data-marked={marked ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      transform={`translate(${ghost?.x ?? cell.x} ${ghost?.y ?? cell.y})`}
      {...(ghost
        ? { "data-testid": "reorder-ghost", "aria-hidden": true }
        : {
            "data-testid": "coverage-cell",
            "data-entity": entity.name,
            role: "button",
            tabIndex: active ? 0 : -1,
            "aria-label": spoken,
            "aria-pressed": selected,
            "aria-keyshortcuts": reorderable ? "M" : undefined,
            onClick: () => onActivate(entity.name),
            onDoubleClick: () => onZoom(entity.name),
            onFocus: () => onFocusCell(entity.name),
            onKeyDown: (event: KeyboardEvent<SVGGElement>) => onKeyDown(event, entity.name),
            onPointerDown: (event: ReactPointerEvent<SVGGElement>) => onGrab?.(entity.name, event),
          })}
    >
      <title>{`${name} · ${entity.healthState}${diff ? ` · ${diff.word}` : ""}`}</title>
      <rect
        className="coverage-cell__ring"
        x={-3}
        y={-3}
        width={cell.width + 6}
        height={cell.height + 6}
        rx={8}
        fill="none"
        stroke={marked ? "var(--colorPaletteMarigoldBorderActive)" : "var(--colorBrandStroke1)"}
        strokeWidth={highlighted || marked ? 3.5 : 2.5}
        style={{ opacity: selected || highlighted || marked || step !== null ? 1 : undefined }}
        strokeDasharray={step !== null && !selected ? "5 3" : undefined}
      />
      <rect
        width={cell.width}
        height={cell.height}
        rx={cell.width < 8 ? 1 : 5}
        fill={fill}
        stroke={diff ? diff.line : entity.healthState === "Healthy" ? "var(--colorNeutralStroke1)" : token.border}
        strokeWidth={entity.healthState === "Unhealthy" || (diff && !strips) ? 2 : strips ? 0.5 : 1.2}
        strokeDasharray={strips ? undefined : dash}
        strokeLinecap="round"
      />
      {loud && !strips && cell.width > 12 ? <rect x={5} y={0} width={cell.width - 10} height={4} rx={2} fill={token.dot} /> : null}
      {cell.glyph ? (
        <g transform={`translate(${cell.width < 28 ? cell.width / 2 - 5.5 : 7} 7)`}>
          <StateGlyph state={entity.healthState} size={cell.width < 28 ? 11 : 15} />
        </g>
      ) : null}
      {cell.label !== null && cell.labelAxis === "horizontal" ? (
        <text className="coverage-cell__label" x={26} y={19} fontSize={12} fontWeight={600} textDecoration={struck ? "line-through" : undefined}>
          {cell.label}
        </text>
      ) : null}
      {cell.label !== null && cell.labelAxis === "vertical" ? (
        <text className="coverage-cell__label" transform={`translate(${cell.width / 2 - 4} 30) rotate(90)`} fontSize={cell.width < 22 ? 10.5 : 11.5} textDecoration={struck ? "line-through" : undefined}>
          {cell.label}
        </text>
      ) : null}
      {cell.badge ? (
        <g aria-hidden="true">
          <circle cx={cell.width - 11} cy={14} r={7.5} fill="var(--colorNeutralBackground1)" stroke="var(--colorNeutralForeground3)" />
          <text x={cell.width - 11} y={17.6} textAnchor="middle" fontSize={10} fontWeight={700} className="coverage-cell__label">
            {otherParents + 1}
          </text>
        </g>
      ) : null}
      {diff && badge ? (
        cell.width >= 40 && !strips ? (
          <g aria-hidden="true" data-testid="coverage-badge" data-badge={badge} transform={`translate(${cell.width - 19} ${cell.height - 18})`}>
            <rect width={15} height={15} rx={7.5} fill={diff.tint} stroke={diff.line} strokeWidth={1.2} />
            <text x={7.5} y={11.5} textAnchor="middle" fontSize={11} fontWeight={700} fill={diff.ink}>
              {diff.glyph}
            </text>
          </g>
        ) : (
          // Too narrow for a mark with a glyph: a bar across the foot of the cell in the mark's colour.
          <rect aria-hidden="true" data-testid="coverage-badge" data-badge={badge} x={0} y={cell.height - (strips ? 8 : 6)} width={cell.width} height={strips ? 8 : 6} rx={1} fill={diff.line} />
        )
      ) : null}
      {impact !== "Standard" && cell.width >= 24 && cell.height > 52 && !strips ? (
        <text className="coverage-cell__label" x={8} y={cell.height - 8} fontSize={12} fontWeight={700} aria-hidden="true">
          {impactStyle[impact].glyph}
        </text>
      ) : null}
      {step !== null ? (
        <g aria-hidden="true">
          <circle cx={cell.width / 2} cy={-2} r={9} fill="var(--colorBrandBackground)" />
          <text x={cell.width / 2} y={2} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--colorNeutralForegroundOnBrand)">
            {step}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export function CoverageView({ entities, relationships, selectedName, highlightedName, chainNames, badges, marked, compare, onActivate }: ViewProps): JSX.Element {
  const styles = useStyles();
  const selectedHealth = useStore((state) => state.selectedHealth);
  const focusSeq = useStore((state) => state.focusSeq);
  const focusNames = useStore((state) => state.focusNames);
  const { ref, width } = useWidth();
  const [zoom, setZoom] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const filtered = useMemo(
    () => visibleGraph(entities, relationships, new Set(), { selectedHealth: new Set(selectedHealth), excludedEntityMode: "hide" }),
    [entities, relationships, selectedHealth],
  );
  const byName = useMemo(() => new Map(filtered.entities.map((entity) => [entity.name, entity] as const)), [filtered]);
  // The viewer's order, shared with every view; while a cell is dragged, the order a drop would keep.
  const reorder = useReorder({ labelOf: (name) => byName.get(name)?.displayName || name });
  const model = useMemo(() => coverage(filtered.entities, filtered.relationships, { focus: zoom, order: reorder.order }), [filtered, zoom, reorder.order]);
  const layout = useMemo(
    () => layoutCoverage(model, (name) => byName.get(name)?.displayName || name, width),
    [model, byName, width],
  );
  const laid = useMemo(() => new Map(layout.cells.map((cell) => [cell.name, cell] as const)), [layout]);
  const cellOf = useMemo(() => new Map(model.cells.map((cell) => [cell.name, cell] as const)), [model]);
  // A cell trades places with the cells under the same parent, and a part that is not connected to the root with
  // the other such parts; what is below a cell goes along. A compared model is not dragged.
  const world = useMemo<ReorderWorld | null>(() => {
    if (compare !== undefined) return null;
    const siblings = new Map<string, string[]>();
    for (const cell of model.cells) {
      const group = cell.parent ?? `#band:${cell.band}`;
      siblings.set(group, [...(siblings.get(group) ?? []), cell.name]);
    }
    return {
      rows: [...siblings.values()],
      rects: new Map(layout.cells.map((cell) => [cell.name, { x: cell.x, y: cell.y, width: cell.width, height: cell.height }] as const)),
      parents: new Map(model.cells.map((cell) => [cell.name, cell.parent === null ? [] : [cell.parent]] as const)),
    };
  }, [compare, model, layout]);
  reorder.offer(world);
  const moving = reorder.move;
  const onGrab = useCallback(
    (name: string, event: ReactPointerEvent<Element>): void => {
      reorder.onPointerDown(name, event, (client) => {
        const matrix = svg.current?.getScreenCTM?.();
        if (!matrix) return client;
        const local = new DOMPoint(client.x, client.y).matrixTransform(matrix.inverse());
        return { x: local.x, y: local.y };
      });
    },
    [reorder.onPointerDown],
  );
  const steps = useMemo(() => {
    const lower = new Map(filtered.entities.map((entity) => [entity.name.toLowerCase(), entity.name] as const));
    const names = chainNames.map((name) => lower.get(name.toLowerCase())).filter((name): name is string => name !== undefined).reverse();
    return new Map(names.map((name, index) => [name, index + 1] as const));
  }, [filtered, chainNames]);

  const zoomTo = useCallback((name: string | null): void => {
    setZoom(name);
    setActive(name);
  }, []);
  const focusCell = useCallback((name: string): void => {
    svg.current?.querySelector<SVGGElement>(`[data-entity="${CSS.escape(name)}"]`)?.focus();
  }, []);

  // Search and "Show on graph": zoom out if the entity is not in this part, then bring it into view.
  const lastFocus = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq === 0 || focusSeq <= lastFocus.current || focusNames.length === 0) return;
    lastFocus.current = focusSeq;
    const target = focusNames[0] as string;
    if (zoom !== null && !coverage(filtered.entities, filtered.relationships, { focus: zoom }).cells.some((cell) => cell.name === target)) setZoom(null);
    setActive(target);
    const frame = requestAnimationFrame(() => {
      svg.current?.querySelector<SVGGElement>(`[data-entity="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "center", inline: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSeq, focusNames, zoom, filtered]);

  const current = active !== null && cellOf.has(active) ? active : (model.cells[0]?.name ?? null);

  const onKeyDown = (event: KeyboardEvent<SVGGElement>, name: string): void => {
    const direction = KEYS[event.key];
    if (direction !== undefined) {
      event.preventDefault();
      const next = neighbour(model, name, direction);
      if (next !== null) focusCell(next);
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      if (!cellOf.get(name)?.leaf) zoomTo(name);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(name);
    } else if (event.key === "z" && !event.ctrlKey && !event.metaKey) {
      if (!cellOf.get(name)?.leaf) zoomTo(name);
    } else if ((event.key === "Escape" || event.key === "Backspace") && zoom !== null) {
      event.preventDefault();
      zoomTo(model.trail.length > 1 ? (model.trail[model.trail.length - 2] as string) : null);
    }
  };

  const arcFor = selectedName !== null && cellOf.has(selectedName) ? selectedName : current;
  const arcs = useMemo(() => {
    const from = arcFor === null ? undefined : laid.get(arcFor);
    const cell = arcFor === null ? undefined : cellOf.get(arcFor);
    if (!from || !cell) return [];
    return cell.otherParents.flatMap((parent) => {
      const to = laid.get(parent);
      if (!to) return [];
      const x1 = from.x + from.width / 2;
      const y1 = from.y;
      const x2 = to.x + to.width / 2;
      const y2 = to.y + to.height;
      const lift = Math.max(30, Math.abs(y1 - y2) / 2);
      return [{ parent, d: `M${x1} ${y1} C${x1} ${y1 - lift} ${x2} ${y2 + lift} ${x2} ${y2}` }];
    });
  }, [arcFor, laid, cellOf]);

  const trail = model.trail;
  const strips = layout.density === "strips";
  const hatch = (state: "Degraded" | "Unknown" | "Unhealthy"): JSX.Element => (
    <pattern id={`coverage-${state}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill={tokensFor(state).fill} />
      <rect width={state === "Unhealthy" ? 6 : state === "Degraded" ? 3 : 1.5} height="6" fill={tokensFor(state).dot} />
    </pattern>
  );

  return (
    <div className={mergeClasses(styles.root, moving !== null && "is-reordering")} data-testid="coverage-view" {...reorder.root}>
      <div className={styles.bar} data-testid="coverage-breadcrumb" role="navigation" aria-label="Zoom path">
        <Button size="small" appearance="subtle" disabled={zoom === null} onClick={() => zoomTo(null)} data-testid="coverage-zoom-out">
          Whole model
        </Button>
        {trail.map((name, index) => (
          <span key={name}>
            <span aria-hidden="true">›</span>{" "}
            <Button size="small" appearance="subtle" disabled={index === trail.length - 1} onClick={() => zoomTo(name)} data-testid="coverage-trail">
              {byName.get(name)?.displayName || name}
            </Button>
          </span>
        ))}
        <span className={styles.grow} />
        <span role="status" data-testid="coverage-note">
          {strips
            ? `${model.cells.length} parts: too many for names. Use the arrow keys or zoom into a part.`
            : "Double-click or Shift+Enter zooms into a part, Escape back out."}
        </span>
      </div>
      <div className={styles.scroll} ref={ref}>
        {model.cells.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="coverage">
            {entities.length === 0 ? noEntitiesText(compare) : "The Health filter hides every entity."}
          </div>
        ) : (
          <svg
            ref={svg}
            width={layout.width}
            height={layout.height + 12}
            viewBox={`-4 -12 ${layout.width + 8} ${layout.height + 24}`}
            role="group"
            aria-label="Coverage of the health model"
            className="coverage"
            data-density={layout.density}
          >
            <defs>
              {hatch("Unhealthy")}
              {hatch("Degraded")}
              {hatch("Unknown")}
            </defs>
            {layout.bands.map((band) =>
              band.band === 1 ? (
                <text key="unconnected" className="coverage-cell__label" x={0} y={band.y - 14} fontSize={10.5} fontWeight={700} letterSpacing="0.05em">
                  NOT CONNECTED TO THE ROOT
                </text>
              ) : null,
            )}
            {layout.cells.map((cell) => {
              const entity = byName.get(cell.name) as Entity;
              const model_ = cellOf.get(cell.name)!;
              return (
                <Cell
                  key={cell.name}
                  cell={cell}
                  entity={entity}
                  parts={model_.leaf ? 0 : model_.span}
                  step={steps.get(cell.name) ?? null}
                  badge={badges?.get(cell.name.toLowerCase()) ?? null}
                  marked={marked?.has(cell.name.toLowerCase()) ?? false}
                  selected={cell.name === selectedName}
                  highlighted={cell.name === highlightedName}
                  active={cell.name === current}
                  strips={strips}
                  otherParents={model_.otherParents.length}
                  reorderable={world !== null}
                  dragging={moving?.id === cell.name}
                  onGrab={onGrab}
                  onActivate={onActivate}
                  onZoom={(name) => {
                    if (!cellOf.get(name)?.leaf) zoomTo(name);
                  }}
                  onFocusCell={setActive}
                  onKeyDown={onKeyDown}
                />
              );
            })}
            {(() => {
              const moved = moving === null ? undefined : laid.get(moving.id);
              const entity = moving === null ? undefined : byName.get(moving.id);
              if (!moving || !moved || !entity) return null;
              return (
                <g aria-hidden="true" pointerEvents="none">
                  {moving.candidate ? <rect className="drop-indicator--svg" data-testid="drop-indicator" x={moved.x} y={moved.y} width={moved.width} height={moved.height} rx={5} /> : null}
                  {moving.pointer ? (
                    <Cell
                      cell={moved}
                      entity={entity}
                      parts={0}
                      step={null}
                      badge={null}
                      marked={false}
                      selected={false}
                      highlighted={false}
                      active={false}
                      strips={strips}
                      otherParents={0}
                      ghost={{ ...moving.pointer, blocked: moving.candidate === null }}
                      onActivate={onActivate}
                      onZoom={zoomTo}
                      onFocusCell={setActive}
                      onKeyDown={onKeyDown}
                    />
                  ) : null}
                </g>
              );
            })()}
            <g aria-hidden="true" pointerEvents="none">
              {arcs.map((arc) => (
                <path key={arc.parent} data-testid="coverage-arc" data-parent={arc.parent} d={arc.d} fill="none" stroke="var(--colorBrandStroke1)" strokeWidth={2.4} strokeDasharray="6 4" />
              ))}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}
