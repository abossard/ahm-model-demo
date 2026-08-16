import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { ReactFlow, ReactFlowProvider, Background, useReactFlow } from "@xyflow/react";
import type { Edge, NodeTypes } from "@xyflow/react";
import type { Entity, Relationship } from "../model/types";
import { LAYOUT_ENGINES, type GraphLayout, type NodeSize } from "../model/layout";
import { orderEntities, orderWithinRanks } from "../model/ordering";
import { descendantCounts, visibleGraph } from "../model/collapse";
import { cardTokens, tokensFor } from "../model/palette";
import { useAppSelector } from "../store/store";
import {
  selectCollapsed,
  selectFocusNames,
  selectFocusSeq,
  selectHighlightedName,
  selectLayoutId,
  selectSelectedName,
  selectSortKey,
  selectSortReversed,
} from "../store/selectors";
import { EntityNode, estimateNodeSize, type EntityRfNode } from "./EntityNode";
import { GraphToolbar } from "./GraphToolbar";
import { SearchOverlay } from "./SearchOverlay";

interface TopologyProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const nodeTypes: NodeTypes = { entity: EntityNode };

export const LAYOUT_TRANSITION_MS = 500;
export const FOCUS_TRANSITION_MS = 750;
const EMPTY_LAYOUT: GraphLayout = { positions: new Map(), width: 0, height: 0 };

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function motionDuration(base: number): number {
  return prefersReducedMotion() ? 0 : base;
}

function buildEdges(
  relationships: readonly Relationship[],
  byName: ReadonlyMap<string, Entity>,
): Edge[] {
  const edges: Edge[] = [];
  for (const relationship of relationships) {
    const child = byName.get(relationship.childEntityName);
    if (!byName.has(relationship.parentEntityName)) continue;
    if (!child) continue;
    const label = relationship.displayName ?? "";
    edges.push({
      id: relationship.name,
      source: relationship.parentEntityName,
      target: relationship.childEntityName,
      type: "smoothstep",
      label: label || undefined,
      labelShowBg: label.length > 0,
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 9,
      labelBgStyle: { fill: cardTokens.pillFill, stroke: cardTokens.pillStroke },
      labelStyle: { fill: cardTokens.ink, fontSize: 10.5 },
      style: { stroke: tokensFor(child.healthState).dot },
    });
  }
  return edges;
}

function TopologyCanvas({ entities, relationships }: TopologyProps): JSX.Element {
  const selectedName = useAppSelector(selectSelectedName);
  const highlightedName = useAppSelector(selectHighlightedName);
  const layoutId = useAppSelector(selectLayoutId);
  const sortKey = useAppSelector(selectSortKey);
  const sortReversed = useAppSelector(selectSortReversed);
  const collapsed = useAppSelector(selectCollapsed);
  const focusNames = useAppSelector(selectFocusNames);
  const focusSeq = useAppSelector(selectFocusSeq);
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;

  // Single source of truth for "has something to collapse": `descendantCounts` already drops
  // self-loops and edges pointing at absent entities, so a node cannot get a toggle that hides
  // nothing.
  const descendants = useMemo(
    () => descendantCounts(entities, relationships),
    [entities, relationships],
  );

  const visible = useMemo(
    () => visibleGraph(entities, relationships, new Set(collapsed)),
    [entities, relationships, collapsed],
  );

  const sizes = useMemo<ReadonlyMap<string, NodeSize>>(
    () =>
      new Map(
        visible.entities.map(
          (item) => [item.name, estimateNodeSize(item, descendants.has(item.name))] as const,
        ),
      ),
    [visible.entities, descendants],
  );

  const [layout, setLayout] = useState<GraphLayout>(EMPTY_LAYOUT);
  const [fitToken, setFitToken] = useState(0);
  // Collapsing must not move the viewport, so only an engine or sort change asks for a re-fit.
  const fitOn = `${layoutId}|${sortKey}|${String(sortReversed)}`;
  const lastFitOn = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const engine = LAYOUT_ENGINES[layoutId];
    const order = orderEntities(visible.entities, sortKey, sortReversed).map((item) => item.name);

    void engine
      .run(visible.entities, visible.relationships, (item) =>
        estimateNodeSize(item, descendants.has(item.name)),
      )
      .then((next) => {
        if (cancelled) return;
        setLayout(orderWithinRanks(next, order, engine.rankAxis, sizes));
        if (lastFitOn.current !== fitOn) {
          lastFitOn.current = fitOn;
          setFitToken((current) => current + 1);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [layoutId, sortKey, sortReversed, visible, sizes, descendants, fitOn]);

  useEffect(() => {
    if (fitToken === 0) return;
    // The very first fit lands the graph on screen; animating it only delays first paint.
    const duration = fitToken === 1 ? 0 : motionDuration(LAYOUT_TRANSITION_MS);
    const frame = requestAnimationFrame(() => {
      void fitViewRef.current({ duration });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitToken]);

  const positionsRef = useRef(layout.positions);
  positionsRef.current = layout.positions;
  const lastFocus = useRef(0);
  useEffect(() => {
    if (focusSeq === lastFocus.current || focusNames.length === 0) return;
    if (!focusNames.every((name) => positionsRef.current.has(name))) return;
    lastFocus.current = focusSeq;
    void fitViewRef.current({
      nodes: focusNames.map((name) => ({ id: name })),
      duration: motionDuration(FOCUS_TRANSITION_MS),
      maxZoom: 1.4,
    });
  }, [focusSeq, focusNames, fitToken]);

  const nodes = useMemo<EntityRfNode[]>(
    () =>
      visible.entities.map((entity) => {
        const size = sizes.get(entity.name) ?? { width: 0, height: 0 };
        const position = layout.positions.get(entity.name) ?? { x: 0, y: 0 };
        return {
          id: entity.name,
          type: "entity",
          position: { x: position.x, y: position.y },
          width: size.width,
          height: size.height,
          // Carried so React Flow keeps the measured handle bounds when a new layout swaps the
          // node objects; without it `parseHandles` drops them and no edge is ever drawn.
          measured: { width: size.width, height: size.height },
          data: {
            entity,
            selected: entity.name === selectedName,
            highlighted: entity.name === highlightedName,
            hasChildren: descendants.has(entity.name),
            collapsed: collapsed.includes(entity.name),
            hiddenCount: descendants.get(entity.name) ?? 0,
          },
        };
      }),
    [visible, layout, sizes, selectedName, highlightedName, collapsed, descendants],
  );

  const edges = useMemo(
    () =>
      buildEdges(
        visible.relationships,
        new Map(visible.entities.map((entity) => [entity.name, entity])),
      ),
    [visible],
  );

  return (
    <div id="topology" className="topology">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
      </ReactFlow>
      <GraphToolbar visibleCount={visible.entities.length} />
      <SearchOverlay entities={entities} relationships={relationships} />
    </div>
  );
}

export function Topology(props: TopologyProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <TopologyCanvas {...props} />
    </ReactFlowProvider>
  );
}
