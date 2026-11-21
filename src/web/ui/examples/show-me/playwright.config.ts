import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const origin = "http://127.0.0.1:4286";
export default defineConfig({
  testMatch: "example.spec.ts",
  use: { baseURL: origin },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4286 --strictPort",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: origin + "/examples/show-me/",
    reuseExistingServer: true,
  },
});
