import { mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = require.resolve("@microsoft/office-js/package.json");
const { dirname, join } = await import("node:path");
const distDir = join(dirname(src), "dist");
mkdirSync("dist/lib", { recursive: true });
copyFileSync(join(distDir, "office.js"), "dist/lib/office.js");
// office.js fetches its app-to-file mapping table from its own directory
// before Office.onReady fires — without it the pane never renders, even in
// a plain browser (Task 4 smoke).
copyFileSync(join(distDir, "o15apptofilemappingtable.js"), "dist/lib/o15apptofilemappingtable.js");
console.log("vendored office.js");
