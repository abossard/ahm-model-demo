import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "../../../artifacts/survey-playwright",
  use: { baseURL: "http://127.0.0.1:4174", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && cd ../../.. && .venv-health-ui/bin/python -m src.survey.tests.local_server",
    url: "http://127.0.0.1:4174/api/ready",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
