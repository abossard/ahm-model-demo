import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, PAGE_POLICY, VIEW_POLICY } from "./app";
import { createFeed } from "./feed";
import type { Feed } from "./feed";
import { sha256 } from "./views";

const SID = "tab-0123abcd";
const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((server) => { server.closeAllConnections(); server.close(); }); });

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, "127.0.0.1", () => resolve(server));
    servers.push(server);
  });
}
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function setup(upstream: (req: IncomingMessage, res: ServerResponse) => void, mcpUrl?: string) {
  const stub = await listen(upstream);
  const feed = createFeed();
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    config: { mcpUrl: mcpUrl ?? urlOf(stub), webDir: "/nonexistent" },
    log: (level, msg, fields) => logs.push({ level, msg, ...fields }),
    feed,
  });
  const host = await listen(app);
  return { base: urlOf(host), feed, logs, stub };
}

function events(feed: Feed, sid = SID) {
  const frames: string[] = [];
  feed.open(sid, { write: (chunk) => void frames.push(chunk), end: () => {} });
  return frames.map((text) => JSON.parse(/data: (.*)\n/.exec(text)![1]!));
}

const call = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "hello_show", arguments: {}, _meta: { "playground/trace": "t-abc" } } };
const post = (base: string, body: unknown, headers: Record<string, string> = { "x-playground-sid": SID }) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("proxy", () => {
  it("relays a JSON reply byte for byte and records both messages with the trace", async () => {
    const reply = JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [], structuredContent: { ok: true } } });
    let seen = { sid: "", body: "" };
    const { base, feed } = await setup((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk)).on("end", () => {
        seen = { sid: String(req.headers["x-playground-sid"]), body };
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "m1" }).end(reply);
      });
    });
    const response = await post(base, call);
    expect(await response.text()).toBe(reply);
    expect(response.headers.get("mcp-session-id")).toBe("m1");
    expect(seen).toEqual({ sid: SID, body: JSON.stringify(call) });
    const [request, answer] = events(feed);
    expect(request).toMatchObject({ hop: "host-server", from: "host", to: "server", kind: "request", tool: "hello_show", trace: "t-abc", rpcId: 5, seq: 1 });
    expect(answer).toMatchObject({ from: "server", to: "host", kind: "response", method: "tools/call", tool: "hello_show", trace: "t-abc", bytes: reply.length, seq: 2 });
    expect(answer.http).toMatchObject({ status: 200, streamed: false, path: "/mcp" });
    expect(answer.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes a stream through as it arrives and records each event as streamed", async () => {
    const first = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1, _meta: { "playground/trace": "t-abc" } } };
    const last = { jsonrpc: "2.0", id: 5, result: { content: [] } };
    const wire = `event: message\ndata: ${JSON.stringify(first)}\n\nevent: message\ndata: ${JSON.stringify(last)}\n\n`;
    const cut = wire.indexOf("\n\nevent") + 5;
    const { base, feed } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(wire.slice(0, cut));
      setTimeout(() => res.end(wire.slice(cut)), 30);
    });
    const response = await post(base, call);
    expect(await response.text()).toBe(wire);
    const [, progress, reply] = events(feed);
    expect(progress).toMatchObject({ kind: "notification", method: "notifications/progress", trace: "t-abc", http: { streamed: true, status: 200 } });
    expect(reply).toMatchObject({ kind: "response", tool: "hello_show", http: { streamed: true } });
  });

  it("records a View document under its digest and serves it with the View policy", async () => {
    const html = "<!doctype html><p>héllo</p>" + "x".repeat(5000);
    const reply = { jsonrpc: "2.0", id: 2, result: { contents: [{ uri: "ui://playground/hello.html", mimeType: "text/html;profile=mcp-app", text: html }] } };
    const { base, feed } = await setup((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply)));
    await post(base, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://playground/hello.html" } });
    const document = await fetch(`${base}/view/${sha256(html)}`);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-security-policy")).toBe(VIEW_POLICY);
    expect(await document.text()).toBe(html);
    const [, answer] = events(feed);
    expect(answer).toMatchObject({ truncated: true });
    expect(answer.bytes).toBeGreaterThan(5000);
  });

  it.each([
    ["a digest that is not hex", "nope"],
    ["a digest that is unknown", "0".repeat(64)],
  ])("answers 404 for %s", async (_name, digest) => {
    const { base } = await setup((_req, res) => void res.end());
    expect((await fetch(`${base}/view/${digest}`)).status).toBe(404);
  });

  it("records an exchange that carried no message", async () => {
    const { base, feed } = await setup((_req, res) => void res.writeHead(405, { allow: "POST", "content-type": "text/plain" }).end("Method Not Allowed"));
    const response = await fetch(`${base}/mcp`, { headers: { "x-playground-sid": SID, accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(events(feed)).toMatchObject([{ kind: "http", http: { method: "GET", path: "/mcp", status: 405 } }]);
  });

  it("answers 502 with a JSON-RPC error when the MCP server is unreachable", async () => {
    const dead = await listen(() => {});
    const url = urlOf(dead);
    dead.close();
    const { base, feed, logs } = await setup(() => {}, url);
    const response = await post(base, call);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 5, error: { code: -32000 } });
    expect(events(feed).at(-1)).toMatchObject({ kind: "http", http: { status: 502 } });
    expect(logs.some((line) => line.level === "error")).toBe(true);
  });

  it("files a request without a sid under none and gives it to no feed", async () => {
    const { base, feed, logs } = await setup((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    await post(base, call, {});
    expect(logs.filter((line) => line.msg === "wire").map((line) => line.sid)).toEqual(["none", "none"]);
    expect((await fetch(`${base}/debug/stream?sid=none`)).status).toBe(400);
    expect(feed.stats().tabs).toBe(1);
  });

  it("logs one structured line per message", async () => {
    const { base, logs } = await setup((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} })));
    await post(base, call);
    expect(logs).toMatchObject([
      { level: "info", msg: "wire", hop: "host-server", from: "host", to: "server", kind: "request", tool: "hello_show", trace: "t-abc", sid: SID },
      { msg: "wire", from: "server", to: "host", kind: "response", tool: "hello_show", trace: "t-abc", status: 200 },
    ]);
  });

  it("aborts the upstream call when the browser goes away", async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
    const { base } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      res.on("close", closed);
    });
    const response = await post(base, call);
    await response.body?.cancel();
    await upstreamClosed;
  });
});

