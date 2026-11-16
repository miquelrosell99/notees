import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Render dist/manifest.xml from the manifest.xml template.
 *
 * Two build flavors:
 *   - default — the layout a static file server serves under a path prefix:
 *     HOST from NOTEES_WORD_HOST (default https://localhost:8378), BASE_PATH
 *     from NOTEES_WORD_BASE_PATH (default "/word", the prefix the Notees
 *     sync server uses).
 *   - `localhost` (argv[2] === "localhost") — the `notees word serve`
 *     layout: the CLI serves dist/ at the ROOT of http://localhost:<port>,
 *     so HOST defaults to http://localhost:8471 and BASE_PATH to "".
 *
 * Env vars override either flavor's defaults. Both placeholders must be
 * fully resolved — an unresolved placeholder fails the build loudly.
 */
export const WORD_SERVE_DEFAULT_PORT = "8471";

export function manifestFlavor(argv = process.argv.slice(2), env = process.env) {
  const localhost = argv[0] === "localhost";
  return {
    host: env.NOTEES_WORD_HOST ?? (localhost ? `http://localhost:${WORD_SERVE_DEFAULT_PORT}` : "https://localhost:8378"),
    basePath: env.NOTEES_WORD_BASE_PATH ?? (localhost ? "" : "/word"),
  };
}

export function renderManifest(template, flavor) {
  const manifest = template.replaceAll("${HOST}", flavor.host).replaceAll("${BASE_PATH}", flavor.basePath);
  if (manifest.includes("${")) {
    throw new Error("unresolved ${...} placeholder in manifest.xml");
  }
  return manifest;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const flavor = manifestFlavor();
  const template = readFileSync("manifest.xml", "utf8");
  const manifest = renderManifest(template, flavor);
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/manifest.xml", manifest);
  console.log(`manifest written with host ${flavor.host} and base path "${flavor.basePath}"`);
}
