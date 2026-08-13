import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const python = path.join(repoRoot, ".venv-health-ui/bin/python");

const backendEnv = {
  AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
  QUEUE_URL: "https://example.queue.core.windows.net/requests",
  POSTGRES_HOST: "pg.example.postgres.database.azure.com",
  POSTGRES_DATABASE: "demo",
  POSTGRES_USER: "id-ahm-demo-app",
  APPLICATIONINSIGHTS_CONNECTION_STRING:
    "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  AZURE_SUBSCRIPTION_ID: "11111111-1111-1111-1111-111111111111",
  AZURE_SUBSCRIPTION_NAME: "Example Subscription",
  AZURE_RESOURCE_GROUP: "rg-ahm-demo",
  HEALTH_MODEL_NAME: "hm-ahm-demo",
  HEALTH_MODEL_LOCATION: "northeurope",
  HEALTH_COPILOT_ENABLED: "true",
  AGENT_WEB_ORIGIN: "http://127.0.0.1:8100",
  AGENT_FAKE_PORT: "8100",
};

export default defineConfig({
  testDir: "./tests",
  testMatch: ["agent.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8099",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node tests/fake-agent.mjs",
      cwd: here,
      env: { AGENT_FAKE_PORT: "8100" },
      url: "http://127.0.0.1:8100/agent",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `${python} -m uvicorn --app-dir src/web/app --host 127.0.0.1 --port 8099 main:app`,
      cwd: repoRoot,
      env: backendEnv,
      url: "http://127.0.0.1:8099/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
