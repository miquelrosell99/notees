import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../src/exit-codes.js";
import { EMBEDDED_WORD_ASSETS, EMBEDDED_WORD_MANIFEST_TEMPLATE } from "../src/word/embedded.generated.js";
import { resolveWordStatics } from "../src/word/paths.js";
import { startWordServe, type EmbeddedWordStatics, type WordServeSession } from "../src/word/serve.js";
import { resolveWordDistSource } from "../scripts/word-dist-source.mjs";

/** The real bundle fallback: generated from the in-tree add-in at test time. */
const EMBEDDED: EmbeddedWordStatics = {
  assets: EMBEDDED_WORD_ASSETS,
  manifestTemplate: EMBEDDED_WORD_MANIFEST_TEMPLATE,
};

// The same rule the generator used — the freshness gate compares against
// exactly the source the embed was generated from.
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wordSource = resolveWordDistSource(cliRoot);
if (wordSource === undefined) {
  throw new Error("no Word add-in statics — build clients/word or restore the committed word-snapshot/");
}

const roots: string[] = [];
let cacheCounter = 0;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "notees-word-embedded-"));
  roots.push(root);
  return root;
}

const sessions: WordServeSession[] = [];

async function startEmbedded(): Promise<WordServeSession> {
  const session = await startWordServe({
    cacheDir: join(tempRoot(), `cache-${cacheCounter++}`),
    port: 0,
    embedded: EMBEDDED,
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  while (sessions.length > 0) {
    await sessions.pop()!.close().catch(() => {});
  }
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("embedded statics generation", () => {
  it("mirrors the on-disk add-in dist exactly (a stale embed fails here, not in the field)", () => {
    const distDir = join(wordSource, "dist");
    const index = readFileSync(join(distDir, "index.html"), "utf8");
    expect(EMBEDDED_WORD_ASSETS["/index.html"]).toEqual({ content: index, encoding: "utf8" });
    expect(EMBEDDED_WORD_ASSETS["/lib/office.js"]?.encoding).toBe("utf8");
    const icon = readFileSync(join(distDir, "assets", "icon-32.png"));
    expect(EMBEDDED_WORD_ASSETS["/assets/icon-32.png"]?.content).toBe(icon.toString("base64"));
    expect(EMBEDDED_WORD_ASSETS["/assets/icon-32.png"]?.encoding).toBe("base64");
    expect(EMBEDDED_WORD_MANIFEST_TEMPLATE).toBe(readFileSync(join(wordSource, "manifest.xml"), "utf8"));
    expect(EMBEDDED_WORD_MANIFEST_TEMPLATE).toContain("${HOST}");
  });
});

describe("serve from the embedded map (no on-disk dist)", () => {
  it("serves the pane, office.js, and the icons with the right content types", async () => {
    const session = await startEmbedded();
    const base = `http://127.0.0.1:${session.port}`;

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toBe(readFileSync(join(wordSource, "dist", "index.html"), "utf8"));

    const office = await fetch(`${base}/lib/office.js`);
    expect(office.status).toBe(200);
    expect(office.headers.get("content-type")).toContain("text/javascript");

    const icon = await fetch(`${base}/assets/icon-32.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await icon.arrayBuffer());
    expect(bytes[0]).toBe(0x89); // PNG magic survives the base64 round-trip
    expect(bytes[1]).toBe(0x50);
  });

  it("renders the sideload manifest per port from the embedded template", async () => {
    const session = await startEmbedded();
    const served = await fetch(`http://127.0.0.1:${session.port}/manifest.xml`);
    expect(served.status).toBe(200);
    const body = await served.text();
    expect(body).toContain(`http://localhost:${session.port}/index.html`);
    expect(body).not.toContain("${");
    expect(readFileSync(session.manifestPath, "utf8")).toBe(body);
  });

  it("has no traversal surface: unknown and escaped paths 404", async () => {
    const session = await startEmbedded();
    const base = `http://127.0.0.1:${session.port}`;
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/word-snapshot/manifest.xml`)).status).toBe(404);
  });
});

describe("statics resolution order", () => {
  it("NOTEES_WORD_DIST wins over everything", () => {
    expect(resolveWordStatics({ NOTEES_WORD_DIST: "/somewhere/dist" }, "/nonexistent")).toEqual({
      kind: "dir",
      distDir: "/somewhere/dist",
    });
  });

  it("walks up to a built clients/word/dist before falling back to embedded", () => {
    const root = tempRoot();
    mkdirSync(join(root, "clients", "word", "dist"), { recursive: true });
    const nested = join(root, "deeply", "nested");
    mkdirSync(nested, { recursive: true });
    expect(resolveWordStatics({}, nested)).toEqual({
      kind: "dir",
      distDir: join(root, "clients", "word", "dist"),
    });
    const empty = tempRoot();
    expect(resolveWordStatics({}, empty)).toEqual({ kind: "embedded" });
  });

  it("walks up to the committed word-snapshot/dist before falling back to embedded", () => {
    const root = tempRoot();
    mkdirSync(join(root, "word-snapshot", "dist"), { recursive: true });
    const nested = join(root, "repo", "clients", "cli", "src", "word");
    mkdirSync(nested, { recursive: true });
    expect(resolveWordStatics({}, nested)).toEqual({
      kind: "dir",
      distDir: join(root, "word-snapshot", "dist"),
    });
  });

  it("an empty NOTEES_WORD_DIST is not a directive — falls through", () => {
    const empty = tempRoot();
    expect(resolveWordStatics({ NOTEES_WORD_DIST: "" }, empty)).toEqual({ kind: "embedded" });
  });

  it("an on-disk dist passed explicitly wins over the embedded map", async () => {
    const root = tempRoot();
    const distDir = join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html><body>from-disk</body></html>");
    writeFileSync(
      join(root, "manifest.xml"),
      '<OfficeApp><SourceLocation DefaultValue="${HOST}${BASE_PATH}/index.html"/></OfficeApp>',
    );
    const session = await startWordServe({
      cacheDir: join(root, "cache"),
      port: 0,
      distDir,
      manifestTemplatePath: join(root, "manifest.xml"),
      embedded: EMBEDDED,
    });
    sessions.push(session);
    const index = await fetch(`http://127.0.0.1:${session.port}/`);
    expect(await index.text()).toContain("from-disk");
  });

  it("neither a disk dist nor an embedded map is a usage error", async () => {
    try {
      await startWordServe({ cacheDir: join(tempRoot(), "cache"), port: 0 });
      expect.unreachable("expected the start to fail");
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(EXIT.usage);
    }
  });
});
