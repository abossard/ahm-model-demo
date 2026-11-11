import type { Annotation, Report, SignalInfo, SeriesHistory, StateCode, Transition } from "../model/timeline";
import { formatValue } from "../model/timelineHover";
import { colourRuns, levelOf, thresholdLines, type ColourRun, type Level } from "../model/timelineLine";
import { ruleZones } from "../model/timelineTree";
import { clusterMarkers, decimateColumns, pixelBands, valueDomain, visibleRange, type Band, type MarkerAt, type PixelBand } from "../model/timelineBands";
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
const BOLD = "600 10px system-ui, -apple-system, Segoe UI, sans-serif";
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
    ctx.font = tick.major ? BOLD.replace("10px", "11px") : FONT;
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

/** The bar of an entity: it gets taller as the state gets worse, and Unknown is the thinnest. */
const STRIP_HEIGHT: Readonly<Record<StateCode, number>> = { 0: 4, 1: 6, 2: 12, 3: 18, 4: 6 };

function fillStrip(frame: Frame, bands: readonly PixelBand[], centre: number): void {
  const { ctx, colors } = frame;
  for (const band of bands) {
    const h = STRIP_HEIGHT[band.state];
    const x = Math.floor(band.x0);
    ctx.fillStyle = colors.state[band.state];
    ctx.fillRect(x, centre - h / 2, Math.max(1, Math.ceil(band.x1) - x), h);
  }
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
  fillStrip(frame, pixelBands(bands, view.t0, view.t1, width), y + row.h - 12);
  const items: MarkerAt<MarkerItem>[] = [
    ...markers.annotations.map((item): MarkerAt<MarkerItem> => ({ x: scale.x(item.t), item: { kind: "annotation", state: 1 } })),
    ...markers.reports.map((item): MarkerAt<MarkerItem> => ({ x: scale.x(item.t), item: { kind: "report", state: item.state } })),
  ]
    .filter((marker) => marker.x >= -6 && marker.x <= width + 6)
    .sort((a, b) => a.x - b.x);
  for (const cluster of clusterMarkers(items, 12)) {
    drawMarker(frame, cluster.x, y + 2, cluster.items[0]?.kind ?? "annotation", cluster.items[0]?.state ?? 1);
  }
  // Each state change of the selected entity: a tick through its bar.
  ctx.fillStyle = colors.ink;
  ctx.strokeStyle = colors.panel;
  ctx.lineWidth = 1;
  for (const change of changes) {
    const x = Math.round(scale.x(change.t));
    if (x < -2 || x > width + 2) continue;
    ctx.strokeRect(x - 1.5, y + row.h - 12 - 11, 3, 22);
    ctx.fillRect(x - 1, y + row.h - 12 - 10, 2, 20);
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

function axisText(frame: Frame, text: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline, color = frame.colors.muted): void {
  const { ctx, colors } = frame;
  ctx.font = SMALL;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  const w = ctx.measureText(text).width;
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

/** Strokes the runs of a line, one colour at a time, and marks a run of one point as a dot. */
function strokeRuns(frame: Frame, runs: readonly ColourRun[], xOf: (x: number) => number, yOf: (value: number) => number): void {
  const { ctx, colors } = frame;
  for (const level of LEVELS) {
    ctx.strokeStyle = colors.state[level];
    ctx.fillStyle = colors.state[level];
    ctx.beginPath();
    for (const run of runs) {
      if (run.level !== level || run.xs.length < 2) continue;
      ctx.moveTo(xOf(run.xs[0] as number), yOf(run.vs[0] as number));
      for (let i = 1; i < run.xs.length; i += 1) ctx.lineTo(xOf(run.xs[i] as number), yOf(run.vs[i] as number));
    }
    ctx.stroke();
    for (const run of runs) {
      if (run.level !== level || run.xs.length !== 1) continue;
      ctx.beginPath();
      ctx.arc(xOf(run.xs[0] as number), yOf(run.vs[0] as number), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * A lane of one signal: the measured value is the line, green while it is healthy, orange past the degraded threshold,
 * red past the unhealthy one and grey where the state is Unknown. The thresholds are drawn and named. A signal without
 * numbers shows its states as marks.
 */
export function drawSignalRow(
  frame: Frame,
  row: SignalRow,
  y: number,
  info: SignalInfo | undefined,
  history: SeriesHistory | undefined,
  bands: readonly Band[],
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

  if (!history || history.points.length === 0) {
    ctx.fillStyle = colors.muted;
    ctx.font = SMALL;
    ctx.textBaseline = "middle";
    ctx.fillText(history?.error ? `Could not load: ${history.error.message}` : loading ? "Loading…" : history ? "No data in this range" : "Scroll here to load", 8, chartTop + chartH / 2);
    return;
  }

  ctx.fillStyle = colors.state[0];
  ctx.globalAlpha = 0.22;
  for (const band of pixelBands(bands, view.t0, view.t1, width)) {
    if (band.state === 0) ctx.fillRect(Math.floor(band.x0), chartTop, Math.max(1, Math.ceil(band.x1) - Math.floor(band.x0)), chartH);
  }
  ctx.globalAlpha = 1;

  const rules = info?.rules ?? { degraded: null, unhealthy: null, dynamic: false };
  const unit = info?.unit ?? null;
  const [i0, i1] = visibleRange(history.points, view.t0, view.t1);
  const sparse = i1 - i0 < width / 3;
  const columns = sparse ? null : decimateColumns(history.points, view.t0, view.t1, width);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  if (columns) {
    for (let i = 0; i < columns.x.length; i += 1) {
      lo = Math.min(lo, columns.lo[i] as number);
      hi = Math.max(hi, columns.hi[i] as number);
    }
  } else {
    for (let i = i0; i < i1; i += 1) {
      const value = history.points[i]?.[1];
      if (value === null || value === undefined) continue;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
  }

  if (!Number.isFinite(lo)) {
    drawStateMarks(frame, history, i0, i1, chartTop, chartH);
    axisText(frame, "reported states, no measured value", 6, chartTop + 2, "left", "top");
    return;
  }

  const domain = valueDomain(lo, hi, rules);
  const yOf = (value: number): number => chartTop + chartH - ((value - domain.lo) / (domain.hi - domain.lo)) * chartH;
  const lines = thresholdLines(rules, unit).filter((line) => line.value >= domain.lo && line.value <= domain.hi);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, chartTop, width, chartH);
  ctx.clip();
  for (const zone of ruleZones(rules, domain)) {
    ctx.globalAlpha = zone.state === 3 ? 0.16 : 0.12;
    ctx.fillStyle = colors.state[zone.state];
    ctx.fillRect(0, yOf(zone.to), width, yOf(zone.from) - yOf(zone.to));
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  for (const line of lines) {
    ctx.strokeStyle = colors.state[line.state];
    ctx.beginPath();
    ctx.moveTo(0, Math.round(yOf(line.value)) + 0.5);
    ctx.lineTo(width, Math.round(yOf(line.value)) + 0.5);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.lineWidth = 1.7;
  ctx.lineJoin = "round";
  const gapPx = Math.max(6, hold * scale.pxPerMs);
  if (columns) {
    // The range inside a pixel column is a bar in the level of its worst end; the line runs through the first and last values.
    const level = columns.x.map((_, i) => Math.max(levelOf(columns.lo[i] as number, columns.state[i] as StateCode, rules), levelOf(columns.hi[i] as number, columns.state[i] as StateCode, rules)));
    ctx.globalAlpha = 0.3;
    for (const l of LEVELS) {
      ctx.fillStyle = colors.state[l];
      for (let i = 0; i < columns.x.length; i += 1) {
        if (level[i] !== l) continue;
        const top = yOf(columns.hi[i] as number);
        ctx.fillRect(columns.x[i] as number, top, 1, Math.max(1, yOf(columns.lo[i] as number) - top));
      }
    }
    ctx.globalAlpha = 1;
    const x: number[] = [];
    const v: number[] = [];
    const s: StateCode[] = [];
    for (let i = 0; i < columns.x.length; i += 1) {
      x.push(columns.x[i] as number, columns.x[i] as number);
      v.push(columns.first[i] as number, columns.last[i] as number);
      s.push(columns.state[i] as StateCode, columns.state[i] as StateCode);
    }
    strokeRuns(frame, colourRuns({ x, v, s }, rules, gapPx), (column) => column + 0.5, yOf);
  } else {
    const x: number[] = [];
    const v: (number | null)[] = [];
    const s: StateCode[] = [];
    for (let i = i0; i < i1; i += 1) {
      const point = history.points[i];
      if (!point) continue;
      x.push(point[0]);
      v.push(point[1]);
      s.push(point[2]);
    }
    strokeRuns(frame, colourRuns({ x, v, s }, rules, hold), scale.x, yOf);
    if (scale.pxPerMs * (hold / 3) > 5 || i1 - i0 < 40) {
      for (let i = 0; i < x.length; i += 1) {
        const value = v[i];
        if (value === null || value === undefined) continue;
        ctx.fillStyle = colors.state[levelOf(value, s[i] as StateCode, rules)];
        ctx.beginPath();
        ctx.arc(scale.x(x[i] as number), yOf(value), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  for (const line of lines) {
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

export function drawCursor(frame: Frame, x: number | null, pinnedX: number | null): void {
  const { ctx, height, colors } = frame;
  if (pinnedX !== null && pinnedX >= 0 && pinnedX <= frame.width) {
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.round(pinnedX), 0);
    ctx.lineTo(Math.round(pinnedX), height);
    ctx.stroke();
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(pinnedX - 5, 0);
    ctx.lineTo(pinnedX + 5, 0);
    ctx.lineTo(pinnedX, 7);
    ctx.fill();
    ctx.lineWidth = 1;
  }
  if (x === null) return;
  ctx.strokeStyle = colors.cursor;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, height);
  ctx.stroke();
  ctx.setLineDash([]);
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