describe("routes", () => {
  it("streams the events of a tab and replays after Last-Event-ID", async () => {
    const { base, feed } = await setup((_req, res) => void res.end());
    await post(base, call);
    const abort = new AbortController();
    const response = await fetch(`${base}/debug/stream?sid=${SID}`, { signal: abort.signal, headers: { "last-event-id": "1" } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toMatch(/^id: 2\nevent: wire\n/);
    expect(feed.stats().streams).toBe(1);
    abort.abort();
  });

  it("rejects a feed without a valid sid", async () => {
    const { base } = await setup((_req, res) => void res.end());
    expect((await fetch(`${base}/debug/stream?sid=x`)).status).toBe(400);
  });

  it("reports health with the reachability of the MCP server", async () => {
    const { base } = await setup((_req, res) => void res.writeHead(200).end("{}"));
    const response = await fetch(`${base}/healthz`);
    expect(await response.json()).toMatchObject({ ok: true, svc: "playground-host", mcp: { reachable: true }, feeds: 0 });
    expect(response.headers.get("content-security-policy")).toBe(PAGE_POLICY);
  });

  it("reports an unreachable MCP server and still answers ok", async () => {
    const dead = await listen(() => {});
    const url = urlOf(dead);
    dead.close();
    const { base } = await setup(() => {}, url);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: true, mcp: { reachable: false } });
  });
});
