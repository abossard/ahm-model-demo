// Calculations behind the wire drawer. No React, no clock, no console: a test can read all of it.
import type { DebugEvent, Hop, Party, WireKind } from "@playground/contracts";

export type Lane = 0 | 1 | 2;
export const LANES: readonly { party: Party; label: string }[] = [
  { party: "view", label: "View" },
  { party: "host", label: "Host" },
  { party: "server", label: "Server" },
];
const LANE_OF: Record<Party, Lane> = { view: 0, host: 1, server: 2 };

export function laneSpan(event: Pick<DebugEvent, "from" | "to">): { from: Lane; to: Lane } {
  return { from: LANE_OF[event.from], to: LANE_OF[event.to] };
}

// The colour of a row. Colours on the wire carry meaning and nothing else uses them.
export type Flow = "view-to-host" | "host-to-view" | "host-to-server" | "server-to-host" | "error";

export function isFailure(event: DebugEvent): boolean {
  return event.kind === "error" || (event.http !== null && event.http.status >= 400);
}

export function flowOf(event: DebugEvent): Flow {
  if (isFailure(event)) return "error";
  const key = `${event.from}>${event.to}`;
  switch (key) {
    case "view>host": return "view-to-host";
    case "host>view": return "host-to-view";
    case "server>host": return "server-to-host";
    default: return "host-to-server";
  }
}

export function hopLabel(hop: Hop): string {
  return hop === "view-host" ? "View ↔ Host (postMessage)" : "Host ↔ Server (HTTP/SSE)";
}

// ---- filters ----

export interface WireFilters {
  hop: Hop | "all";
  kind: WireKind | "all";
  text: string;
  trace: string | null;
  hideLongPolls: boolean;
}
export const NO_FILTERS: WireFilters = { hop: "all", kind: "all", text: "", trace: null, hideLongPolls: false };

export function isLongPoll(event: DebugEvent): boolean {
  return event.tool === "wait_for_change";
}

const haystacks = new WeakMap<DebugEvent, string>();

// What a text filter searches: every field a person would look for, and the payload.
export function searchText(event: DebugEvent): string {
  let text = haystacks.get(event);
  if (text === undefined) {
    const http = event.http ? `${event.http.method} ${event.http.path} ${event.http.status}` : "";
    const payload = event.payload === null || event.payload === undefined ? "" : JSON.stringify(event.payload);
    text = [
      event.kind, event.method, event.tool, event.view, event.trace, event.hop, event.from, event.to,
      event.rpcId === null ? "" : `#${event.rpcId}`, http, payload,
    ].filter(Boolean).join(" ").toLowerCase();
    haystacks.set(event, text);
  }
  return text;
}

export function matchesFilters(event: DebugEvent, filters: WireFilters): boolean {
  if (filters.hop !== "all" && event.hop !== filters.hop) return false;
  if (filters.kind !== "all" && event.kind !== filters.kind) return false;
  if (filters.trace !== null && event.trace !== filters.trace) return false;
  if (filters.hideLongPolls && isLongPoll(event)) return false;
  const terms = filters.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = searchText(event);
  return terms.every((term) => haystack.includes(term));
}

export function applyFilters(events: readonly DebugEvent[], filters: WireFilters): DebugEvent[] {
  return events.filter((event) => matchesFilters(event, filters));
}

export function filtersActive(filters: WireFilters): boolean {
  return filters.hop !== "all" || filters.kind !== "all" || filters.text.trim() !== "" || filters.trace !== null || filters.hideLongPolls;
}

// ---- correlation ----

export interface Pairing {
  // request id to the id of its reply, and back.
  replyOf: ReadonlyMap<string, string>;
  requestOf: ReadonlyMap<string, string>;
  // Requests that have no reply yet.
  pending: ReadonlySet<string>;
}

