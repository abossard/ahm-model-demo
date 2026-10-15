import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { ReactFlow, ReactFlowProvider, Background, useReactFlow } from "@xyflow/react";
import type { EdgeTypes, NodeTypes, NodeChange } from "@xyflow/react";
import type { Entity, HealthState, Relationship } from "../model/types";
import {
  LAYOUT_ENGINES,
  anchorLayout,
  boundsOf,
  type LiveLayoutSession,
  type GraphLayout,
  type NodeSize,
  type Point,
} from "../model/layout";
import {
  sidesFor,
  type ConnectionPolicy,
  type EdgeStyle,
  type LayoutFlow,
  type Rect,
} from "../model/edgeRouting";
import { orderEntities, orderWithinRanks } from "../model/ordering";
import { collapseControls, visibleGraph } from "../model/collapse";
import { cardTokens, tokensFor } from "../model/palette";
import { useAppDispatch, useAppSelector } from "../store/store";
import {
  selectCollapsed,
  selectConnectionPolicy,
  selectEdgeStyle,
  selectFocusNames,
  selectFocusSeq,
  selectHighlightedName,
  selectLayoutId,
  selectExcludedEntityMode,
  selectSelectedHealth,
  selectSelectedName,
  selectSortKey,
  selectSortReversed,
} from "../store/selectors";
import { announce } from "../store/uiSlice";
import { EntityNode, estimateNodeSize, type EntityRfNode } from "./EntityNode";
import { FloatingEdge, type FloatingRfEdge } from "./FloatingEdge";
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
const FALLBACK_GRID_COLUMNS = 4;
const FALLBACK_GRID_X = 320;
const FALLBACK_GRID_Y = 220;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    setReduced(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    const legacy = onChange as unknown as (event: MediaQueryListEvent | MediaQueryList) => void;
    media.addListener(legacy);
    return () => media.removeListener(legacy);
  }, []);

  return reduced;
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

function layoutMaterialSignature(
  fitOn: string,
  orderedNames: readonly string[],
  relationships: readonly Relationship[],
  sizes: ReadonlyMap<string, NodeSize>,
): string {
  const nodes = orderedNames
    .map((name) => {
      const size = sizes.get(name) ?? { width: 0, height: 0 };
      return `${name}:${size.width}x${size.height}`;
    })
    .join("|");
  const links = relationships
    .filter((item) => orderedNames.includes(item.parentEntityName) && orderedNames.includes(item.childEntityName))
    .map((item) => `${item.parentEntityName}>${item.childEntityName}`)
    .join("|");
  return `${fitOn}::${nodes}::${links}`;
}

function graphIdentitySignature(entities: readonly Entity[], relationships: readonly Relationship[]): string {
  const nodeIds = entities.map((item) => item.name).join("|");
  const links = relationships
    .map((item) => `${item.parentEntityName}>${item.childEntityName}:${item.name}`)
    .join("|");
  return `${nodeIds}::${links}`;
}

function fallbackLayout(
  orderedEntities: readonly Entity[],
  sizes: ReadonlyMap<string, NodeSize>,
  remembered: ReadonlyMap<string, Point>,
): GraphLayout {
  const positions = new Map<string, Point>();
  for (const [index, entity] of orderedEntities.entries()) {
    const existing = remembered.get(entity.name);
    if (existing) {
      positions.set(entity.name, existing);
      continue;
    }
    positions.set(entity.name, {
      x: (index % FALLBACK_GRID_COLUMNS) * FALLBACK_GRID_X,
      y: Math.floor(index / FALLBACK_GRID_COLUMNS) * FALLBACK_GRID_Y,
    });
  }
  return { positions, ...boundsOf(positions, sizes) };
}

