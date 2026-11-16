import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

import { CliError, EXIT } from "../exit-codes.js";
import { renderWordManifest } from "./manifest.js";
import { isProxyPath, proxyApiRequest, proxyApiUpgrade, type WordProxyTarget } from "./proxy.js";

const LOCK_FILE_NAME = "word-serve.lock";
const MANIFEST_FILE_NAME = "manifest.xml";
const RESTART_GRACE_MS = 3_000;

// The word repo's server contract: explicit content types for the dist's
// file kinds, application/octet-stream for anything else.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** One embedded add-in asset: utf8 text, or base64 for binary kinds. */
export interface EmbeddedWordAsset {
  readonly content: string;
  readonly encoding: "utf8" | "base64";
}

/**
 * The add-in statics embedded in the release bundle — generated from
 * vendor/word by scripts/gen-word-embedded.mjs (`embedded.generated.ts`).
 * The manifest template carries the raw `${HOST}`/`${BASE_PATH}`
 * placeholders, rendered per port exactly like the on-disk template.
 */
export interface EmbeddedWordStatics {
  readonly assets: Record<string, EmbeddedWordAsset>;
  readonly manifestTemplate: string;
}

export interface WordServeOptions {
  /**
   * Directory of built add-in statics (the vendored `vendor/word/dist`).
   * Optional now that the bundle carries the embedded fallback: when set it
   * wins (NOTEES_WORD_DIST / the dev walk-up); when unset the embedded map
   * serves. At least one of distDir/embedded is required.
   */
  readonly distDir?: string;
  /** Per-user cache dir: the rendered manifest and the serve lock live here. */
  readonly cacheDir: string;
  /** Port to bind; 0 = OS-assigned (tests). */
  readonly port: number;
  /** Stop a running `notees word serve` on this cache dir and take its place. */
  readonly restart?: boolean;
  /** The raw manifest template (defaults to manifest.xml next to the dist). */
  readonly manifestTemplatePath?: string;
  /** Embedded statics fallback for bundle installs with no on-disk dist. */
  readonly embedded?: EmbeddedWordStatics;
  /**
   * Fixed upstream for the same-origin `/api/*` gateway. When set, `/api/*`
   * requests (any method, plus WebSocket upgrades) relay here with the
   * credential injected server-side; when unset, `/api/*` 404s like any
   * missing static.
   */
  readonly proxy?: WordProxyTarget;
}

export interface WordServeSession {
  /** The ACTUAL bound port (options.port may be 0 = OS-assigned). */
  readonly port: number;
  /** The ACTUAL bound address — the loopback proof (127.0.0.1). */
  readonly address: string;
  /** The origin Word loads the pane from: http://localhost:<port>. */
  readonly url: string;
  /** Where the rendered sideload manifest was written. */
  readonly manifestPath: string;
  /** Stops accepting, lets in-flight requests finish, frees the lock. */
  close(): Promise<void>;
}

/**
 * One live `notees word serve` per cache dir. The lock records the holder
 * pid; a stale lock (holder dead) is stolen, and `--restart` SIGTERMs a live
 * holder and waits it out. A lock held by THIS process is only stealable via
 * restart (it cannot meaningfully SIGTERM itself) — real usage is one serve
 * per process; an in-process double start is a test artifact.
 *
 * The grace wait is ASYNCHRONOUS on purpose: a synchronous spin would starve
 * the event loop, and a terminated child of THIS process would linger
 * unreaped (kill(pid, 0) succeeds on the zombie) for the whole grace window.
 */
