import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { newPlayer, Player } from "@playground/contracts";
import { z } from "zod";
import { errorText, log } from "./log";

// zod compiles its parsers with new Function by default, which the page policy forbids.
z.config({ jitless: true });

export type Theme = "light" | "dark";

export interface ConnectOptions {
  capabilities?: McpUiAppCapabilities;
  timeoutMs?: number;
}

export interface Connected {
  app: App;
  // The arguments of the entry tool call. `args.player` is the visitor.
  args: Record<string, unknown>;
  // The result of the entry tool call.
  first: CallToolResult;
  theme: Theme;
}

// A grace for hosts that send the result without the input.
const INPUT_GRACE_MS = 300;
const NO_HOST = "No host answered. This View only runs inside an MCP Apps host.";

// The visitor of the entry call. A host that omits it gets a fresh anonymous player.
export function playerOf(args: Record<string, unknown>): Player {
  const parsed = Player.safeParse(args["player"]);
  if (parsed.success) return parsed.data;
  log.warn("player missing from the entry arguments; using an anonymous one");
  return newPlayer(crypto.getRandomValues(new Uint8Array(10)));
}

function themeOf(app: App): Theme {
  return app.getHostContext()?.theme === "light" ? "light" : "dark";
}

// Registers the handlers first, then connects, and resolves once the entry call's input and result have arrived.
export async function connect(name: string, options: ConnectOptions = {}): Promise<Connected> {
  const app = new App({ name: `playground-${name}`, version: "1" }, options.capabilities ?? {}, { autoResize: true });
  let args: Record<string, unknown> | undefined;
  let first: CallToolResult | undefined;
  let settle: (value: { args: Record<string, unknown>; first: CallToolResult }) => void = () => {};
  const arrived = new Promise<{ args: Record<string, unknown>; first: CallToolResult }>((resolve) => { settle = resolve; });
  const check = () => { if (first && args) settle({ args, first }); };

  app.addEventListener("toolinput", (params) => { args = params.arguments ?? {}; check(); });
  app.addEventListener("toolresult", (params) => {
    first = params as CallToolResult;
    setTimeout(() => { args ??= {}; check(); }, INPUT_GRACE_MS);
    check();
  });
  app.addEventListener("hostcontextchanged", (params) => {
    if (params.theme) applyDocumentTheme(params.theme);
    log.debug("host context", { ...params });
  });

  const started = performance.now();
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(NO_HOST)), options.timeoutMs ?? 15_000);
  });
  try {
    await Promise.race([app.connect(), timeout]);
    const entry = await Promise.race([arrived, timeout]);
    const theme = themeOf(app);
    applyDocumentTheme(theme);
    log.info("connected", { ms: Math.round(performance.now() - started), host: app.getHostVersion()?.name, theme });
    return { app, ...entry, theme };
  } catch (error) {
    log.error("connect failed", { error: errorText(error) });
    throw error;
  }
}