export function buildEdges(
  relationships: readonly Relationship[],
  byName: ReadonlyMap<string, Entity>,
  rects: ReadonlyMap<string, Rect>,
  flow: LayoutFlow = "free",
  edgeStyle: EdgeStyle = "smooth",
  connectionPolicy: ConnectionPolicy = "with-layout",
  dotNames: ReadonlySet<string> = new Set<string>(),
): FloatingRfEdge[] {
  const drawable = relationships.filter(
    (item) => rects.has(item.parentEntityName) && rects.has(item.childEntityName) && byName.has(item.childEntityName),
  );

  const boundaries = new Map<string, string[]>();
  const sidesByEdge = new Map<string, ReturnType<typeof sidesFor>>();
  for (const item of drawable) {
    const source = rects.get(item.parentEntityName) as Rect;
    const target = rects.get(item.childEntityName) as Rect;
    const sides = sidesFor(connectionPolicy, flow, source, target);
    sidesByEdge.set(item.name, sides);
    pushGroup(boundaries, `${item.parentEntityName}|${sides.sourceSide}`, item.name);
    pushGroup(boundaries, `${item.childEntityName}|${sides.targetSide}`, item.name);
  }

  const edges: FloatingRfEdge[] = [];
  for (const relationship of drawable) {
    const child = byName.get(relationship.childEntityName);
    if (!child) continue;
    const sides = sidesByEdge.get(relationship.name)!;
    const sourceGroup = boundaries.get(`${relationship.parentEntityName}|${sides.sourceSide}`) ?? [];
    const targetGroup = boundaries.get(`${relationship.childEntityName}|${sides.targetSide}`) ?? [];
    const sourceLane = laneOf(sourceGroup.indexOf(relationship.name), sourceGroup.length);
    const targetLane = laneOf(targetGroup.indexOf(relationship.name), targetGroup.length);
    const label = relationship.displayName ?? "";
    edges.push({
      id: relationship.name,
      source: relationship.parentEntityName,
      target: relationship.childEntityName,
      type: "floating",
      data: {
        ...sides, sourceLane, targetLane,
        sourceLaneCount: sourceGroup.length, targetLaneCount: targetGroup.length, style: edgeStyle,
      },
      label: label || undefined,
      labelShowBg: label.length > 0,
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 9,
      labelBgStyle: { fill: cardTokens.pillFill, stroke: cardTokens.pillStroke },
      labelStyle: { fill: cardTokens.ink, fontSize: 10.5 },
      style: {
        stroke:
          dotNames.has(relationship.parentEntityName) || dotNames.has(relationship.childEntityName)
            ? cardTokens.muted
            : tokensFor(child.healthState).dot,
      },
    });
  }
  return edges;
}

