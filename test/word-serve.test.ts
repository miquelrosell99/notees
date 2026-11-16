import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../src/exit-codes.js";
import { startWordServe, type WordServeSession } from "../src/word/serve.js";

const root = mkdtempSync(join(tmpdir(), "notees-word-serve-"));
const snapshotDir = join(root, "snapshot");
const distDir = join(snapshotDir, "dist");
const templatePath = join(snapshotDir, "manifest.xml");

mkdirSync(snapshotDir, { recursive: true });
writeFileSync(
  templatePath,
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OfficeApp>',
    '  <IconUrl DefaultValue="${HOST}${BASE_PATH}/assets/icon-32.png"/>',
    '  <SourceLocation DefaultValue="${HOST}${BASE_PATH}/index.html"/>',
    "</OfficeApp>",
  ].join("\n"),
);
mkdirSync(join(distDir, "assets"), { recursive: true });
mkdirSync(join(distDir, "lib"), { recursive: true });
writeFileSync(join(distDir, "index.html"), "<html><body>notees pane</body></html>");
writeFileSync(join(distDir, "assets", "icon-32.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(distDir, "lib", "office.js"), "// vendored office.js");

const sessions: WordServeSession[] = [];
let cacheCounter = 0;

/** Every test gets its own cache dir — the lock is per cache dir. */
function freshCacheDir(): string {
  return join(root, `cache-${cacheCounter++}`);
}

async function start(options: { port?: number; restart?: boolean; cacheDir?: string } = {}): Promise<WordServeSession> {
  const session = await startWordServe({
    distDir,
    cacheDir: options.cacheDir ?? freshCacheDir(),
    port: options.port ?? 0,
    restart: options.restart ?? false,
    manifestTemplatePath: templatePath,
  });
  sessions.push(session);
  return session;
}

async function get(path: string, session: WordServeSession): Promise<Response> {
  return fetch(`http://127.0.0.1:${session.port}${path}`);
}

afterEach(async () => {
  // Each test closes what it started except where the test body closes early;
  // close() is idempotent enough for a double close of a drained server.
  while (sessions.length > 0) {
    await sessions.pop()!.close().catch(() => {});
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startWordServe", () => {
  it("serves the dist at the root with the word repo content types", async () => {
    const session = await start();
    const index = await get("/", session);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("notees pane");

    const icon = await get("/assets/icon-32.png", session);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");

    const office = await get("/lib/office.js", session);
    expect(office.status).toBe(200);
    expect(office.headers.get("content-type")).toContain("text/javascript");

    expect((await get("/missing.js", session)).status).toBe(404);
    expect((await get("/assets", session)).status).toBe(404); // no directory index
  });

  it("path traversal stays inside the dist (encoded dot segments 404)", async () => {
    const session = await start();
    const escaped = await get("/%2e%2e/%2e%2e/snapshot/manifest.xml", session);
    expect(escaped.status).toBe(404);
  });

  it("non-GET/HEAD methods get 405", async () => {
    const session = await start();
    const post = await fetch(`http://127.0.0.1:${session.port}/index.html`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("serves the rendered manifest at /manifest.xml and writes it to the cache dir", async () => {
    const cacheDir = freshCacheDir();
    const session = await start({ cacheDir });
    const url = `http://localhost:${session.port}`;
    expect(session.url).toBe(url);
    expect(session.manifestPath).toBe(join(cacheDir, "manifest.xml"));
    expect(session.address).toBe("127.0.0.1");

    const served = await get("/manifest.xml", session);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/xml");
    const body = await served.text();
    expect(body).toContain(`${url}/index.html`);
    expect(body).not.toContain("${");

    const written = readFileSync(session.manifestPath, "utf8");
    expect(written).toBe(body);
  });

  it("a second serve on the same cache dir conflicts with a --restart hint (exit 4)", async () => {
    const cacheDir = freshCacheDir();
    const first = await start({ cacheDir });
    try {
      await start({ cacheDir });
      expect.unreachable("expected the second serve to conflict");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.conflict);
      expect((error as Error).message).toContain("--restart");
      expect((error as Error).message).toContain(String(process.pid));
    }
    // The conflict must not have disturbed the running session's lock.
    const lock = readFileSync(join(cacheDir, "word-serve.lock"), "utf8");
    expect(lock.trim()).toBe(String(process.pid));
    await first.close();
  });

  it("a stale lock from a dead pid is stolen", async () => {
    const cacheDir = freshCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "word-serve.lock"), "999999\n");
    const session = await start({ cacheDir });
    expect((await get("/", session)).status).toBe(200);
  });

  it("--restart stops a live holder from another process and takes its place", async () => {
    const cacheDir = freshCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    // Attach before the serve: the SIGTERM happens inside startWordServe's
    // grace wait, so the exit may precede our await.
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    await new Promise((resolveReady) => child.once("spawn", resolveReady));
    writeFileSync(join(cacheDir, "word-serve.lock"), `${child.pid}\n`);

    const session = await start({ cacheDir, restart: true });
    expect((await get("/", session)).status).toBe(200);
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("a busy port maps to exit 4, not a stack trace", async () => {
    const first = await start();
    try {
      await start({ port: first.port, cacheDir: freshCacheDir() });
      expect.unreachable("expected the bind to conflict");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.conflict);
      expect((error as Error).message).toContain("already in use");
    }
  });
});
