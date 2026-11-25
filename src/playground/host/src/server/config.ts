export interface HostConfig {
  port: number;
  mcpUrl: string;
  webDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {}

const LEVELS = ["debug", "info", "warn", "error"] as const;

// A calculation: the environment in, the config or the one line that names what is missing.
export function readConfig(env: Record<string, string | undefined>, defaultWebDir: string): HostConfig {
  const production = env.NODE_ENV === "production";
  const mcpUrl = env.MCP_URL ?? (production ? undefined : "http://127.0.0.1:8091");
  if (!mcpUrl) throw new ConfigError("MCP_URL is required");
  const port = Number(env.PORT ?? 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT is not a port: ${env.PORT}`);
  const level = env.LOG_LEVEL ?? (production ? "info" : "debug");
  if (!(LEVELS as readonly string[]).includes(level)) throw new ConfigError(`LOG_LEVEL is not one of ${LEVELS.join(", ")}: ${level}`);
  return {
    port,
    mcpUrl: mcpUrl.replace(/\/+$/, ""),
    webDir: env.WEB_DIR ?? defaultWebDir,
    logLevel: level as HostConfig["logLevel"],
  };
}
