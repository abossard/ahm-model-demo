import { z } from "zod";

// Correlation. `sid` names one browser tab, `trace` one chain of cause (a click and all it sets off),
// `rpcId` one JSON-RPC exchange on one hop.
export const SID_HEADER = "x-playground-sid";
export const TRACE_META_KEY = "playground/trace";
// A tool result carries the player's career here when the call changed it.
export const CAREER_META_KEY = "playground/career";

export const Hop = z.enum(["view-host", "host-server"]);
export type Hop = z.infer<typeof Hop>;
export const Party = z.enum(["view", "host", "server"]);
export type Party = z.infer<typeof Party>;
export const WireKind = z.enum(["request", "response", "error", "notification", "http"]);
export type WireKind = z.infer<typeof WireKind>;

export const HttpExchange = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().int(),
  contentType: z.string().nullable(),
  // True when the message arrived as an event of a text/event-stream response.
  streamed: z.boolean(),
});
export type HttpExchange = z.infer<typeof HttpExchange>;

// One message on one hop. The browser records hop view-host, the host server records hop host-server.
export const DebugEvent = z.object({
  id: z.string(),
  seq: z.number().int(),
  at: z.number(),
  sid: z.string(),
  hop: Hop,
  from: Party,
  to: Party,
  kind: WireKind,
  // For a response or an error: the method of the request it answers.
  method: z.string().nullable(),
  rpcId: z.union([z.string(), z.number()]).nullable(),
  tool: z.string().nullable(),
  view: z.string().nullable(),
  trace: z.string().nullable(),
  bytes: z.number().int().min(0),
  // For a response or an error: milliseconds since its request on the same hop.
  durationMs: z.number().nullable(),
  http: HttpExchange.nullable(),
  truncated: z.boolean(),
  payload: z.unknown(),
});
export type DebugEvent = z.infer<typeof DebugEvent>;

export interface Classified {
  kind: Exclude<WireKind, "http">;
  method: string | null;
  rpcId: string | number | null;
  tool: string | null;
  trace: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// A calculation: what a JSON-RPC message is, read from its shape alone.
export function classify(message: unknown): Classified {
  const body = record(message) ?? {};
  const params = record(body.params);
  const meta = record(params?._meta) ?? record(record(body.result)?._meta);
  const rpcId = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  const method = typeof body.method === "string" ? body.method : null;
  const traceValue = meta?.[TRACE_META_KEY];
  return {
    kind: method ? (rpcId === null ? "notification" : "request") : "error" in body ? "error" : "response",
    method,
    rpcId,
    tool: method === "tools/call" && typeof params?.name === "string" ? params.name : null,
    trace: typeof traceValue === "string" ? traceValue : null,
  };
}

export const CLIP_STRING_CHARS = 2000;

// A calculation: a copy of the payload with long strings shortened, so a View document does not flood the feed.
export function clip(payload: unknown, maxChars = CLIP_STRING_CHARS): { payload: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string" && value.length > maxChars) {
      truncated = true;
      return `${value.slice(0, 200)}… (${value.length} chars)`;
    }
    if (Array.isArray(value)) return value.map(walk);
    const object = record(value);
    return object ? Object.fromEntries(Object.entries(object).map(([key, item]) => [key, walk(item)])) : value;
  };
  return { payload: walk(payload), truncated };
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface EventBase {
  seq: number;
  at: number;
  sid: string;
  hop: Hop;
  from: Party;
  to: Party;
  view?: string | null;
  trace?: string | null;
  http?: HttpExchange | null;
}

