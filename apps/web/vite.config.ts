import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Browser stand-ins for node-only imports reachable from @notees/store
      // (see the shim files; the store package cannot be modified from here).
      { find: "node:crypto", replacement: shim("node-crypto.ts") },
      { find: "node:fs", replacement: shim("node-builtins.ts") },
      { find: "node:os", replacement: shim("node-builtins.ts") },
      { find: "node:path", replacement: shim("node-builtins.ts") },
      { find: "better-sqlite3", replacement: shim("better-sqlite3.ts") },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    // The serial pnpm-chain run starves the jsdom timers (798 tests, CPU
    // contention with the sibling packages): the default 5 s timeout flakes
    // a different timing-sensitive spec on nearly every chain run while the
    // isolated suite is fully green. 15 s keeps the gate honest under load.
    testTimeout: 15_000,
  },
});
