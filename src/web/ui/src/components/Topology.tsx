import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ReactFlow, ReactFlowProvider, Background, MiniMap, useReactFlow, useStore as useFlowStore } from "@xyflow/react";
import type { EdgeTypes, Node, NodeChange, NodeProps, NodeTypes } from "@xyflow/react";
import type { Entity, HealthModelSnapshot, HealthState, Relationship } from "../model/types";
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
  edgePorts,
  type ConnectionPolicy,
  type EdgeStyle,
  type LayoutFlow,
  type Rect,
} from "../model/edgeRouting";
import { familyOf, kindOf, orderKey, ranksFromPositions } from "../model/customOrder";
import { orderEntities, orderWithinRanks } from "../model/ordering";
import {
  candidateAt,
  candidatesOf,
  currentCandidate,
  describeMove,
  orderAfter,
  previewPositions,
  stepCandidate,
  type Axis,
  type Candidate,
  type DragWorld,
  type StepKey,
} from "../model/reorder";
import type { ChangeBadge } from "../model/changes";
import { collapseControls, visibleGraph } from "../model/collapse";
import { emptyText } from "../model/compare";
import { cardTokens, edgeAppearance, tokensFor } from "../model/palette";
import { LEVEL_HEIGHT, zoomLevel } from "../model/zoomLevels";
import { actions, canvasFrame, useStore } from "../store/store";
import { EntityNode, estimateNodeSize, type EntityNodeData, type EntityRfNode } from "./EntityNode";
import { FloatingEdge, type FloatingRfEdge } from "./FloatingEdge";

interface TopologyProps {
  /** Prefix of this instance's DOM id and test id, so that two graphs can share a page. */
  readonly idPrefix: string;
  readonly label?: string;
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  /** Change badges and marks of a compared Health model diff, keyed by lower-cased entity name. */
  readonly badges?: ReadonlyMap<string, ChangeBadge>;
  readonly marked?: ReadonlySet<string>;
  /** How far the graph may zoom out; a narrow canvas needs more than the default to fit a wide graph. */
  readonly minZoom?: number;
  /** How far an automatic fit may zoom out; the user may zoom out to `minZoom`. Defaults to `minZoom`. */
  readonly fitMinZoom?: number;
  /** A mini-map in the corner that colours every part by its state. */
  readonly minimap?: boolean;
  /**
   * The graph this one is arranged with. Two graphs that share a basis put the same entity in the
   * same relation to the others, so one can be read against the other.
   */
  readonly basis?: HealthModelSnapshot;
}

