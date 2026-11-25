import { defineConfig } from "@playwright/test";
import onboarding from "./playwright.onboarding.config";

export default defineConfig(onboarding, {
  testMatch: "**/core/core.spec.ts",
  outputDir: "./test-results/core-walkthrough",
  timeout: 420_000,
});
