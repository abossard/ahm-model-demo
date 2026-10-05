import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.LIVE_BASE_URL;
if (!baseURL) {
  throw new Error(
    "LIVE_BASE_URL is required for live Playwright runs (for example the current deployed app URL).",
  );
}
const includeMutations = process.env.LIVE_INCLUDE_MUTATION === "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["live-experience.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  grep: includeMutations ? /@live-(readonly|mutation)/ : /@live-readonly/,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
