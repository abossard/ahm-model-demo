import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const SERVER = "http://127.0.0.1:8090";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // The page policy allows fonts and images from the same origin only, so nothing is inlined as a data URL.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    port: 5273,
    strictPort: true,
    proxy: Object.fromEntries(["/mcp", "/debug", "/view", "/healthz"].map((path) => [path, SERVER])),
  },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
