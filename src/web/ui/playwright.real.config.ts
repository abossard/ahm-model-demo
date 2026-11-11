import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const python = path.join(repoRoot, ".venv-health-ui/bin/python");

/** A port nothing listens on, found once: workers that load this file again read it from the environment. */
function freePort(): string {
  const script = "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})";
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
}
process.env.REAL_BACKEND_PORT ??= freePort();
const port = process.env.REAL_BACKEND_PORT;

// The offline mode of docs/development.md: Sessions in memory and a scripted agent, so nothing reaches Azure.
const offlineEnv = {
  // No sign-in: the server acts as the developer, and `GET /api/config` says `local`.
  AUTH_MODE: "local",
  AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000",
  AZURE_RESOURCE_GROUP: "rg-local",
  HEALTH_MODEL_NAME: "hm-local",
  HEALTH_MODEL_DESIGN_NAME: "hm-local-design",
  FOUNDRY_AGENT_NAME: "health-model-agent",
  SESSIONS_CONTAINER_URL: "memory:",
  FOUNDRY_PROJECT_ENDPOINT: "fake:",
  APPLICATIONINSIGHTS_CONNECTION_STRING:
    "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=http://127.0.0.1:9/",
};

// The real web app serves the built UI, so the run needs `.venv-health-ui` (`make deps`) and builds the UI first.
export default defineConfig({
  testDir: "./tests",
  testMatch: ["real-backend.spec.ts"],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // The app keeps its Sessions and the fixture models in memory, so the tests share one process in order.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm --prefix src/web/ui run build && ${python} -m uvicorn --app-dir src/web/app --host 127.0.0.1 --port ${port} main:app`,
    cwd: repoRoot,
    env: offlineEnv,
    url: `http://127.0.0.1:${port}/api/health-models`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
