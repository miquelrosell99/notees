/**
 * Node-link clipboard helpers. The app's deep-link format is
 * `<origin>/<uuid>` (App.tsx routing); `nodeLinkUrl` builds it and
 * `parseNodeLink` detects it — or a bare uuid — on the clipboard so
 * Ctrl/Cmd+V can paste a mention instead of raw text.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical URL that opens a node: `<origin>/<uuid>`. */
export function nodeLinkUrl(id: string): string {
  return `${window.location.origin}/${id}`;
}

/**
 * Extract a node id from clipboard text: either `http(s)://<host>/<uuid>`
 * (any origin — the id resolves against the local graph, so a link carried
 * across deployments still pastes when the node exists here) or a bare
 * uuid. Returns null for anything else, which keeps the default paste.
 */
export function parseNodeLink(text: string): string | null {
  const trimmed = text.trim();
  if (UUID_RE.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    return null;
  }
  const match = /^\/([^/]+)$/.exec(pathname);
  if (match !== null && UUID_RE.test(match[1]!)) return match[1]!;
  return null;
}
