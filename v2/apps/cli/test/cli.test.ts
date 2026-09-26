import { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    },
    { logger: false },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.NOTEES_STATE_FILE = stateFile;

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
  };
  return harness;
}

let harness: Harness | null = null;
beforeEach(async () => {
  harness = await bootServer();
});
afterEach(async () => {
  if (harness !== null) {
    await harness.app.close();
    rmSync(harness.dataDir, { recursive: true, force: true });
    harness = null;
  }
  delete process.env.NOTEES_STATE_FILE;
});

describe("object lifecycle (json mode)", () => {
  it("create → get → list → search → update → delete", async () => {
    const h = harness!;

    // create (prints the new id; --json wraps it) — content via --stdin
    const stdin = JSON.stringify({
      nodeType: "page",
      name: "CLI page",
      contentAst: [{ type: "text", text: "quixotic CLI expedition notes" }],
    });
    const createCode = await h.runCliWithStdin(stdin, "--json", "object", "create", "--stdin");
    expect(createCode).toBe(EXIT.ok);
    const created = JSON.parse(h.io.stdoutText);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    // get
    expect(await h.runCli("--json", "object", "get", created.id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("CLI page");

    // update
    expect(await h.runCli("--json", "object", "update", created.id, "--name", "CLI page v2")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("CLI page v2");

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
    const h = harness!;
    const stdin = JSON.stringify({ nodeType: "page", name: "Stdin page", contentAst: [{ type: "text", text: "from stdin" }] });
    const code = await h.runCliWithStdin(stdin, "--json", "object", "create", "--stdin");
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(h.io.stdoutText);
    expect(await h.runCli("--json", "object", "get", id)).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).object.name).toBe("Stdin page");
  });

  it("create with --class shows up via class list members", async () => {
    const h = harness!;
    await h.runCli("--json", "class", "list");
    const classes = JSON.parse(h.io.stdoutText).classes as { id: string; name: string }[];
    const taskClass = classes.find((c) => c.name === "task")!;
    expect(taskClass).toBeDefined();

    const code = await h.runCli("--json", "object", "create", "--nodeType", "page", "--name", "Task", "--class", taskClass.id);
    expect(code).toBe(EXIT.ok);
    const { id } = JSON.parse(h.io.stdoutText);
    expect(await h.runCli("--json", "backlinks", id)).toBe(EXIT.ok);
  });
});

describe("exit codes", () => {
  it("bad API key → 3", async () => {
    const h = harness!;
    const io = new Capture();
    const code = await run(["--server", h.baseUrl, "--key", `nk_${"z".repeat(32)}`, "--json", "object", "list"], io);
    expect(code).toBe(EXIT.auth);
  });

  it("unreachable server → 5", async () => {
    const h = harness!;
    await h.app.close();
    const code = await h.runCli("--json", "object", "list");
    expect(code).toBe(EXIT.network);
  });

  it("unknown object → 1 (domain)", async () => {
    const h = harness!;
    const code = await h.runCli("--json", "object", "get", crypto.randomUUID());
    expect(code).toBe(EXIT.domain);
  });

  it("usage errors → 2 (missing server, invalid flag values)", async () => {
    const h = harness!;
    const io = new Capture();
    const missingServer = await run(["--key", API_KEY, "object", "list"], io);
    expect(missingServer).toBe(EXIT.usage);

    const badNodeType = await h.runCli("object", "create", "--nodeType", "galaxy");
    expect(badNodeType).toBe(EXIT.usage);
  });

  it("doctor passes against a healthy server and fails on a bad key", async () => {
    const h = harness!;
    expect(await h.runCli("--json", "doctor")).toBe(EXIT.ok);
    expect(JSON.parse(h.io.stdoutText).ok).toBe(true);

    const io = new Capture();
    const badKey = await run(["--server", h.baseUrl, "--key", `nk_${"y".repeat(32)}`, "doctor"], io);
    expect(badKey).toBe(EXIT.auth);
  });
});

describe("assets, classes, sync", () => {
  it("asset add → get round-trip", async () => {
    const h = harness!;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("cli-upload"),
    ]);
    const file = join(h.dataDir, "upload.png");
    writeFileSync(file, png);

    const addCode = await h.runCli("--json", "asset", "add", file);
    expect(addCode).toBe(EXIT.ok);
    const { assetId } = JSON.parse(h.io.stdoutText);

    const out = join(h.dataDir, "downloaded.png");
    const getCode = await h.runCli("--json", "asset", "get", assetId, "--output", out);
    expect(getCode).toBe(EXIT.ok);
    expect(readFileSync(out).equals(png)).toBe(true);
  });

  it("class list includes seeded classes", async () => {
    const h = harness!;
    expect(await h.runCli("--json", "class", "list")).toBe(EXIT.ok);
    const names = (JSON.parse(h.io.stdoutText).classes as { name: string }[]).map((c) => c.name);
    expect(names).toContain("task");
    expect(names).toContain("source");
  });

  it("sync status reports server stats and the local cursor", async () => {
    const h = harness!;
    await h.runCli("--json", "object", "create", "--nodeType", "page", "--name", "sync probe");
    expect(await h.runCli("--json", "sync", "status")).toBe(EXIT.ok);
    const status = JSON.parse(h.io.stdoutText);
    expect(status.envelopeCount).toBeGreaterThan(0);
    expect(status.localCursorSeq).toBe(0);
    expect(status.behind).toBe(status.envelopeCount);
  });

  it("object create prints a bare id in human mode", async () => {
    const h = harness!;
    expect(await h.runCli("object", "create", "--nodeType", "page", "--name", "human")).toBe(EXIT.ok);
    expect(h.io.stdoutText.trim()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
