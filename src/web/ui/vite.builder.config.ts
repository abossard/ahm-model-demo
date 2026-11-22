import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => ({
  plugins: [react(), viteSingleFile()],
  build: { emptyOutDir: false, rollupOptions: { input: mode === "diagram" ? "diagram.html" : "builder.html" } },
}));