// A calculation: the DebugEvent of one JSON-RPC message. `raw` is its text on the wire, when the recorder has it.
export function toDebugEvent(base: EventBase, message: unknown, raw?: string): DebugEvent {
  const seen = classify(message);
  const clipped = clip(message);
  return {
    id: `${base.hop === "view-host" ? "v" : "s"}-${base.seq}`,
    seq: base.seq,
    at: base.at,
    sid: base.sid,
    hop: base.hop,
    from: base.from,
    to: base.to,
    kind: seen.kind,
    method: seen.method,
    rpcId: seen.rpcId,
    tool: seen.tool,
    view: base.view ?? null,
    trace: base.trace ?? seen.trace,
    bytes: byteLength(raw ?? JSON.stringify(message)),
    durationMs: null,
    http: base.http ?? null,
    truncated: clipped.truncated,
    payload: clipped.payload,
  };
}

// The DebugEvent of an HTTP exchange that carried no JSON-RPC message, such as GET /mcp answered with 405.
export function toHttpEvent(base: EventBase & { http: HttpExchange }, bytes = 0): DebugEvent {
  return {
    id: `s-${base.seq}`, seq: base.seq, at: base.at, sid: base.sid, hop: base.hop, from: base.from, to: base.to,
    kind: "http", method: null, rpcId: null, tool: null, view: base.view ?? null, trace: base.trace ?? null,
    bytes, durationMs: null, http: base.http, truncated: false, payload: null,
  };
}

// Joins each response to its request on the same hop: fills method, tool, trace and durationMs.
// Holds the open requests of one recorder, so each recorder makes one.
export function createPairing(limit = 500): (event: DebugEvent) => DebugEvent {
  const open = new Map<string, { at: number; method: string | null; tool: string | null; trace: string | null }>();
  return (event) => {
    if (event.rpcId === null) return event;
    // Each party numbers its own requests, so the asker is part of the key.
    const asker = event.kind === "request" ? event.from : event.to;
    const key = `${event.hop}|${event.view ?? ""}|${asker}|${event.rpcId}`;
    if (event.kind === "request") {
      if (open.size >= limit) open.delete(open.keys().next().value!);
      open.set(key, { at: event.at, method: event.method, tool: event.tool, trace: event.trace });
      return event;
    }
    const request = open.get(key);
    if (!request) return event;
    open.delete(key);
    return {
      ...event,
      method: request.method,
      tool: request.tool,
      trace: event.trace ?? request.trace,
      durationMs: Math.max(0, event.at - request.at),
    };
  };
}

const ARROW: Record<Party, Record<Party, string>> = {
  view: { view: "", host: "view → host", server: "" },
  host: { view: "view ← host", host: "", server: "host → server" },
  server: { view: "", host: "host ← server", server: "" },
};

// The one line every recorder writes to its console for a message. Browser, host server and MCP server agree on it.
export function wireLine(event: DebugEvent): string {
  const what = event.kind === "http" && event.http
    ? `${event.http.method} ${event.http.path} ${event.http.status}`
    : [event.method ?? "?", event.tool ? `(${event.tool})` : ""].join("");
  const parts = [
    "[wire]", ARROW[event.from][event.to].padEnd(13), event.kind.padEnd(12), what,
    event.rpcId === null ? "" : `#${event.rpcId}`,
    `${event.bytes}B`,
    event.durationMs === null ? "" : `${event.durationMs}ms`,
    event.trace ? `trace=${event.trace}` : "",
    event.view ? `view=${event.view}` : "",
    `sid=${event.sid}`,
  ];
  return parts.filter(Boolean).join(" ");
}

// The fields a server puts in its JSON log line for a wire message. Add `t`, `level`, `svc` and `msg` around it.
export function wireFields(event: DebugEvent): Record<string, string | number | null> {
  return {
    hop: event.hop, from: event.from, to: event.to, kind: event.kind, method: event.method, tool: event.tool,
    rpcId: event.rpcId, bytes: event.bytes, ms: event.durationMs, trace: event.trace, sid: event.sid,
    status: event.http?.status ?? null,
  };
}

// What the host server sends on GET /debug/stream, one SSE event each.
export const FEED_EVENT = "wire";
export const FEED_PATH = "/debug/stream";
export const MCP_PATH = "/mcp";
export const VIEW_PATH = "/view";
