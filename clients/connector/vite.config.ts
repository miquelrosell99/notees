/// <reference types="vitest/config" />
import { defineConfig, type UserConfig } from "vitest/config";

/** Self-contained non-module script bundle (MV2 background / content script). */
function scriptBuild(entry: string, fileName: string): UserConfig {
  return {
    build: {
      outDir: "dist",
      emptyOutDir: false, // several builds share dist/
      copyPublicDir: false,
      lib: {
        entry,
        name: fileName.replace(/[^a-zA-Z0-9]/g, ""), // IIFE global must be a valid identifier
        fileName: () => `${fileName}.js`,
        formats: ["iife"],
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode === "background") return scriptBuild("src/background/index.ts", "background");
  if (mode === "bridge") return scriptBuild("src/content/bridge.ts", "content-bridge");
  if (mode === "options") {
    return {
      build: {
        outDir: "dist",
        emptyOutDir: false,
        copyPublicDir: false,
        rollupOptions: { input: { options: "src/options/index.html" } },
      },
    };
  }
  // default (vitest / plain `vite` invocation): test config only
  return {
    test: {
      environment: "node",
      setupFiles: ["./test/setup.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
