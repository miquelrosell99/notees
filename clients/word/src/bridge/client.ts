import type { Bridge, BridgeError, BridgeResponse, BridgeResult } from "./types";

export class BridgeOfflineError extends Error {
  readonly kind = "offline" as const;
  constructor(cause: unknown) {
    super(`Notees bridge unreachable: ${String(cause)}`);
    this.name = "BridgeOfflineError";
  }
}
export class BridgeShapeError extends Error {
  readonly kind = "shape" as const;
  constructor(readonly detail: string) {
    super(`Bridge returned unexpected payload: ${detail}`);
    this.name = "BridgeShapeError";
  }
}

const TIMEOUT_MS = 5_000;

/**
 * The client talks ONLY to the loopback bridge. The host is a literal here
 * and the built URL is re-asserted before use: a non-integer/out-of-range
 * port is a programmer error and throws before fetch is ever called.
 */
function loopbackBase(port: number): string {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`bridge port must be an integer in 0..65535, got ${String(port)}`);
  }
  const base = new URL(`http://127.0.0.1:${String(port)}`);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
    throw new RangeError(`bridge base URL must be http://127.0.0.1, got ${base.origin}`);
  }
  return base.origin;
}

export function createBridge(opts: {
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Bridge {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = loopbackBase(opts.port);

  async function call<T extends Record<string, unknown>>(
    cmd: string,
    body: Record<string, unknown>,
    requireKeys: (keyof T)[]
  ): Promise<BridgeResponse<T>> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ cmd, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new BridgeOfflineError(e);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new BridgeOfflineError(new Error(`HTTP ${res.status}, non-JSON body`));
    }
    if (typeof json !== "object" || json === null || !("ok" in json)) {
      throw new BridgeShapeError("missing ok flag");
    }
    if (json.ok === false) {
      const err = (json as { error?: Partial<BridgeError> }).error ?? {};
      return { ok: false, error: { code: String(err.code ?? "unknown"), message: String(err.message ?? "unknown error"), status: res.status } };
    }
    for (const k of requireKeys) {
      if (!(k in json)) throw new BridgeShapeError(`missing key ${String(k)}`);
    }
    return json as BridgeResponse<T>;
  }

  return {
    search: (query) =>
      call<{ results: BridgeResult[] }>("search", { query }, ["results"]).then(r =>
        r.ok && !Array.isArray(r.results) ? { ok: false, error: { code: "shape", message: "results not an array" } } : r),
    renderCitation: (objectIds, styleId, locator) =>
      call("render-citation", { objectIds, styleId, ...(locator ? { locator } : {}) }, ["citation"]),
    renderBibliography: (objectIds, styleId) =>
      call("render-bibliography", { objectIds, styleId }, ["bibliography"]),
    listStyles: () => call("list-styles", {}, ["styles"]),
  };
}
