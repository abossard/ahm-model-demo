import type { Annotation, Report, SignalInfo, SeriesHistory, StateCode, Transition } from "../model/timeline";
import { formatValue } from "../model/timelineHover";
import { thresholdLines, type ColourRun, type Lane, type Level, type ThresholdLine } from "../model/timelineLine";
import { emphasisOf, ruleZones, type Zone } from "../model/timelineTree";
import { bucketRange, clusterMarkers, firstAt, pixelBands, valueDomain, visibleRange, type Band, type MarkerAt, type PixelBand } from "../model/timelineBands";
import type { Incident } from "../model/timelineIncidents";
import type { EntityRow, SignalRow } from "../model/timelineRows";
import type { Scale, Tick, View } from "../model/timelineScale";
import type { TimelineColors } from "./colors";

export const AXIS_HEIGHT = 40;
const STRIP_Y = 28;
const STRIP_H = 6;
/** The rows of pixels the incident bars sit in, with a little room to point at them. */
export const INCIDENT_BAND: readonly [number, number] = [STRIP_Y - 4, STRIP_Y + STRIP_H + 4];
const FONT = "11px system-ui, -apple-system, Segoe UI, sans-serif";
const SMALL = "10px system-ui, -apple-system, Segoe UI, sans-serif";
const BOLD = "600 11px system-ui, -apple-system, Segoe UI, sans-serif";
const DASH: readonly number[] = [4, 3];
const DOTS: readonly number[] = [3, 3];
const SOLID: readonly number[] = [];
interface MarkerItem {
  readonly kind: "annotation" | "report";
  readonly state: StateCode;
}

export interface Frame {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly view: View;
  readonly scale: Scale;
  readonly colors: TimelineColors;
}

export function clear(frame: Frame): void {
  const { ctx, width, height, colors } = frame;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, width, height);
}

export function drawAxis(frame: Frame, ticks: readonly Tick[], incidents: readonly Incident[], now: number): void {
  const { ctx, width, scale, colors } = frame;
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.fillStyle = colors.lane;
  ctx.fillRect(0, 0, width, AXIS_HEIGHT);
  for (const tick of ticks) {
    const x = Math.round(scale.x(tick.t)) + 0.5;
    ctx.strokeStyle = tick.major ? colors.muted : colors.hair;
    ctx.beginPath();
    ctx.moveTo(x, tick.major ? 4 : 20);
    ctx.lineTo(x, STRIP_Y - 2);
    ctx.stroke();
    ctx.fillStyle = tick.major ? colors.ink : colors.muted;
    ctx.font = tick.major ? BOLD : FONT;
    ctx.textAlign = "left";
    ctx.fillText(tick.label, x + 4, 12);
  }
  for (const incident of incidents) {
    const x0 = Math.max(0, scale.x(incident.from));
    const x1 = Math.min(width, scale.x(incident.to ?? now));
    if (x1 <= 0 || x0 >= width) continue;
    ctx.fillStyle = colors.state[incident.peak];
    ctx.fillRect(x0, STRIP_Y, Math.max(2, x1 - x0), STRIP_H);
  }
  ctx.strokeStyle = colors.hair;
  ctx.beginPath();
  ctx.moveTo(0, AXIS_HEIGHT - 0.5);
  ctx.lineTo(width, AXIS_HEIGHT - 0.5);
  ctx.stroke();
}

