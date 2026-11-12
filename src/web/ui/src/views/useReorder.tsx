import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { orderKey, type ModelOrder } from "../model/customOrder";
import type { Point } from "../model/layout";
import {
  candidateAt,
  candidatesOf,
  currentCandidate,
  describeMove,
  orderAfter,
  stepCandidate,
  type Candidate,
  type ReorderWorld,
  type StepKey,
} from "../model/reorder";
import { actions, useStore } from "../store/store";
import "./reorder.css";

/**
 * Dragging a thing to another place of its view, by pointer or keyboard: the one module every view
 * uses. A view says what it draws side by side (`ReorderWorld`) and draws with the order it gets
 * back; where a thing may go, what a drop keeps, the keys and the announcements are the same
 * everywhere. Rules are in `model/reorder.ts`; this is the part that listens and writes.
 */

/** A thing on its way to another place. */
export interface Move {
  readonly id: string;
  /** The corner of the copy that follows the pointer, in the view's coordinates; none for the keyboard. */
  readonly pointer: Point | null;
  /** The place the thing would take; null where none would have it. */
  readonly candidate: Candidate | null;
  readonly source: "pointer" | "keyboard";
}

export interface ReorderOptions {
  /** What a thing is called in an announcement. */
  readonly labelOf: (id: string) => string;
  /** Why a thing that holds its place does, said when M is pressed on it. */
  readonly whyFixed?: (id: string) => string | null;
  /** The data attribute that names a thing on its element: `entity` (`data-entity`) unless ids are not entity names. */
  readonly idAttribute?: string;
  /** Called as a drop is kept, before the store has the order. */
  readonly onKeep?: () => void;
}

export interface Reorder {
  readonly move: Move | null;
  /** The viewer's order for the open model, while the Order is Custom. */
  readonly stored: ModelOrder | null;
  /** While a thing is over a place: the order a drop there would keep. */
  readonly tentative: ModelOrder | null;
  /** The order to draw with: `tentative`, or else `stored`. */
  readonly order: ModelOrder | null;
  /**
   * Call while rendering, once the view is laid out with `order`: what it offers a drag. Null
   * where nothing is dragged (a compared model, the live force layout).
   */
  readonly offer: (world: ReorderWorld | null) => void;
  /** For the element round the view: the keys, and what a test or a style sheet can read. */
  readonly root: {
    readonly "data-moving": Move["source"] | undefined;
    readonly "data-moving-to": string | undefined;
    readonly onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => void;
  };
  /** For a React Flow view: its node drag is the pointer. */
  readonly flow: {
    readonly onNodeDragStart: (event: unknown, node: Node) => void;
    readonly onNodeDrag: (event: unknown, node: Node) => void;
    readonly onNodeDragStop: () => void;
  };
  /** For any other view: call on pointer down on a thing. `toLocal` turns a point of the window into the view's coordinates. */
  readonly onPointerDown: (id: string, event: ReactPointerEvent<Element>, toLocal: (client: Point) => Point) => void;
}

/** How far the pointer goes before a press becomes a drag, so a click stays a click. */
export const DRAG_THRESHOLD = 4;

function sameCandidate(left: Candidate | null, right: Candidate | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "index") return right.kind === "index" && left.index === right.index;
  return right.kind === "swap" && left.target === right.target;
}

