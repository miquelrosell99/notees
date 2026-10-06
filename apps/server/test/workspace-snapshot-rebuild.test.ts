/**
 * Server-side snapshot self-heal: a workspace whose log has no
 * snapshot (post-restore wipe, fresh relay) gets one from the server's own
 * derived store at hydration time, so the next fresh client restores instead
 * of replaying the whole log. Snapshots stay an optimization — the log is
 * untouched and remains the only authority.
 *
 * Hydration runs once per handle creation (i.e. per boot, lazily on first
 * touch), so the tests boot a server, write a log, close, and boot again.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Clock } from "@notees/protocol";
import { Store } from "@notees/store";
import { HttpTransport, SyncEngine } from "@notees/sync";

import { buildServer } from "../src/index.js";
import { SNAPSHOT_REBUILD_MIN_ENVELOPES } from "../src/workspace-store.js";
import {
  ingest,
  makeConfig,
  pagePayload,
  testEnvelope,
  TEST_API_KEY,
  TEST_WORKSPACE,
  type TestServer,
} from "./helpers";

let dataDir = "";
let servers: TestServer[] = [];

afterEach(async () => {
  for (const server of servers) await server.app.close();
  servers = [];
  if (dataDir !== "") {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = "";
  }
});

/** Boot a server on a shared data dir (multi-boot tests manage it manually). */
async function boot(): Promise<TestServer> {
  const built = await buildServer(makeConfig(dataDir), { logger: false });
  const server: TestServer = {
    ...built,
    dataDir,
    apiKey: TEST_API_KEY,
    workspaceId: TEST_WORKSPACE,
    authHeaders: { "x-api-key": TEST_API_KEY },
  };
  servers.push(server);
  return server;
}

function freshDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), "notees-server-snapshot-rebuild-"));
  return dataDir;
}

/** One batch of `count` object.create envelopes (WIRE cap: 1000 per batch). */
async function seedObjects(server: TestServer, count: number, label: string): Promise<void> {
  for (let offset = 0; offset < count; offset += 1000) {
    const envelopes = [];
    for (let i = 0; i < Math.min(1000, count - offset); i += 1) {
      envelopes.push(
        testEnvelope({ opType: "object.create", payload: pagePayload(`${label}-${offset + i}`) }),
      );
    }
    const res = await ingest(server, envelopes);
    expect(res.statusCode).toBe(200);
  }
}

