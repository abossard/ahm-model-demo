import { EMPTY_TIMELINE, type EntityInfo, type Point, type SignalInfo, type StateHistory, type SeriesHistory, type TimelineData, seriesKey } from "../model/timeline";
import { bandsFromPoints, bucketSize, changeFrom, holdOf, parseDuration, type Band } from "../model/timelineBands";
import { GESTURE_GAP_MS, wheelPixels, wheelStep, wheelZoom, type AxisLock } from "../model/timelineGesture";
import { entityBands, type Incident } from "../model/timelineIncidents";
import { markersOf, tooltipLines, type Tip } from "../model/timelineHover";
import { incidentText } from "../model/timelineIncidents";
import { laneOf, type Lane } from "../model/timelineLine";
import { ROW_HEIGHT, visibleRows, type Row, type RowModel } from "../model/timelineRows";
import {
  brushView,
  clampView,
  cursorStep,
  formatMoment,
  makeScale,
  panBy,
  sameView,
  timeTicks,
  type OffsetOf,
  zoomAt,
  type Bounds,
  type View,
} from "../model/timelineScale";
import type { TimelineColors } from "./colors";
import {
  AXIS_HEIGHT,
  clear,
  drawAxis,
  drawBrush,
  drawCursor,
  drawEntityRow,
  drawGrid,
  drawMoment,
  drawRowOutline,
  drawSignalRow,
  INCIDENT_BAND,
  type Box,
  type Frame,
} from "./draw";

export interface PlotModel {
  readonly data: TimelineData;
  readonly rows: RowModel;
  readonly colors: TimelineColors;
  /** The entity that is selected: its rows are outlined and its state changes are marked. */
  readonly selectedName: string | null;
  readonly loading: ReadonlySet<string>;
  readonly incidents: readonly Incident[];
  readonly bounds: Bounds;
  /** Minutes behind UTC at an instant, as `Date.getTimezoneOffset` gives it. */
  readonly offsetOf: OffsetOf;
  /** The window follows now: the server's clock is `skew` ms ahead of the browser's. Null when it stays where it is. */
  readonly follow: { readonly skew: number } | null;
}

export interface PlotHooks {
  /** The view a gesture settled on. */
  readonly view: (view: View) => void;
  /** The selected moment changed, null for now. Called at most once per animation frame, and never with the moment it has. */
  readonly pin: (t: number | null) => void;
  /** The rows scrolled to `top`. Called inside the frame that draws them there, so the tree can move with the plot. */
  readonly scroll: (top: number) => void;
  /** A click on a row of the plot: the keyboard focus goes there. The entity opens from its name, not from the plot. */
  readonly focus: (row: Row) => void;
  readonly incident: (incident: Incident) => void;
  readonly reset: () => void;
  readonly tip: (tip: Tip | null, x: number, y: number, offsetOf: OffsetOf) => void;
  readonly announce: (text: string) => void;
}

type Gesture =
  | { readonly kind: "pan"; lastX: number; moved: number; samples: { t: number; c: number }[] }
  | { readonly kind: "brush"; readonly x0: number; x1: number }
  | { readonly kind: "pinch"; readonly d0: number; readonly s0: number; readonly anchor: number }
  | { readonly kind: "moment" };

const EASE_MS = 70;
const FRICTION_MS = 325;
const COMMIT_MS = 160;
const CLICK_PX = 4;
/** How near the line of the selected moment a press takes hold of it: a finger needs more room than a mouse. */
const GRAB_PX = { mouse: 6, touch: 16 } as const;
/** The lanes of a series that are kept: the zoom level that shows and the ones a pinch just left. */
const LANES_KEPT = 3;
/** Two scroll offsets this near are the same place: a scroller of the page keeps its own to a fraction of a pixel. */
const SAME_PX = 0.05;
const NO_MARKERS = { annotations: [], reports: [] } as const;
const NO_CHANGES: readonly never[] = [];
const NO_RULES: SignalInfo["rules"] = { degraded: null, unhealthy: null, dynamic: false };

