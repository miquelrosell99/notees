/**
 * Same-origin API seam for the pane. The local gateway (`notees word serve`)
 * proxies `/api/*` to the configured sync server with the credential
 * injected server-side, so the pane holds no server URL and no API key:
 * every API call is a plain relative fetch against the pane's own origin.
 *
 * Root-relative `/api/` paths only — an absolute URL would escape the
 * gateway (and leak the credential to whoever it points at), so it is a
 * programmer error, thrown before fetch is ever called.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/api/")) {
    throw new Error(`api path must be root-relative under /api/: ${path}`);
  }
  return path;
}

export interface ApiClientOptions {
  /** Injectable for tests; defaults to the global same-origin fetch. */
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async request(path, init = {}) {
      return fetchImpl(apiUrl(path), init);
    },
  };
}
