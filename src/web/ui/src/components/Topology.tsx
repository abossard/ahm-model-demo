import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { ReactFlow, ReactFlowProvider, Background, useReactFlow } from "@xyflow/react";
import type { Edge, EdgeTypes, NodeTypes } from "@xyflow/react";
import type { Entity, HealthState, Relationship } from "../model/types";
import {
  LAYOUT_ENGINES,
  anchorLayout,
  type GraphLayout,
  type NodeSize,
  type Point,
  type RouteSource,
} from "../model/layout";
import {
  sidesFor,
  ROUTE_REFERENCE_ZOOM,
  routeEdges,
  type ConnectionPolicy,
  type EdgeStyle,
  type LayoutFlow,
  type Rect,
} from "../model/edgeRouting";
import { orderEntities, orderWithinRanks } from "../model/ordering";
import { descendantCounts, visibleGraph } from "../model/collapse";
import { cardTokens, tokensFor } from "../model/palette";
import { useAppSelector } from "../store/store";
import {
  selectCollapsed,
  selectConnectionPolicy,
  selectEdgeStyle,
  selectFocusNames,
  selectFocusSeq,
  selectHighlightedName,
  selectLayoutId,
  selectSelectedName,
  selectSortKey,
  selectSortReversed,
} from "../store/selectors";
import { EntityNode, estimateNodeSize, type EntityRfNode } from "./EntityNode";
import { FloatingEdge } from "./FloatingEdge";
import { GraphToolbar } from "./GraphToolbar";
import { SearchOverlay } from "./SearchOverlay";

interface TopologyProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const nodeTypes: NodeTypes = { entity: EntityNode };
const edgeTypes: EdgeTypes = { floating: FloatingEdge };

export const LAYOUT_TRANSITION_MS = 500;
export const FOCUS_TRANSITION_MS = 750;
const EMPTY_LAYOUT: GraphLayout = { positions: new Map(), width: 0, height: 0 };
const EMPTY_STATES: ReadonlyMap<HealthState, number> = new Map();

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function motionDuration(base: number): number {
  return prefersReducedMotion() ? 0 : base;
}

/** Lanes are counted per arrival boundary, so a fan-in never stacks its paths on one point. */
function laneOf(index: number, total: number): number {
  return index - (total - 1) / 2;
}

function pushGroup(map: Map<string, string[]>, key: string, name: string): void {
  const group = map.get(key);
  if (group) group.push(name);
  else map.set(key, [name]);
}

/**
 * The edges React Flow paints, exported so a test can measure the real lane assignment and the real
 * routes rather than a second copy of both.
 */
