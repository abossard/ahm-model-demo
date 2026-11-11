import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { Background, BackgroundVariant, Panel, ReactFlow, ReactFlowProvider, ViewportPortal, useReactFlow } from "@xyflow/react";
import type { NodeTypes } from "@xyflow/react";
import { chainSteps } from "../model/chainSteps";
import { collapseControls, visibleGraph } from "../model/collapse";
import { SIDE_LABEL, linkKey, noEntitiesText } from "../model/compare";
import { cardTokens, edgeAppearance, type DiffMark, type EdgeAppearance } from "../model/palette";
import { orderKey } from "../model/customOrder";
import { FOLD_ABOVE, firstProblem, planFolds, tidyLayout } from "../model/tidy";
import type { Entity } from "../model/types";
import { actions, canvasFrame, useStore } from "../store/store";
import { stepEdge, stepEdgeTypes, type StepRfEdge } from "../components/StepEdge";
import { prefersReducedMotion } from "../components/Topology";
import { TidyFold, TidyTile, type TidyRfNode } from "./TidyTile";
import type { ViewProps } from "./types";

const MIN_ZOOM = 0.05;
const MAX_FIT_ZOOM = 1;
const FIT_PADDING = 0.12;
const FIT_MS = 500;
const FOCUS_MS = 750;
/** Room kept round a tile that keyboard focus brings into view. */
const FOCUS_MARGIN = 24;

