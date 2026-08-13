import { defineConfig } from "@playwright/test";

const healthEnvironment = [
  "AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000001",
  "QUEUE_URL=https://example.queue.core.windows.net/requests",
  "POSTGRES_HOST=pg.example.postgres.database.azure.com",
  "POSTGRES_DATABASE=demo",
  "POSTGRES_USER=id-ahm-demo-app",
  "APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=00000000-0000-0000-0000-000000000000",
  "AZURE_SUBSCRIPTION_ID=11111111-1111-1111-1111-111111111111",
  "AZURE_SUBSCRIPTION_NAME=Example Subscription",
  "AZURE_RESOURCE_GROUP=rg-ahm-demo",
  "HEALTH_MODEL_NAME=hm-ahm-demo",
  "HEALTH_MODEL_LOCATION=northeurope",
  "HEALTH_COPILOT_ENABLED=true",
].join(" ");
const liveBaseUrl = process.env.LIVE_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: "../../artifacts/health-copilot/playwright",
  use: {
    baseURL: liveBaseUrl || "http://127.0.0.1:8081",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: liveBaseUrl ? undefined : [
    {
      command: "node tests/fake-agent.mjs",
      url: "http://127.0.0.1:8000/ready",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "npm run build --silent && npm run start -- --hostname 127.0.0.1 --port 3000",
      url: "http://127.0.0.1:3000/agent/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        `cd ../.. && ${healthEnvironment} ` +
        ".venv-health-ui/bin/gunicorn --chdir src/health-app " +
        "--bind 127.0.0.1:8081 --workers 1 --threads 4 --timeout 120 " +
        "app:app",
      url: "http://127.0.0.1:8081/",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