export function useReorder({ labelOf, whyFixed, idAttribute = "entity", onKeep }: ReorderOptions): Reorder {
  const stored = useStore((state) => {
    const key = orderKey(state.selected);
    return state.sortKey === "custom" && key !== null ? (state.customOrders[key] ?? null) : null;
  });

  const [move, setMove] = useState<Move | null>(null);
  const moveRef = useRef<Move | null>(null);
  // A drag is judged against what was on screen when it began: the view draws the order a drop would keep as it goes.
  const held = useRef<{ readonly world: ReorderWorld; readonly base: ModelOrder | null } | null>(null);
  const cancelled = useRef(false);
  const offered = useRef<ReorderWorld | null>(null);
  const latest = useRef({ stored, labelOf, whyFixed, onKeep });
  latest.current = { stored, labelOf, whyFixed, onKeep };
  const offer = useCallback((world: ReorderWorld | null): void => {
    offered.current = world;
  }, []);

  const update = useCallback((next: Move | null): void => {
    const before = moveRef.current;
    const kept = next && before && sameCandidate(before.candidate, next.candidate) ? { ...next, candidate: before.candidate } : next;
    moveRef.current = kept;
    if (kept === null) held.current = null;
    setMove(kept);
  }, []);

  const start = useCallback(
    (id: string, pointer: Point | null, source: Move["source"]): boolean => {
      const current = offered.current;
      if (!current || !current.parents.has(id) || !current.rects.has(id)) return false;
      held.current = { world: current, base: latest.current.stored };
      cancelled.current = false;
      update({ id, pointer, candidate: currentCandidate(current, id), source });
      return true;
    },
    [update],
  );

  const dragTo = useCallback(
    (id: string, corner: Point): void => {
      const current = moveRef.current;
      const frozen = held.current;
      if (!frozen || !current || current.id !== id || cancelled.current) return;
      const rect = frozen.world.rects.get(id);
      const centre = { x: corner.x + (rect?.width ?? 0) / 2, y: corner.y + (rect?.height ?? 0) / 2 };
      update({ ...current, pointer: corner, candidate: candidateAt(frozen.world, id, centre) });
    },
    [update],
  );

  const drop = useCallback((): void => {
    const current = moveRef.current;
    const frozen = held.current;
    update(null);
    if (!current || !frozen) return;
    const order = current.candidate ? orderAfter(frozen.world, frozen.base, current.id, current.candidate) : null;
    if (!order) {
      actions.announce(`${latest.current.labelOf(current.id)} stays where it is.`);
      return;
    }
    latest.current.onKeep?.();
    actions.commitCustomOrder(order);
    actions.announce(`${latest.current.labelOf(current.id)} moved. The order is now Custom.`);
  }, [update]);

  const cancel = useCallback((): void => {
    if (moveRef.current === null) return;
    cancelled.current = moveRef.current.source === "pointer";
    update(null);
    actions.announce("Move cancelled.");
  }, [update]);

  // Escape puts the thing back, while it is dragged by the pointer too, wherever the focus is.
  const moving = move !== null;
  useEffect(() => {
    if (!moving) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving, cancel]);

  // A view that stops offering a drag (Compare opens, the layout changes) ends the one under way.
  useEffect(() => {
    if (offered.current === null && moveRef.current !== null) update(null);
  });

  const tentative = useMemo(
    () => (move?.candidate && held.current ? orderAfter(held.current.world, held.current.base, move.id, move.candidate) : null),
    [move?.id, move?.candidate],
  );

  const onKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const stop = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      const current = moveRef.current;
      const frozen = held.current;
      if (current && frozen) {
        if (event.key === "Escape") {
          stop();
          cancel();
        } else if (current.source !== "keyboard") {
          return;
        } else if (event.key === "Enter" || event.key === " ") {
          stop();
          drop();
        } else if (event.key === "Tab") {
          cancel();
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
          stop();
          const next = stepCandidate(frozen.world, current.id, current.candidate, event.key as StepKey);
          if (next === null) {
            actions.announce("No further place.");
            return;
          }
          update({ ...current, candidate: next });
          actions.announce(describeMove(frozen.world, current.id, next, latest.current.labelOf));
        } else {
          stop();
        }
        return;
      }
      const world = offered.current;
      if (!world || (event.key !== "m" && event.key !== "M")) return;
      const id = (event.target as HTMLElement).closest<HTMLElement>(`[data-${idAttribute}]`)?.dataset[idAttribute];
      if (!id || !world.rects.has(id)) return;
      stop();
      const label = latest.current.labelOf(id);
      if (!world.parents.has(id) || candidatesOf(world, id).length === 0) {
        actions.announce((world.parents.has(id) ? null : latest.current.whyFixed?.(id)) ?? `${label} has no other place.`);
        return;
      }
      if (!start(id, null, "keyboard")) return;
      const here = currentCandidate(world, id);
      actions.announce(`${label} picked up. Arrow keys choose a place, Enter drops it, Escape puts it back.${here ? ` ${describeMove(world, id, here, latest.current.labelOf)}` : ""}`);
    },
    [cancel, drop, start, update, idAttribute],
  );

  const flow = useMemo<Reorder["flow"]>(
    () => ({
      onNodeDragStart: (_event, node) => void start(node.id, node.position, "pointer"),
      onNodeDrag: (_event, node) => dragTo(node.id, node.position),
      onNodeDragStop: () => {
        const was = cancelled.current;
        cancelled.current = false;
        if (!was) drop();
      },
    }),
    [start, dragTo, drop],
  );

  const onPointerDown = useCallback<Reorder["onPointerDown"]>(
    (id, event, toLocal) => {
      const world = offered.current;
      const rect = world?.rects.get(id);
      if (!world || !rect || event.button !== 0 || !world.parents.has(id)) return;
      const origin = { x: event.clientX, y: event.clientY };
      const grabbed = toLocal(origin);
      const offset = { x: grabbed.x - rect.x, y: grabbed.y - rect.y };
      const cornerAt = (client: Point): Point => {
        const local = toLocal(client);
        return { x: local.x - offset.x, y: local.y - offset.y };
      };
      let dragging = false;
      const onMove = (next: PointerEvent): void => {
        const client = { x: next.clientX, y: next.clientY };
        if (!dragging) {
          if (Math.hypot(client.x - origin.x, client.y - origin.y) < DRAG_THRESHOLD) return;
          dragging = start(id, cornerAt(client), "pointer");
          if (!dragging) return;
        }
        dragTo(id, cornerAt(client));
      };
      const finish = (keep: boolean): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (!dragging) return;
        // The press that ends a drag is not a click on what lies under it.
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        const was = cancelled.current;
        cancelled.current = false;
        if (was) return;
        if (keep) drop();
        else cancel();
      };
      const onUp = (): void => finish(true);
      const onCancel = (): void => finish(false);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [start, dragTo, drop, cancel],
  );

  const root = useMemo<Reorder["root"]>(
    () => ({
      "data-moving": move?.source,
      "data-moving-to": move?.candidate ? (move.candidate.kind === "swap" ? move.candidate.target : String(move.candidate.index)) : undefined,
      onKeyDownCapture,
    }),
    [move?.source, move?.candidate, onKeyDownCapture],
  );

  return { move, stored, tentative, order: tentative ?? stored, offer, root, flow, onPointerDown };
}

