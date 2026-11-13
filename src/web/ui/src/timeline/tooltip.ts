import { stateName, type StateCode } from "../model/timeline";
import { formatInstant, type OffsetOf } from "../model/timelineScale";
import type { Tip } from "../model/timelineHover";

const GLYPH: Readonly<Record<string, string>> = { Healthy: "✓", Degraded: "▲", Unhealthy: "■", Unknown: "○", Deleted: "◆" };

/** The marks the legend names: an annotation, a health report, a state change and an incident. */
export const MARK: Readonly<Record<Tip["markers"][number]["kind"], string>> = { annotation: "◆", report: "▼", change: "┃", incident: "▬" };

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Fills the tooltip element with what a cursor reads. It builds plain DOM and sets no style attribute, so it is
 * as cheap as a frame and passes a strict style-src. The classes come from the panel, which owns the look.
 */
export function renderTip(host: HTMLElement, classes: Readonly<Record<string, string>>, tip: Tip, offsetOf: OffsetOf): void {
  const head = el("div", classes.tipHead ?? "", formatInstant(tip.t, offsetOf));
  const rows = tip.lines.map((line) => {
    const state = line.state === null ? "None" : stateName(line.state);
    const row = el("div", classes.tipLine ?? "");
    const glyph = el("span", `tl-state ${classes.tipGlyph ?? ""}`, line.state === null ? "–" : (GLYPH[state] ?? "○"));
    glyph.dataset.state = state;
    const name = el("span", classes.tipName ?? "", line.label);
    if (line.context) name.append(el("span", classes.tipContext ?? "", ` · ${line.context}`));
    const value = el("span", `tl-state ${classes.tipValue ?? ""}`, line.value ?? (line.state === null ? "no data" : state));
    value.dataset.state = state;
    row.append(glyph, name, value);
    return row;
  });
  const extra: HTMLElement[] = [];
  for (const marker of tip.markers) extra.push(el("div", classes.tipMarker ?? "", `${MARK[marker.kind]} ${marker.text}${marker.kind === "change" ? ` · ${formatInstant(marker.t, offsetOf)}` : ""}`));
  if (tip.hidden > 0) extra.push(el("div", classes.tipMore ?? "", `+${tip.hidden} more rows`));
  host.replaceChildren(head, ...extra, ...rows);
}

export function stateOf(code: StateCode | null): string {
  return code === null ? "no data" : stateName(code);
}
