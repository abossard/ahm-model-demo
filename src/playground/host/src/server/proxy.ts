import type { Request, RequestHandler, Response as Reply } from "express";
import { MCP_PATH, SID_HEADER, toDebugEvent, toHttpEvent, wireFields } from "@playground/contracts";
import type { DebugEvent, Party } from "@playground/contracts";
import { SID_PATTERN } from "./feed";
import type { Feed } from "./feed";
import type { Log } from "./log";
import { SSE_START, readSse } from "./sse";
import { viewDocuments } from "./views";
import type { Views } from "./views";

export interface ProxyDeps {
  mcpUrl: string;
  feed: Feed;
  views: Views;
  log: Log;
  fetch?: typeof fetch;
  now?: () => number;
}

const FORWARD_REQUEST = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id", SID_HEADER];
const RELAY_RESPONSE = ["content-type", "cache-control", "allow", "mcp-session-id", "mcp-protocol-version"];

// A calculation: the JSON-RPC messages of a body, each with the text it had on the wire.
export function messagesOf(text: string): { message: unknown; raw: string }[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.map((message) => ({ message, raw: JSON.stringify(message) }))
      : [{ message: parsed, raw: text }];
  } catch {
    return [];
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Forwards the browser's MCP traffic and records every message and exchange as a DebugEvent.
// It relays bytes: the browser sees what the MCP server sent.
export function createProxy({ mcpUrl, feed, views, log, fetch: send = fetch, now = Date.now }: ProxyDeps): RequestHandler {
  return async (req: Request, res: Reply) => {
    const sidHeader = header(req, SID_HEADER);
    const sid = sidHeader && SID_PATTERN.test(sidHeader) ? sidHeader : "none";
    const wire = (event: DebugEvent) => log("info", "wire", wireFields(event));
    const record = (event: (seq: number) => DebugEvent) => wire(feed.record(sid, event));
    const message = (from: Party, to: Party, body: unknown, raw: string, http: DebugEvent["http"]) =>
      record((seq) => toDebugEvent({ seq, at: now(), sid, hop: "host-server", from, to, http }, body, raw));
    const exchange = (status: number, contentType: string | null, bytes: number) =>
      record((seq) => toHttpEvent({
        seq, at: now(), sid, hop: "host-server", from: "server", to: "host",
        http: { method: req.method, path: MCP_PATH, status, contentType, streamed: false },
      }, bytes));

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sent = messagesOf(body.toString("utf8"));
    for (const item of sent) message("host", "server", item.message, item.raw, null);

    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });

    const headers: Record<string, string> = {};
    for (const name of FORWARD_REQUEST) {
      const value = header(req, name);
      if (value !== undefined) headers[name] = value;
    }

    let upstream: Response;
    try {
      upstream = await send(`${mcpUrl}${MCP_PATH}`, {
        method: req.method,
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: new Uint8Array(body) }),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      log("error", "error", { where: "proxy", sid, reason });
      const first = sent[0]?.message as { id?: unknown } | undefined;
      const id = typeof first?.id === "string" || typeof first?.id === "number" ? first.id : null;
      exchange(502, "application/json", 0);
      res.status(502).json({ jsonrpc: "2.0", id, error: { code: -32000, message: `MCP server unreachable: ${reason}` } });
      return;
    }

    res.status(upstream.status);
    for (const name of RELAY_RESPONSE) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    const contentType = upstream.headers.get("content-type");
    const received = (text: string, streamed: boolean) => {
      for (const item of messagesOf(text)) {
        for (const document of viewDocuments(item.message)) views.put(document);
        message("server", "host", item.message, item.raw, {
          method: req.method, path: MCP_PATH, status: upstream.status, contentType, streamed,
        });
      }
    };

    if (contentType?.includes("text/event-stream") && upstream.body) {
      res.flushHeaders();
      const decoder = new TextDecoder();
      let state = SSE_START;
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          const read = readSse(state, decoder.decode(value, { stream: true }));
          state = read.state;
          for (const payload of read.payloads) received(payload, true);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          log("error", "error", { where: "proxy.stream", sid, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      res.end();
      return;
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (contentType?.includes("application/json")) received(bytes.toString("utf8"), false);
    else exchange(upstream.status, contentType, bytes.length);
    res.end(bytes);
  };
}