function TopologyCanvas({ entities, relationships }: TopologyProps): JSX.Element {
  const dispatch = useAppDispatch();
  const selectedName = useAppSelector(selectSelectedName);
  const highlightedName = useAppSelector(selectHighlightedName);
  const layoutId = useAppSelector(selectLayoutId);
  const edgeStyle = useAppSelector(selectEdgeStyle);
  const connectionPolicy = useAppSelector(selectConnectionPolicy);
  const sortKey = useAppSelector(selectSortKey);
  const sortReversed = useAppSelector(selectSortReversed);
  const collapsed = useAppSelector(selectCollapsed);
  const selectedHealth = useAppSelector(selectSelectedHealth);
  const excludedEntityMode = useAppSelector(selectExcludedEntityMode);
  const focusNames = useAppSelector(selectFocusNames);
  const focusSeq = useAppSelector(selectFocusSeq);
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  const reducedMotion = useReducedMotionPreference();

  const visible = useMemo(
    () =>
      visibleGraph(entities, relationships, new Set(collapsed), {
        selectedHealth: new Set(selectedHealth),
        excludedEntityMode,
      }),
    [entities, relationships, collapsed, selectedHealth, excludedEntityMode],
  );
  const controls = useMemo(
    () =>
      collapseControls(entities, relationships, new Set(collapsed), {
        selectedHealth: new Set(selectedHealth),
        excludedEntityMode,
      }),
    [entities, relationships, collapsed, selectedHealth, excludedEntityMode],
  );

  const [measuredCards, setMeasuredCards] = useState<ReadonlyMap<string, NodeSize>>(new Map());
  const sizes = useMemo<ReadonlyMap<string, NodeSize>>(
    () =>
      new Map(
        visible.entities.map(
          (item) => {
            const displayRole = visible.dotNames.has(item.name) ? "dot" : "card";
            return [
              item.name,
              displayRole === "dot"
                ? estimateNodeSize(item, false, "dot")
                : measuredCards.get(item.name) ??
                  estimateNodeSize(item, (visible.hiddenCounts.get(item.name) ?? 0) > 0),
            ] as const;
          },
        ),
      ),
    [visible, measuredCards],
  );

  const [layout, setLayout] = useState<GraphLayout>(EMPTY_LAYOUT);
  const liveSession = useRef<LiveLayoutSession | null>(null);
  const liveReducedMotion = useRef<boolean | null>(null);
  const liveGeneration = useRef(0);
  const staticGeneration = useRef(0);
  const liveMaterial = useRef<WeakMap<LiveLayoutSession, string>>(new WeakMap());
  // Collapsing must not move the viewport, so only an engine or sort change asks for a re-fit.
  const fitOn = `${layoutId}|${sortKey}|${String(sortReversed)}`;
  const fitOnRef = useRef(fitOn);
  fitOnRef.current = fitOn;
  const [fitToken, setFitToken] = useState(0);
  const lastFitOn = useRef<string | null>(null);
  // Collapsing must not move the graph either, so a run that keeps the same engine and order
  // re-seats the fresh layout onto the positions already on screen. The memory keeps a hidden
  // node's last position too, so expanding puts a descendant back exactly where it was instead of
  // letting the engine re-place it somewhere else on the canvas.
  const settled = useRef<{ readonly key: string; readonly positions: ReadonlyMap<string, Point> } | null>(
    null,
  );
  const pendingFocus = useRef<{ readonly seq: number; readonly names: readonly string[]; readonly graphEpoch: number } | null>(null);
  const graphEpoch = useRef(0);
  const lastFocus = useRef(focusSeq);
  const rememberedFromLayout = useRef(layout.positions);
  rememberedFromLayout.current = layout.positions;
  const liveInputsRef = useRef<{
    readonly orderedEntities: readonly Entity[];
    readonly relationships: readonly Relationship[];
    readonly sizes: ReadonlyMap<string, NodeSize>;
  }>({ orderedEntities: [], relationships: [], sizes: new Map() });
  const sourceSignature = useMemo(
    () => graphIdentitySignature(entities, relationships),
    [entities, relationships],
  );

  useEffect(() => {
    graphEpoch.current += 1;
  }, [sourceSignature]);

  useEffect(() => {
    if (focusSeq === 0 || focusNames.length === 0 || focusSeq <= lastFocus.current) return;
    pendingFocus.current = { seq: focusSeq, names: [...focusNames], graphEpoch: graphEpoch.current };
  }, [focusSeq, focusNames]);

  useEffect(() => {
    const engine = LAYOUT_ENGINES[layoutId];
    const order = orderEntities(visible.entities, sortKey, sortReversed).map((item) => item.name);
    const orderedEntities = order.map((name) => visible.entities.find((entity) => entity.name === name) as Entity);
    const signature = layoutMaterialSignature(fitOn, order, visible.relationships, sizes);
    liveInputsRef.current = { orderedEntities, relationships: visible.relationships, sizes };

    if (engine.startLive) {
      liveGeneration.current += 1;
      if (liveSession.current && liveReducedMotion.current !== null && liveReducedMotion.current !== reducedMotion) {
        liveSession.current.dispose();
        liveSession.current = null;
      }
      if (!liveSession.current) {
        let currentSession: LiveLayoutSession | null = null;
        currentSession = engine.startLive({
          reducedMotion,
          onFrame: (frame) => {
            if (liveSession.current !== currentSession) return;
            settled.current = { key: fitOnRef.current, positions: new Map(frame.positions) };
            setLayout(frame);
          },
          onError: () => {
            if (liveSession.current !== currentSession) return;
            currentSession?.dispose();
            liveSession.current = null;
            const remembered = settled.current?.positions ?? rememberedFromLayout.current;
            const fallback = fallbackLayout(
              liveInputsRef.current.orderedEntities,
              liveInputsRef.current.sizes,
              remembered,
            );
            settled.current = { key: fitOnRef.current, positions: new Map(fallback.positions) };
            setLayout(fallback);
            dispatch(announce("Live force layout failed. Showing latest stable placement."));
          },
        });
        liveSession.current = currentSession;
        liveReducedMotion.current = reducedMotion;
      }
      const currentSession = liveSession.current;
      if (liveMaterial.current.get(currentSession) === signature) return () => {};
      const carried = settled.current;
      const remembered = carried && carried.key === fitOnRef.current ? carried.positions : new Map<string, Point>();
      try {
        currentSession.update(
          orderedEntities,
          visible.relationships,
          (item) => sizes.get(item.name) ?? estimateNodeSize(item),
          remembered,
        );
        if (liveSession.current === currentSession) {
          liveMaterial.current.set(currentSession, signature);
        }
      } catch {
        if (liveSession.current === currentSession) {
          currentSession.dispose();
          liveSession.current = null;
        }
        const rememberedPositions = settled.current?.positions ?? rememberedFromLayout.current;
        const fallback = fallbackLayout(
          liveInputsRef.current.orderedEntities,
          liveInputsRef.current.sizes,
          rememberedPositions,
        );
        settled.current = { key: fitOnRef.current, positions: new Map(fallback.positions) };
        setLayout(fallback);
        dispatch(announce("Live force layout failed. Showing latest stable placement."));
      }
      if (lastFitOn.current !== fitOn) {
        lastFitOn.current = fitOn;
        setFitToken((current) => current + 1);
      }
      return () => {
        liveGeneration.current += 1;
      };
    }

    if (liveSession.current) {
      liveSession.current.dispose();
      liveSession.current = null;
    }

    const carried = settled.current;
    if (
      carried &&
      carried.key === fitOn &&
      visible.entities.every((entity) => carried.positions.has(entity.name))
    ) {
      const retained = new Map<string, Point>();
      for (const entity of visible.entities) {
        retained.set(entity.name, carried.positions.get(entity.name) as Point);
      }
      const placed = anchorLayout({ positions: retained, ...boundsOf(retained, sizes) }, carried.positions, sizes);
      settled.current = { key: fitOn, positions: new Map([...carried.positions, ...placed.positions]) };
      setLayout(placed);
      return () => {};
    }

    let cancelled = false;
    staticGeneration.current += 1;
    const generation = staticGeneration.current;

    void engine
      .run(visible.entities, visible.relationships, (item) =>
        sizes.get(item.name) ?? estimateNodeSize(item),
      )
      .then((next) => {
        if (cancelled || generation !== staticGeneration.current) return;
        const ordered = orderWithinRanks(next, order, engine.rankAxis, sizes);
        const current = settled.current;
        const remembered = current && current.key === fitOn ? current.positions : null;
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
      })
      .catch(() => {
        if (cancelled || generation !== staticGeneration.current) return;
        const remembered = settled.current?.positions ?? rememberedFromLayout.current;
        const fallback = fallbackLayout(orderedEntities, sizes, remembered);
        settled.current = { key: fitOnRef.current, positions: new Map(fallback.positions) };
        setLayout(fallback);
        dispatch(announce("Layout failed. Showing latest stable placement."));
      });

    return () => {
      cancelled = true;
    };
  }, [layoutId, sortKey, sortReversed, visible, sizes, fitOn, dispatch, reducedMotion]);

  useEffect(
    () => () => {
      liveSession.current?.dispose();
      liveSession.current = null;
      liveReducedMotion.current = null;
      liveMaterial.current = new WeakMap();
    },
    [],
  );

  useEffect(() => {
    if (fitToken === 0) return;
    // The very first fit lands the graph on screen; animating it only delays first paint.
    const duration = fitToken === 1 ? 0 : motionDuration(LAYOUT_TRANSITION_MS);
    const frame = requestAnimationFrame(() => {
      void fitViewRef.current({ duration });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitToken]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (pending.graphEpoch !== graphEpoch.current) {
      pendingFocus.current = null;
      return;
    }
    if (!pending.names.every((name) => rememberedFromLayout.current.has(name))) return;
    pendingFocus.current = null;
    lastFocus.current = pending.seq;
    void fitViewRef.current({
      nodes: pending.names.map((name) => ({ id: name })),
      duration: motionDuration(FOCUS_TRANSITION_MS),
      maxZoom: 1.4,
    });
  }, [layout, fitToken, focusSeq]);

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
          ...(visible.dotNames.has(entity.name) ? { height: size.height } : {}),
          // Carried so React Flow keeps the measured handle bounds when a new layout swaps the
          // node objects; without it `parseHandles` drops them and no edge is ever drawn.
          measured: { width: size.width, height: size.height },
          data: {
            entity,
            displayRole: visible.dotNames.has(entity.name) ? "dot" : "card",
            selected: entity.name === selectedName,
            highlighted: entity.name === highlightedName,
            hasChildren: controls.has(entity.name),
            collapsed: collapsed.includes(entity.name),
            hiddenCount: collapsed.includes(entity.name)
              ? visible.hiddenCounts.get(entity.name) ?? 0
              : controls.get(entity.name)?.hiddenCount ?? 0,
            hiddenStates: visible.hiddenStates.get(entity.name) ?? EMPTY_STATES,
          },
        };
      }),
    [visible, layout, sizes, selectedName, highlightedName, collapsed, controls],
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

  const edges = useMemo(
    () =>
      buildEdges(
        visible.relationships,
        new Map(visible.entities.map((entity) => [entity.name, entity])),
        rects,
        LAYOUT_ENGINES[layoutId].flow,
        edgeStyle,
        connectionPolicy,
        visible.dotNames,
      ),
    [visible, rects, layoutId, edgeStyle, connectionPolicy],
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
          nodeOrigin={[0, 0]}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.5}
          nodesDraggable={layoutId === "d3-force-adaptive"}
          nodesConnectable={false}
          nodesFocusable={false}
          elementsSelectable={false}
          onNodesChange={(changes: NodeChange<EntityRfNode>[]) => {
            setMeasuredCards((previous) => {
              let next: Map<string, NodeSize> | undefined;
              for (const change of changes) {
                if (change.type !== "dimensions" || !change.dimensions || visible.dotNames.has(change.id)) continue;
                const before = previous.get(change.id);
                const { width, height } = change.dimensions;
                if (before?.width === width && before.height === height) continue;
                next ??= new Map(previous);
                next.set(change.id, { width, height });
              }
              return next ?? previous;
            });
          }}
          onNodeDragStart={(_, node) => {
            if (layoutId !== "d3-force-adaptive") return;
            liveSession.current?.setDrag(node.id, { x: node.position.x, y: node.position.y });
          }}
          onNodeDrag={(_, node) => {
            if (layoutId !== "d3-force-adaptive") return;
            liveSession.current?.setDrag(node.id, { x: node.position.x, y: node.position.y });
          }}
          onNodeDragStop={(_, node) => {
            if (layoutId !== "d3-force-adaptive") return;
            liveSession.current?.setDrag(node.id, null);
            liveSession.current?.settle();
            const nextPositions = new Map(layout.positions);
            nextPositions.set(node.id, node.position);
            settled.current = { key: fitOn, positions: nextPositions };
          }}
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