async function acquireWordServeLock(lockPath: string, restart: boolean): Promise<void> {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  const alive = Number.isInteger(holder) && holder > 1 && isProcessAlive(holder);
  if (alive && !restart) {
    throw new CliError(
      EXIT.conflict,
      `notees word serve is already running (pid ${holder}) — pass --restart to stop it and start anew`,
    );
  }
  if (alive && holder !== process.pid) {
    try {
      process.kill(holder, "SIGTERM");
    } catch {
      // Raced exit between the liveness check and the signal — the lock is
      // stale now and falls through to the steal below.
    }
    const deadline = Date.now() + RESTART_GRACE_MS;
    while (isProcessAlive(holder) && Date.now() < deadline) {
      // 50 ms sleeps keep the event loop turning so a terminated child of
      // this process is reaped (its zombie answers kill(pid, 0) as alive);
      // a foreign holder's death shows up in kill(pid, 0) immediately.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
    if (isProcessAlive(holder)) {
      throw new CliError(
        EXIT.conflict,
        `the running notees word serve (pid ${holder}) did not stop within ${RESTART_GRACE_MS / 1000}s — stop it by hand and try again`,
      );
    }
  }
  rmSync(lockPath, { force: true });
  await acquireWordServeLock(lockPath, false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the local add-in server. The loopback bind is non-negotiable: the
 * post-listen address check fails the start (rather than serving) if the
 * platform ever resolved anything else, and a port already bound maps to
 * exit 4 (conflict), never a stack trace.
 */
export async function startWordServe(options: WordServeOptions): Promise<WordServeSession> {
  // Statics source: an on-disk dist wins (NOTEES_WORD_DIST, the dev
  // walk-up); otherwise the bundle's embedded map. The embedded path has no
  // filesystem traversal to guard — only exact map keys are served.
  const useDisk = options.distDir !== undefined;
  if (!useDisk && options.embedded === undefined) {
    throw new CliError(
      EXIT.usage,
      "no Word add-in statics available: neither an on-disk dist (NOTEES_WORD_DIST / vendor/word) nor the embedded bundle copy",
    );
  }
  const distRoot = useDisk ? resolve(options.distDir!) : null;
  const templatePath = useDisk
    ? (options.manifestTemplatePath ?? join(dirname(distRoot!), MANIFEST_FILE_NAME))
    : null;
  const lockPath = join(options.cacheDir, LOCK_FILE_NAME);
  const manifestPath = join(options.cacheDir, MANIFEST_FILE_NAME);

  mkdirSync(options.cacheDir, { recursive: true });
  await acquireWordServeLock(lockPath, options.restart === true);

  const statics: StaticsSource = useDisk
    ? { kind: "dir", distRoot: distRoot! }
    : { kind: "embedded", assets: options.embedded!.assets };
  const server: Server = createServer((req, res) => {
    respond(req, res, statics, manifestPath, options.proxy).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("internal error");
    });
  });
  if (options.proxy !== undefined) {
    const proxy = options.proxy;
    // WebSocket upgrades cannot ride the request handler: take the socket
    // and tunnel it to the fixed upstream (relay socket included, it lives
    // under /api/relay/v2/ws/). Anything not /api/* gets no upgrade here.
    server.on("upgrade", (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (!isProxyPath(pathname)) {
        socket.destroy();
        return;
      }
      proxyApiUpgrade(req, socket, head, proxy);
    });
  }
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port, "127.0.0.1", resolveListen);
    });
  } catch (error) {
    rmSync(lockPath, { force: true });
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new CliError(
        EXIT.conflict,
        `port ${options.port} is already in use on 127.0.0.1 — pass --port <n> or stop whatever holds it`,
      );
    }
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    rmSync(lockPath, { force: true });
    throw new CliError(EXIT.domain, "refusing to serve: bound address is not 127.0.0.1");
  }

  // The manifest renders against the ACTUAL port (0 = OS-assigned), both
  // into the cache dir (Word's shared-folder catalog reads that file) and
  // into memory (served at /manifest.xml).
  const template = useDisk ? readTemplateFromDisk(templatePath!) : options.embedded!.manifestTemplate;
  const manifest = renderWordManifest(template, address.port);
  writeFileSync(manifestPath, manifest);

  return {
    port: address.port,
    address: address.address,
    url: `http://localhost:${address.port}`,
    manifestPath,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        // fetch/undici keeps idle keep-alive sockets open; close() waits on
        // them forever without this. In-flight requests are untouched —
        // close() only resolves after they drain.
        server.closeIdleConnections();
        rmSync(lockPath, { force: true });
      }),
  };
}

type StaticsSource =
  | { kind: "dir"; distRoot: string }
  | { kind: "embedded"; assets: Record<string, EmbeddedWordAsset> };

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  statics: StaticsSource,
  manifestPath: string,
  proxy: WordProxyTarget | undefined,
): Promise<void> {
  // The gateway branch rides the RAW path (undecoded) — /api/ URLs are the
  // upstream's business, and any method (incl. POST/PUT bodies and future
  // long-lived feeds) relays. This precedes the static GET/HEAD gate on
  // purpose.
  if (proxy !== undefined) {
    let rawPathname: string;
    try {
      rawPathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("malformed path");
      return;
    }
    if (isProxyPath(rawPathname)) {
      await proxyApiRequest(req, res, proxy);
      return;
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("malformed path");
    return;
  }

  // The rendered sideload manifest tracks the actual port, so it is served
  // from the cache-dir render, not the vendored dist copy.
  if (pathname === `/${MANIFEST_FILE_NAME}`) {
    sendBytes(res, req.method, readFileSync(manifestPath), "application/xml; charset=utf-8");
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  if (statics.kind === "embedded") {
    // Map lookup only — no path arithmetic, no traversal surface.
    const asset = statics.assets[normalize(pathname).split("\\").join("/")];
    if (asset === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const type = CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
    const body = Buffer.from(asset.content, asset.encoding);
    sendBytes(res, req.method, body, type);
    return;
  }

  // Containment: the normalized path must stay under distRoot. Escape
  // attempts (.. segments, encoded or not) and non-file hits 404 — this
  // server has no directory index and no symlinks-out.
  const distRoot = statics.distRoot;
  const candidate = normalize(join(distRoot, pathname));
  if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const type = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "no-cache" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((resolvePipe, rejectPipe) => {
    createReadStream(candidate)
      .on("end", resolvePipe)
      .on("error", rejectPipe)
      .pipe(res);
  });
}

/** Disk template read, with the vendored-snapshot diagnostic. */
function readTemplateFromDisk(templatePath: string): string {
  if (!existsSync(templatePath)) {
    throw new CliError(
      EXIT.domain,
      `Word manifest template not found at ${templatePath} — the vendored snapshot is incomplete; re-run scripts/sync-word-dist.mjs`,
    );
  }
  return readFileSync(templatePath, "utf8");
}

function sendBytes(res: ServerResponse, method: string, body: Buffer, contentType: string): void {
  res.writeHead(200, { "content-type": contentType, "content-length": body.length, "cache-control": "no-cache" });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}