interface HeldLanes {
  readonly rules: SignalInfo["rules"];
  readonly hold: number;
  readonly bySize: Map<number, Lane>;
  /** At this bucket size and below, every bucket is one evaluation: one lane serves them all. */
  exactSize: number;
}

/**
 * The bands of an entity's row, worked out once per history, state and now: the last state of a quiet row holds up to
 * now, so a later now is a longer band although the history is the same.
 */
export function createEntityBands(): (data: TimelineData, entity: EntityInfo) => readonly Band[] {
  const cache = new WeakMap<StateHistory, { readonly state: number; readonly now: number; readonly bands: readonly Band[] }>();
  return (data, entity) => {
    const history = data.states[entity.name];
    if (!history) return [];
    const cached = cache.get(history);
    if (cached && cached.state === entity.state && cached.now === data.now) return cached.bands;
    const bands = entityBands(data, entity);
    cache.set(history, { state: entity.state, now: data.now, bands });
    return bands;
  };
}

/**
 * The canvas of the timeline: it owns the view window, the scroll offset of the rows, the selected moment while it is
 * dragged, the gestures that move them and one draw per frame. React only hands it a model when data or selection
 * change; a drag, a wheel turn or a hover never touches React state.
 */
export class Plot {
  private readonly ctx: CanvasRenderingContext2D;
  private model: PlotModel = {
    data: EMPTY_TIMELINE,
    rows: { rows: [], height: 0, indexByKey: new Map() },
    colors: {} as TimelineColors,
    selectedName: null,
    loading: new Set(),
    incidents: [],
    bounds: { lo: 0, hi: 1 },
    offsetOf: () => 0,
    follow: null,
  };
  private followTimer = 0;
  /** A gesture has settled and its window is about to be committed: following must not move it meanwhile. */
  private pendingCommit = false;
  private width = 1;
  private height = 1;
  private dpr = 1;
  /** Where the rows are scrolled to, to the fraction of a pixel a touchpad reports; they are drawn at the device pixel nearest to it. */
  private scrollTop = 0;
  private scrollSent = 0;
  private target: View = { t0: 0, t1: 1 };
  private shown: View = { t0: 0, t1: 1 };
  private velocity = 0;
  private frameId = 0;
  private lastTs = 0;
  private dirty = true;
  private commitTimer = 0;
  private pointerX: number | null = null;
  private pointerY = 0;
  /** The selected moment, and the one the store has: they differ from a drag or a key press until the next frame. */
  private moment: number | null = null;
  private momentSent: number | null = null;
  private momentText: readonly [number, string] = [Number.NaN, ""];
  private momentBox: Box | null = null;
  private gesture: Gesture | null = null;
  private wheelLock: AxisLock | null = null;
  /** A wheel gesture is going on: the tooltip stays away until it ends. */
  private wheeling = false;
  private wheelTimer = 0;
  private tipShown = false;
  private cursorStyle = "";
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly entityBands = createEntityBands();
  private readonly seriesCache = new WeakMap<SeriesHistory, { bands: readonly Band[]; hold: number; end: number }>();
  private readonly lanes = new WeakMap<readonly Point[], HeldLanes>();
  private markerKey: readonly [unknown, unknown] = [null, null];
  private markers = new Map<string, { annotations: TimelineData["annotations"]; reports: TimelineData["reports"] }>();
  private entities = new Map<string, EntityInfo>();
  private visible: readonly [number, number] = [0, 0];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: PlotHooks,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("A 2D canvas is not available.");
    this.ctx = ctx;
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onCancel);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("dblclick", this.onDouble);
  }

  destroy(): void {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointercancel", this.onCancel);
    c.removeEventListener("pointerleave", this.onLeave);
    c.removeEventListener("dblclick", this.onDouble);
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.commitTimer);
    window.clearTimeout(this.wheelTimer);
    window.clearInterval(this.followTimer);
  }

  /* ---------- inputs from React ---------- */

  setModel(model: PlotModel): void {
    this.model = model;
    this.followNow(model.follow !== null);
    this.entities = new Map(model.data.entities.map((entity) => [entity.name, entity]));
    if (this.markerKey[0] !== model.data.annotations || this.markerKey[1] !== model.data.reports) this.indexMarkers();
    this.scrollTop = this.clampScroll(this.scrollTop);
    this.invalidate();
  }

  /** The bounds a gesture is held to: while following, the right edge is now, which moves. */
  private bounds(): Bounds {
    const { bounds, follow } = this.model;
    return follow ? { lo: bounds.lo, hi: Math.max(bounds.hi, Date.now() + follow.skew) } : bounds;
  }

  /** Keeps the right edge of the window at now, four times a second: enough that a pixel never lags by more than a moment. */
  private followNow(on: boolean): void {
    if (!on) {
      window.clearInterval(this.followTimer);
      this.followTimer = 0;
      return;
    }
    if (this.followTimer !== 0) return;
    this.followTimer = window.setInterval(() => {
      const follow = this.model.follow;
      if (!follow || this.gesture || this.velocity !== 0 || this.pendingCommit || document.hidden) return;
      const hi = Date.now() + follow.skew;
      const span = this.target.t1 - this.target.t0;
      this.target = { t0: hi - span, t1: hi };
      this.shown = this.target;
      this.invalidate();
    }, 250);
  }

  /** Moves the view to `view`, easing there unless `animate` is false. A view the plot already has is ignored. */
  setView(view: View, animate = true): void {
    const next = clampView(view, this.bounds());
    if (sameView(next, this.target, 1)) return;
    this.target = next;
    this.velocity = 0;
    if (!animate) this.shown = next;
    this.invalidate();
  }

  getView(): View {
    return this.target;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scrollTop = this.clampScroll(this.scrollTop);
    this.invalidate();
  }

  /** The moment the store has: one that a drag or a key set here is already this one. */
  setMoment(t: number | null): void {
    this.momentSent = t;
    if (t === this.moment) return;
    this.moment = t;
    this.invalidate();
  }

  getMoment(): number | null {
    return this.moment;
  }

  /** Where the rows are drawn: the scroll offset at the device pixel, which is also an offset a scroller of the page can take. */
  getScroll(): number {
    return Math.round(this.scrollTop * this.dpr) / this.dpr;
  }

  /**
   * Scrolls the rows to `top`, as far as they go. The tree hears of it in the next frame; it also hears when `top` is
   * somewhere the rows cannot be, so a scroller that got there by itself comes back.
   */
  scrollTo(top: number): void {
    const next = this.clampScroll(top);
    const here = Math.abs(next - top) < SAME_PX;
    if (here && Math.abs(top - this.getScroll()) < SAME_PX) return;
    this.scrollTop = next;
    if (!here) this.scrollSent = Number.NaN;
    this.invalidate();
  }

  private clampScroll(top: number): number {
    return Math.max(0, Math.min(top, this.model.rows.height - Math.max(0, this.height - AXIS_HEIGHT)));
  }

  /**
   * Handles a wheel event anywhere in the timeline, over the tree as over the plot: a vertical swipe scrolls the rows,
   * a horizontal one or Shift pans, a pinch or Control zooms. The page behind gets none of it.
   */
  handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const page = Math.max(1, this.height - AXIS_HEIGHT);
    const step = wheelStep(
      {
        dx: wheelPixels(event.deltaX, event.deltaMode, page),
        dy: wheelPixels(event.deltaY, event.deltaMode, page),
        zoom: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
        at: event.timeStamp,
      },
      this.wheelLock,
    );
    this.wheelLock = step.lock;
    this.velocity = 0;
    this.wheeling = true;
    window.clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => {
      this.wheeling = false;
      this.invalidate();
    }, GESTURE_GAP_MS);
    const { x, y } = this.local(event);
    const over = x >= 0 && x <= this.width;
    if (step.intent === "scroll") {
      this.scrollTop = this.clampScroll(this.scrollTop + step.amount);
      this.invalidate();
    } else if (step.intent === "pan") {
      this.target = panBy(this.target, step.amount / makeScale(this.target, this.width).pxPerMs, this.bounds());
      this.shown = this.target;
      this.settle();
    } else this.zoom(wheelZoom(step.amount), makeScale(this.target, this.width).t(over ? x : this.width / 2));
    if (over && y >= 0 && y <= this.height) {
      this.pointerX = x;
      this.pointerY = y;
    }
  }

  /**
   * Handles the keys that move in time. Left and Right move the selected moment, with Shift to the state change before
   * or after it in `row`, the row that has the focus. Returns true when it used the key.
   */
  handleKey(event: KeyboardEvent, row: Row | null): boolean {
    const span = this.target.t1 - this.target.t0;
    const middle = this.target.t0 + span / 2;
    const hover = this.hoverT();
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step = event.key === "ArrowLeft" ? -1 : 1;
        const from = this.moment ?? hover ?? this.target.t1;
        const to = event.shiftKey ? changeFrom(this.bandsOfRow(row ?? this.model.rows.rows[0] ?? null), from, step) : from + step * cursorStep(span, false);
        if (to !== null) this.selectMoment(to);
        return true;
      }
      case "Home":
        this.selectMoment(this.target.t0);
        return true;
      case "End":
        this.selectMoment(this.target.t1);
        return true;
      case "+":
      case "=":
        this.zoom(1 / 1.5, this.anchor());
        return true;
      case "-":
      case "_":
        this.zoom(1.5, this.anchor());
        return true;
      case "[":
        this.pan(-span * 0.25);
        return true;
      case "]":
        this.pan(span * 0.25);
        return true;
      case "0":
        this.hooks.reset();
        return true;
      case " ":
        this.selectMoment(hover ?? this.moment ?? middle);
        return true;
      case "Escape":
        this.moment = null;
        this.invalidate();
        return true;
      default:
        return false;
    }
  }

  /* ---------- the view ---------- */

  /** The instant under the pointer, or null when it is not over the plot. */
  private hoverT(): number | null {
    return this.pointerX === null ? null : makeScale(this.shown, this.width).t(this.pointerX);
  }

  /** What a key zooms around: the selected moment when it shows, else the pointer, else the middle. */
  private anchor(): number {
    const { t0, t1 } = this.target;
    return this.moment !== null && this.moment >= t0 && this.moment <= t1 ? this.moment : (this.hoverT() ?? (t0 + t1) / 2);
  }

  /** Selects a moment from a key, brings it into the window and has it read out. The store hears of it in the next frame. */
  private selectMoment(at: number): void {
    const { lo, hi } = this.bounds();
    const t = Math.min(hi, Math.max(lo, at));
    const { t0, t1 } = this.target;
    this.moment = t;
    if (t < t0 || t > t1) this.pan(t < t0 ? t - t0 - (t1 - t0) * 0.1 : t - t1 + (t1 - t0) * 0.1);
    this.hooks.announce(`${new Date(t).toLocaleString()}`);
    this.invalidate();
  }

  private bandsOfRow(row: Row | null): readonly Band[] {
    if (row === null) return [];
    const entity = this.entities.get(row.entity);
    if (row.kind === "entity") return entity ? this.bandsOf(entity) : [];
    return this.seriesOf(row.entity, row.signal)?.bands ?? [];
  }

  private pan(dt: number): void {
    this.target = panBy(this.target, dt, this.bounds());
    this.settle();
  }

  private zoom(factor: number, anchor: number): void {
    this.target = zoomAt(this.target, anchor, factor, this.bounds());
    this.settle();
  }

  private settle(): void {
    window.clearTimeout(this.commitTimer);
    this.pendingCommit = true;
    this.commitTimer = window.setTimeout(() => {
      this.pendingCommit = false;
      this.hooks.view(this.target);
    }, COMMIT_MS);
    this.invalidate();
  }

  /* ---------- frames ---------- */

  invalidate(): void {
    this.dirty = true;
    if (!this.frameId) this.frameId = requestAnimationFrame(this.frame);
  }

  private readonly frame = (ts: number): void => {
    this.frameId = 0;
    const dt = this.lastTs ? Math.min(50, ts - this.lastTs) : 16;
    this.lastTs = ts;
    let moving = false;

    if (this.velocity !== 0 && !this.gesture) {
      const scale = makeScale(this.target, this.width);
      this.target = panBy(this.target, this.velocity * dt, this.bounds());
      this.shown = this.target;
      this.velocity *= Math.exp(-dt / FRICTION_MS);
      if (Math.abs(this.velocity * scale.pxPerMs) < 0.01) {
        this.velocity = 0;
        this.settle();
      } else moving = true;
    }

    const alpha = 1 - Math.exp(-dt / EASE_MS);
    const scale = makeScale(this.target, this.width);
    const off = Math.abs(this.target.t0 - this.shown.t0) + Math.abs(this.target.t1 - this.shown.t1);
    if (off * scale.pxPerMs > 0.15) {
      this.shown = { t0: this.shown.t0 + (this.target.t0 - this.shown.t0) * alpha, t1: this.shown.t1 + (this.target.t1 - this.shown.t1) * alpha };
      moving = true;
    } else if (off > 0) this.shown = this.target;

    this.tell();
    if (moving || this.dirty) {
      this.dirty = false;
      this.render(moving);
    }
    if (moving) this.frameId = requestAnimationFrame(this.frame);
    else this.lastTs = 0;
  };

  /** Tells the page what moved since the last frame: where the rows are, and the selected moment. Each once, and only when it changed. */
  private tell(): void {
    const top = this.getScroll();
    if (top !== this.scrollSent) {
      this.scrollSent = top;
      this.hooks.scroll(top);
    }
    if (this.moment !== this.momentSent) {
      this.momentSent = this.moment;
      this.hooks.pin(this.moment);
    }
  }

  private indexMarkers(): void {
    const { annotations, reports } = this.model.data;
    this.markerKey = [annotations, reports];
    const out = new Map<string, { annotations: typeof annotations; reports: typeof reports }>();
    for (const item of annotations) {
      const held = out.get(item.entity) ?? { annotations: [], reports: [] };
      out.set(item.entity, { annotations: [...held.annotations, item], reports: held.reports });
    }
    for (const item of reports) {
      const held = out.get(item.entity) ?? { annotations: [], reports: [] };
      out.set(item.entity, { annotations: held.annotations, reports: [...held.reports, item] });
    }
    this.markers = out;
  }

  private bandsOf = (entity: EntityInfo): readonly Band[] => this.entityBands(this.model.data, entity);

  private seriesOf(entity: string, signal: string): { history: SeriesHistory; bands: readonly Band[]; hold: number } | undefined {
    const history = this.model.data.series[seriesKey(entity, signal)];
    if (!history) return undefined;
    const end = this.model.data.now;
    let cached = this.seriesCache.get(history);
    if (!cached || cached.end !== end) {
      const refresh = parseDuration(this.entities.get(entity)?.signals.find((item) => item.name === signal)?.refreshInterval ?? null);
      const hold = holdOf(history.points, refresh);
      cached = { bands: bandsFromPoints(history.points, hold, end), hold, end };
      this.seriesCache.set(history, cached);
    }
    return { history, bands: cached.bands, hold: cached.hold };
  }

  /**
   * The lane of a series for the zoom level that shows. It is made when the series or the level changes, never per frame:
   * a pan and a scroll read the one that is kept.
   */
  private laneFor(points: readonly Point[], rules: SignalInfo["rules"], hold: number, msPerPx: number): Lane | null {
    if (points.length === 0) return null;
    let held = this.lanes.get(points);
    if (!held || held.rules !== rules || held.hold !== hold) {
      held = { rules, hold, bySize: new Map(), exactSize: 0 };
      this.lanes.set(points, held);
    }
    const size = Math.max(bucketSize(msPerPx), held.exactSize);
    let lane = held.bySize.get(size);
    if (!lane) {
      lane = laneOf(points, size, rules, hold);
      if (held.bySize.size >= LANES_KEPT) held.bySize.delete(held.bySize.keys().next().value as number);
      held.bySize.set(size, lane);
      if (lane.exact) held.exactSize = size;
    }
    return lane;
  }

  private render(moving: boolean): void {
    const { ctx, width, height, dpr, model } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = makeScale(this.shown, width);
    const frame: Frame = { ctx, width, height, view: this.shown, scale, colors: model.colors };
    clear(frame);
    const ticks = timeTicks(this.shown, width, 96, model.offsetOf);
    drawGrid(frame, ticks);
    const viewport = Math.max(0, height - AXIS_HEIGHT);
    const top = this.getScroll();
    this.visible = visibleRows(model.rows, top, viewport, 0);
    const [i0, i1] = visibleRows(model.rows, top, viewport, 1);
    const msPerPx = 1 / scale.pxPerMs;
    for (let i = i0; i < i1; i += 1) {
      const row = model.rows.rows[i];
      if (!row) continue;
      const y = AXIS_HEIGHT + row.y - top;
      if (row.kind === "entity") {
        const entity = this.entities.get(row.entity);
        const changes = row.entity === model.selectedName ? (model.data.states[row.entity]?.transitions ?? NO_CHANGES) : NO_CHANGES;
        if (entity) drawEntityRow(frame, row, y, this.bandsOf(entity), this.markers.get(row.entity) ?? NO_MARKERS, changes);
        if (row.entity === model.selectedName) drawRowOutline(frame, y, row.h);
      } else {
        const info = this.entities.get(row.entity)?.signals.find((signal) => signal.name === row.signal);
        const held = this.seriesOf(row.entity, row.signal);
        const hold = held?.hold ?? 300_000;
        const lane = held ? this.laneFor(held.history.points, info?.rules ?? NO_RULES, hold, msPerPx) : null;
        drawSignalRow(frame, row, y, info, held?.history, held?.bands ?? [], lane, hold, model.loading.has(row.entity));
      }
    }
    ctx.fillStyle = model.colors.panel;
    ctx.fillRect(0, 0, width, AXIS_HEIGHT);
    drawAxis(frame, ticks, model.incidents, model.data.now);
    const hovering = this.pointerX !== null && this.gesture?.kind !== "moment";
    if (hovering) drawCursor(frame, this.pointerX as number);
    this.momentBox = this.moment === null ? null : drawMoment(frame, scale.x(this.moment), this.textOf(this.moment));
    if (this.gesture?.kind === "brush") drawBrush(frame, this.gesture.x0, this.gesture.x1);
    // The tooltip reads the lanes where the pointer rests: while the plot moves under it, it stays away.
    if (this.gesture === null && !this.wheeling && !moving && this.velocity === 0) this.updateTip();
    else this.hideTip();
  }

  private textOf(moment: number): string {
    if (this.momentText[0] !== moment) this.momentText = [moment, formatMoment(moment, this.model.offsetOf)];
    return this.momentText[1];
  }

  private hideTip(): void {
    if (!this.tipShown) return;
    this.tipShown = false;
    this.hooks.tip(null, 0, 0, this.model.offsetOf);
  }

  private updateTip(): void {
    const t = this.hoverT();
    if (this.pointerX === null || t === null) {
      this.hideTip();
      return;
    }
    const model = this.model;
    this.tipShown = true;
    if (this.pointerY >= INCIDENT_BAND[0] && this.pointerY < INCIDENT_BAND[1]) {
      const incident = model.incidents.find((item) => t >= item.from && t <= (item.to ?? model.data.now));
      const marker = incident ? [{ kind: "incident" as const, entity: "", t: incident.from, text: incidentText(incident, model.data.now) }] : [];
      this.hooks.tip(incident ? { t, lines: [], hidden: 0, markers: marker } : null, this.pointerX, this.pointerY, model.offsetOf);
      return;
    }
    const [i0, i1] = this.visible;
    const rows = model.rows.rows.slice(i0, i1);
    const hovered = this.rowAt(this.pointerY);
    const inputBase = {
      t,
      rows,
      entities: this.entities,
      bandsOf: this.bandsOf,
      seriesOf: (entity: string, signal: string) => model.data.series[seriesKey(entity, signal)],
      hoveredKey: hovered?.key ?? null,
      maxLines: 14,
      holdOf: (history: SeriesHistory) => this.holdFor(history),
    };
    const { lines, hidden } = tooltipLines(inputBase);
    const reach = 7 / makeScale(this.shown, this.width).pxPerMs;
    const markers =
      hovered && hovered.kind === "entity"
        ? markersOf({
            annotations: model.data.annotations,
            reports: model.data.reports,
            changes: hovered.entity === model.selectedName ? (model.data.states[hovered.entity]?.transitions ?? []) : [],
            entity: hovered.entity,
            t0: t - reach,
            t1: t + reach,
          })
        : [];
    this.hooks.tip({ t, lines, hidden, markers }, this.pointerX, this.pointerY, model.offsetOf);
  }

  private holdFor(history: SeriesHistory): number {
    return this.seriesCache.get(history)?.hold ?? holdOf(history.points);
  }

  private rowAt(y: number): Row | null {
    const content = y - AXIS_HEIGHT + this.getScroll();
    if (y < AXIS_HEIGHT) return null;
    const rows = this.model.rows.rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const row = rows[mid] as Row;
      if (row.y + row.h <= content) lo = mid + 1;
      else hi = mid;
    }
    return rows[lo] ?? null;
  }

  /* ---------- pointer ---------- */

  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The pointer is on the selected moment: on its line, or on the label at its top. */
  private onMoment(x: number, y: number, pointerType: string): boolean {
    if (this.moment === null) return false;
    const box = this.momentBox;
    if (box && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return true;
    const at = makeScale(this.shown, this.width).x(this.moment);
    return Math.abs(x - at) <= (pointerType === "mouse" ? GRAB_PX.mouse : GRAB_PX.touch);
  }

  /** Shows that the selected moment can be dragged from here. */
  private pointAt(x: number, y: number, pointerType: string): void {
    const style = this.onMoment(x, y, pointerType) ? "ew-resize" : "";
    if (style === this.cursorStyle) return;
    this.cursorStyle = style;
    this.canvas.style.cursor = style;
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const { x, y } = this.local(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x, y });
    this.velocity = 0;
    window.clearTimeout(this.commitTimer);
    if (this.pointers.size === 2) {
      const [p, q] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const scale = makeScale(this.target, this.width);
      this.gesture = { kind: "pinch", d0: Math.max(10, Math.hypot(p.x - q.x, p.y - q.y)), s0: this.target.t1 - this.target.t0, anchor: scale.t((p.x + q.x) / 2) };
    } else if (event.shiftKey) this.gesture = { kind: "brush", x0: x, x1: x };
    // A press on the selected moment takes hold of it, wherever on the plot it is: Shift, which zooms to a range, comes first.
    else if (this.onMoment(x, y, event.pointerType)) this.gesture = { kind: "moment" };
    else if (y < AXIS_HEIGHT && event.pointerType === "mouse") this.gesture = { kind: "brush", x0: x, x1: x };
    else this.gesture = { kind: "pan", lastX: x, moved: 0, samples: [{ t: event.timeStamp, c: (this.target.t0 + this.target.t1) / 2 }] };
    this.pointerX = x;
    this.pointerY = y;
    this.invalidate();
  };

  private readonly onMove = (event: PointerEvent): void => {
    const { x, y } = this.local(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x, y });
    const g = this.gesture;
    const inside = Math.max(0, Math.min(this.width, x));
    if (g?.kind === "pan" && this.pointers.size === 1) {
      const dx = x - g.lastX;
      g.lastX = x;
      g.moved += Math.abs(dx);
      if (g.moved > CLICK_PX && dx !== 0) {
        const scale = makeScale(this.target, this.width);
        this.target = panBy(this.target, -dx / scale.pxPerMs, this.bounds());
        this.shown = this.target;
        g.samples.push({ t: event.timeStamp, c: (this.target.t0 + this.target.t1) / 2 });
        if (g.samples.length > 8) g.samples.shift();
      }
    } else if (g?.kind === "brush") g.x1 = inside;
    else if (g?.kind === "moment") {
      const { lo, hi } = this.bounds();
      this.moment = Math.min(hi, Math.max(lo, makeScale(this.shown, this.width).t(inside)));
    } else if (g?.kind === "pinch" && this.pointers.size === 2) {
      const [p, q] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const span = Math.max(1, g.s0 * (g.d0 / Math.max(10, Math.hypot(p.x - q.x, p.y - q.y))));
      const fraction = (p.x + q.x) / 2 / this.width;
      const t0 = g.anchor - fraction * span;
      this.target = clampView({ t0, t1: t0 + span }, this.bounds());
      this.shown = this.target;
    }
    if (g === null) this.pointAt(x, y, event.pointerType);
    this.pointerX = inside;
    this.pointerY = y;
    this.invalidate();
  };

  private readonly onUp = (event: PointerEvent): void => {
    const { x, y } = this.local(event);
    this.pointers.delete(event.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      const rest = [...this.pointers.values()][0];
      this.gesture = rest ? { kind: "pan", lastX: rest.x, moved: 10, samples: [] } : null;
      if (!this.gesture) this.settle();
      return;
    }
    if (this.pointers.size > 0) return;
    this.gesture = null;
    if (g.kind === "brush") {
      if (Math.abs(g.x1 - g.x0) >= 6) {
        const scale = makeScale(this.target, this.width);
        this.target = brushView(scale.t(g.x0), scale.t(g.x1), this.bounds());
        this.settle();
      } else this.click(x, y);
    } else if (g.kind === "pan") {
      if (g.moved > CLICK_PX) {
        this.velocity = this.releaseVelocity(g.samples, event.timeStamp);
        if (this.velocity === 0) this.settle();
      } else this.click(x, y);
    }
    this.invalidate();
  };

  private releaseVelocity(samples: { t: number; c: number }[], at: number): number {
    const last = samples[samples.length - 1];
    if (!last || samples.length < 2 || at - last.t > 60) return 0;
    let first = last;
    for (let i = samples.length - 2; i >= 0 && last.t - (samples[i]?.t ?? 0) <= 100; i -= 1) first = samples[i] as { t: number; c: number };
    return last.t > first.t ? (last.c - first.c) / (last.t - first.t) : 0;
  }

  /** A click selects the moment under it and gives its row the focus; on an incident bar it opens the incident. */
  private click(x: number, y: number): void {
    const t = makeScale(this.shown, this.width).t(x);
    if (y < AXIS_HEIGHT) {
      const incident = this.model.incidents.find((item) => t >= item.from && t <= (item.to ?? this.model.data.now));
      if (incident) this.hooks.incident(incident);
      return;
    }
    // Before any history is read there is no window on screen, and so no moment under a click.
    if (this.model.data.now === 0) return;
    const row = this.rowAt(y);
    const { lo, hi } = this.bounds();
    this.moment = Math.min(hi, Math.max(lo, t));
    if (row) this.hooks.focus(row);
  }

  private readonly onCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.gesture = null;
    this.settle();
  };

  private readonly onLeave = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || this.gesture) return;
    this.pointerX = null;
    this.invalidate();
  };

  private readonly onDouble = (): void => this.hooks.reset();
}

export { ROW_HEIGHT };
