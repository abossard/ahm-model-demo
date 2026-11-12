import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Background, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { Node, NodeProps, NodeTypes } from "@xyflow/react";
import type { ChangeBadge } from "../model/changes";
import { causePath, openToReveal } from "../model/causePath";
import { layoutCause, type CauseLayout, type Placement } from "../model/causeLayout";
import { visibleGraph } from "../model/collapse";
import { noEntitiesText } from "../model/compare";
import { cardTokens, diffTokens, edgeAppearance, impactOf, impactStyle, tokensFor, type DiffMark } from "../model/palette";
import { drawnParents, type ReorderWorld } from "../model/reorder";
import { formatSignalValue } from "../model/signalValue";
import type { Entity } from "../model/types";
import { actions, canvasFrame, useStore } from "../store/store";
import { ICONS, pickIcon } from "../components/EntityNode";
import { StateGlyph } from "../components/StateGlyph";
import { stepEdge, stepEdgeTypes, type StepRfEdge } from "../components/StepEdge";
import { prefersReducedMotion } from "../components/Topology";
import type { ViewProps } from "./types";
import { DropSlot, moveClass, useReorder, withMoveNodes, type MoveMarks } from "./useReorder";

const MIN_ZOOM = 0.1;
const MAX_FIT_ZOOM = 1;
const FIT_PADDING = 0.12;
/** Below this zoom the text of a card cannot be read: the first view shows the chain instead of everything. */
const READABLE_ZOOM = 0.45;
const FIT_MS = 500;
const FOCUS_MS = 750;

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
  calm: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
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

interface CauseNodeData extends Record<string, unknown>, MoveMarks {
  readonly placement: Placement;
  readonly entity: Entity | null;
  readonly owner: string | null;
  readonly selected: boolean;
  readonly highlighted: boolean;
  /** What the diff of a Compare does to the entity, and whether its changes are ticked. */
  readonly badge: ChangeBadge | null;
  readonly marked: boolean;
  readonly onToggle: (groupId: string, node: string) => void;
  readonly onActivate: (name: string) => void;
}

type CauseRfNode = Node<CauseNodeData, "cause" | "chip">;

const CHIP_KINDS: Readonly<Record<string, string>> = {
  healthy: "healthy",
  unknown: "unknown",
  "not-in-rollup": "not in the rollup",
  unconnected: "not connected to the root",
  more: "other",
};

function stateSummary(states: Readonly<Partial<Record<string, number>>>): string {
  return Object.entries(states)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
}