export function drawGrid(frame: Frame, ticks: readonly Tick[]): void {
  const { ctx, scale, colors, height } = frame;
  ctx.strokeStyle = colors.hair;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (const tick of ticks) {
    const x = Math.round(scale.x(tick.t)) + 0.5;
    ctx.moveTo(x, AXIS_HEIGHT);
    ctx.lineTo(x, height);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** The bar of an entity fills its row; quiet states are faint so that Degraded and Unhealthy stand out. */
export const STRIP_ALPHA: Readonly<Record<StateCode, number>> = { 0: 0.16, 1: 0.2, 2: 0.6, 3: 0.75, 4: 0.2 };
const STRIP_INSET = 3;

function fillStrip(frame: Frame, bands: readonly PixelBand[], top: number, height: number): void {
  const { ctx, colors } = frame;
  for (const band of bands) {
    const x = Math.floor(band.x0);
    ctx.globalAlpha = STRIP_ALPHA[band.state];
    ctx.fillStyle = colors.state[band.state];
    ctx.fillRect(x, top, Math.max(1, Math.ceil(band.x1) - x), height);
  }
  ctx.globalAlpha = 1;
}

export function drawEntityRow(
  frame: Frame,
  row: EntityRow,
  y: number,
  bands: readonly Band[],
  markers: { readonly annotations: readonly Annotation[]; readonly reports: readonly Report[] },
  changes: readonly Transition[],
): void {
  const { ctx, width, view, scale, colors } = frame;
  ctx.fillStyle = colors.hair;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(0, y + row.h - 1, width, 1);
  ctx.globalAlpha = 1;
  const top = y + STRIP_INSET;
  const height = row.h - 2 * STRIP_INSET;
  fillStrip(frame, pixelBands(bands, view.t0, view.t1, width), top, height);
  if (markers.annotations.length + markers.reports.length > 0) {
    const items: MarkerAt<MarkerItem>[] = [
      ...markers.annotations.map((item): MarkerAt<MarkerItem> => ({ x: scale.x(item.t), item: { kind: "annotation", state: 1 } })),
      ...markers.reports.map((item): MarkerAt<MarkerItem> => ({ x: scale.x(item.t), item: { kind: "report", state: item.state } })),
    ]
      .filter((marker) => marker.x >= -6 && marker.x <= width + 6)
      .sort((a, b) => a.x - b.x);
    for (const cluster of clusterMarkers(items, 12)) {
      drawMarker(frame, cluster.x, y + 2, cluster.items[0]?.kind ?? "annotation", cluster.items[0]?.state ?? 1);
    }
  }
  if (changes.length === 0) return;
  // Each state change of the selected entity: a tick through its bar.
  ctx.fillStyle = colors.ink;
  ctx.strokeStyle = colors.panel;
  ctx.lineWidth = 1;
  for (const change of changes) {
    const x = Math.round(scale.x(change.t));
    if (x < -2 || x > width + 2) continue;
    ctx.strokeRect(x - 1.5, top - 0.5, 3, height + 1);
    ctx.fillRect(x - 1, top, 2, height);
  }
}

/** A diamond for an annotation, a flag pointing down for a health report: the legend names both. */
function drawMarker(frame: Frame, x: number, y: number, kind: "annotation" | "report", state: StateCode): void {
  const { ctx, colors } = frame;
  ctx.fillStyle = kind === "annotation" ? colors.accent : colors.state[state === 1 ? 2 : state];
  ctx.strokeStyle = colors.panel;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (kind === "annotation") {
    ctx.moveTo(x, y - 1);
    ctx.lineTo(x + 5, y + 4);
    ctx.lineTo(x, y + 9);
    ctx.lineTo(x - 5, y + 4);
    ctx.closePath();
  } else {
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 9);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.fill();
  ctx.lineWidth = 1;
}

/** How wide a text of the lanes is: measured once, since the same words are drawn in every frame. */
const widths = new Map<string, number>();

function widthOf(ctx: CanvasRenderingContext2D, text: string): number {
  const held = widths.get(text);
  if (held !== undefined) return held;
  if (widths.size > 4000) widths.clear();
  const width = ctx.measureText(text).width;
  widths.set(text, width);
  return width;
}

function axisText(frame: Frame, text: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline, color = frame.colors.muted): void {
  const { ctx, colors } = frame;
  ctx.font = SMALL;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  const w = widthOf(ctx, text);
  const left = align === "right" ? x - w : x;
  ctx.fillStyle = colors.panel;
  ctx.globalAlpha = 0.78;
  ctx.fillRect(left - 2, baseline === "top" ? y - 1 : y - 11, w + 4, 12);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
}

const LEVELS: readonly Level[] = [0, 1, 2, 3];
const NO_RULES: SignalInfo["rules"] = { degraded: null, unhealthy: null, dynamic: false };

/** The threshold lines of a signal with their words: the same for every frame it is drawn in. */
const linesBySignal = new WeakMap<SignalInfo, readonly ThresholdLine[]>();
const NO_LINES: readonly ThresholdLine[] = [];

function linesOf(info: SignalInfo | undefined): readonly ThresholdLine[] {
  if (!info) return NO_LINES;
  let lines = linesBySignal.get(info);
  if (!lines) {
    lines = thresholdLines(info.rules, info.unit);
    linesBySignal.set(info, lines);
  }
  return lines;
}

/**
 * Strokes the part of a lane's line that shows, one colour at a time, and marks a run of one point as a dot. The runs
 * are in time: each vertex is placed, none is computed.
 */
function strokeRuns(frame: Frame, lane: Lane, yOf: (value: number) => number): void {
  const { ctx, colors, view, scale } = frame;
  const k = scale.pxPerMs;
  for (const level of LEVELS) {
    const runs = lane.runs[level] as readonly ColourRun[];
    if (runs.length === 0) continue;
    ctx.strokeStyle = colors.state[level];
    ctx.fillStyle = colors.state[level];
    ctx.beginPath();
    let dots = false;
    for (const run of runs) {
      const n = run.xs.length;
      if ((run.xs[n - 1] as number) < view.t0) continue;
      if ((run.xs[0] as number) > view.t1) break;
      if (n === 1) {
        dots = true;
        continue;
      }
      let i = Math.max(0, firstAt(run.xs, view.t0) - 1);
      ctx.moveTo(((run.xs[i] as number) - view.t0) * k, yOf(run.vs[i] as number));
      for (i += 1; i < n; i += 1) {
        const t = run.xs[i] as number;
        ctx.lineTo((t - view.t0) * k, yOf(run.vs[i] as number));
        if (t > view.t1) break;
      }
    }
    ctx.stroke();
    if (!dots) continue;
    for (const run of runs) {
      const t = run.xs[0] as number;
      if (run.xs.length !== 1 || t < view.t0) continue;
      if (t > view.t1) break;
      ctx.beginPath();
      ctx.arc((t - view.t0) * k, yOf(run.vs[0] as number), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** The range of the values folded into each pixel column, as a faint bar in the level of its worst end. */
function fillRanges(frame: Frame, lane: Lane, i0: number, i1: number, yOf: (value: number) => number): void {
  const { ctx, colors, view, scale } = frame;
  const { buckets } = lane;
  ctx.globalAlpha = 0.3;
  for (const level of LEVELS) {
    let column = Number.NaN;
    let top = 0;
    let bottom = 0;
    ctx.fillStyle = colors.state[level];
    for (let i = i0; i < i1; i += 1) {
      if (lane.level[i] !== level || (buckets.values[i] as number) < 3) continue;
      const x = Math.floor(((buckets.from[i] as number) - view.t0) * scale.pxPerMs);
      const hi = yOf(buckets.hi[i] as number);
      const lo = yOf(buckets.lo[i] as number);
      if (x === column) {
        top = Math.min(top, hi);
        bottom = Math.max(bottom, lo);
        continue;
      }
      if (!Number.isNaN(column)) ctx.fillRect(column, top, 1, Math.max(1, bottom - top));
      column = x;
      top = hi;
      bottom = lo;
    }
    if (!Number.isNaN(column)) ctx.fillRect(column, top, 1, Math.max(1, bottom - top));
  }
  ctx.globalAlpha = 1;
}

/**
 * The background of a lane says what state the signal exposed, in two layers. Each range of values the rule cuts (the
 * healthy one green, the degraded one amber, the unhealthy one red) is a faint band as tall as its values are on the
 * lane. Where the signal had a state, the band of that state is stronger in that stretch of time: green where it was
 * healthy, red only where it was unhealthy. Unknown, and a signal without a rule, are washed over the whole lane height.
 * Both layers stay fainter than the line and its dots.
 */
const ZONE_ALPHA = 0.06;
const WASH_ALPHA: Readonly<Record<StateCode, number>> = { 0: 0.14, 1: 0.14, 2: 0.2, 3: 0.22, 4: 0 };
const NO_ZONES: readonly Zone[] = [];

function fillZones(frame: Frame, zones: readonly Zone[], yOf: (value: number) => number): void {
  const { ctx, colors, width } = frame;
  ctx.globalAlpha = ZONE_ALPHA;
  for (const zone of zones) {
    ctx.fillStyle = colors.state[zone.state];
    ctx.fillRect(0, yOf(zone.to), width, yOf(zone.from) - yOf(zone.to));
  }
  ctx.globalAlpha = 1;
}

function washSpans(frame: Frame, spans: readonly PixelBand[], zones: readonly Zone[], top: number, height: number, yOf: (value: number) => number): void {
  const { ctx, colors } = frame;
  for (const wash of emphasisOf(spans, zones)) {
    const x = Math.floor(wash.x0);
    const y0 = wash.to === null ? top : yOf(wash.to);
    const y1 = wash.from === null ? top + height : yOf(wash.from);
    ctx.globalAlpha = WASH_ALPHA[wash.state];
    ctx.fillStyle = colors.state[wash.state];
    ctx.fillRect(x, y0, Math.max(1, Math.ceil(wash.x1) - x), y1 - y0);
  }
  ctx.globalAlpha = 1;
}

/**
 * A lane of one signal: the measured value is the line, green while it is healthy, orange past the degraded threshold,
 * red past the unhealthy one and grey where the state is Unknown. The thresholds are drawn and named. A signal without
 * numbers shows its states as marks. `lane` is the series folded for this zoom level, null while there is none.
 */
export function drawSignalRow(
  frame: Frame,
  row: SignalRow,
  y: number,
  info: SignalInfo | undefined,
  history: SeriesHistory | undefined,
  bands: readonly Band[],
  lane: Lane | null,
  hold: number,
  loading: boolean,
): void {
  const { ctx, width, view, scale, colors } = frame;
  const chartTop = y + 4;
  const chartH = row.h - 8;
  ctx.fillStyle = colors.lane;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(0, chartTop, width, chartH);
  ctx.globalAlpha = 1;

  if (!history || history.points.length === 0 || lane === null) {
    ctx.fillStyle = colors.muted;
    ctx.font = SMALL;
    ctx.textBaseline = "middle";
    ctx.fillText(history?.error ? `Could not load: ${history.error.message}` : loading ? "Loading…" : history ? "No data in this range" : "Scroll here to load", 8, chartTop + chartH / 2);
    return;
  }

  const spans = pixelBands(bands, view.t0, view.t1, width);

  const rules = info?.rules ?? NO_RULES;
  const unit = info?.unit ?? null;
  const { buckets } = lane;
  const [i0, i1] = bucketRange(buckets, view.t0, view.t1);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = i0; i < i1; i += 1) {
    if ((buckets.lo[i] as number) < lo) lo = buckets.lo[i] as number;
    if ((buckets.hi[i] as number) > hi) hi = buckets.hi[i] as number;
  }

  if (!Number.isFinite(lo)) {
    const [p0, p1] = visibleRange(history.points, view.t0, view.t1);
    washSpans(frame, spans, NO_ZONES, chartTop, chartH, () => chartTop);
    drawStateMarks(frame, history, p0, p1, chartTop, chartH);
    axisText(frame, "reported states, no measured value", 6, chartTop + 2, "left", "top");
    return;
  }

  const domain = valueDomain(lo, hi, rules);
  const perUnit = chartH / (domain.hi - domain.lo);
  const base = chartTop + chartH;
  const yOf = (value: number): number => base - (value - domain.lo) * perUnit;
  const lines = linesOf(info);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, chartTop, width, chartH);
  ctx.clip();
  const zones = ruleZones(rules, domain);
  fillZones(frame, zones, yOf);
  washSpans(frame, spans, zones, chartTop, chartH, yOf);
  ctx.setLineDash(DASH as number[]);
  ctx.lineWidth = 1;
  for (const line of lines) {
    if (line.value < domain.lo || line.value > domain.hi) continue;
    ctx.strokeStyle = colors.state[line.state];
    ctx.beginPath();
    ctx.moveTo(0, Math.round(yOf(line.value)) + 0.5);
    ctx.lineTo(width, Math.round(yOf(line.value)) + 0.5);
    ctx.stroke();
  }
  ctx.setLineDash(SOLID as number[]);

  ctx.lineWidth = 1.7;
  ctx.lineJoin = "round";
  if (lane.ranges) fillRanges(frame, lane, i0, i1, yOf);
  strokeRuns(frame, lane, yOf);
  // Each evaluation is a dot once they stand apart.
  if (lane.exact && (scale.pxPerMs * (hold / 3) > 5 || i1 - i0 < 40)) {
    let level = -1;
    for (let i = i0; i < i1; i += 1) {
      if (lane.level[i] !== level) {
        level = lane.level[i] as number;
        ctx.fillStyle = colors.state[level as Level];
      }
      ctx.beginPath();
      ctx.arc(((buckets.from[i] as number) - view.t0) * scale.pxPerMs, yOf(buckets.first[i] as number), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  for (const line of lines) {
    if (line.value < domain.lo || line.value > domain.hi) continue;
    const at = yOf(line.value);
    const label = Math.min(chartTop + chartH - 1, Math.max(chartTop + 12, line.side === "above" ? at - 2 : at + 13));
    axisText(frame, line.text, width - 20, label, "right", "bottom", colors.label[line.state]);
  }
  axisText(frame, formatValue(domain.hi, unit), 4, chartTop + 1, "left", "top");
  axisText(frame, formatValue(domain.lo, unit), 4, chartTop + chartH - 1, "left", "bottom");
}

/** A signal that reports states and no numbers: one mark per evaluation, in the colour and shape of its state. */
function drawStateMarks(frame: Frame, history: SeriesHistory, i0: number, i1: number, top: number, h: number): void {
  const { ctx, colors, scale } = frame;
  const cy = top + h / 2 + 3;
  let last = -100;
  for (let i = i0; i < i1; i += 1) {
    const point = history.points[i];
    if (!point) continue;
    const x = scale.x(point[0]);
    if (x - last < 5) continue;
    last = x;
    ctx.fillStyle = colors.state[point[2]];
    ctx.strokeStyle = colors.panel;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (point[2] === 3) ctx.rect(x - 4, cy - 4, 8, 8);
    else if (point[2] === 2) {
      ctx.moveTo(x, cy - 5);
      ctx.lineTo(x + 5, cy + 4);
      ctx.lineTo(x - 5, cy + 4);
      ctx.closePath();
    } else ctx.arc(x, cy, point[2] === 1 ? 2.5 : 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
  }
  ctx.lineWidth = 1;
}

/** The dashed line under the pointer. */
export function drawCursor(frame: Frame, x: number): void {
  const { ctx, height, colors } = frame;
  ctx.strokeStyle = colors.cursor;
  ctx.setLineDash(DOTS as number[]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, height);
  ctx.stroke();
  ctx.setLineDash(SOLID as number[]);
}

/** Where the label of the selected moment was drawn: the handle to drag it by. */
export interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

const MOMENT_H = 17;

/**
 * The selected moment: a line through every row with a rim in the panel's colour, so it reads on any bar or line, and a
 * label at its top that says the time in full. A moment outside the window keeps its label, at the edge it left by.
 */
export function drawMoment(frame: Frame, x: number, text: string): Box {
  const { ctx, width, height, colors } = frame;
  const inside = x >= 0 && x <= width;
  const label = inside ? text : x < 0 ? `◀ ${text}` : `${text} ▶`;
  ctx.font = BOLD;
  // Not through the kept widths: a moment that is dragged has a new text in every frame.
  const w = ctx.measureText(label).width + 12;
  const at = Math.round(Math.max(0, Math.min(width, x)));
  const left = Math.max(0, at + w > width ? at - w : at);
  if (inside) {
    ctx.strokeStyle = colors.panel;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(at, MOMENT_H);
    ctx.lineTo(at, height);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at, height);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  ctx.fillStyle = colors.accent;
  ctx.fillRect(left, 0, w, MOMENT_H);
  ctx.fillStyle = colors.panel;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + 6, MOMENT_H / 2 + 0.5);
  return { x0: left, x1: left + w, y0: 0, y1: MOMENT_H };
}

export function drawBrush(frame: Frame, x0: number, x1: number): void {
  const { ctx, height, colors } = frame;
  const a = Math.min(x0, x1);
  ctx.fillStyle = colors.accent;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(a, 0, Math.abs(x1 - x0), height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.accent;
  ctx.strokeRect(a + 0.5, 0.5, Math.abs(x1 - x0), height - 1);
}

export function drawRowOutline(frame: Frame, y: number, h: number): void {
  const { ctx, width, colors } = frame;
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0.75, y + 0.75, width - 1.5, h - 1.5);
  ctx.lineWidth = 1;
}
