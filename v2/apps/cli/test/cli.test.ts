import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// One real server per file (was: per test — repeated boots accumulated
// handles in the worker and beforeEach intermittently blew the 10 s hook
// timeout under load; registered flake in SCHEMA.md's deviation register).
// Generous timeouts kept as a bounded safety margin.
vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

import { buildServer } from "@notees/server";

import { run, type CliIo } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";

const API_KEY = `nk_${"c".repeat(32)}`;
type App = Awaited<ReturnType<typeof buildServer>>["app"];

class Capture implements CliIo {
  stdoutText = "";
  stderrText = "";
  isTty = false;
  stdin?: NodeJS.ReadableStream | undefined;
  stdout = {
    write: (chunk: string) => {
      this.stdoutText += chunk;
    },
  };
  stderr = {
    write: (chunk: string) => {
      this.stderrText += chunk;
    },
  };
}

interface Harness {
  app: App;
  dataDir: string;
  baseUrl: string;
  stateFile: string;
  io: Capture;
  runCli(...args: string[]): Promise<number>;
  runCliWithStdin(stdin: string, ...args: string[]): Promise<number>;
  createPage(name: string, contentAst: unknown[]): Promise<string>;
}

async function bootServer(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-cli-test-"));
  const stateFile = join(dataDir, "cli-state.json");
  const { app } = await buildServer(
    {
      dataDir,
      apiKey: API_KEY,
      port: 0,
      host: "127.0.0.1",
      logger: false,
      relayBatchPerMinute: 30_000,
      globalRequestsPerMinute: 10_000,
      maxMediaBytes: 50 * 1024 * 1024,
      maxDocumentBytes: 100 * 1024 * 1024,
      corsOrigins: [],
    },
    { logger: false },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const io = new Capture();
  const harness: Harness = {
    app,
    dataDir,
    baseUrl,
    stateFile,
    io,
    async runCli(...args: string[]) {
      io.stdoutText = "";
      io.stderrText = "";
      return run(["--server", baseUrl, "--key", API_KEY, ...args], io);
    },
    async runCliWithStdin(stdin: string, ...args: string[]) {
      io.stdoutText = "";
      io.stderrText = "";
      io.stdin = Readable.from([stdin]);
      const code = await run(["--server", baseUrl, "--key", API_KEY, ...args], io);
      io.stdin = undefined;
      return code;
    },
    async createPage(name: string, contentAst: unknown[]) {
      const code = await this.runCliWithStdin(
        JSON.stringify({ nodeType: "page", name, contentAst }),
        "--json", "object", "create", "--stdin",
      );
      if (code !== EXIT.ok) throw new Error(`createPage ${name} failed: ${io.stderrText}`);
      return (JSON.parse(io.stdoutText) as { id: string }).id;
    },
  };
  return harness;
}

let harness: Harness;
beforeAll(async () => {
  harness = await bootServer();
  process.env.NOTEES_STATE_FILE = harness.stateFile;
});
afterAll(async () => {
  await harness.app.close();
  rmSync(harness.dataDir, { recursive: true, force: true });
  delete process.env.NOTEES_STATE_FILE;
});

describe("object lifecycle (json mode)", () => {
  it("create → get → list → search → update → delete", async () => {
    const h = harness;

    // create (prints the new id; --json wraps it) — content via --stdin
    const stdin = JSON.stringify({
      nodeType: "page",
      name: "t1-cli-page",
      contentAst: [{ type: "text", text: "quixotic CLI expedition notes" }],
    });
    const createCode = await h.runCliWithStdin(stdin, "--json", "object", "create", "--stdin");
    expect(createCode).toBe(EXIT.ok);
    const created = JSON.parse(h.io.stdoutText);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    // get
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("t1-cli-page");

    // update
    expect(await h.runCli("--json", "object", "update", created.id, "--name", "t1-cli-page-v2")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("t1-cli-page-v2");

    // list
    expect(await h.runCli("--json", "object", "list", "--nodeType", "page")).toBe(EXIT.ok);
    const list = JSON.parse(h.io.stdoutText);
    expect(list.objects.map((o: { id: string }) => o.id)).toContain(created.id);
    expect(list.nextCursor).toBeDefined();

    // search
    expect(await h.runCli("--json", "search", "quixotic")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).results.map((r: { id: string }) => r.id)).toContain(created.id);

    // delete without --yes: exit 2, nothing deleted
    const refused = await h.runCli("--json", "object", "delete", created.id);
    expect(refused).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("--yes");
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.isActive).toBe(true);

    // delete with --yes (soft)
    expect(await h.runCli("--json", "object", "delete", created.id, "--yes")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText)).toMatchObject({ id: created.id, deleted: true, permanent: false });

    // permanent delete
    expect(await h.runCli("--json", "object", "delete", created.id, "--permanent", "--yes")).toBe(EXIT.ok);
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.domain);
    expect(h.io.stderrText).toContain("does not exist");
  });

  it("create reads the body from --stdin", async () => {
    const h = harness;
    const stdin = JSON.stringify({ nodeType: "page", name: "t2-stdin-page", contentAst: [{ type: "text", text: "from stdin" }] });
    const code = await h.runCliWithStdin(stdin, "--json", "object", "create", "--stdin");
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(h.io.stdoutText);
    expect(await h.runCli("--json", "object", "get", id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("t2-stdin-page");
  });

  it("create with --class shows up via class list members", async () => {
    const h = harness;
    await h.runCli("--json", "class", "list");
    const classes = JSON.parse(h.io.stdoutText).classes as { id: string; name: string }[];
    const taskClass = classes.find((c) => c.name === "task")!;
    expect(taskClass).toBeDefined();

    const code = await h.runCli("--json", "object", "create", "--nodeType", "page", "--name", "t3-task-page", "--class", taskClass.id);
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(h.io.stdoutText);
    expect(await h.runCli("--json", "backlinks", id)).toBe(EXIT.ok);
  });
});

