import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/sqljs": "src/adapters/sqljs.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["better-sqlite3", "sql.js"],
});