// The key `createPairing` in the contracts uses: each party numbers its own requests, so the asker is part of it.
function pairKey(event: DebugEvent): string | null {
  if (event.rpcId === null) return null;
  const asker = event.kind === "request" ? event.from : event.to;
  return `${event.hop}|${event.view ?? ""}|${asker}|${event.rpcId}`;
}

export function pairEvents(events: readonly DebugEvent[]): Pairing {
  const open = new Map<string, string>();
  const replyOf = new Map<string, string>();
  const requestOf = new Map<string, string>();
  for (const event of events) {
    const key = pairKey(event);
    if (key === null) continue;
    if (event.kind === "request") {
      open.set(key, event.id);
    } else if (event.kind === "response" || event.kind === "error") {
      const requestId = open.get(key);
      if (requestId === undefined) continue;
      open.delete(key);
      replyOf.set(requestId, event.id);
      requestOf.set(event.id, requestId);
    }
  }
  return { replyOf, requestOf, pending: new Set(open.values()) };
}

export interface Related {
  partner: string | null;
  sameTrace: ReadonlySet<string>;
}

export function relatedTo(selected: DebugEvent | null, events: readonly DebugEvent[], pairing: Pairing): Related {
  if (!selected) return { partner: null, sameTrace: new Set() };
  const partner = pairing.replyOf.get(selected.id) ?? pairing.requestOf.get(selected.id) ?? null;
  const sameTrace = new Set<string>();
  if (selected.trace) for (const event of events) if (event.trace === selected.trace && event.id !== selected.id) sameTrace.add(event.id);
  return { partner, sameTrace };
}

// ---- formatting ----

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatClock(at: number, timeZone?: string): string {
  const date = new Date(at);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}),
  }).format(date);
  return `${parts}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
}

export interface RowLabel {
  primary: string;
  secondary: string | null;
}

export function rowLabel(event: DebugEvent): RowLabel {
  if (event.kind === "http" && event.http) {
    return { primary: `${event.http.method} ${event.http.path}`, secondary: `${event.http.status}` };
  }
  if (event.kind === "error") return { primary: event.method ?? "error", secondary: errorMessage(event) ?? event.tool };
  return { primary: event.method ?? event.kind, secondary: event.tool };
}

function errorMessage(event: DebugEvent): string | null {
  const payload = event.payload;
  const error = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).error : null;
  const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>).message : null;
  return typeof message === "string" ? message : null;
}

export function arrowCaption(event: Pick<DebugEvent, "from" | "to">): string {
  return `${event.from} → ${event.to}`;
}

// The time a row shows: how long a reply took, how long a request has been waiting, or nothing.
export function rowTiming(event: DebugEvent, pending: boolean, waitedMs: number | null): string | null {
  if (pending) return waitedMs === null ? "waiting" : `waiting ${formatDuration(waitedMs)}`;
  return event.durationMs === null ? null : formatDuration(event.durationMs);
}

// ---- copy ----

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function exportEvents(events: readonly DebugEvent[]): string {
  return prettyJson(events);
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// A request that went to the server, as a curl command that sends it again. Null for any other message.
export function curlOf(event: DebugEvent, origin: string): { command: string; truncated: boolean } | null {
  if (event.hop !== "host-server" || event.kind !== "request" || event.payload === null || event.payload === undefined) return null;
  const headers = [
    "content-type: application/json",
    "accept: application/json, text/event-stream",
    `x-playground-sid: ${event.sid}`,
  ];
  const command = [
    "curl -sN -X POST", shellQuote(`${origin}/mcp`),
    ...headers.map((header) => `-H ${shellQuote(header)}`),
    `-d ${shellQuote(JSON.stringify(event.payload))}`,
  ].join(" ");
  return { command, truncated: event.truncated };
}

export const ROW_LIMIT = 500;

export function visibleRows<T>(rows: readonly T[], limit = ROW_LIMIT): { rows: readonly T[]; hidden: number } {
  return rows.length <= limit ? { rows, hidden: 0 } : { rows: rows.slice(rows.length - limit), hidden: rows.length - limit };
}