/* ------------------------------------------------------------------------------------------ */
/* For the React Flow views: the copy and the place, as nodes                                  */
/* ------------------------------------------------------------------------------------------ */

export const GHOST_ID = "__ghost__";
export const SLOT_ID = "__slot__";

/** What the node of a thing that can be moved is told about the move. */
export interface MoveMarks {
  /** The thing can be moved with the keyboard: M picks it up. */
  readonly reorderable?: boolean;
  /** It is being moved: it stays where its place would be, dimmed. */
  readonly dragging?: boolean;
  /** A see-through copy that follows the pointer; `blocked` while no place would take it. */
  readonly ghost?: "free" | "blocked";
}

/** The class names and attributes of a node for its marks. */
export function moveClass(marks: MoveMarks): string {
  return `${marks.dragging ? " is-dragging" : ""}${marks.ghost ? ` is-ghost${marks.ghost === "blocked" ? " is-blocked" : ""}` : ""}`;
}

interface SlotData extends Record<string, unknown> {
  readonly width: number;
  readonly height: number;
}

/** The empty place a dragged thing would take, drawn where it would stand. */
export function DropSlot({ data }: NodeProps<Node<SlotData, "slot">>): JSX.Element {
  return <div className="drop-indicator" data-testid="drop-indicator" style={{ width: data.width, height: data.height }} />;
}

/**
 * The nodes of a view with a move drawn in: the place the thing would take, marked under it, and
 * the copy that follows the pointer. The moved node itself is where the view put it for the order
 * a drop would keep.
 */
export function withMoveNodes<N extends Node>(nodes: readonly N[], move: Move | null): Node[] {
  if (!move) return nodes as N[];
  const moved = nodes.find((node) => node.id === move.id);
  if (!moved) return nodes as N[];
  const width = moved.measured?.width ?? moved.width ?? 0;
  const height = moved.measured?.height ?? moved.height ?? 0;
  const still = { draggable: false, selectable: false, focusable: false } as const;
  const extra: Node[] = [];
  if (move.candidate) {
    extra.push({ ...still, id: SLOT_ID, type: "slot", position: moved.position, width, height, zIndex: -1, data: { width, height } });
  }
  if (move.pointer) {
    extra.push({ ...moved, ...still, id: GHOST_ID, position: move.pointer, zIndex: 1000, data: { ...moved.data, ghost: move.candidate ? "free" : "blocked", dragging: false } });
  }
  return [...nodes, ...extra];
}