async function snapshotMeta(server: TestServer) {
  const res = await server.app.inject({
    method: "GET",
    url: `/api/relay/v2/snapshot?workspaceId=${TEST_WORKSPACE}`,
    headers: server.authHeaders,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    snapshotId: string;
    hlc: { physical: number; logical: number };
    hasSnapshot: boolean;
    upToSeq: number | null;
  };
}

describe("snapshot self-heal after replay", () => {
  it("creates a snapshot from the replayed store when the log has none", async () => {
    freshDataDir();
    const first = await boot();
    await seedObjects(first, SNAPSHOT_REBUILD_MIN_ENVELOPES + 50, "seed");
    expect((await snapshotMeta(first)).hasSnapshot).toBe(false);

    // Reboot (the wipe-recovery shape: derived replay happens at hydration).
    await first.app.close();
    servers = servers.filter((s) => s !== first);
    const second = await boot();
    // Touch the workspace so hydration runs; one more envelope lands after it.
    await seedObjects(second, 1, "post-boot");

    const meta = await snapshotMeta(second);
    expect(meta.hasSnapshot).toBe(true);
    expect(meta.upToSeq).toBe(SNAPSHOT_REBUILD_MIN_ENVELOPES + 50);

    // The blob round-trips into a fresh store with the state the replay
    // converged to (the snapshot predates the post-boot envelope).
    const row = second.ctx.relay.latestSnapshot(TEST_WORKSPACE);
    expect(row).not.toBeNull();
    const bytes = second.ctx.relay.readSnapshotData(row!.id);
    expect(bytes).not.toBeNull();
    const restored = new Store();
    restored.restore(new Uint8Array(bytes!));
    const nodes = (restored.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number })
      .n;
    expect(nodes).toBe(SNAPSHOT_REBUILD_MIN_ENVELOPES + 50);
    restored.close();
  });

  it("does not thrash: a second hydration keeps the same single snapshot", async () => {
    freshDataDir();
    const first = await boot();
    await seedObjects(first, SNAPSHOT_REBUILD_MIN_ENVELOPES + 50, "seed");
    await first.app.close();
    servers = servers.filter((s) => s !== first);
    const second = await boot();
    await seedObjects(second, 1, "post-boot");
    const created = (await snapshotMeta(second)).snapshotId;

    await second.app.close();
    servers = servers.filter((s) => s !== second);
    const third = await boot();
    await seedObjects(third, 1, "post-boot-2");

    expect(await snapshotMeta(third)).toMatchObject({
      hasSnapshot: true,
      snapshotId: created,
    });
    expect(third.ctx.relay.snapshotCount(TEST_WORKSPACE)).toBe(1);
  });

  it("leaves small logs snapshot-less (below the rebuild threshold)", async () => {
    freshDataDir();
    const first = await boot();
    await seedObjects(first, 10, "small");
    await first.app.close();
    servers = servers.filter((s) => s !== first);
    const second = await boot();
    await seedObjects(second, 1, "post-boot");

    expect(await snapshotMeta(second)).toMatchObject({ hasSnapshot: false, upToSeq: null });
    expect(second.ctx.relay.snapshotCount(TEST_WORKSPACE)).toBe(0);
  });

  it("leaves an existing snapshot untouched", async () => {
    freshDataDir();
    const first = await boot();
    await seedObjects(first, SNAPSHOT_REBUILD_MIN_ENVELOPES + 50, "seed");
    const put = await first.app.inject({
      method: "PUT",
      url: `/api/relay/v2/snapshot/data?workspaceId=${TEST_WORKSPACE}&physical=100&logical=2`,
      headers: { "content-type": "application/octet-stream", ...first.authHeaders },
      payload: Buffer.from("client-uploaded-bytes"),
    });
    expect(put.statusCode).toBe(201);
    const uploadedId = (put.json() as { snapshotId: string }).snapshotId;

    await first.app.close();
    servers = servers.filter((s) => s !== first);
    const second = await boot();
    await seedObjects(second, 1, "post-boot");

    expect(await snapshotMeta(second)).toMatchObject({
      hasSnapshot: true,
      snapshotId: uploadedId,
    });
    expect(second.ctx.relay.snapshotCount(TEST_WORKSPACE)).toBe(1);
  });

  it("serves the rebuilt snapshot to a fresh SyncEngine client end-to-end", async () => {
    freshDataDir();
    const first = await boot();
    await seedObjects(first, SNAPSHOT_REBUILD_MIN_ENVELOPES + 50, "seed");
    await first.app.close();
    servers = servers.filter((s) => s !== first);

    const second = await boot();
    await second.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = second.app.server.address() as import("node:net").AddressInfo;
    // Hydration + snapshot creation happen on this touch.
    await seedObjects(second, 1, "post-boot");
    const meta = await snapshotMeta(second);
    expect(meta.hasSnapshot).toBe(true);

    // A fresh client (empty store, cursor 0) syncs over real HTTP: it must
    // restore the server-produced bytes and catch up from the snapshot's
    // seq — the exact flow a new browser profile takes.
    const clientStore = new Store();
    const engine = new SyncEngine(
      clientStore,
      new HttpTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: TEST_API_KEY,
        workspaceId: TEST_WORKSPACE,
      }),
      new Clock("rebuild-e2e-client"),
      { workspaceId: TEST_WORKSPACE },
    );
    await engine.pull();

    expect(engine.getCursorSeq()).toBe(meta.upToSeq! + 1);
    const clientNodes = (
      clientStore.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number }
    ).n;
    const serverNodes = (
      second.ctx.workspaces.storeFor(TEST_WORKSPACE).database
        .prepare("SELECT COUNT(*) AS n FROM node")
        .get() as { n: number }
    ).n;
    expect(clientNodes).toBe(serverNodes);
    expect(clientNodes).toBe(SNAPSHOT_REBUILD_MIN_ENVELOPES + 51);
    clientStore.close();
  });
});
