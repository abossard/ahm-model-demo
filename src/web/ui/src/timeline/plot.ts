import { EMPTY_TIMELINE, type EntityInfo, type StateHistory, type SeriesHistory, type TimelineData, seriesKey } from "../model/timeline";
import { bandsFromPoints, holdOf, parseDuration, type Band } from "../model/timelineBands";
import { entityBands, type Incident } from "../model/timelineIncidents";
import { markersOf, tooltipLines, type Tip } from "../model/timelineHover";
import { incidentText } from "../model/timelineIncidents";
import { ROW_HEIGHT, visibleRows, type Row, type RowModel } from "../model/timelineRows";
import {
  brushView,
  clampView,
  cursorStep,
  makeScale,
  panBy,
  sameView,
  timeTicks,
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
  drawRowOutline,
  drawSignalRow,
  INCIDENT_BAND,
  type Frame,
} from "./draw";

export interface PlotModel {
  readonly data: TimelineData;
  readonly rows: RowModel;
  readonly colors: TimelineColors;
  /** The entity that is selected: its rows are outlined and its state changes are marked. */
  readonly selectedName: string | null;
  readonly pinned: number | null;
  readonly loading: ReadonlySet<string>;
  readonly incidents: readonly Incident[];
  readonly bounds: Bounds;
  /** Minutes behind UTC, as `Date.getTimezoneOffset` gives it. */
  readonly offsetMin: number;
  /** The window follows now: the server's clock is `skew` ms ahead of the browser's. Null when it stays where it is. */
  readonly follow: { readonly skew: number } | null;
}

export interface PlotHooks {
  /** The view a gesture settled on. */
  readonly view: (view: View) => void;
  readonly pin: (t: number | null) => void;
  /** A click on a row of the plot: the keyboard focus goes there. The entity opens from its name, not from the plot. */
  readonly focus: (row: Row) => void;
  readonly incident: (incident: Incident) => void;
  readonly reset: () => void;
  readonly tip: (tip: Tip | null, x: number, y: number, offsetMin: number) => void;
  readonly announce: (text: string) => void;
}

type Gesture =
  | { readonly kind: "pan"; lastX: number; moved: number; samples: { t: number; c: number }[] }
  | { readonly kind: "brush"; readonly x0: number; x1: number }
  | { readonly kind: "pinch"; readonly d0: number; readonly s0: number; readonly anchor: number };

const EASE_MS = 70;
const FRICTION_MS = 325;
const COMMIT_MS = 160;
const CLICK_PX = 4;

/**
 * The canvas of the timeline: it owns the view window, the gestures that move it and one draw per frame. React only
 * hands it a model when data or selection change; a drag, a wheel turn or a hover never touches React state.
 */