describe("exit codes", () => {
  it("bad API key → 3", async () => {
    const h = harness;
    const io = new Capture();
    const code = await run(["--server", h.baseUrl, "--key", `nk_${"z".repeat(32)}`, "--json", "object", "list"], io);
    expect(code).toBe(EXIT.auth);
  });

  it("unreachable server → 5", async () => {
    // A port that was just released: guaranteed nothing is listening there,
    // and the shared file-level server stays up for the remaining tests.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error !== null && error !== undefined ? reject(error) : resolve())),
    );
    const io = new Capture();
    const code = await run(
      ["--server", `http://127.0.0.1:${deadPort}`, "--key", API_KEY, "--json", "object", "list"],
      io,
    );
    expect(code).toBe(EXIT.network);
  });

  it("unknown object → 1 (domain)", async () => {
    const h = harness;
    const code = await h.runCli("--json", "object", "get", crypto.randomUUID());
    expect(code).toBe(EXIT.domain);
  });

  it("usage errors → 2 (missing server, invalid flag values)", async () => {
    const h = harness;
    const io = new Capture();
    const missingServer = await run(["--key", API_KEY, "object", "list"], io);
    expect(missingServer).toBe(EXIT.usage);

    const badNodeType = await h.runCli("object", "create", "--nodeType", "galaxy");
    expect(badNodeType).toBe(EXIT.usage);
  });

  it("doctor passes against a healthy server and fails on a bad key", async () => {
    const h = harness;
    expect(await h.runCli("--json", "doctor")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).ok).toBe(true);

    const io = new Capture();
    const badKey = await run(["--server", h.baseUrl, "--key", `nk_${"y".repeat(32)}`, "doctor"], io);
    expect(badKey).toBe(EXIT.auth);
  });
});

describe("assets, classes, sync", () => {
  it("asset add → get round-trip", async () => {
    const h = harness;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("cli-upload"),
    ]);
    const file = join(h.dataDir, "t4-upload.png");
    writeFileSync(file, png);

    const addCode = await h.runCli("--json", "asset", "add", file);
    expect(addCode).toBe(EXIT.ok);
    const { assetId } = JSON.parse(h.io.stdoutText);

    const out = join(h.dataDir, "t4-downloaded.png");
    const getCode = await h.runCli("--json", "asset", "get", assetId, "--output", out);
    expect(getCode).toBe(EXIT.ok);
    expect(readFileSync(out).equals(png)).toBe(true);
  });

  it("class list includes seeded classes", async () => {
    const h = harness;
    expect(await h.runCli("--json", "class", "list")).toBe(EXIT.ok);
    const names = (JSON.parse(h.io.stdoutText).classes as { name: string }[]).map((c) => c.name);
    expect(names).toContain("task");
    expect(names).toContain("source");
  });

  it("sync status reports server stats and the local cursor", async () => {
    const h = harness;
    await h.runCli("--json", "object", "create", "--nodeType", "page", "--name", "t5-sync-probe");
    expect(await h.runCli("--json", "sync", "status")).toBe(EXIT.ok);
    const status = JSON.parse(h.io.stdoutText);
    // One server + one state file for the whole file: envelopeCount includes
    // seeding and every other test's writes (hence only > 0), and no command
    // in the file ever advances the persisted cursor, so it stays 0 and
    // `behind` must equal the full envelope count.
    expect(status.envelopeCount).toBeGreaterThan(0);
    expect(status.localCursorSeq).toBe(0);
    expect(status.behind).toBe(status.envelopeCount);
  });

  it("object create prints a bare id in human mode", async () => {
    const h = harness;
    expect(await h.runCli("object", "create", "--nodeType", "page", "--name", "t6-human")).toBe(EXIT.ok);
    expect(h.io.stdoutText.trim()).toMatch(/^[0-9a-f-]{36}$/);
  });
});


