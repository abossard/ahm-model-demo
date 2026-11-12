import { defineConfig, devices } from "@playwright/test";

// Two runs at once (two people, or two agents) need their own port and their own build folder:
// E2E_PORT=4273 E2E_DIST=/tmp/ui-dist-a npm run e2e
const port = Number(process.env.E2E_PORT ?? 4173);
const dist = process.env.E2E_DIST ? ` --outDir "${process.env.E2E_DIST}"` : "";
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["live-experience.spec.ts", "real-backend.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npx vite build${dist}${dist ? " --emptyOutDir" : ""} && npx vite preview --host 127.0.0.1 --port ${port} --strictPort${dist}`,
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
