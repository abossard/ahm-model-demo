import { defineConfig } from "@playwright/test";
import offline from "./playwright.real.config";

export default defineConfig(offline, {
  testDir: "./onboarding",
  testMatch: "walkthrough.spec.ts",
  outputDir: "./test-results/onboarding",
  timeout: 150_000,
  use: {
    colorScheme: "light",
    timezoneId: "UTC",
    locale: "en-US",
    launchOptions: { slowMo: 160 },
  },
  projects: [{ name: "chromium", use: { viewport: { width: 1360, height: 850 } } }],
});