const useStyles = makeStyles({
  root: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  // The canvas owns the space the toolbar leaves, so no card can ever render under the toolbar.
  label: {
    flex: "0 0 auto",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  canvas: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    overflow: "hidden",
    "@media (max-width: 720px)": { flex: "1 0 320px" },
  },
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

/** The empty place a dragged card would take, drawn where it would stand. */
interface SlotData extends Record<string, unknown> {
  readonly width: number;
  readonly height: number;
}

type GhostNode = Node<EntityNodeData, "ghost">;
type SlotNode = Node<SlotData, "slot">;
type TopologyNode = EntityRfNode | GhostNode | SlotNode;

const GHOST_ID = "__ghost__";
const SLOT_ID = "__slot__";

function DropSlot({ data }: NodeProps<SlotNode>): JSX.Element {
  return <div className="drop-indicator" data-testid="drop-indicator" style={{ width: data.width, height: data.height }} />;
}

const nodeTypes: NodeTypes = { entity: EntityNode, ghost: EntityNode, slot: DropSlot };
const edgeTypes: EdgeTypes = { floating: FloatingEdge };

const DEFAULT_MIN_ZOOM = 0.5;
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

/** A card on its way to another place: where the pointer has it, and the place it would take. */
interface Move {
  readonly name: string;
  /** The corner of the copy that follows the pointer, in flow coordinates; none for the keyboard. */
  readonly ghost: Point | null;
  /** The place the card would take; null where none would have it. */
  readonly candidate: Candidate | null;
  readonly source: "pointer" | "keyboard";
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

  const ports = edgePorts(
    drawable.map((item) => ({ id: item.name, from: item.parentEntityName, to: item.childEntityName })),
    rects,
    flow,
    connectionPolicy,
  );

  const edges: FloatingRfEdge[] = [];
  for (const relationship of drawable) {
    const child = byName.get(relationship.childEntityName);
    const port = ports.get(relationship.name);
    if (!child || !port) continue;
    const label = relationship.displayName ?? "";
    const appearance = edgeAppearance(child.healthState, child.impact, null);
    edges.push({
      id: relationship.name,
      source: relationship.parentEntityName,
      target: relationship.childEntityName,
      type: "floating",
      data: { ...port, style: edgeStyle },
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
            : appearance.stroke,
        strokeWidth: appearance.width,
        ...(appearance.dash ? { strokeDasharray: appearance.dash, strokeLinecap: appearance.cap } : {}),
      },
    });
  }
  return edges;
}

/** A mini-map colour for a part: strong where it needs attention, faint where it is fine. */
function heatOf(node: Node): string {
  const entity = (node.data as { readonly entity?: Entity }).entity;
  if (!entity || entity.healthState === "Healthy") return "var(--healthy-border)";
  return tokensFor(entity.healthState).dot;
}

function TopologyCanvas({
  idPrefix,
  label,
  entities,
  relationships,
  badges,
  marked,
  minZoom = DEFAULT_MIN_ZOOM,
  fitMinZoom = minZoom,
  minimap = false,
  basis,
}: TopologyProps): JSX.Element {
  const styles = useStyles();
  const selectedName = useStore((state) => state.selectedName);
  const highlightedName = useStore((state) => state.highlightedName);
  const layoutId = useStore((state) => state.layoutId);
  const edgeStyle = useStore((state) => state.edgeStyle);
  const connectionPolicy = useStore((state) => state.connectionPolicy);
  const sortKey = useStore((state) => state.sortKey);
  const sortReversed = useStore((state) => state.sortReversed);
  const workspaceFrame = useStore(canvasFrame);
  const collapsed = useStore((state) => state.collapsed);
  const selectedHealth = useStore((state) => state.selectedHealth);
  const excludedEntityMode = useStore((state) => state.excludedEntityMode);
  const focusNames = useStore((state) => state.focusNames);
  const focusSeq = useStore((state) => state.focusSeq);
  const chainNames = useStore((state) => state.chainNames);
  const selectedModel = useStore((state) => state.selected);
  const customOrders = useStore((state) => state.customOrders);
  const { fitView } = useReactFlow();
  // What the zoom shows of a card: it changes only where the zoom crosses a floor, so nothing re-renders in between.
  const level = useFlowStore((state) => zoomLevel(state.transform?.[2])) ?? "card";
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

  // What the arrangement runs on: this graph, or the basis it shares, drawn with this graph's sizes
  // where it has the entity and estimated ones where it has not.
  const arranged = useMemo(() => {
    if (!basis) return { visible, sizes };
    const shared = visibleGraph(basis.entities, basis.relationships, new Set(collapsed), {
      selectedHealth: new Set(selectedHealth),
      excludedEntityMode,
    });
    const sharedSizes = new Map(sizes);
    for (const item of shared.entities) {
      if (sharedSizes.has(item.name)) continue;
      sharedSizes.set(
        item.name,
        shared.dotNames.has(item.name)
          ? estimateNodeSize(item, false, "dot")
          : estimateNodeSize(item, (shared.hiddenCounts.get(item.name) ?? 0) > 0),
      );
    }
    return { visible: shared, sizes: sharedSizes };
  }, [basis, visible, sizes, collapsed, selectedHealth, excludedEntityMode]);

  const [layout, setLayout] = useState<GraphLayout>(EMPTY_LAYOUT);
  // What a drop showed, kept on screen until the arrangement it asked for arrives.
  const [held, setHeld] = useState<ReadonlyMap<string, Point> | null>(null);
  const liveSession = useRef<LiveLayoutSession | null>(null);
  const liveReducedMotion = useRef<boolean | null>(null);
  const liveGeneration = useRef(0);
  const staticGeneration = useRef(0);
  const liveMaterial = useRef<WeakMap<LiveLayoutSession, string>>(new WeakMap());
  // Collapsing must not move the viewport, so only an engine or sort change asks for a re-fit.
  // The first drag turns the order to Custom without the graph having to move, so it is not a reason to fit again.
  const fitOn = `${layoutId}|${sortKey === "custom" ? "shortest" : sortKey}|${String(sortReversed)}`;
  // What the arrangement on screen was made for: the same, and the custom order it keeps.
  const family = familyOf(layoutId);
  const customKey = family ? orderKey(selectedModel, family) : null;
  const custom = sortKey === "custom" && customKey ? customOrders[customKey] ?? null : null;
  const orderStamp = useMemo(() => (custom ? JSON.stringify(custom) : ""), [custom]);
  const settledKey = `${fitOn}|${orderStamp}`;
  const fitOnRef = useRef(settledKey);
  fitOnRef.current = settledKey;
  const layoutRanks = useRef<readonly (readonly string[])[] | undefined>(undefined);
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
    const shortest = sortKey === "shortest" || sortKey === "custom";
    const order = orderEntities(visible.entities, sortKey, sortReversed).map((item) => item.name);
    const orderedEntities = order.map((name) => visible.entities.find((entity) => entity.name === name) as Entity);
    const signature = layoutMaterialSignature(settledKey, order, visible.relationships, sizes);
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
            actions.announce("Live force layout failed. Showing latest stable placement.");
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
        actions.announce("Live force layout failed. Showing latest stable placement.");
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
      carried.key === settledKey &&
      visible.entities.every((entity) => carried.positions.has(entity.name))
    ) {
      const retained = new Map<string, Point>();
      for (const entity of visible.entities) {
        retained.set(entity.name, carried.positions.get(entity.name) as Point);
      }
      const placed = anchorLayout({ positions: retained, ...boundsOf(retained, sizes) }, carried.positions, sizes);
      settled.current = { key: settledKey, positions: new Map([...carried.positions, ...placed.positions]) };
      setLayout(placed);
      return () => {};
    }

    let cancelled = false;
    staticGeneration.current += 1;
    const generation = staticGeneration.current;

    void engine
      .run(
        arranged.visible.entities,
        arranged.visible.relationships,
        (item) => arranged.sizes.get(item.name) ?? estimateNodeSize(item),
        { shortest, ...(custom ? { custom } : {}) },
      )
      .then((whole) => {
        if (cancelled || generation !== staticGeneration.current) return;
        const own = new Map<string, Point>();
        for (const item of visible.entities) own.set(item.name, whole.positions.get(item.name) ?? { x: 0, y: 0 });
        const next = basis ? { positions: own, ...boundsOf(own, sizes) } : whole;
        const ordered = shortest ? next : orderWithinRanks(next, order, engine.rankAxis, sizes);
        const current = settled.current;
        const remembered = current && current.key === settledKey ? current.positions : null;
        const placed = remembered ? anchorLayout(ordered, remembered, sizes) : ordered;
        settled.current = {
          key: settledKey,
          positions: new Map([...(remembered ?? []), ...placed.positions]),
        };
        layoutRanks.current = shortest ? whole.ranks : undefined;
        setLayout(placed);
        setHeld(null);
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
        actions.announce("Layout failed. Showing latest stable placement.");
      });

    return () => {
      cancelled = true;
    };
  }, [layoutId, sortKey, sortReversed, visible, sizes, arranged, basis, fitOn, settledKey, custom, reducedMotion]);

  useEffect(
    () => () => {
      liveSession.current?.dispose();
      liveSession.current = null;
      liveReducedMotion.current = null;
      liveMaterial.current = new WeakMap();
    },
    [],
  );

  // A side panel opening or resizing changes what the canvas can show, so the graph fits it again.
  const lastFrame = useRef(workspaceFrame);
  useEffect(() => {
    if (lastFrame.current === workspaceFrame) return;
    lastFrame.current = workspaceFrame;
    setFitToken((current) => current + 1);
  }, [workspaceFrame]);

  useEffect(() => {
    if (fitToken === 0) return;
    // The very first fit lands the graph on screen; animating it only delays first paint.
    const duration = fitToken === 1 ? 0 : motionDuration(LAYOUT_TRANSITION_MS);
    const frame = requestAnimationFrame(() => {
      void fitViewRef.current({ duration, minZoom: fitMinZoom });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitToken]);

  const visibleNames = useMemo(() => new Set(visible.entities.map((item) => item.name)), [visible]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (pending.graphEpoch !== graphEpoch.current) {
      pendingFocus.current = null;
      return;
    }
    // Another graph may show entities this one does not; a name this graph never draws is no reason to wait.
    const names = pending.names.filter((name) => visibleNames.has(name));
    if (!names.every((name) => rememberedFromLayout.current.has(name))) return;
    pendingFocus.current = null;
    lastFocus.current = pending.seq;
    if (names.length === 0) return;
    void fitViewRef.current({
      nodes: names.map((name) => ({ id: name })),
      duration: motionDuration(FOCUS_TRANSITION_MS),
      maxZoom: 1.4,
      minZoom: fitMinZoom,
    });
  }, [layout, fitToken, focusSeq, visibleNames]);

  const chain = useMemo(() => new Set(chainNames.map((name) => name.toLowerCase())), [chainNames]);

  // Dragging a card to another place. The live force layout is a simulation with no places to keep:
  // there a drag pulls on it, as it always did. A compared graph is arranged for both sides, so it is not dragged.
  const adaptive = layoutId === "d3-force-adaptive";
  const reorderable = family !== null && !adaptive && basis === undefined;
  const axis: Axis = layoutId === "dagre-lr" || layoutId === "dagre-rl" ? "y" : "x";
  const flow = LAYOUT_ENGINES[layoutId].flow;

  const rects = useMemo<ReadonlyMap<string, Rect>>(() => {
    const map = new Map<string, Rect>();
    for (const [name, point] of layout.positions) {
      const size = sizes.get(name);
      if (!size) continue;
      map.set(name, { x: point.x, y: point.y, width: size.width, height: size.height });
    }
    return map;
  }, [layout, sizes]);

  const world = useMemo<DragWorld | null>(() => {
    if (!reorderable || family === null) return null;
    let ranks: readonly (readonly string[])[] = [];
    if (kindOf(family) === "ranks") {
      const read = layoutRanks.current ?? ranksFromPositions(layout.positions, axis);
      // Rows read off the positions run from the top, or the left: the roots are at the other end when the ranks run up or left.
      const ordered = layoutRanks.current === undefined && (flow === "bt" || flow === "rl") ? [...read].reverse() : read;
      ranks = ordered.map((row) => row.filter((name) => rects.has(name)));
    }
    return { family, rects, links: visible.relationships, ranks, axis };
  }, [reorderable, family, layout, rects, visible, axis, flow]);

  const [move, setMove] = useState<Move | null>(null);
  const moveRef = useRef<Move | null>(null);
  const cancelled = useRef(false);
  const update = useCallback((next: Move | null): void => {
    moveRef.current = next;
    setMove(next);
  }, []);

  const nameOf = useCallback(
    (name: string): string => {
      const item = visible.entities.find((entity) => entity.name === name);
      return item?.displayName || name;
    },
    [visible],
  );

  /** The order a drop on the candidate would keep, and where every card would stand under it. */
  const dropOrder = useMemo(
    () => (move?.candidate && world ? orderAfter(world, move.name, move.candidate, sizes) : null),
    [move?.name, move?.candidate, world, sizes],
  );
  const preview = useMemo(
    () => (dropOrder ? previewPositions(layoutId, dropOrder, layout, arranged.visible.entities, arranged.visible.relationships, arranged.sizes) : null),
    [dropOrder, layoutId, layout, arranged],
  );
  const shown = preview ?? held ?? layout.positions;

  const finish = useCallback(
    (commit: boolean): void => {
      const current = moveRef.current;
      update(null);
      if (!current || !commit || !current.candidate || !world || family === null) return;
      const order = orderAfter(world, current.name, current.candidate, sizes);
      if (!order) {
        actions.announce(`${nameOf(current.name)} stays where it is.`);
        return;
      }
      if (preview && customKey !== null) setHeld(preview);
      actions.commitCustomOrder(family, order);
      actions.announce(`${nameOf(current.name)} moved. The order is now Custom.`);
    },
    [update, world, family, sizes, preview, nameOf, customKey],
  );

  // The held drop never stays longer than the arrangement it waits for takes.
  useEffect(() => {
    if (held === null) return;
    const timer = window.setTimeout(() => setHeld(null), 2000);
    return () => window.clearTimeout(timer);
  }, [held]);

  const cancel = useCallback((): void => {
    if (moveRef.current === null) return;
    cancelled.current = true;
    update(null);
    actions.announce("Move cancelled.");
  }, [update]);

  // Escape puts the card back, while it is dragged by the pointer too.
  const moving = move !== null;
  useEffect(() => {
    if (!moving) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving, cancel]);

  const onPointerDragStart = (name: string, corner: Point): void => {
    if (!world || !world.rects.has(name)) return;
    cancelled.current = false;
    update({ name, ghost: corner, candidate: currentCandidate(world, name), source: "pointer" });
  };

  const onPointerDrag = (name: string, corner: Point): void => {
    const current = moveRef.current;
    if (!world || !current || current.name !== name || cancelled.current) return;
    const size = sizes.get(name) ?? { width: 0, height: 0 };
    const candidate = candidateAt(world, name, { x: corner.x + size.width / 2, y: corner.y + size.height / 2 });
    update({ ...current, ghost: corner, candidate });
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!world || event.altKey || event.ctrlKey || event.metaKey) return;
    const current = moveRef.current;
    if (current?.source === "keyboard") {
      const stop = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape") {
        stop();
        cancel();
      } else if (event.key === "Enter" || event.key === " ") {
        stop();
        finish(true);
      } else if (event.key === "Tab") {
        cancel();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
        stop();
        const next = stepCandidate(world, current.name, current.candidate, event.key as StepKey);
        if (next === null) {
          actions.announce("No further place.");
          return;
        }
        update({ ...current, candidate: next });
        actions.announce(`${describeMove(world, current.name, next)}`);
      } else {
        stop();
      }
      return;
    }
    if (event.key !== "m" && event.key !== "M") return;
    const holder = (event.target as HTMLElement).closest<HTMLElement>("[data-entity]");
    const name = holder?.dataset.entity;
    if (!name || !world.rects.has(name)) return;
    event.preventDefault();
    event.stopPropagation();
    if (candidatesOf(world, name).length === 0) {
      actions.announce(`${nameOf(name)} has no other place.`);
      return;
    }
    cancelled.current = false;
    update({ name, ghost: null, candidate: currentCandidate(world, name), source: "keyboard" });
    actions.announce(
      `${nameOf(name)} picked up. Arrow keys choose a place, Enter drops it, Escape puts it back.${
        currentCandidate(world, name) ? ` ${describeMove(world, name, currentCandidate(world, name) as Candidate)}` : ""
      }`,
    );
  };

  const base = useMemo<EntityRfNode[]>(
    () =>
      visible.entities.map((entity) => {
        const size = sizes.get(entity.name) ?? { width: 0, height: 0 };
        const position = shown.get(entity.name) ?? { x: 0, y: 0 };
        return {
          id: entity.name,
          type: "entity",
          position: { x: position.x, y: position.y },
          width: size.width,
          ...(visible.dotNames.has(entity.name) ? { height: size.height } : level !== "card" ? { height: LEVEL_HEIGHT[level] } : {}),
          // Carried so React Flow keeps the measured handle bounds when a new layout swaps the
          // node objects; without it `parseHandles` drops them and no edge is ever drawn.
          measured: { width: size.width, height: visible.dotNames.has(entity.name) || level === "card" ? size.height : LEVEL_HEIGHT[level] },
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
            badge: badges?.get(entity.name.toLowerCase()) ?? null,
            marked: marked?.has(entity.name.toLowerCase()) ?? false,
            inChain: chain.has(entity.name.toLowerCase()),
            level,
            ...(reorderable ? { reorderable: true } : {}),
            ...(move?.name === entity.name ? { dragging: true } : {}),
          },
        };
      }),
    [visible, shown, sizes, selectedName, highlightedName, collapsed, controls, badges, marked, chain, level, reorderable, move?.name],
  );

  // The copy that follows the pointer, and the place the card would take.
  const nodes = useMemo<TopologyNode[]>(() => {
    if (!move) return base;
    const moved = base.find((node) => node.id === move.name);
    if (!moved) return base;
    const extra: TopologyNode[] = [];
    if (move.candidate) {
      extra.push({
        id: SLOT_ID,
        type: "slot",
        position: moved.position,
        width: moved.width ?? 0,
        height: moved.measured?.height ?? 0,
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -1,
        data: { width: moved.measured?.width ?? 0, height: moved.measured?.height ?? 0 },
      });
    }
    if (move.ghost) {
      extra.push({
        id: GHOST_ID,
        type: "ghost",
        position: move.ghost,
        width: moved.width ?? 0,
        ...(moved.height === undefined ? {} : { height: moved.height }),
        ...(moved.measured ? { measured: moved.measured } : {}),
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: 1000,
        data: { ...moved.data, ghost: move.candidate ? "free" : "blocked", dragging: false },
      });
    }
    return [...base, ...extra];
  }, [base, move]);

  const shownRects = useMemo<ReadonlyMap<string, Rect>>(() => {
    if (shown === layout.positions) return rects;
    const map = new Map<string, Rect>();
    for (const [name, point] of shown) {
      const size = sizes.get(name);
      if (size) map.set(name, { x: point.x, y: point.y, width: size.width, height: size.height });
    }
    return map;
  }, [shown, layout, rects, sizes]);

  const edges = useMemo(
    () =>
      buildEdges(
        visible.relationships,
        new Map(visible.entities.map((entity) => [entity.name, entity])),
        shownRects,
        LAYOUT_ENGINES[layoutId].flow,
        edgeStyle,
        connectionPolicy,
        visible.dotNames,
      ),
    [visible, shownRects, layoutId, edgeStyle, connectionPolicy],
  );

  return (
    <div
      id={idPrefix}
      data-testid={idPrefix}
      data-moving={move ? move.source : undefined}
      data-moving-to={move?.candidate ? (move.candidate.kind === "swap" ? move.candidate.target : String(move.candidate.index)) : undefined}
      className={mergeClasses("topology", styles.root, (level === "dot" || level === "speck") && "topology--far", move !== null && "topology--reordering")}
      onKeyDownCapture={onKeyDownCapture}
    >
      {label ? <div className={styles.label}>{label}</div> : null}
      <div className={styles.canvas}>
        <ReactFlow
          id={idPrefix}
          nodes={nodes}
          edges={edges}
          nodeOrigin={[0, 0]}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={minZoom}
          nodesDraggable={adaptive || reorderable}
          nodeDragThreshold={4}
          nodeClickDistance={4}
          nodesConnectable={false}
          nodesFocusable={false}
          elementsSelectable={false}
          onNodesChange={(changes: NodeChange<TopologyNode>[]) => {
            setMeasuredCards((previous) => {
              let next: Map<string, NodeSize> | undefined;
              for (const change of changes) {
                // Far out a card is drawn smaller; what the layout keeps is its size as a card.
                if (change.type !== "dimensions" || !change.dimensions || visible.dotNames.has(change.id) || level !== "card") continue;
                if (change.id === GHOST_ID || change.id === SLOT_ID) continue;
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
            if (adaptive) {
              liveSession.current?.setDrag(node.id, { x: node.position.x, y: node.position.y });
              return;
            }
            if (reorderable) onPointerDragStart(node.id, node.position);
          }}
          onNodeDrag={(_, node) => {
            if (adaptive) {
              liveSession.current?.setDrag(node.id, { x: node.position.x, y: node.position.y });
              return;
            }
            if (reorderable) onPointerDrag(node.id, node.position);
          }}
          onNodeDragStop={(_, node) => {
            if (adaptive) {
              liveSession.current?.setDrag(node.id, null);
              liveSession.current?.settle();
              const nextPositions = new Map(layout.positions);
              nextPositions.set(node.id, node.position);
              settled.current = { key: settledKey, positions: nextPositions };
              return;
            }
            if (!reorderable) return;
            const wasCancelled = cancelled.current;
            cancelled.current = false;
            if (!wasCancelled) finish(true);
          }}
          proOptions={{ hideAttribution: false }}
        >
          <Background id={idPrefix} />
          {minimap ? (
            <MiniMap
              pannable
              zoomable
              ariaLabel="Mini-map: every part coloured by its health state"
              nodeStrokeWidth={0}
              nodeBorderRadius={3}
              nodeColor={heatOf}
              maskColor="rgba(128, 128, 128, 0.18)"
              style={{ backgroundColor: cardTokens.pillFill, border: `1px solid ${cardTokens.pillStroke}` }}
            />
          ) : null}
        </ReactFlow>
        {entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph={idPrefix}>
            {emptyText(label)}
          </div>
        ) : null}
      </div>
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
