import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vitest/config";

// `VIEW=<name> vite build` turns <name>.html into dist/<name>.html: one file, no request.
const view = process.env["VIEW"] ?? "hello";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { input: `${view}.html` },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node" },
});
