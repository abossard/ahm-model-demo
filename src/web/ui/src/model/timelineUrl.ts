import { MIN_SPAN, type View } from "./timelineScale";

export interface TimelineLocation {
  readonly open: boolean;
  /** The window a link names; null when it names none or a bad one. */
  readonly view: View | null;
  /** The link asks for the window that follows now (`live=1`, with its length as `span`, in milliseconds). */
  readonly follow: boolean;
  readonly span: number | null;
  /** The link asks for the timeline to fill the window (`fullscreen=1`). */
  readonly fullscreen: boolean;
}

/** What a link says about the timeline: `?timeline=1`, the window as `&from=` and `&to=` (ISO 8601 or epoch ms), and `&fullscreen=1`. */
export function timelineFromSearch(search: string): TimelineLocation {
  const params = new URLSearchParams(search);
  if (params.get("timeline") !== "1") return { open: false, view: null, follow: false, span: null, fullscreen: false };
  const follow = params.get("live") === "1";
  const length = Number(params.get("span"));
  const span = follow && Number.isFinite(length) && length >= MIN_SPAN ? length : null;
  const from = parseTime(params.get("from"));
  const to = parseTime(params.get("to"));
  const view = from !== null && to !== null && to - from >= MIN_SPAN ? { t0: from, t1: to } : null;
  return { open: true, view, follow, span, fullscreen: params.get("fullscreen") === "1" };
}

function parseTime(text: string | null): number | null {
  if (text === null || text === "") return null;
  const value = /^\d{10,14}$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(value) ? value : null;
}

/** The query parameters that open the timeline on a window; nothing while it is closed. */
export function timelineParams(open: boolean, view: View | null, follow = false, fullscreen = false): Readonly<Record<string, string>> {
  if (!open) return {};
  const screen = fullscreen ? { fullscreen: "1" } : {};
  if (follow && view !== null) return { timeline: "1", live: "1", span: String(Math.round(view.t1 - view.t0)), ...screen };
  return view === null
    ? { timeline: "1", ...screen }
    : { timeline: "1", from: new Date(Math.round(view.t0)).toISOString(), to: new Date(Math.round(view.t1)).toISOString(), ...screen };
}