function CauseChipImpl({ data }: NodeProps<CauseRfNode>): JSX.Element {
  const { placement, owner, onToggle } = data;
  const group = placement.group;
  const toggle = (): void => {
    if (group) onToggle(group.id, placement.id);
  };
  const spoken = group
    ? group.open
      ? `Hide the ${group.count} ${CHIP_KINDS[group.kind]} entities under ${owner ?? "the root"}`
      : `${group.count} ${CHIP_KINDS[group.kind]} entities are folded under ${owner ?? "the root"} (${stateSummary(group.states)}). Show them`
    : "";
  return (
    <div className="cause-chip-shell" style={{ width: placement.rect.width, height: placement.rect.height }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <button
        type="button"
        className="cause-chip"
        data-testid="cause-chip"
        data-chip={group?.id}
        data-open={group?.open ? "true" : undefined}
        data-kind={group?.kind}
        aria-expanded={group?.open ?? false}
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
        <span aria-hidden="true">{group?.open ? "▾" : "▸"}</span>
        <span>{group?.open ? "Hide" : group?.label}</span>
      </button>
    </div>
  );
}

function CauseCardImpl({ data }: NodeProps<CauseRfNode>): JSX.Element | null {
  const { placement, entity, selected, highlighted, badge, marked, reorderable, ghost, onActivate } = data;
  if (!entity) return null;
  const token = tokensFor(entity.healthState);
  const impact = impactOf(entity.impact);
  const name = entity.displayName || entity.name;
  const { kind, rect, step, rows, moreRows, healthySignals } = placement;
  const activate = (): void => onActivate(entity.name);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  };
  const quiet = entity.healthState === "Healthy" || entity.healthState === "Unknown";
  const dotted = impact === "Suppressed";
  const diff = badge ? diffTokens[badge] : null;
  const spoken = `${name} (${entity.healthState}${impact === "Standard" ? "" : `, ${impactStyle[impact].word}`})${badge ? `, ${badge} in the proposed changes` : ""}${step === null ? "" : `, step ${step} of the chain`}`;
  return (
    <div className="cause-node-shell" style={{ width: rect.width, height: rect.height }}>
      <Handle type="target" position={Position.Top} className="entity-node__handle" />
      <div
        className={mergeClasses("cause-node", `cause-node--${kind}`, selected && "is-selected", highlighted && "is-highlighted", marked && "is-marked", step !== null && "is-chain", moveClass(data).trim())}
        {...(ghost ? { "data-testid": "reorder-ghost", "aria-hidden": true } : { "data-testid": "cause-node", "data-entity": entity.name, tabIndex: 0 })}
        aria-keyshortcuts={reorderable && !ghost ? "M" : undefined}
        data-state={entity.healthState}
        data-kind={kind}
        data-step={step ?? undefined}
        data-highlighted={highlighted ? "true" : undefined}
        data-badge={badge ?? undefined}
        data-marked={marked ? "true" : undefined}
        role="button"
        aria-label={spoken}
        style={{
          width: rect.width,
          height: rect.height,
          borderStyle: badge === "removed" ? "dashed" : dotted ? "dotted" : token.dashed ? "dashed" : "solid",
          borderColor: diff ? diff.line : token.border,
          backgroundColor: badge === "removed" && diff ? diff.tint : quiet && kind === "pill" ? tokens.colorNeutralBackground1 : token.fill,
        }}
        onClick={activate}
        onKeyDown={onKeyDown}
      >
        {step === null ? null : (
          <span className="cause-node__step" data-testid="chain-step" aria-hidden="true">
            {step}
          </span>
        )}
        {badge ? (
          <span className="entity-node__badge" data-testid="change-badge" data-badge={badge} aria-hidden="true">
            {badge}
          </span>
        ) : null}
        {kind === "pill" ? (
          <div className="cause-node__pillrow">
            <StateGlyph state={entity.healthState} size={14} />
            <span className="cause-node__name cause-node__name--pill" style={badge === "removed" ? { textDecoration: "line-through" } : undefined}>
              {name}
            </span>
            {impact === "Standard" ? null : (
              <span className="cause-node__mark" title={impactStyle[impact].word} aria-hidden="true">
                {impactStyle[impact].glyph}
              </span>
            )}
          </div>
        ) : (
          <>
            <div className="cause-node__header">
              <span
                className="entity-node__icon"
                style={{ color: cardTokens.muted }}
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" width="20" height="20">${ICONS[pickIcon(name)] ?? ICONS.cube}</svg>` }}
              />
              <span className="cause-node__name" title={name} style={badge === "removed" ? { textDecoration: "line-through" } : undefined}>
                {name}
              </span>
              <span className="entity-node__pill" style={{ borderColor: token.border }}>
                <StateGlyph state={entity.healthState} size={12} className="entity-node__dot" />
                <span className="entity-node__pill-word">{token.word}</span>
              </span>
            </div>
            {impact === "Standard" ? null : (
              <div className="entity-node__chips">
                <span className="entity-node__chip" data-testid="impact-chip" data-impact={impact}>
                  <span aria-hidden="true">{impactStyle[impact].glyph}</span> {impactStyle[impact].word}
                </span>
              </div>
            )}
            {rows.length > 0 || healthySignals > 0 ? (
              <ul className="cause-node__rows">
                {rows.map((signal) => (
                  <li className="cause-node__row" key={signal.name} data-state={signal.healthState}>
                    <StateGlyph state={signal.healthState} size={12} />
                    <span className="cause-node__row-name" title={signal.displayName || signal.name}>
                      {signal.displayName || signal.name}
                    </span>
                    <span className="cause-node__row-value" style={{ color: tokensFor(signal.healthState).label }}>
                      {formatSignalValue(signal.value)}
                    </span>
                  </li>
                ))}
                {moreRows > 0 ? <li className="cause-node__summary">+{moreRows} more not healthy</li> : null}
                {healthySignals > 0 ? (
                  <li className="cause-node__summary">
                    +{healthySignals} healthy signal{healthySignals === 1 ? "" : "s"}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="entity-node__handle" />
    </div>
  );
}

const CauseNode = memo(function CauseNode(props: NodeProps<CauseRfNode>): JSX.Element | null {
  return props.type === "chip" ? <CauseChipImpl {...props} /> : <CauseCardImpl {...props} />;
});

// ---- edges ---------------------------------------------------------------------------------------

const nodeTypes: NodeTypes = { cause: CauseNode, chip: CauseNode, slot: DropSlot };

/** Close enough to the 10.5 px label font: the router only needs room for the pill, not its exact width. */
const labelWidthOf = (text: string): number => text.length * 5.9;

function edgesOf(layout: CauseLayout, byName: ReadonlyMap<string, Entity>, steps: ReadonlyMap<string, number>, badges: ReadonlyMap<string, ChangeBadge> | undefined): StepRfEdge[] {
  return layout.edges.map((edge) => {
    const child = byName.get(edge.to);
    const badge = child ? badges?.get(child.name.toLowerCase()) : undefined;
    const mark: DiffMark | null = badge === "added" || badge === "removed" ? badge : null;
    const appearance = child ? edgeAppearance(child.healthState, child.impact, mark) : { stroke: "var(--edge)", width: 1.4, dash: "2 4", cap: "round" as const };
    const from = steps.get(edge.from);
    const to = steps.get(edge.to);
    return stepEdge({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      points: edge.points,
      label: edge.label,
      text: edge.text,
      appearance,
      emphasised: from !== undefined && to !== undefined && from === to + 1,
    });
  });
}

// ---- the view --------------------------------------------------------------------------------------

function CausePathCanvas({ entities, relationships, selectedName, highlightedName, chainNames, badges, marked, compare, onActivate }: ViewProps): JSX.Element {
  const styles = useStyles();
  const selectedHealth = useStore((state) => state.selectedHealth);
  const openChips = useStore((state) => state.openChips);
  const focusNames = useStore((state) => state.focusNames);
  const focusSeq = useStore((state) => state.focusSeq);
  const workspaceFrame = useStore(canvasFrame);
  const rf = useReactFlow();
  const rfRef = useRef(rf);
  rfRef.current = rf;

  // The Health filter narrows what the view may draw, before anything is folded: an unselected
  // state is not drawn and not counted in a chip. Collapse toggles belong to Everything.
  const filtered = useMemo(
    () => visibleGraph(entities, relationships, new Set(), { selectedHealth: new Set(selectedHealth), excludedEntityMode: "hide" }),
    [entities, relationships, selectedHealth],
  );
  // In Compare the entities the diff touches are what needs attention: drawn with their ancestors, the rest of what is healthy folded.
  const changed = useMemo(() => {
    if (!compare || !badges) return undefined;
    return new Set(filtered.entities.filter((entity) => badges.has(entity.name.toLowerCase())).map((entity) => entity.name));
  }, [compare, badges, filtered]);
  const path = useMemo(
    () => causePath(filtered.entities, filtered.relationships, { explainChain: chainNames, open: new Set(openChips), ...(changed ? { changed } : {}) }),
    [filtered, chainNames, openChips, changed],
  );
  const byName = useMemo(() => new Map(filtered.entities.map((entity) => [entity.name, entity] as const)), [filtered]);
  const steps = useMemo(() => new Map(path.chain.map((name, index) => [name, index + 1] as const)), [path]);
  // The viewer's order, shared with every view; while a card is dragged, the order a drop would keep.
  const reorder = useReorder({
    labelOf: (id) => byName.get(id)?.displayName || id,
    whyFixed: (id) => (steps.has(id) ? `${byName.get(id)?.displayName || id} is on the chain to the root. The chain follows the cause, so it keeps its place.` : null),
  });
  const layout = useMemo(() => layoutCause(filtered.entities, filtered.relationships, path, labelWidthOf, changed, reorder.order), [filtered, path, changed, reorder.order]);
  // Cards beside each other under one parent trade places. The chain is a fixed sequence, the cause order, and a chip
  // stands for what is folded: both hold their place. A compared model is not dragged.
  const world = useMemo<ReorderWorld | null>(() => {
    if (compare !== undefined) return null;
    const cards = layout.nodes.filter((node) => node.kind !== "chip").map((node) => node.id);
    const movable = cards.filter((id) => !steps.has(id));
    return { rows: layout.ranks, rects: new Map(layout.nodes.map((node) => [node.id, node.rect] as const)), parents: drawnParents(movable, new Set(cards), filtered.relationships) };
  }, [compare, layout, steps, filtered]);
  reorder.offer(world);
  const moving = reorder.move;

  // Opening a chip re-arranges; the clicked chip stays where it was on screen.
  const anchor = useRef<{ readonly id: string; readonly x: number; readonly y: number } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onToggle = useCallback((groupId: string, nodeId: string): void => {
    const rect = layoutRef.current.nodes.find((node) => node.id === nodeId)?.rect;
    const viewport = rfRef.current.getViewport?.();
    if (rect && viewport) {
      anchor.current = { id: nodeId, x: (rect.x + rect.width / 2) * viewport.zoom + viewport.x, y: (rect.y + rect.height / 2) * viewport.zoom + viewport.y };
    }
    actions.toggleChip(groupId);
  }, []);

  const nodes = useMemo<CauseRfNode[]>(
    () =>
      layout.nodes.map((placement) => {
        const entity = byName.get(placement.id) ?? null;
        return {
          id: placement.id,
          type: placement.kind === "chip" ? "chip" : "cause",
          position: { x: placement.rect.x, y: placement.rect.y },
          width: placement.rect.width,
          height: placement.rect.height,
          // Carried so React Flow keeps the measured handle bounds when a new layout swaps the node objects.
          measured: { width: placement.rect.width, height: placement.rect.height },
          draggable: world?.parents.has(placement.id) ?? false,
          data: {
            placement,
            ...(world?.parents.has(placement.id) ? { reorderable: true } : {}),
            ...(moving?.id === placement.id ? { dragging: true } : {}),
            entity,
            owner: placement.group ? (byName.get(placement.group.owner)?.displayName ?? placement.group.owner) : null,
            selected: placement.id === selectedName,
            highlighted: placement.id === highlightedName,
            badge: badges?.get(placement.id.toLowerCase()) ?? null,
            marked: marked?.has(placement.id.toLowerCase()) ?? false,
            onToggle,
            onActivate,
          },
        };
      }),
    [layout, byName, selectedName, highlightedName, badges, marked, world, moving?.id, onToggle, onActivate],
  );
  const shownNodes = useMemo(() => withMoveNodes(nodes, moving), [nodes, moving]);
  const edges = useMemo(() => edgesOf(layout, byName, steps, badges), [layout, byName, steps, badges]);

  // The first layout fits the screen. When that would be too small to read, the chain is what the
  // eye needs: fit that, and let "Fit all" show the rest. Later layouts leave the viewport alone,
  // except to keep an opened chip in place.
  const fitted = useRef(false);
  const lastFrame = useRef(workspaceFrame);
  const chainRef = useRef(path.chain);
  chainRef.current = path.chain;
  const fitAll = useCallback((duration: number): Promise<boolean> => rfRef.current.fitView({ padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, duration }), []);
  useEffect(() => {
    if (layout.nodes.length === 0) return;
    const reflow = lastFrame.current !== workspaceFrame;
    lastFrame.current = workspaceFrame;
    if (fitted.current && !reflow) return;
    const first = !fitted.current;
    fitted.current = true;
    const frame = requestAnimationFrame(() => {
      void fitAll(first || prefersReducedMotion() ? 0 : FIT_MS).then(() => {
        const zoom = rfRef.current.getZoom?.();
        if (first && zoom !== undefined && zoom < READABLE_ZOOM && chainRef.current.length > 0) {
          void rfRef.current.fitView({ nodes: chainRef.current.map((id) => ({ id })), padding: 0.3, maxZoom: 1, duration: 0 });
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, workspaceFrame, fitAll]);

  useEffect(() => {
    const held = anchor.current;
    if (!held) return;
    anchor.current = null;
    const rect = layout.nodes.find((node) => node.id === held.id)?.rect;
    const viewport = rfRef.current.getViewport?.();
    if (!rect || !viewport) return;
    void rfRef.current.setViewport?.({ zoom: viewport.zoom, x: held.x - (rect.x + rect.width / 2) * viewport.zoom, y: held.y - (rect.y + rect.height / 2) * viewport.zoom });
  }, [layout]);

  // A search result or "Focus cause": open the chips an entity sits behind, then fit to it.
  const lastFocus = useRef(focusSeq);
  const pendingFit = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (focusSeq === 0 || focusNames.length === 0 || focusSeq <= lastFocus.current) return;
    lastFocus.current = focusSeq;
    const options = { explainChain: chainNames, open: new Set(openChips) };
    const reveal = openToReveal(filtered.entities, filtered.relationships, options, focusNames);
    const added = [...reveal].filter((id) => !openChips.includes(id));
    pendingFit.current = focusNames;
    if (added.length > 0) actions.openChipsFor(added);
  }, [focusSeq, focusNames, chainNames, openChips, filtered]);
  useEffect(() => {
    const names = pendingFit.current;
    if (!names) return;
    const present = names.filter((name) => layout.nodes.some((node) => node.id === name));
    pendingFit.current = null;
    if (present.length === 0) return;
    void rfRef.current.fitView({ nodes: present.map((name) => ({ id: name })), duration: prefersReducedMotion() ? 0 : FOCUS_MS, maxZoom: 1.4, padding: 0.3 });
  }, [layout]);

  const hidden = path.folded.filter((group) => !group.open).reduce((sum, group) => sum + group.count, 0);
  const leaf = path.chain[0];
  const focusCause = (): void => {
    if (leaf) actions.focusEntities({ highlight: leaf, names: path.chain });
  };

  return (
    <div className={mergeClasses(styles.root, moving !== null && "is-reordering")} data-testid="cause-view" {...reorder.root}>
      <div className={styles.banner} data-testid="cause-summary">
        {changed ? (
          <span role="status" data-testid="cause-compare">
            {changed.size} entit{changed.size === 1 ? "y is" : "ies are"} added, changed or removed
            {path.alarms > 0 ? `, ${path.alarms} need${path.alarms === 1 ? "s" : ""} attention` : ""}
            {hidden > 0 ? `. ${hidden} unchanged and healthy fold${hidden === 1 ? "s" : ""} into chips` : ""}.
          </span>
        ) : path.calm ? (
          <>
            <span className={styles.calm} data-testid="cause-calm" role="status">
              Nothing is degraded or unhealthy.
            </span>
            <span>
              {hidden} entit{hidden === 1 ? "y is" : "ies are"} folded into the chips below.
            </span>
          </>
        ) : (
          <span role="status">
            {path.alarms} entit{path.alarms === 1 ? "y needs" : "ies need"} attention
            {path.chain.length > 0 ? `, ${path.chain.length} on the chain to the root` : ""}
            {hidden > 0 ? `. ${hidden} fold${hidden === 1 ? "s" : ""} into chips` : ""}.
          </span>
        )}
        <span className={styles.grow} />
        {path.calm && !changed ? null : (
          <Button size="small" appearance="subtle" data-testid="fit-all" onClick={() => void fitAll(prefersReducedMotion() ? 0 : FIT_MS)}>
            Fit all
          </Button>
        )}
        {path.calm ? (
          changed ? null : (
            <Button size="small" appearance="primary" data-testid="show-everything" onClick={() => actions.setView("zoom")}>
              Show everything
            </Button>
          )
        ) : (
          <Button size="small" data-testid="focus-cause" disabled={path.chain.length === 0} onClick={focusCause}>
            Focus cause
          </Button>
        )}
      </div>
      <div className={styles.canvas}>
        <ReactFlow
          id="cause"
          nodes={shownNodes}
          edges={edges}
          nodeOrigin={[0, 0]}
          nodeTypes={nodeTypes}
          edgeTypes={stepEdgeTypes}
          minZoom={MIN_ZOOM}
          nodesDraggable={world !== null}
          nodeDragThreshold={4}
          nodeClickDistance={4}
          {...reorder.flow}
          nodesConnectable={false}
          nodesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background id="cause" />
        </ReactFlow>
        {entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="cause">
            {noEntitiesText(compare)}
          </div>
        ) : filtered.entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="cause">
            The Health filter hides every entity.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CausePathView(props: ViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <CausePathCanvas {...props} />
    </ReactFlowProvider>
  );
}

