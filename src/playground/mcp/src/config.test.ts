import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

describe("loadConfig", () => {
  it.each([
    { name: "defaults", env: {}, expect: { port: 8091, store: "memory", llm: "fake", fast: false, longPollMs: 25_000, logLevel: "debug", dealerDeployment: "gpt-54-mini" } },
    { name: "fast mode", env: { PLAYGROUND_FAST: "1" }, expect: { fast: true, longPollMs: 5000 } },
    { name: "emulator default endpoint", env: { PLAYGROUND_STORE: "emulator" }, expect: { cosmosEndpoint: "http://localhost:8081" } },
    {
      name: "azure",
      env: { PORT: "8080", PLAYGROUND_STORE: "cosmos", COSMOS_ENDPOINT: "https://c.documents.azure.com", PLAYGROUND_LLM: "azure", DEALER_ENDPOINT: "https://x.openai.azure.com/", LOG_LEVEL: "info" },
      expect: { port: 8080, store: "cosmos", cosmosEndpoint: "https://c.documents.azure.com", llm: "azure", dealerEndpoint: "https://x.openai.azure.com", logLevel: "info" },
    },
    { name: "views dir", env: { VIEWS_DIR: "/app/views/dist" }, expect: { viewsDir: "/app/views/dist" } },
  ])("reads $name", ({ env, expect: wanted }) => {
    expect(loadConfig(env, "/default")).toMatchObject(wanted);
  });

  it.each([
    { name: "cosmos without endpoint", env: { PLAYGROUND_STORE: "cosmos" }, message: "COSMOS_ENDPOINT is required" },
    { name: "azure without endpoint", env: { PLAYGROUND_LLM: "azure" }, message: "DEALER_ENDPOINT is required" },
    { name: "unknown store", env: { PLAYGROUND_STORE: "sqlite" }, message: "PLAYGROUND_STORE must be one of" },
    { name: "bad port", env: { PORT: "abc" }, message: "PORT must be a port number" },
  ])("stops with one line for $name", ({ env, message }) => {
    expect(() => loadConfig(env, "/default")).toThrow(ConfigError);
    expect(() => loadConfig(env, "/default")).toThrow(message);
  });
});