const useStyles = makeStyles({
  root: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
  canvas: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden", "@media (max-width: 720px)": { flex: "1 0 320px" } },
  panel: {
    display: "flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
    padding: tokens.spacingHorizontalXS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  shelf: {
    position: "absolute",
    left: 0,
    top: 0,
    boxSizing: "border-box",
    border: `1.2px dashed ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusXLarge,
    pointerEvents: "none",
  },
  shelfLabel: {
    position: "absolute",
    left: "10px",
    top: "7px",
    fontSize: "10.5px",
    fontWeight: tokens.fontWeightBold,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: tokens.colorNeutralForeground3,
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

const nodeTypes: NodeTypes = { tile: TidyTile, fold: TidyFold };

const NEUTRAL: EdgeAppearance = { stroke: "var(--edge)", width: 1.4, dash: "2 4", cap: "round" };

type Mode = "fit" | "problem";

function TidyCanvas({ entities, relationships, selectedName, highlightedName, chainNames, badges, marked, compare, onActivate }: ViewProps): JSX.Element {
  const styles = useStyles();
  const collapsed = useStore((state) => state.collapsed);
  const selectedHealth = useStore((state) => state.selectedHealth);
  const excludedEntityMode = useStore((state) => state.excludedEntityMode);
  const workspaceFrame = useStore(canvasFrame);
  const focusNames = useStore((state) => state.focusNames);
  const focusSeq = useStore((state) => state.focusSeq);
  // The order given by dragging in the card graph is the order of the hierarchy here too.
  const hierarchyOrder = useStore((state) => {
    const key = orderKey(state.selected, "hierarchy");
    const stored = key !== null && state.sortKey === "custom" ? state.customOrders[key] : undefined;
    return stored?.kind === "ranks" ? stored.ranks : undefined;
  });
  const rf = useReactFlow();
  const rfRef = useRef(rf);
  rfRef.current = rf;
  const paneRef = useRef<HTMLDivElement | null>(null);
  // A tile focused by the pointer is where the pointer is; panning under it would make the click miss.
  const pointerDown = useRef(false);

  // The Health filter and the collapse state are the store's, shared with the card graph.
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);
  const options = useMemo(() => ({ selectedHealth: new Set(selectedHealth), excludedEntityMode }), [selectedHealth, excludedEntityMode]);
  const visible = useMemo(() => visibleGraph(entities, relationships, collapsedSet, options), [entities, relationships, collapsedSet, options]);
  const controls = useMemo(() => collapseControls(entities, relationships, collapsedSet, options), [entities, relationships, collapsedSet, options]);
  const byName = useMemo(() => new Map(visible.entities.map((entity) => [entity.name, entity] as const)), [visible]);
  const steps = useMemo(() => chainSteps(chainNames, byName.keys()), [chainNames, byName]);

  // In Compare, both sides are arranged together and each draws what it has: folds, keeps and the
  // arrangement come from everything either side draws, so an entity keeps its place on both.
  const side = compare !== undefined && compare.side !== "merged" ? compare : null;
  const shared = useMemo(
    () => (side ? visibleGraph(side.basis.entities, side.basis.relationships, collapsedSet, options) : visible),
    [side, visible, collapsedSet, options],
  );
  const sharedNames = useMemo(() => new Map(shared.entities.map((entity) => [entity.name.toLowerCase(), entity.name] as const)), [shared]);

  // What must stay a tile rather than fold into a count: whatever the viewer is looking at or was sent to.
  const keep = useMemo(() => {
    const names = new Set<string>(chainSteps(chainNames, sharedNames.values()).keys());
    for (const name of [selectedName, highlightedName, ...focusNames]) if (name) names.add(name);
    for (const key of [...(marked ?? []), ...(side ? side.marks.keys() : (badges?.keys() ?? []))]) {
      const name = sharedNames.get(key);
      if (name) names.add(name);
    }
    return names;
  }, [chainNames, sharedNames, selectedName, highlightedName, focusNames, marked, badges, side]);

  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const folds = useMemo(() => planFolds(shared.entities, shared.relationships, keep, openFolds), [shared, keep, openFolds]);
  const allOpen = folds.length > 0 && folds.every((fold) => fold.open);
  // A side draws only what it has, in the places the arrangement of both gives it.
  const only = useMemo(
    () => (side ? { entities: new Set(visible.entities.map((entity) => entity.name)), links: new Set(visible.relationships.map((item) => linkKey(item.parentEntityName, item.childEntityName))) } : undefined),
    [side, visible],
  );

  // Selecting a tile that is already drawn changes no fold, so it must not lay the graph out again.
  const foldsKey = folds.map((fold) => `${fold.id}${fold.open ? "+" : "-"}${fold.members.join(",")}`).join("|");
  const foldsRef = useRef(folds);
  foldsRef.current = folds;
  const layout = useMemo(
    () =>
      tidyLayout({
        entities: shared.entities,
        relationships: shared.relationships,
        folds: foldsRef.current,
        whole: side ? side.basis : { entities, relationships },
        ...(only ? { only } : {}),
        ...(hierarchyOrder ? { order: hierarchyOrder } : {}),
      }),
    // `foldsRef` holds the folds `foldsKey` names, so the key is what decides when to lay out again.
    [shared, foldsKey, entities, relationships, side, only, hierarchyOrder],
  );
  const problem = useMemo(() => firstProblem(visible.entities, visible.relationships, layout.nodes.map((node) => node.id)), [visible, layout]);
  const dense = shared.entities.length > FOLD_ABOVE;

  const onToggle = useCallback((entity: Entity, wasCollapsed: boolean, hiddenCount: number): void => {
    const label = entity.displayName || entity.name;
    actions.toggleCollapse(entity.name);
    actions.announce(wasCollapsed ? `${label} expanded.` : `${label} collapsed, ${hiddenCount} nodes hidden.`);
  }, []);
  const onToggleFold = useCallback((parent: string, open: boolean): void => {
    setOpenFolds((previous) => {
      const next = new Set(previous);
      if (open) next.add(parent);
      else next.delete(parent);
      return next;
    });
  }, []);

  // The browser scrolls a clipped container to a focused element; the viewport is React Flow's to move.
  const onFocusNode = useCallback((id: string, element: HTMLElement): void => {
    const pane = paneRef.current;
    if (!pane) return;
    for (let node: HTMLElement | null = element; node && node !== pane.parentElement; node = node.parentElement) {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }
    if (pointerDown.current) return;
    const target = rfRef.current.getNode(id);
    const viewport = rfRef.current.getViewport();
    const box = pane.getBoundingClientRect();
    if (!target) return;
    const left = target.position.x * viewport.zoom + viewport.x;
    const top = target.position.y * viewport.zoom + viewport.y;
    const right = left + (target.width ?? 0) * viewport.zoom;
    const bottom = top + (target.height ?? 0) * viewport.zoom;
    if (left >= FOCUS_MARGIN && top >= FOCUS_MARGIN && right <= box.width - FOCUS_MARGIN && bottom <= box.height - FOCUS_MARGIN) return;
    void rfRef.current.setCenter(target.position.x + (target.width ?? 0) / 2, target.position.y + (target.height ?? 0) / 2, { zoom: viewport.zoom, duration: prefersReducedMotion() ? 0 : FIT_MS });
  }, []);

  const nodes = useMemo<TidyRfNode[]>(
    () =>
      layout.nodes.map((node): TidyRfNode => {
        const size = { width: node.rect.width, height: node.rect.height };
        const common = { id: node.id, position: { x: node.rect.x, y: node.rect.y }, ...size, measured: size };
        if (node.kind === "fold") {
          const parent = byName.get(node.fold.parent);
          return { ...common, type: "fold", data: { fold: node.fold, parentLabel: parent?.displayName || node.fold.parent, onToggleFold, onFocusNode } };
        }
        const entity = byName.get(node.id) as Entity;
        const key = entity.name.toLowerCase();
        const control = controls.get(entity.name);
        const isCollapsed = collapsedSet.has(entity.name);
        return {
          ...common,
          type: "tile",
          data: {
            entity,
            selected: entity.name === selectedName,
            highlighted: entity.name === highlightedName,
            step: steps.get(entity.name) ?? null,
            badge: badges?.get(key) ?? null,
            marked: marked?.has(key) ?? false,
            dimmed: visible.dotNames.has(entity.name),
            collapse: control ? { collapsed: isCollapsed, hiddenCount: isCollapsed ? (visible.hiddenCounts.get(entity.name) ?? 0) : control.hiddenCount } : null,
            onActivate,
            onToggle,
            onFocusNode,
          },
        };
      }),
    [layout, byName, controls, collapsedSet, visible, selectedName, highlightedName, steps, badges, marked, onActivate, onToggle, onToggleFold, onFocusNode],
  );

  const edges = useMemo<StepRfEdge[]>(
    () =>
      layout.edges.map((edge) => {
        const child = byName.get(edge.to);
        const diff = child ? badges?.get(child.name.toLowerCase()) : undefined;
        const mark: DiffMark | null = diff === "added" || diff === "removed" ? diff : null;
        const faint = visible.dotNames.has(edge.from) || visible.dotNames.has(edge.to);
        const base = child ? edgeAppearance(child.healthState, child.impact, mark) : NEUTRAL;
        const from = steps.get(edge.from);
        const to = steps.get(edge.to);
        return stepEdge({
          id: edge.id,
          source: edge.from,
          target: edge.to,
          points: edge.points,
          label: edge.label,
          text: edge.text,
          appearance: faint ? { ...base, stroke: cardTokens.muted } : base,
          emphasised: from !== undefined && to !== undefined && from === to + 1,
        });
      }),
    [layout, byName, steps, badges, visible],
  );

  // Fit to the screen, or on a large model to the first problem; again when the model, the Health
  // filter or the side panel changes what is on screen. Collapsing and selecting leave the view alone.
  const mode = useRef<Mode>("fit");
  const problemRef = useRef(problem);
  problemRef.current = problem;
  const show = useCallback((how: Mode, duration: number): void => {
    mode.current = how;
    const wanted = problemRef.current;
    if (how === "problem" && wanted.length > 0) void rfRef.current.fitView({ nodes: wanted.map((id) => ({ id })), maxZoom: MAX_FIT_ZOOM, padding: 0.5, duration });
    else void rfRef.current.fitView({ padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, duration });
  }, []);
  const modelKey = useMemo(() => entities.map((entity) => entity.name).join("|"), [entities]);
  const fitKey = `${modelKey}#${selectedHealth.join(",")}#${excludedEntityMode}#${workspaceFrame}`;
  const lastFit = useRef<string | null>(null);
  const lastModel = useRef<string | null>(null);
  useEffect(() => {
    if (layout.nodes.length === 0 || lastFit.current === fitKey) return;
    // Marked done only when the frame runs, so an effect that is cancelled and run again still fits.
    const frame = requestAnimationFrame(() => {
      const first = lastFit.current === null;
      const fresh = lastModel.current !== modelKey;
      lastFit.current = fitKey;
      lastModel.current = modelKey;
      show(fresh ? (dense && problemRef.current.length > 0 ? "problem" : "fit") : mode.current, first || prefersReducedMotion() ? 0 : FIT_MS);
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, fitKey, modelKey, dense, show]);

  // A search result: bring its entities into view.
  const lastFocus = useRef(focusSeq);
  const pendingFit = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (focusSeq === 0 || focusNames.length === 0 || focusSeq <= lastFocus.current) return;
    lastFocus.current = focusSeq;
    pendingFit.current = focusNames;
  }, [focusSeq, focusNames]);
  useEffect(() => {
    const names = pendingFit.current;
    if (!names) return;
    const present = names.filter((name) => layout.nodes.some((node) => node.id === name));
    pendingFit.current = null;
    if (present.length === 0) return;
    void rfRef.current.fitView({ nodes: present.map((name) => ({ id: name })), duration: prefersReducedMotion() ? 0 : FOCUS_MS, maxZoom: 1.4, padding: 0.3 });
  }, [layout, focusSeq]);

  return (
    <div className={styles.root} data-testid="tidy-view" data-side={side?.side}>
      <div
        className={styles.canvas}
        ref={paneRef}
        onPointerDownCapture={() => {
          pointerDown.current = true;
        }}
        onPointerUpCapture={() => {
          pointerDown.current = false;
        }}
        onPointerCancelCapture={() => {
          pointerDown.current = false;
        }}
      >
        <ReactFlow
          id={side ? `tidy-${side.side}` : "tidy"}
          aria-label={side ? `${SIDE_LABEL[side.side as "base" | "proposed"]}, tidy tree` : "Health model, tidy tree"}
          nodes={nodes}
          edges={edges}
          nodeOrigin={[0, 0]}
          nodeTypes={nodeTypes}
          edgeTypes={stepEdgeTypes}
          minZoom={MIN_ZOOM}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background id={side ? `tidy-${side.side}` : "tidy"} variant={BackgroundVariant.Dots} gap={24} size={2.4} color="var(--colorNeutralStroke1)" />
          <ViewportPortal>
            {layout.shelves.map((shelf, index) => (
              <div
                key={index}
                className={styles.shelf}
                data-testid="tidy-shelf"
                aria-hidden="true"
                style={{ transform: `translate(${shelf.x}px, ${shelf.y}px)`, width: shelf.width, height: shelf.height }}
              >
                <span className={styles.shelfLabel}>Not connected to the root</span>
              </div>
            ))}
          </ViewportPortal>
          <Panel position="top-left" className={styles.panel}>
            <Button size="small" data-testid="tidy-fit" onClick={() => show("fit", prefersReducedMotion() ? 0 : FIT_MS)}>
              Fit
            </Button>
            {problem.length > 0 ? (
              <Button size="small" data-testid="tidy-problem" onClick={() => show("problem", prefersReducedMotion() ? 0 : FIT_MS)}>
                First problem
              </Button>
            ) : null}
            {folds.length > 0 ? (
              <Button
                size="small"
                data-testid="tidy-fold-all"
                onClick={() => setOpenFolds(allOpen ? new Set() : new Set(folds.map((fold) => fold.parent)))}
              >
                {allOpen ? "Fold healthy leaves" : "Show healthy leaves"}
              </Button>
            ) : null}
          </Panel>
        </ReactFlow>
        {entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="tidy">
            {noEntitiesText(compare)}
          </div>
        ) : visible.entities.length === 0 ? (
          <div className={styles.empty} data-testid="graph-empty" data-graph="tidy">
            The Health filter hides every entity.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TidyView(props: ViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <TidyCanvas {...props} />
    </ReactFlowProvider>
  );
}
