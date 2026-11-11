import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Button, ToggleButton, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Handle, Position, ReactFlow, ReactFlowProvider, getViewportForBounds, useReactFlow } from "@xyflow/react";
import type { Node, NodeProps, NodeTypes } from "@xyflow/react";
import type { ChangeBadge } from "../model/changes";
import { visibleGraph } from "../model/collapse";
import { SIDE_LABEL, linkKey, noEntitiesText } from "../model/compare";
import { layerOf } from "../model/layerOf";
import { chainSteps } from "../model/chainSteps";
import { diffTokens, edgeAppearance, impactOf, impactStyle, tokensFor } from "../model/palette";
import { LANE_GUTTER, contentKey, firstProblem, foldId, layoutSwimlanes, lineageOf, withParents, type SwimCard, type SwimFold, type SwimLane, type SwimlaneLayout } from "../model/swimlanes";
import type { Entity } from "../model/types";
import { actions, canvasFrame, useStore } from "../store/store";
import { ICONS, pickIcon } from "../components/EntityNode";
import { StateGlyph } from "../components/StateGlyph";
import { stepEdge, stepEdgeTypes, type StepRfEdge } from "../components/StepEdge";
import { prefersReducedMotion } from "../components/Topology";
import type { ViewProps } from "./types";
import "./swimlanes.css";

const MIN_ZOOM = 0.08;
const MAX_FIT_ZOOM = 1;
const FIT_PADDING = 0.06;
/** A fit that would draw text below this zoom is not worth showing first: the view opens on the problem instead. */
const LEGIBLE_ZOOM = 0.5;
const FIT_MS = 500;
const FOCUS_MS = 750;
const FOLD_PREFIX = "swim:";

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
  banner: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1 },
  canvas: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden", "@media (max-width: 720px)": { flex: "1 0 320px" } },
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
});

// ---- nodes -------------------------------------------------------------------------------------

interface LaneData extends Record<string, unknown> {
  readonly lane: SwimLane;
}

interface CardData extends Record<string, unknown> {
  readonly card: SwimCard;
  readonly entity: Entity;
  readonly laneKind: string;
  readonly selected: boolean;
  readonly highlighted: boolean;
  readonly step: number | null;
  readonly badge: ChangeBadge | null;
  readonly marked: boolean;
  readonly onActivate: (name: string) => void;
}

interface FoldData extends Record<string, unknown> {
  readonly fold: SwimFold;
  readonly owner: string;
  readonly onToggle: (owner: string) => void;
}

type SwimRfNode = Node<LaneData | CardData | FoldData, "lane" | "card" | "fold">;

function LaneImpl({ data }: NodeProps<Node<LaneData, "lane">>): JSX.Element {
  const { lane } = data;
  return (
    <div
      className="swim-lane"
      data-testid="swim-lane"
      data-lane={lane.kind}
      data-parity={lane.index % 2 === 1 ? "odd" : "even"}
      data-count={lane.count}
      style={{ width: lane.rect.width, height: lane.rect.height }}
    >
      <span className="swim-lane__title" style={{ width: LANE_GUTTER - 28 }}>
        <span className="swim-lane__name">{lane.title}</span>
        <span className="swim-lane__count">
          {lane.count} entit{lane.count === 1 ? "y" : "ies"}
        </span>
      </span>
    </div>
  );
}

function iconOf(name: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18">${ICONS[pickIcon(name)] ?? ICONS.cube}</svg>`;
}

