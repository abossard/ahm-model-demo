import { DAY, MIN_SPAN, type View } from "./timelineScale";

export interface TimelineLocation {
  readonly open: boolean;
  /** The window a link names; null when it names none or a bad one. */
  readonly view: View | null;
  /** The link asks for the window that follows now (`live=1`, with its length as `span`, in milliseconds). */
  readonly follow: boolean;
  readonly span: number | null;
  /** The link asks for the timeline to fill the window (`fullscreen=1`). */
  readonly fullscreen: boolean;
  /** The past moment the link shows the page at (`at=`); null for now. */
  readonly at: number | null;
}

/** As far back as a link's moment may be: what the service keeps. */
const MOMENT_REACH = 30 * DAY;

/** The moment a link names, when it is a time the page can show: not after `now`, and no older than the service keeps. */
export function momentFromSearch(search: string, now: number): number | null {
  const at = parseTime(new URLSearchParams(search).get("at"));
  return at !== null && at <= now && at >= now - MOMENT_REACH ? at : null;
}

/**
 * What a link says about the timeline: `?timeline=1`, the window as `&from=` and `&to=` (ISO 8601 or epoch ms),
 * `&fullscreen=1`, and the selected moment as `&at=`. A moment is selected in the timeline, so a link that names one opens it.
 */
export function timelineFromSearch(search: string, now: number = Date.now()): TimelineLocation {
  const params = new URLSearchParams(search);
  const at = momentFromSearch(search, now);
  if (params.get("timeline") !== "1" && at === null) return { open: false, view: null, follow: false, span: null, fullscreen: false, at: null };
  const follow = params.get("live") === "1";
  const length = Number(params.get("span"));
  const span = follow && Number.isFinite(length) && length >= MIN_SPAN ? length : null;
  const from = parseTime(params.get("from"));
  const to = parseTime(params.get("to"));
  const view = from !== null && to !== null && to - from >= MIN_SPAN ? { t0: from, t1: to } : null;
  return { open: true, view, follow, span, fullscreen: params.get("fullscreen") === "1", at };
}

function parseTime(text: string | null): number | null {
  if (text === null || text === "") return null;
  const value = /^\d{10,14}$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * The query parameters that open the timeline on a window, and at a selected moment (`at`, null for now); nothing while
 * it is closed. `follow` is also true for a window that followed now until a moment was selected: it follows again
 * when the page returns to now.
 */
export function timelineParams(open: boolean, view: View | null, follow = false, fullscreen = false, at: number | null = null): Readonly<Record<string, string>> {
  if (!open) return {};
  const rest = { ...(fullscreen ? { fullscreen: "1" } : {}), ...(at === null ? {} : { at: new Date(Math.round(at)).toISOString() }) };
  if (follow && view !== null) return { timeline: "1", live: "1", span: String(Math.round(view.t1 - view.t0)), ...rest };
  return view === null
    ? { timeline: "1", ...rest }
    : { timeline: "1", from: new Date(Math.round(view.t0)).toISOString(), to: new Date(Math.round(view.t1)).toISOString(), ...rest };
}
