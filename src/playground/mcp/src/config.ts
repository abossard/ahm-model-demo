import { LONG_POLL_SECONDS } from "@playground/contracts";

export type StoreDriver = "memory" | "emulator" | "cosmos";
export type LlmDriver = "fake" | "broken" | "azure";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  port: number;
  store: StoreDriver;
  cosmosEndpoint: string;
  cosmosDatabase: string;
  llm: LlmDriver;
  dealerEndpoint: string;
  dealerDeployment: string;
  viewsDir: string;
  logLevel: LogLevel;
  fast: boolean;
  longPollMs: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const value = env[name] ?? fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value as T;
}

function required(env: Env, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

const EMULATOR_ENDPOINT = "http://localhost:8081";

export function loadConfig(env: Env, defaultViewsDir: string): Config {
  const store = oneOf(env, "PLAYGROUND_STORE", ["memory", "emulator", "cosmos"], "memory");
  const llm = oneOf(env, "PLAYGROUND_LLM", ["fake", "broken", "azure"], "fake");
  const port = Number(env["PORT"] ?? 8091);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`PORT must be a port number, got "${env["PORT"]}"`);
  const fast = env["PLAYGROUND_FAST"] === "1";
  return {
    port,
    store,
    cosmosEndpoint:
      store === "memory" ? "" : store === "emulator" ? (env["COSMOS_ENDPOINT"] ?? EMULATOR_ENDPOINT) : required(env, "COSMOS_ENDPOINT"),
    cosmosDatabase: env["COSMOS_DATABASE"] ?? "playground",
    llm,
    dealerEndpoint: llm === "azure" ? required(env, "DEALER_ENDPOINT").replace(/\/+$/, "") : "",
    dealerDeployment: env["DEALER_DEPLOYMENT"] ?? "gpt-54-mini",
    viewsDir: env["VIEWS_DIR"] ?? defaultViewsDir,
    logLevel: oneOf(env, "LOG_LEVEL", ["debug", "info", "warn", "error"], "debug"),
    fast,
    longPollMs: (fast ? 5 : LONG_POLL_SECONDS) * 1000,
  };
}
