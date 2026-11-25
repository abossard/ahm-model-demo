import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { ErrorRequestHandler, Express } from "express";
import type { LlmStatus } from "./dealer";
import { describeError } from "./log";
import type { Logger } from "./log";

export interface Health {
  store: { driver: string; ready: boolean; check: string };
  llm: LlmStatus;
  views: string[];
  missingViews: string[];
}

export interface HttpDeps {
  createServer(): McpServer;
  health(): Health;
  log: Logger;
  startedAt: number;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createApp(deps: HttpDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    const health = deps.health();
    res.json({
      ok: health.store.ready && health.missingViews.length === 0,
      svc: "playground-mcp",
      store: health.store,
      llm: health.llm,
      views: health.views,
      ...(health.missingViews.length > 0 ? { missingViews: health.missingViews } : {}),
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
    });
  });

  app.post("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
    const server = deps.createServer();
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      deps.log.error("error", { where: "mcp", error: describeError(error) });
      if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
    }
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed. This server keeps no session."));
  });

  const onError: ErrorRequestHandler = (error: { status?: number; type?: string }, _req, res, _next) => {
    const status = error.status ?? 500;
    res.status(status).json(rpcError(status === 400 ? -32700 : -32603, status === 413 ? "Request too large" : "Bad request"));
  };
  app.use(onError);

  return app;
}
