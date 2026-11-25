import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "./config";

describe("readConfig", () => {
  it.each([
    ["local defaults", {}, { port: 8090, mcpUrl: "http://127.0.0.1:8091", webDir: "/d", logLevel: "debug" }],
    ["azure", { NODE_ENV: "production", PORT: "8080", MCP_URL: "https://mcp.example/", WEB_DIR: "/app/host/dist" },
      { port: 8080, mcpUrl: "https://mcp.example", webDir: "/app/host/dist", logLevel: "info" }],
    ["explicit level", { LOG_LEVEL: "warn" }, { port: 8090, mcpUrl: "http://127.0.0.1:8091", webDir: "/d", logLevel: "warn" }],
  ])("%s", (_name, env, expected) => {
    expect(readConfig(env, "/d")).toEqual(expected);
  });

  it.each([
    ["MCP_URL in production", { NODE_ENV: "production" }, "MCP_URL"],
    ["a bad port", { PORT: "http" }, "PORT"],
    ["a bad level", { LOG_LEVEL: "loud" }, "LOG_LEVEL"],
  ])("stops on %s with one line that names it", (_name, env, name) => {
    expect(() => readConfig(env, "/d")).toThrow(ConfigError);
    expect(() => readConfig(env, "/d")).toThrow(name);
  });
});
