import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8081" } },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.ts"] },
});
