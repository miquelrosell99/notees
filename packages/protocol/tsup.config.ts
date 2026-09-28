import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
});
