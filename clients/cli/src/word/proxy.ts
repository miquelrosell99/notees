import { connect as netConnect } from "node:net";
import { Readable, pipeline, type Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The word gateway's fixed upstream: the configured sync server. The client
 * (the pane) can influence NONE of this — no header, query, or path can
 * retarget the proxy: the origin comes only from the CLI's server config
 * (NOTEES_WORD_UPSTREAM override aside), and only `/api/*` paths reach the
 * proxy at all.
 */
export interface WordProxyTarget {
  /** Upstream base URL, e.g. http://127.0.0.1:8379 or https://<host>. */
  readonly upstream: string;
  /** Injected server-side on every proxied request; never client-supplied. */
  readonly apiKey: string;
  /** Injected as `x-workspace-id` when the client did not send one (the
   *  CLI's own requests resolve the configured workspace the same way). */
  readonly workspaceId?: string;
}

/** Everything hop-by-hop, everything that retargets or authenticates. */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Auth is injected server-side; a client-supplied credential is dropped,
  // never forwarded (and never allowed to override the configured key).
  "x-api-key",
  "authorization",
  "cookie",
]);

/**
 * Response-side hop-by-hop set plus the two headers fetch invalidates:
 * undici decodes content encodings transparently (the body arriving here is
 * already plain), so relaying the original content-encoding/content-length
 * would corrupt the stream — the response goes out chunked instead.
 */
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Upgrade handshake drop-list: like the HTTP list, but Connection/Upgrade
 * SURVIVE — they are the upgrade itself. Host and all client auth still go.
 */
const DROP_UPGRADE_HEADERS = new Set([
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "x-api-key",
  "authorization",
  "cookie",
]);

/** Only `/api/*` is proxied — everything else is the statics server. */
export function isProxyPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function filterRequestHeaders(req: IncomingMessage, target: WordProxyTarget): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (target.workspaceId !== undefined && headers["x-workspace-id"] === undefined) {
    headers["x-workspace-id"] = target.workspaceId;
  }
  headers["x-api-key"] = target.apiKey;
  return headers;
}

/**
 * Relay one HTTP request to the fixed upstream, streaming both directions
 * without buffering (relay snapshots and any future SSE-style feed pass
 * through chunk-for-chunk). Redirects are relayed as-is (redirect: "manual")
 * — the relay protocol does not redirect, and a foreign Location would be
 * the pane's own configured origin's business.
 */
export async function proxyApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: WordProxyTarget,
): Promise<void> {
  const path = req.url ?? "/";
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(path, target.upstream);
  } catch {
    sendProxyError(res, 502, `invalid upstream base URL "${target.upstream}"`);
    return;
  }
  const init: {
    method: string | undefined;
    headers: Record<string, string>;
    redirect: "manual";
    body?: unknown;
    duplex?: "half";
  } = {
    method: req.method,
    headers: filterRequestHeaders(req, target),
    redirect: "manual",
  };
  if (BODY_METHODS.has(req.method ?? "")) {
    // Stream the request body too (snapshot PUTs) — no buffering. Long-lived
    // relay responses get no client-side timeout either.
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  let response: Response;
  try {
    response = await fetch(upstreamUrl, init as RequestInit);
  } catch (error) {
    // DNS, refused, TLS, abort — anything that never produced a wire answer.
    sendProxyError(res, 502, `upstream unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
  }
  if (response.body === null) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res, (error) => {
      if (error !== null && error !== undefined && !res.writableEnded) {
        res.destroy();
      }
      // The client going away mid-stream is normal (pane closed); nothing to
      // escalate. Resolve either way — the socket is done.
      resolve();
    });
  });
}

function sendProxyError(res: ServerResponse, status: number, message: string): void {
  const body = `${JSON.stringify({ error: message })}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/**
 * WebSocket upgrade tunnel for `/api/*` (the relay socket lives at
 * `/api/relay/v2/ws/:workspaceId`). The handshake is rewritten hop-by-hop —
 * upstream Host, injected credential, client auth dropped — and afterwards
 * the two TCP sockets are piped byte-for-byte: frames are never parsed or
 * buffered here. A single-use `?ticket=` query rides the URL untouched.
 */
export function proxyApiUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: WordProxyTarget): void {
  let upstream: URL;
  try {
    upstream = new URL(target.upstream);
  } catch {
    socket.destroy();
    return;
  }
  const secure = upstream.protocol === "https:";
  const port = Number(upstream.port || (secure ? 443 : 80));
  const upstreamSocket = secure
    ? tlsConnect({ host: upstream.hostname, port, servername: upstream.hostname })
    : netConnect({ host: upstream.hostname, port });

  let handshaken = false;
  const failEarly = (): void => {
    if (!handshaken) socket.destroy();
  };
  upstreamSocket.once("error", failEarly);
  socket.once("error", () => upstreamSocket.destroy());

  const onReady = (): void => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    const raw = req.rawHeaders;
    let sawWorkspace = false;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i]!.toLowerCase();
      const value = raw[i + 1]!;
      if (DROP_UPGRADE_HEADERS.has(name)) continue;
      if (name === "x-workspace-id") sawWorkspace = true;
      lines.push(`${raw[i]}: ${value}`);
    }
    if (target.workspaceId !== undefined && !sawWorkspace) {
      lines.push(`x-workspace-id: ${target.workspaceId}`);
    }
    lines.push(`host: ${upstream.host}`, `x-api-key: ${target.apiKey}`);
    upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    handshaken = true;
    upstreamSocket.removeListener("error", failEarly);
    upstreamSocket.once("error", () => {
      socket.destroy();
      upstreamSocket.destroy();
    });
    if (head.length > 0) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  };

  if (secure) {
    upstreamSocket.once("secureConnect", onReady);
  } else {
    upstreamSocket.once("connect", onReady);
  }
}
