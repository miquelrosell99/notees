import { CliError, EXIT } from "../exit-codes.js";

/**
 * Render the sideload manifest for one serve port. The vendored template is
 * the notees-word manifest.xml with its `${HOST}`/`${BASE_PATH}` build
 * placeholders; the local server always serves the dist at the root, so
 * BASE_PATH renders empty and the origin is plain http on localhost (the
 * loopback exemption — no TLS anywhere in this path).
 */
export function renderWordManifest(template: string, port: number): string {
  const manifest = template.replaceAll("${HOST}", `http://localhost:${port}`).replaceAll("${BASE_PATH}", "");
  if (manifest.includes("${")) {
    throw new CliError(
      EXIT.domain,
      "vendored Word manifest template has unresolved placeholders — refresh vendor/word (scripts/sync-word-dist.mjs)",
    );
  }
  return manifest;
}
