/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    // public/ (manifest icons) lands in dist verbatim via vite's native
    // publicDir copy; manifest.xml and lib/office.js are added on top by
    // scripts/copy-*.mjs after the build.
    rollupOptions: {
      // office.js is vendored as a static file (scripts/copy-office-js.mjs),
      // never bundled.
      external: [],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
