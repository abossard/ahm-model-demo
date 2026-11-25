import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Express, Response } from "express";
import { FEED_PATH, MCP_PATH, VIEW_PATH } from "@playground/contracts";
import { SID_PATTERN, createFeed } from "./feed";
import type { Feed } from "./feed";
import type { HostConfig } from "./config";
import type { Log } from "./log";
import { createProxy } from "./proxy";
import { createViews } from "./views";

export const PAGE_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const VIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

const PROBE_TTL_MS = 5_000;

export interface AppDeps {
  config: Pick<HostConfig, "mcpUrl" | "webDir">;
  log: Log;
  feed?: Feed;
  fetch?: typeof fetch;
  now?: () => number;
  startedAt?: number;
}

export function createApp({ config, log, feed = createFeed(), fetch: send = fetch, now = Date.now, startedAt = now() }: AppDeps): Express {
  const views = createViews();
  const app = express();
  app.disable("x-powered-by");

  let probe = { at: -Infinity, reachable: false };
  async function mcpReachable(): Promise<boolean> {
    if (now() - probe.at < PROBE_TTL_MS) return probe.reachable;
    const reachable = await send(`${config.mcpUrl}/healthz`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
    probe = { at: now(), reachable };
    return reachable;
  }

  app.use((req, res, next) => {
    if (!req.path.startsWith(`${VIEW_PATH}/`)) res.setHeader("content-security-policy", PAGE_POLICY);
    next();
  });

  app.get("/healthz", async (_req, res) => {
    const reachable = await mcpReachable();
    res.json({
      ok: true, svc: "playground-host", mcp: { url: config.mcpUrl, reachable },
      feeds: feed.stats().streams, uptimeSec: Math.round((now() - startedAt) / 1000),
    });
  });

  app.all(MCP_PATH, express.raw({ type: "*/*", limit: "1mb" }), createProxy({ mcpUrl: config.mcpUrl, feed, views, log, fetch: send, now }));

  app.get(FEED_PATH, (req, res) => {
    const sid = String(req.query.sid ?? "");
    if (!SID_PATTERN.test(sid)) {
      res.status(400).type("text/plain").send("sid must match [a-z0-9-]{8,40}");
      return;
    }
    res.status(200).set({
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no",
    });
    res.flushHeaders();
    const last = Number(req.headers["last-event-id"] ?? 0);
    const detach = feed.open(sid, { write: (chunk) => void res.write(chunk), end: () => void res.end() }, Number.isFinite(last) ? last : 0);
    res.on("close", detach);
  });

  app.get(`${VIEW_PATH}/:sha256`, (req, res) => {
    const text = /^[a-f0-9]{64}$/.test(req.params.sha256) ? views.get(req.params.sha256) : undefined;
    if (text === undefined) {
      res.status(404).type("text/plain").send("No such View document");
      return;
    }
    res.set({ "content-type": "text/html; charset=utf-8", "content-security-policy": VIEW_POLICY, "cache-control": "no-store" }).send(text);
  });

  const index = join(config.webDir, "index.html");
  app.use(express.static(config.webDir, { index: false }));
  app.use((req, res: Response) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || !existsSync(index)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.sendFile(index);
  });

  return app;
}