function CardImpl({ data }: NodeProps<Node<CardData, "card">>): JSX.Element {
  const { card, entity, laneKind, selected, highlighted, step, badge, marked, onActivate } = data;
  const { spec, rect } = card;
  const token = tokensFor(entity.healthState);
  const impact = impactOf(entity.impact);
  const name = entity.displayName || entity.name;
  const activate = (): void => onActivate(entity.name);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  };
  const diff = badge ? diffTokens[badge] : null;
  const spoken = `${name} (${entity.healthState}${impact === "Standard" ? "" : `, ${impactStyle[impact].word}`})${badge ? `, ${badge} in the proposed changes` : ""}${step === null ? "" : `, step ${step} of the chain`}`;
  const borderStyle = impact === "Suppressed" ? "dotted" : token.dashed ? "dashed" : "solid";
  return (
    <div className="swim-shell" style={{ width: rect.width, height: rect.height }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <div className={mergeClasses("swim-card-ring", step !== null && "is-chain")} style={{ width: rect.width, height: rect.height }}>
        {step === null ? null : (
          <span className="swim-card__step" data-testid="chain-step" aria-hidden="true">
            {step}
          </span>
        )}
        <div
          className={mergeClasses("swim-card", selected && "is-selected", highlighted && "is-highlighted", marked && "is-marked")}
          data-testid="swim-card"
          data-entity={entity.name}
          data-state={entity.healthState}
          data-lane={laneKind}
          data-step={step ?? undefined}
          data-highlighted={highlighted ? "true" : undefined}
          data-badge={badge ?? undefined}
          data-marked={marked ? "true" : undefined}
          role="button"
          tabIndex={0}
          aria-label={spoken}
          style={{
            width: rect.width,
            height: rect.height,
            borderStyle,
            borderColor: diff ? diff.line : token.border,
            backgroundColor: diff && badge === "removed" ? diff.tint : token.fill,
          }}
          onClick={activate}
          onKeyDown={onKeyDown}
        >
          <div className="swim-card__header" style={{ height: spec.headerHeight }}>
            <div className="swim-card__top">
              <span className="swim-card__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconOf(name) }} />
              <span className="swim-card__names" title={name}>
                {spec.nameLines.map((line, index) => (
                  <span className="swim-card__name" key={index} style={badge === "removed" ? { textDecoration: "line-through" } : undefined}>
                    {line}
                  </span>
                ))}
              </span>
              <span className="swim-card__state" style={{ borderColor: token.border, color: token.label }}>
                <StateGlyph state={entity.healthState} size={12} />
                {token.word}
              </span>
            </div>
            {spec.chips.length > 0 ? (
              <div className="swim-card__chips">
                {spec.chips.map((chip) =>
                  chip.kind === "diff" && diff ? (
                    <span className="swim-card__chip swim-card__badge" key={chip.word} data-testid="change-badge" data-badge={badge ?? undefined} style={{ background: diff.tint, color: diff.ink, borderColor: diff.line }}>
                      <span aria-hidden="true">{chip.glyph}</span>
                      {chip.word}
                    </span>
                  ) : (
                    <span className="swim-card__chip" key={chip.word} data-testid="impact-chip" data-impact={impact}>
                      <span aria-hidden="true">{chip.glyph}</span>
                      {chip.word}
                    </span>
                  ),
                )}
              </div>
            ) : null}
          </div>
          {spec.rows.length > 0 || spec.summary !== null ? (
            <ul className="swim-card__rows" style={{ height: spec.height - spec.headerHeight }}>
              {spec.rows.map((row) => (
                <li className="swim-card__row" key={row.key} data-state={row.state}>
                  <StateGlyph state={row.state} size={12} />
                  <span className="swim-card__row-name" title={row.name}>
                    {row.name}
                  </span>
                  <span className="swim-card__row-value" style={{ color: tokensFor(row.state).label }}>
                    {row.value}
                  </span>
                </li>
              ))}
              {spec.summary === null ? null : <li className="swim-card__summary">{spec.summary}</li>}
            </ul>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="entity-node__handle" />
    </div>
  );
}

function FoldImpl({ data }: NodeProps<Node<FoldData, "fold">>): JSX.Element {
  const { fold, owner, onToggle } = data;
  const count = fold.members.length;
  const states = Object.keys(fold.states).join(", ");
  const spoken = fold.open
    ? `Hide the ${count} healthy entities under ${owner}`
    : `${count} healthy entities are folded under ${owner}${states ? ` (${states})` : ""}. Show them`;
  const toggle = (): void => onToggle(fold.owner);
  return (
    <div className="swim-fold-shell" style={{ width: fold.rect.width, height: fold.rect.height }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <button
        type="button"
        className="swim-fold"
        data-testid="swim-fold"
        data-owner={fold.owner}
        data-open={fold.open ? "true" : undefined}
        aria-expanded={fold.open}
        aria-label={spoken}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }}
      >
        <span aria-hidden="true">{fold.open ? "▾" : "▸"}</span>
        <StateGlyph state="Healthy" size={12} />
        <span>{fold.open ? `Hide ${count} healthy` : `+${count} healthy`}</span>
      </button>
    </div>
  );
}

const SwimNode = memo(function SwimNode(props: NodeProps<SwimRfNode>): JSX.Element {
  if (props.type === "lane") return <LaneImpl {...(props as NodeProps<Node<LaneData, "lane">>)} />;
  if (props.type === "fold") return <FoldImpl {...(props as NodeProps<Node<FoldData, "fold">>)} />;
  return <CardImpl {...(props as NodeProps<Node<CardData, "card">>)} />;
});

const nodeTypes: NodeTypes = { lane: SwimNode, card: SwimNode, fold: SwimNode };

// ---- the view ----------------------------------------------------------------------------------------

const badgeKeyOf = (badges: ReadonlyMap<string, ChangeBadge> | undefined): string => (badges ? [...badges].map(([name, badge]) => `${name}:${badge}`).join("|") : "");

/** The value for a key: the previous one while the key does not change. */
function useStable<T>(value: T, key: string): T {
  const held = useRef<{ readonly key: string; readonly value: T }>({ key, value });
  if (held.current.key !== key) held.current = { key, value };
  return held.current.value;
}

const NEUTRAL_EDGE = { stroke: "var(--edge)", width: 1.4, dash: undefined, cap: "butt" } as const;

/** The lines faded in a dense picture while one entity's lineage is followed. */
const FADED = 0.22;

function edgesOf(layout: SwimlaneLayout, byName: ReadonlyMap<string, Entity>, steps: ReadonlyMap<string, number>, lineage: ReadonlySet<string> | null): StepRfEdge[] {
  const built = layout.edges.map((edge) => {
    const child = byName.get(edge.to);
    const appearance = child ? edgeAppearance(child.healthState, child.impact, null) : NEUTRAL_EDGE;
    const from = steps.get(edge.from);
    const to = steps.get(edge.to);
    const drawn = stepEdge({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      points: edge.points,
      label: edge.label,
      text: edge.text,
      appearance,
      emphasised: from !== undefined && to !== undefined && from === to + 1,
    });
    const faded = lineage !== null && !lineage.has(edge.id);
    return { faded, edge: faded ? { ...drawn, style: { ...drawn.style, opacity: FADED } } : drawn };
  });
  // The lineage is drawn on top of what faded.
  return [...built.filter((item) => item.faded), ...built.filter((item) => !item.faded)].map((item) => item.edge);
}

function SwimlanesCanvas({ entities, relationships, selectedName, highlightedName, chainNames, badges, marked, compare, onActivate }: ViewProps): JSX.Element {
  const styles = useStyles();
  const selectedHealth = useStore((state) => state.selectedHealth);
  const openChips = useStore((state) => state.openChips);
  const focusNames = useStore((state) => state.focusNames);
  const focusSeq = useStore((state) => state.focusSeq);
  const workspaceFrame = useStore(canvasFrame);
  const rf = useReactFlow();
  const rfRef = useRef(rf);
  rfRef.current = rf;
  const paneRef = useRef<HTMLDivElement>(null);
  const [signals, setSignals] = useState(true);
  const [labelChoice, setLabelChoice] = useState<boolean | null>(null);

  // A refresh that brings the same model changes nothing, so nothing is laid out again for it.
  const content = useMemo(() => contentKey(entities, relationships), [entities, relationships]);
  const model = useStable({ entities, relationships }, content);
  const filter = useMemo(() => ({ selectedHealth: new Set(selectedHealth), excludedEntityMode: "hide" as const }), [selectedHealth]);
  // What this drawing has, after the Health filter: the cards, states and chain it draws.
  const own = useMemo(() => visibleGraph(model.entities, model.relationships, new Set(), filter), [model, filter]);
  const byName = useMemo(() => new Map(own.entities.map((entity) => [entity.name, entity] as const)), [own]);

  // In Compare, both sides are laid out together and each draws what it has: the lanes come from
  // what either side has, one version of each, and the sizes from this side's versions.
  const side = compare !== undefined && compare.side !== "merged" ? compare : null;
  const basis = useStable(side ? side.basis : model, side ? contentKey(side.basis.entities, side.basis.relationships) : content);
  const union = useStable(side ? side.union : model, side ? contentKey(side.union.entities, side.union.relationships) : content);
  // Lanes come from the whole model, so the Health filter never moves an entity to another lane.
  const layering = useMemo(() => layerOf(union.entities, union.relationships), [union]);
  const filtered = useMemo(() => (side ? visibleGraph(basis.entities, basis.relationships, new Set(), filter) : own), [side, basis, own, filter]);
  const rival = useStable(side ? side.other.entities : undefined, side ? contentKey(side.other.entities, []) : "");
  const only = useMemo(
    () => (side ? { entities: new Set(own.entities.map((entity) => entity.name)), links: new Set(own.relationships.map((item) => linkKey(item.parentEntityName, item.childEntityName))) } : undefined),
    [side, own],
  );

  const steps = useMemo(() => chainSteps(chainNames, byName.keys()), [byName, chainNames]);
  // What stays a card: the chain, and in Compare what the diff touches, on both sides alike.
  const keepNames = useMemo(() => {
    const names = new Set(chainSteps(chainNames, filtered.entities.map((entity) => entity.name)).keys());
    if (side) {
      const lower = new Map(filtered.entities.map((entity) => [entity.name.toLowerCase(), entity.name] as const));
      for (const key of [...side.marks.keys(), ...(marked ?? [])]) {
        const name = lower.get(key);
        if (name) names.add(name);
      }
    }
    return names;
  }, [chainNames, filtered, side, marked]);
  const keep = useStable(keepNames, [...keepNames].sort().join("|"));
  const open = useMemo(() => new Set(openChips.filter((id) => id.startsWith(FOLD_PREFIX)).map((id) => id.slice(FOLD_PREFIX.length))), [openChips]);
  // Both sides size their cards for the same marks, so a mark never moves one side's cards but not the other's.
  const stableBadges = useStable(side ? side.marks : badges, badgeKeyOf(side ? side.marks : badges));
  const ownBadges = useStable(badges, badgeKeyOf(badges));

  // Labels follow the size of the model unless the viewer chose.
  const layout = useMemo(
    () =>
      layoutSwimlanes(
        { entities: filtered.entities, relationships: filtered.relationships, layering },
        { signals, labels: labelChoice, open, keep, ...(stableBadges ? { badges: stableBadges } : {}), ...(only ? { only } : {}), ...(rival ? { rival } : {}) },
      ),
    [filtered, layering, signals, labelChoice, open, keep, stableBadges, only, rival],
  );
  const labels = layout.labels;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const anchor = useRef<{ readonly id: string; readonly x: number; readonly y: number } | null>(null);

  const onToggle = useCallback((owner: string): void => {
    const held = layoutRef.current.folds.find((fold) => fold.owner === owner)?.rect;
    const viewport = rfRef.current.getViewport?.();
    if (held && viewport) anchor.current = { id: foldId(owner), x: (held.x + held.width / 2) * viewport.zoom + viewport.x, y: (held.y + held.height / 2) * viewport.zoom + viewport.y };
    actions.toggleChip(`${FOLD_PREFIX}${owner}`);
  }, []);

  const nodes = useMemo<SwimRfNode[]>(() => {
    const lanes: SwimRfNode[] = layout.lanes.map((lane) => ({
      id: `lane:${lane.index}`,
      type: "lane",
      position: { x: lane.rect.x, y: lane.rect.y },
      width: lane.rect.width,
      height: lane.rect.height,
      measured: { width: lane.rect.width, height: lane.rect.height },
      zIndex: -1,
      selectable: false,
      draggable: false,
      focusable: false,
      data: { lane },
    }));
    const placed = [...layout.cards, ...layout.folds].sort((a, b) => a.lane - b.lane || a.row - b.row || a.rect.x - b.rect.x);
    const things: SwimRfNode[] = placed.map((thing) => {
      const fold = "members" in thing ? thing : null;
      const common = { id: thing.id, position: { x: thing.rect.x, y: thing.rect.y }, width: thing.rect.width, height: thing.rect.height, measured: { width: thing.rect.width, height: thing.rect.height } };
      if (fold) return { ...common, type: "fold", data: { fold, owner: byName.get(fold.owner)?.displayName || fold.owner, onToggle } };
      const card = thing as SwimCard;
      const entity = byName.get(card.id) as Entity;
      return {
        ...common,
        type: "card",
        data: {
          card,
          entity,
          laneKind: layout.lanes[card.lane]?.kind ?? "resources",
          selected: card.id === selectedName,
          highlighted: card.id === highlightedName,
          step: steps.get(card.id) ?? null,
          badge: ownBadges?.get(card.id.toLowerCase()) ?? null,
          marked: marked?.has(card.id.toLowerCase()) ?? false,
          onActivate,
        },
      };
    });
    return [...lanes, ...things];
  }, [layout, byName, selectedName, highlightedName, steps, ownBadges, marked, onActivate, onToggle]);

  // ---- where the viewport is: fitted, or opened on the problem when a fit would be too small to read ----
  const problem = useMemo(() => firstProblem(layout, byName), [layout, byName]);
  const [zoomedTo, setZoomedTo] = useState<string | null>(null);
  // In a dense picture the lines that are not on the way from the selected, chained or focused entity up to the root fade.
  const lineage = useMemo(() => {
    if (!layout.dense) return null;
    const spots = steps.size > 0 ? [...steps.keys()] : selectedName !== null && byName.has(selectedName) ? [selectedName] : zoomedTo !== null ? [zoomedTo] : [];
    return spots.length === 0 ? null : lineageOf(layout, spots);
  }, [layout, steps, selectedName, byName, zoomedTo]);
  const edges = useMemo(() => edgesOf(layout, byName, steps, lineage), [layout, byName, steps, lineage]);
  const fitAll = useCallback((duration: number): void => {
    setZoomedTo(null);
    void rfRef.current.fitView({ padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, duration });
  }, []);
  const focusOn = useCallback((id: string, duration: number): void => {
    setZoomedTo(id);
    void rfRef.current.fitView({ nodes: withParents(layoutRef.current, id).map((name) => ({ id: name })), padding: 0.35, maxZoom: MAX_FIT_ZOOM, duration });
  }, []);
  const fitZoomOf = (current: SwimlaneLayout): number | null => {
    const size = paneRef.current?.getBoundingClientRect();
    if (!size || size.width === 0 || size.height === 0) return null;
    return getViewportForBounds(current.bounds, size.width, size.height, MIN_ZOOM, MAX_FIT_ZOOM, FIT_PADDING).zoom;
  };

  // The first layout opens the view; a side panel opening or resizing, or a change of what the cards show, fits it again.
  const settled = useRef<{ readonly frame: string; readonly signals: boolean; readonly labels: boolean } | null>(null);
  const hasCards = layout.cards.length > 0;
  useEffect(() => {
    if (!hasCards) return;
    const before = settled.current;
    if (before && before.frame === workspaceFrame && before.signals === signals && before.labels === labels) return;
    const first = before === null;
    const frame = requestAnimationFrame(() => {
      settled.current = { frame: workspaceFrame, signals, labels };
      const duration = first || prefersReducedMotion() ? 0 : FIT_MS;
      const zoom = fitZoomOf(layoutRef.current);
      // Half a screen of a model fits smaller than a whole one, and a Compare is about what the diff touches, not about a problem it leaves alone: it opens fitted.
      if (side === null && problem !== null && zoom !== null && zoom < LEGIBLE_ZOOM) focusOn(problem, duration);
      else fitAll(duration);
    });
    return () => cancelAnimationFrame(frame);
    // Fits on the first layout and on these changes only, never when a chip opens or the model refreshes.
  }, [hasCards, workspaceFrame, signals, labels]);

  // Opening a chip re-arranges; the clicked chip stays where it was on screen.
  useEffect(() => {
    const held = anchor.current;
    if (!held) return;
    anchor.current = null;
    const rect = layout.folds.find((fold) => fold.id === held.id)?.rect;
    const viewport = rfRef.current.getViewport?.();
    if (!rect || !viewport) return;
    void rfRef.current.setViewport?.({ zoom: viewport.zoom, x: held.x - (rect.x + rect.width / 2) * viewport.zoom, y: held.y - (rect.y + rect.height / 2) * viewport.zoom });
  }, [layout]);

  // A search result or "Show on graph": open the chips an entity sits behind, one level at a time as
  // the layout answers, then bring it into view.
  const lastFocus = useRef(focusSeq);
  const pending = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (focusSeq !== 0 && focusNames.length > 0 && focusSeq > lastFocus.current) {
      lastFocus.current = focusSeq;
      pending.current = focusNames.filter((name) => byName.has(name));
    }
    const names = pending.current;
    if (!names) return;
    const behind = layout.folds.filter((fold) => !fold.open && fold.members.some((member) => names.includes(member)));
    if (behind.length > 0) {
      actions.openChipsFor(behind.map((fold) => `${FOLD_PREFIX}${fold.owner}`));
      return;
    }
    pending.current = null;
    const present = names.filter((name) => layout.cards.some((card) => card.id === name));
    if (present.length === 0) return;
    setZoomedTo(null);
    void rfRef.current.fitView({ nodes: present.map((name) => ({ id: name })), duration: prefersReducedMotion() ? 0 : FOCUS_MS, maxZoom: 1.4, padding: 0.3 });
  }, [layout, focusSeq, focusNames, byName]);

  const total = own.entities.length;
  const laneCount = layout.lanes.length;
  const foldedCount = layout.folds.filter((fold) => !fold.open).reduce((sum, fold) => sum + fold.members.length, 0);
  const zoomedName = zoomedTo === null ? null : (byName.get(zoomedTo)?.displayName || zoomedTo);

  return (
    <div className={styles.root} data-testid="swimlanes-view" data-side={side?.side} data-dense={layout.dense ? "true" : undefined}>
      <div className={styles.banner} data-testid="swimlanes-summary">
        <span role="status">
          {zoomedName !== null
            ? `Zoomed to ${zoomedName}. Fit shows all ${total} entities.`
            : `${total} entit${total === 1 ? "y" : "ies"} in ${laneCount} lane${laneCount === 1 ? "" : "s"}${foldedCount > 0 ? `, ${foldedCount} healthy ones folded into chips` : ""}.`}
        </span>
        <span className={styles.grow} />
        <ToggleButton size="small" checked={signals} data-testid="swim-signals" onClick={() => setSignals((current) => !current)}>
          Signals
        </ToggleButton>
        <ToggleButton size="small" checked={labels} data-testid="swim-labels" onClick={() => setLabelChoice(!labels)}>
          Labels
        </ToggleButton>
        <Button size="small" data-testid="swim-focus" disabled={problem === null} onClick={() => problem !== null && focusOn(problem, prefersReducedMotion() ? 0 : FOCUS_MS)}>
          Focus problem
        </Button>
        <Button size="small" appearance={zoomedTo === null ? "secondary" : "primary"} data-testid="swim-fit" onClick={() => fitAll(prefersReducedMotion() ? 0 : FIT_MS)}>
          Fit
        </Button>
      </div>
      <div className={styles.canvas} ref={paneRef}>
        <ReactFlow
          id={side ? `swimlanes-${side.side}` : "swimlanes"}
          aria-label={side ? `${SIDE_LABEL[side.side as "base" | "proposed"]}, swimlanes` : undefined}
          nodes={nodes}
          edges={edges}
          nodeOrigin={[0, 0]}
          nodeTypes={nodeTypes}
          edgeTypes={stepEdgeTypes}
          minZoom={MIN_ZOOM}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        />
        {entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="swimlanes">
            {noEntitiesText(compare)}
          </div>
        ) : own.entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="swimlanes">
            The Health filter hides every entity.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SwimlanesView(props: ViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <SwimlanesCanvas {...props} />
    </ReactFlowProvider>
  );
}