export function buildEdges(
  relationships: readonly Relationship[],
  byName: ReadonlyMap<string, Entity>,
  rects: ReadonlyMap<string, Rect>,
  routeSource: RouteSource,
  flow: LayoutFlow = "free",
  edgeStyle: EdgeStyle = "rounded",
  connectionPolicy: ConnectionPolicy = "free",
): Edge[] {
  const drawable = relationships.filter(
    (item) => rects.has(item.parentEntityName) && rects.has(item.childEntityName),
  );

  const boundaries = new Map<string, string[]>();
  const sidesByEdge = new Map<
    string,
    {
      readonly sourceSide: ReturnType<typeof sidesFor>["sourceSide"];
      readonly targetSide: ReturnType<typeof sidesFor>["targetSide"];
    }
  >();
  for (const item of drawable) {
    const source = rects.get(item.parentEntityName) as Rect;
    const target = rects.get(item.childEntityName) as Rect;
    const sides = sidesFor(connectionPolicy, flow, source, target);
    sidesByEdge.set(item.name, sides);
    pushGroup(boundaries, `${item.parentEntityName}|${sides.sourceSide}`, item.name);
    pushGroup(boundaries, `${item.childEntityName}|${sides.targetSide}`, item.name);
  }

  const prepared: {
    readonly relationship: Relationship;
    readonly child: Entity;
    readonly sourceLane: number;
    readonly targetLane: number;
    readonly sourceLaneCount: number;
    readonly targetLaneCount: number;
    readonly obstacles: readonly Rect[];
  }[] = [];
  for (const relationship of drawable) {
    const child = byName.get(relationship.childEntityName);
    if (!child) continue;
    const sides = sidesByEdge.get(relationship.name) as {
      readonly sourceSide: ReturnType<typeof sidesFor>["sourceSide"];
      readonly targetSide: ReturnType<typeof sidesFor>["targetSide"];
    };
    const sourceGroup = boundaries.get(`${relationship.parentEntityName}|${sides.sourceSide}`) ?? [];
    const targetGroup = boundaries.get(`${relationship.childEntityName}|${sides.targetSide}`) ?? [];
    const sourceLane = laneOf(sourceGroup.indexOf(relationship.name), sourceGroup.length);
    const targetLane = laneOf(targetGroup.indexOf(relationship.name), targetGroup.length);
    const obstacles: Rect[] = [];
    for (const [name, rect] of rects) {
      if (name === relationship.parentEntityName || name === relationship.childEntityName) continue;
      obstacles.push(rect);
    }

    prepared.push({
      relationship,
      child,
      sourceLane,
      targetLane,
      sourceLaneCount: sourceGroup.length,
      targetLaneCount: targetGroup.length,
      obstacles,
    });
  }

  const routes = routeEdges(
    prepared.map(({ relationship, sourceLane, targetLane, sourceLaneCount, targetLaneCount, obstacles }) => {
      const sides = sidesByEdge.get(relationship.name) as {
        readonly sourceSide: ReturnType<typeof sidesFor>["sourceSide"];
        readonly targetSide: ReturnType<typeof sidesFor>["targetSide"];
      };
      return {
        source: rects.get(relationship.parentEntityName) as Rect,
        target: rects.get(relationship.childEntityName) as Rect,
        obstacles,
        lane: 0,
        options: {
          ...sides,
          sourceLane,
          targetLane,
          sourceLaneCount,
          targetLaneCount,
          detourLane: Math.abs(sourceLane) >= Math.abs(targetLane) ? sourceLane : targetLane,
        },
      };
    }),
  );

  const edges: Edge[] = [];
  for (const [index, item] of prepared.entries()) {
    const { relationship, child, sourceLane, targetLane, sourceLaneCount, targetLaneCount } = item;
    const label = relationship.displayName ?? "";
    const route = routes[index] as (typeof routes)[number];
    edges.push({
      id: relationship.name,
      source: relationship.parentEntityName,
      target: relationship.childEntityName,
      type: "floating",
      data: { route, lane: targetLane, sourceLane, targetLane, sourceLaneCount, targetLaneCount, style: edgeStyle },
      // Painted on the element so a routing miss surfaces instead of drawing a wrong path that
      // looks the same as a right one, and so a layout cannot change route source unnoticed.
      className: `route-source-${routeSource} route-${route.clear ? "clear" : "blocked"}`,
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
  const edgeStyle = useAppSelector(selectEdgeStyle);
  const connectionPolicy = useAppSelector(selectConnectionPolicy);
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

  /*
   * What each expanded node would hide if it were collapsed right now. The toggle announces that
   * number, and under Q17 only `collapse.ts` can tell it, because a descendant reachable through
   * another expanded parent stays on screen.
   * ponytail: one visibleGraph pass per collapsible node. Fold it into a single sweep when a model
   * arrives whose branching count makes the repeat measurable.
   */
  const wouldHide = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of descendants.keys()) {
      if (collapsed.includes(name)) continue;
      const graph = visibleGraph(entities, relationships, new Set([...collapsed, name]));
      counts.set(name, graph.hiddenCounts.get(name) ?? 0);
    }
    return counts;
  }, [entities, relationships, collapsed, descendants]);

  const sizes = useMemo<ReadonlyMap<string, NodeSize>>(
    () =>
      new Map(
        visible.entities.map(
          (item) =>
            [item.name, estimateNodeSize(item, (visible.hiddenCounts.get(item.name) ?? 0) > 0)] as const,
        ),
      ),
    [visible],
  );

  const [layout, setLayout] = useState<GraphLayout>(EMPTY_LAYOUT);
  const [fitToken, setFitToken] = useState(0);
  // Collapsing must not move the viewport, so only an engine or sort change asks for a re-fit.
  const fitOn = `${layoutId}|${sortKey}|${String(sortReversed)}`;
  const lastFitOn = useRef<string | null>(null);
  // Collapsing must not move the graph either, so a run that keeps the same engine and order
  // re-seats the fresh layout onto the positions already on screen. The memory keeps a hidden
  // node's last position too, so expanding puts a descendant back exactly where it was instead of
  // letting the engine re-place it somewhere else on the canvas.
  const settled = useRef<{ readonly key: string; readonly positions: ReadonlyMap<string, Point> } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const engine = LAYOUT_ENGINES[layoutId];
    const order = orderEntities(visible.entities, sortKey, sortReversed).map((item) => item.name);

    void engine
      .run(visible.entities, visible.relationships, (item) =>
        sizes.get(item.name) ?? estimateNodeSize(item),
      )
      .then((next) => {
        if (cancelled) return;
        const ordered = orderWithinRanks(next, order, engine.rankAxis, sizes);
        const carried = settled.current;
        const remembered = carried && carried.key === fitOn ? carried.positions : null;
        const placed = remembered ? anchorLayout(ordered, remembered, sizes) : ordered;
        settled.current = {
          key: fitOn,
          positions: new Map([...(remembered ?? []), ...placed.positions]),
        };
        setLayout(placed);
        if (lastFitOn.current !== fitOn) {
          lastFitOn.current = fitOn;
          setFitToken((current) => current + 1);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [layoutId, sortKey, sortReversed, visible, sizes, fitOn]);

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
            hiddenCount: collapsed.includes(entity.name)
              ? visible.hiddenCounts.get(entity.name) ?? 0
              : wouldHide.get(entity.name) ?? 0,
            hiddenStates: visible.hiddenStates.get(entity.name) ?? EMPTY_STATES,
          },
        };
      }),
    [visible, layout, sizes, selectedName, highlightedName, collapsed, descendants, wouldHide],
  );

  const rects = useMemo<ReadonlyMap<string, Rect>>(() => {
    const map = new Map<string, Rect>();
    for (const [name, point] of layout.positions) {
      const size = sizes.get(name);
      if (!size) continue;
      map.set(name, { x: point.x, y: point.y, width: size.width, height: size.height });
    }
    return map;
  }, [layout, sizes]);

  const routedEdges = useMemo(
    () =>
      buildEdges(
        visible.relationships,
        new Map(visible.entities.map((entity) => [entity.name, entity])),
        rects,
        LAYOUT_ENGINES[layoutId].routeSource,
        LAYOUT_ENGINES[layoutId].flow,
        "rounded",
        connectionPolicy,
      ),
    [visible, rects, layoutId, connectionPolicy],
  );
  const edges = useMemo(
    () => routedEdges.map((edge) => ({ ...edge, data: { ...edge.data, style: edgeStyle } })),
    [routedEdges, edgeStyle],
  );

  return (
    <div id="topology" className="topology">
      {/*
       * The toolbar takes its own row above the canvas instead of floating over it. An overlay
       * toolbar sits between the pointer and whatever the graph paints underneath, so an ordinary
       * zoom could park a card's header disclosure under it and swallow every click on it.
       */}
      <GraphToolbar visibleCount={visible.entities.length} />
      <div className="topology__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={ROUTE_REFERENCE_ZOOM}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background />
        </ReactFlow>
      </div>
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