describe("export markdown", () => {
  it("--linked-to prints the referrer's markdown with [[name]] mentions (stdout)", async () => {
    const h = harness;
    const target = await h.createPage("expm-target-x", [{ type: "text", text: "seed body" }]);
    await h.createPage("expm-referrer-r", [
      { type: "mention", targetNodeId: target, text: "expm-target-x" },
      { type: "text", text: " points here" },
    ]);

    const code = await h.runCli("export", "markdown", "--linked-to", target, "--stdout");
    expect(code).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-referrer-r");
    expect(h.io.stdoutText).toContain("[[expm-target-x]]");
    // The seed is part of the bundle (hub of the closure).
    expect(h.io.stdoutText).toContain("# expm-target-x");
  });

  it("--output-dir writes <uuid>.md files + notees-manifest.json; --json reports the set", async () => {
    const h = harness;
    const a = await h.createPage("expm-file-a", [{ type: "text", text: "file a body" }]);
    const b = await h.createPage("expm-file-b", []);
    const dir = join(h.dataDir, "expm-out-dir");

    const code = await h.runCli("--json", "export", "markdown", "--ids", a, b, "--output-dir", dir);
    expect(code).toBe(EXIT.ok);
    const machine = JSON.parse(h.io.stdoutText) as { files: number; nodes: { id: string; name: string }[] };
    expect(machine.files).toBe(2);
    expect(machine.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());

    const fileA = readFileSync(join(dir, `${a}.md`), "utf8");
    expect(fileA).toContain("name: expm-file-a");
    expect(fileA).toContain("# expm-file-a");
    expect(fileA).toContain("file a body");
    expect(existsSync(join(dir, `${b}.md`))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, "notees-manifest.json"), "utf8")) as {
      format: string;
      version: number;
      nodes: { id: string; name: string; nodeType: string }[];
    };
    expect(manifest.format).toBe("notees-markdown");
    expect(manifest.version).toBe(1);
    expect(manifest.nodes).toHaveLength(2);
    expect(manifest.nodes.find((n) => n.id === a)).toMatchObject({ name: "expm-file-a", nodeType: "page" });
  });

  it("--depth 0 limits the closure to the seed's direct referrers", async () => {
    const h = harness;
    const target = await h.createPage("expm-depth-target", []);
    const direct = await h.createPage("expm-depth-direct", [
      { type: "mention", targetNodeId: target, text: "expm-depth-target" },
    ]);
    const transitive = await h.createPage("expm-depth-transitive", [
      { type: "mention", targetNodeId: direct, text: "expm-depth-direct" },
    ]);
    expect(transitive).toBeDefined();

    expect(await h.runCli("export", "markdown", "--linked-to", target, "--depth", "0", "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-depth-direct");
    expect(h.io.stdoutText).not.toContain("# expm-depth-transitive");

    // Default depth (3) reaches the transitive referrer.
    expect(await h.runCli("export", "markdown", "--linked-to", target, "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-depth-transitive");
  });

  it("children render as nested bullets under their page", async () => {
    const h = harness;
    const pageId = await h.createPage("expm-parent", [{ type: "text", text: "parent body" }]);
    await h.runCliWithStdin(
      JSON.stringify({
        nodeType: "block",
        parentId: pageId,
        contentAst: [{ type: "text", text: "child bullet body" }],
      }),
      "--json", "object", "create", "--stdin",
    );

    expect(await h.runCli("export", "markdown", "--ids", pageId, "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("parent body");
    expect(h.io.stdoutText).toContain("- child bullet body");
  });

  it("--fixpoint expands until no new pages are found", async () => {
    const h = harness;
    // NB: a true mention cycle cannot be authored through the M1 CLI (object
    // update carries no content flag and ids are server-generated), so the
    // fixpoint path is exercised with a referrer chain instead.
    const a = await h.createPage("expm-fp-a", []);
    const b = await h.createPage("expm-fp-b", [
      { type: "mention", targetNodeId: a, text: "expm-fp-a" },
    ]);
    const c = await h.createPage("expm-fp-c", [
      { type: "mention", targetNodeId: b, text: "expm-fp-b" },
    ]);
    expect(c).toBeDefined();

    expect(await h.runCli("export", "markdown", "--linked-to", a, "--fixpoint", "--stdout")).toBe(EXIT.ok);
    expect(h.io.stdoutText).toContain("# expm-fp-a");
    expect(h.io.stdoutText).toContain("# expm-fp-b");
    expect(h.io.stdoutText).toContain("# expm-fp-c");
  });

  it("usage errors exit 2 (missing selector, missing output)", async () => {
    const h = harness;
    expect(await h.runCli("export", "markdown", "--stdout")).toBe(EXIT.usage);
    expect(await h.runCli("export", "markdown", "--ids", crypto.randomUUID())).toBe(EXIT.usage);
    expect(h.io.stderrText).toContain("--output-dir");
  });
});
