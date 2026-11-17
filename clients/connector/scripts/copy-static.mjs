import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("public/manifest.json", "dist/manifest.json");
cpSync("public/icons", "dist/icons", { recursive: true });

// The options page build emits at src/options/index.html (path mirrors the
// input relative to the project root); the manifest needs it at options.html.
const builtPage = "dist/src/options/index.html";
if (existsSync(builtPage)) {
  renameSync(builtPage, "dist/options.html");
  rmSync("dist/src", { recursive: true, force: true });
}

console.log("static files copied to dist/");