export class Plot {
  private readonly ctx: CanvasRenderingContext2D;
  private model: PlotModel = {
    data: EMPTY_TIMELINE,
    rows: { rows: [], height: 0, indexByKey: new Map() },
    colors: {} as TimelineColors,
    selectedName: null,
    pinned: null,
    loading: new Set(),
    incidents: [],
    bounds: { lo: 0, hi: 1 },
    offsetMin: 0,
    follow: null,
  };
  private followTimer = 0;
  /** A gesture has settled and its window is about to be committed: following must not move it meanwhile. */
  private pendingCommit = false;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private scrollTop = 0;
  private target: View = { t0: 0, t1: 1 };
  private shown: View = { t0: 0, t1: 1 };
  private velocity = 0;
  private frameId = 0;
  private lastTs = 0;
  private dirty = true;
  private commitTimer = 0;
  private pointerX: number | null = null;
  private pointerY = 0;
  private cursorT: number | null = null;
  private gesture: Gesture | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly entityCache = new WeakMap<StateHistory, { state: number; bands: readonly Band[] }>();
  private readonly seriesCache = new WeakMap<SeriesHistory, { bands: readonly Band[]; hold: number; end: number }>();
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
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDouble);
  }

  destroy(): void {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointercancel", this.onCancel);
    c.removeEventListener("pointerleave", this.onLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("dblclick", this.onDouble);
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.commitTimer);
    window.clearInterval(this.followTimer);
  }

  /* ---------- inputs from React ---------- */

  setModel(model: PlotModel): void {
    this.model = model;
    this.followNow(model.follow !== null);
    this.entities = new Map(model.data.entities.map((entity) => [entity.name, entity]));
    if (this.markerKey[0] !== model.data.annotations || this.markerKey[1] !== model.data.reports) this.indexMarkers();
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

  setScroll(top: number): void {
    this.scrollTop = top;
    this.invalidate();
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
    this.invalidate();
  }

  /** The instant a key press moves the cursor to, so a screen reader can be told. */
  getCursor(): number | null {
    return this.cursorT;
  }

  setCursor(t: number | null): void {
    this.cursorT = t;
    this.pointerX = t === null ? null : makeScale(this.shown, this.width).x(t);
    this.invalidate();
  }

  /** Handles the keys that move in time. Returns true when it used the key. */
  handleKey(event: KeyboardEvent): boolean {
    const span = this.target.t1 - this.target.t0;
    const middle = this.target.t0 + span / 2;
    const at = this.cursorT ?? middle;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const next = Math.min(this.bounds().hi, Math.max(this.bounds().lo, at + (event.key === "ArrowLeft" ? -1 : 1) * cursorStep(span, event.shiftKey)));
        this.moveCursor(next);
        return true;
      }
      case "Home":
        this.moveCursor(this.target.t0);
        return true;
      case "End":
        this.moveCursor(this.target.t1);
        return true;
      case "+":
      case "=":
        this.zoom(1 / 1.5, at);
        return true;
      case "-":
      case "_":
        this.zoom(1.5, at);
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
        this.hooks.pin(this.cursorT ?? middle);
        return true;
      case "Escape":
        this.hooks.pin(null);
        return true;
      default:
        return false;
    }
  }

  /* ---------- the view ---------- */

  private moveCursor(t: number): void {
    this.cursorT = t;
    if (t < this.target.t0 || t > this.target.t1) this.pan(t < this.target.t0 ? t - this.target.t0 - (this.target.t1 - this.target.t0) * 0.1 : t - this.target.t1 + (this.target.t1 - this.target.t0) * 0.1);
    this.pointerX = makeScale(this.target, this.width).x(t);
    this.hooks.announce(`${new Date(t).toLocaleString()}`);
    this.invalidate();
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

    if (moving || this.dirty) {
      this.dirty = false;
      this.render();
    }
    if (moving) this.frameId = requestAnimationFrame(this.frame);
    else this.lastTs = 0;
  };

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

  private bandsOf = (entity: EntityInfo): readonly Band[] => {
    const history = this.model.data.states[entity.name];
    if (!history) return [];
    const cached = this.entityCache.get(history);
    if (cached && cached.state === entity.state) return cached.bands;
    const bands = entityBands(this.model.data, entity);
    this.entityCache.set(history, { state: entity.state, bands });
    return bands;
  };

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

  private render(): void {
    const { ctx, width, height, dpr, model } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame: Frame = { ctx, width, height, view: this.shown, scale: makeScale(this.shown, width), colors: model.colors };
    clear(frame);
    const ticks = timeTicks(this.shown, width, 96, model.offsetMin);
    drawGrid(frame, ticks);
    const viewport = Math.max(0, height - AXIS_HEIGHT);
    this.visible = visibleRows(model.rows, this.scrollTop, viewport, 0);
    const [i0, i1] = visibleRows(model.rows, this.scrollTop, viewport, 1);
    for (let i = i0; i < i1; i += 1) {
      const row = model.rows.rows[i];
      if (!row) continue;
      const y = AXIS_HEIGHT + row.y - this.scrollTop;
      if (row.kind === "entity") {
        const entity = this.entities.get(row.entity);
        const changes = row.entity === model.selectedName ? (model.data.states[row.entity]?.transitions ?? []) : [];
        if (entity) drawEntityRow(frame, row, y, this.bandsOf(entity), this.markers.get(row.entity) ?? { annotations: [], reports: [] }, changes);
      } else {
        const info = this.entities.get(row.entity)?.signals.find((signal) => signal.name === row.signal);
        const held = this.seriesOf(row.entity, row.signal);
        drawSignalRow(frame, row, y, info, held?.history, held?.bands ?? [], held?.hold ?? 300_000, model.loading.has(row.entity));
      }
      if (row.kind === "entity" && row.entity === model.selectedName) drawRowOutline(frame, y, row.h);
    }
    ctx.fillStyle = model.colors.panel;
    ctx.fillRect(0, 0, width, AXIS_HEIGHT);
    drawAxis(frame, ticks, model.incidents, model.data.now);
    const scale = frame.scale;
    drawCursor(frame, this.cursorT === null ? null : scale.x(this.cursorT), model.pinned === null ? null : scale.x(model.pinned));
    if (this.gesture?.kind === "brush") drawBrush(frame, this.gesture.x0, this.gesture.x1);
    this.updateTip(scale.t(this.pointerX ?? 0));
  }

  private updateTip(t: number): void {
    if (this.pointerX === null || this.cursorT === null) {
      this.hooks.tip(null, 0, 0, this.model.offsetMin);
      return;
    }
    const model = this.model;
    if (this.pointerY >= INCIDENT_BAND[0] && this.pointerY < INCIDENT_BAND[1]) {
      const incident = model.incidents.find((item) => this.cursorT !== null && this.cursorT >= item.from && this.cursorT <= (item.to ?? model.data.now));
      const marker = incident ? [{ kind: "incident" as const, entity: "", t: incident.from, text: incidentText(incident, model.data.now) }] : [];
      this.hooks.tip(incident ? { t: this.cursorT, lines: [], hidden: 0, markers: marker } : null, this.pointerX, this.pointerY, model.offsetMin);
      return;
    }
    const [i0, i1] = this.visible;
    const rows = model.rows.rows.slice(i0, i1);
    const hovered = this.rowAt(this.pointerY);
    const inputBase = {
      t: this.cursorT,
      rows,
      entities: this.entities,
      bandsOf: this.bandsOf,
      seriesOf: (entity: string, signal: string) => model.data.series[seriesKey(entity, signal)],
      hoveredKey: hovered?.key ?? null,
      maxLines: 14,
      holdOf: (history: SeriesHistory) => this.holdFor(history),
    };
    const { lines, hidden } = tooltipLines(inputBase);
    const markers =
      hovered && hovered.kind === "entity"
        ? markersOf({
            annotations: model.data.annotations,
            reports: model.data.reports,
            changes: hovered.entity === model.selectedName ? (model.data.states[hovered.entity]?.transitions ?? []) : [],
            entity: hovered.entity,
            t0: t - 7 / makeScale(this.shown, this.width).pxPerMs,
            t1: t + 7 / makeScale(this.shown, this.width).pxPerMs,
          })
        : [];
    this.hooks.tip({ t: this.cursorT, lines, hidden, markers }, this.pointerX, this.pointerY, model.offsetMin);
  }

  private holdFor(history: SeriesHistory): number {
    return this.seriesCache.get(history)?.hold ?? holdOf(history.points);
  }

  private rowAt(y: number): Row | null {
    const content = y - AXIS_HEIGHT + this.scrollTop;
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
    } else if (event.shiftKey || (y < AXIS_HEIGHT && event.pointerType === "mouse")) this.gesture = { kind: "brush", x0: x, x1: x };
    else this.gesture = { kind: "pan", lastX: x, moved: 0, samples: [{ t: event.timeStamp, c: (this.target.t0 + this.target.t1) / 2 }] };
    this.pointerX = x;
    this.pointerY = y;
    this.cursorT = makeScale(this.shown, this.width).t(x);
    this.invalidate();
  };

  private readonly onMove = (event: PointerEvent): void => {
    const { x, y } = this.local(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x, y });
    const g = this.gesture;
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
    } else if (g?.kind === "brush") g.x1 = Math.max(0, Math.min(this.width, x));
    else if (g?.kind === "pinch" && this.pointers.size === 2) {
      const [p, q] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const span = Math.max(1, g.s0 * (g.d0 / Math.max(10, Math.hypot(p.x - q.x, p.y - q.y))));
      const fraction = (p.x + q.x) / 2 / this.width;
      const t0 = g.anchor - fraction * span;
      this.target = clampView({ t0, t1: t0 + span }, this.bounds());
      this.shown = this.target;
    }
    this.pointerX = Math.max(0, Math.min(this.width, x));
    this.pointerY = y;
    this.cursorT = makeScale(this.shown, this.width).t(this.pointerX);
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
    } else if (g.moved > CLICK_PX) {
      this.velocity = this.releaseVelocity(g.samples, event.timeStamp);
      if (this.velocity === 0) this.settle();
    } else this.click(x, y);
    this.invalidate();
  };

  private releaseVelocity(samples: { t: number; c: number }[], at: number): number {
    const last = samples[samples.length - 1];
    if (!last || samples.length < 2 || at - last.t > 60) return 0;
    let first = last;
    for (let i = samples.length - 2; i >= 0 && last.t - (samples[i]?.t ?? 0) <= 100; i -= 1) first = samples[i] as { t: number; c: number };
    return last.t > first.t ? (last.c - first.c) / (last.t - first.t) : 0;
  }

  private click(x: number, y: number): void {
    const scale = makeScale(this.shown, this.width);
    const t = scale.t(x);
    if (y < AXIS_HEIGHT) {
      const incident = this.model.incidents.find((item) => t >= item.from && t <= (item.to ?? this.model.data.now));
      if (incident) this.hooks.incident(incident);
      return;
    }
    const row = this.rowAt(y);
    this.hooks.pin(this.model.pinned !== null && Math.abs(scale.x(this.model.pinned) - x) < 4 ? null : t);
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
    this.cursorT = null;
    this.invalidate();
  };

  private readonly onDouble = (): void => this.hooks.reset();

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    this.velocity = 0;
    const { x } = this.local(event);
    const scale = makeScale(this.target, this.width);
    if (!event.ctrlKey && (event.shiftKey || Math.abs(dx) > Math.abs(dy))) {
      this.pan(((event.shiftKey && dx === 0 ? dy : dx) / this.width) * (this.target.t1 - this.target.t0));
    } else {
      this.zoom(Math.exp(dy * (event.ctrlKey ? 0.01 : 0.0018)), scale.t(x));
    }
    this.pointerX = x;
    this.pointerY = this.local(event).y;
    this.cursorT = scale.t(x);
  };
}

export { ROW_HEIGHT };
