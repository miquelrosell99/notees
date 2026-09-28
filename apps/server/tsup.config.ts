import { defineConfig } from "tsup";

// Bundle the workspace TS sources (they export raw .ts); keep the native
// better-sqlite3 binding external.
export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  target: "node22",
  sourcemap: true,
  clean: true,
  external: ["better-sqlite3"],
  noExternal: ["@notees/protocol", "@notees/domain", "@notees/store", "@notees/sync"],
});
