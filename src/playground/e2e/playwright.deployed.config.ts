import { defineConfig } from "@playwright/test";

// Against Azure: PLAYGROUND_URL=https://<host fqdn> npx playwright test -c playwright.deployed.config.ts
const url = process.env["PLAYGROUND_URL"];
if (!url) throw new Error("PLAYGROUND_URL is not set");

export default defineConfig({
  testDir: "tests",
  testMatch: ["deployed.spec.ts"],
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results-deployed",
  use: { baseURL: url, trace: "retain-on-failure", viewport: { width: 1440, height: 900 }, actionTimeout: 30_000 },
});
