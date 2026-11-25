import { defineConfig } from "@playwright/test";

// PLAYGROUND_E2E_PORT_OFFSET lets two runs share one machine.
const OFFSET = Number(process.env.PLAYGROUND_E2E_PORT_OFFSET ?? 0);
const MCP_PORT = 18291 + OFFSET;
const HOST_PORT = 18290 + OFFSET;
const BROKEN_MCP_PORT = 18391 + OFFSET;
const BROKEN_HOST_PORT = 18390 + OFFSET;

const SECOND = 1000;
const root = new URL("..", import.meta.url).pathname;

function pair(hostPort: number, mcpPort: number, llm: "fake" | "broken") {
  const env = { PLAYGROUND_STORE: "memory", PLAYGROUND_LLM: llm, PLAYGROUND_FAST: "1", LOG_LEVEL: "warn" };
  return [
    { command: "npm run start -w @playground/mcp", cwd: root, url: `http://127.0.0.1:${mcpPort}/healthz`, env: { ...env, PORT: String(mcpPort) }, reuseExistingServer: false, timeout: 120 * SECOND },
    { command: "npm run start -w @playground/host", cwd: root, url: `http://127.0.0.1:${hostPort}/healthz`, env: { ...env, PORT: String(hostPort), MCP_URL: `http://127.0.0.1:${mcpPort}` }, reuseExistingServer: false, timeout: 120 * SECOND },
  ];
}

// The built Views and host page are expected in views/dist and host/dist: run `npm run build` first.
export default defineConfig({
  testDir: "tests",
  testIgnore: ["deployed.spec.ts"],
  timeout: 120 * SECOND,
  expect: { timeout: 30 * SECOND },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  // Screenshots are taken at rest: motion off. The motion spec turns it back on.
  use: { reducedMotion: "reduce", trace: "retain-on-failure", viewport: { width: 1440, height: 900 }, actionTimeout: 30 * SECOND },
  projects: [
    { name: "main", testIgnore: ["misdeal.spec.ts", "deployed.spec.ts"], use: { baseURL: `http://127.0.0.1:${HOST_PORT}` } },
    { name: "broken", testMatch: ["misdeal.spec.ts"], use: { baseURL: `http://127.0.0.1:${BROKEN_HOST_PORT}` } },
  ],
  webServer: [...pair(HOST_PORT, MCP_PORT, "fake"), ...pair(BROKEN_HOST_PORT, BROKEN_MCP_PORT, "broken")],
});
