// @vitest-environment node
/**
 * Realtime sync plumbing tests (slice 3): WorkspaceClient.startRealtime
 * applies relay ops frames live (no explicit sync), exposes a status
 * snapshot (state, backlog, realtime flag), and the worker wire protocol
 * (handleMessage) routes startRealtime / stopRealtime / status. MemoryRelay
 * plays the relay: its subscribe() is the same ops-frame surface the WS
 * client drives in the app.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import type { OpfsStore } from "../src/worker/opfs.js";
import {
  WorkerCore,
  handleMessage,
  type WorkerContext,
  type WorkerInitMessage,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from "../src/worker/worker-core.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const T0 = 1_727_200_000_000;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
const cores: WorkerCore[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()!.close();
  while (cores.length > 0) await cores.pop()!.close();
});

function makeEnvelope(deviceId: string, physical: number, objectId: string, name: string): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId,
    hlc: { physical, logical: 0 },
    opType: "object.create",
    payload: { objectId, nodeType: "page", name },
    timestamp: new Date(physical).toISOString(),
  });
}

describe("WorkspaceClient realtime (MemoryRelay subscribe surface)", () => {
  it("applies remote ops frames live and reports status", async () => {
    const relay = new MemoryRelay();
    const clientA = await WorkspaceClient.create({
      transport: new MemoryTransport(relay),
      actorId: ACTOR,
      sqlJs: sqlModule,
    });
    const clientB = await WorkspaceClient.create({
      transport: new MemoryTransport(relay),
      actorId: ACTOR,
      sqlJs: sqlModule,
    });
    clients.push(clientA, clientB);
    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);

    let notifications = 0;
    const unsubscribe = clientA.subscribe(() => {
      notifications += 1;
    });

    // Realtime off: nothing wired, status says so.
    expect(clientA.status()).toMatchObject({ status: "idle", realtime: false, pending: 0 });

    clientA.startRealtime();
    expect(clientA.isRealtimeActive()).toBe(true);
    expect(clientA.status().realtime).toBe(true);

    // B commits; the relay's ops frame applies on A without an explicit sync.
    const pageId = "0192a000-0000-7000-8000-0000000000b1";
    const before = notifications;
    await clientB.createObject({ nodeType: "page", name: "Live Page", id: pageId });
    await clientB.push();

    expect(clientA.getPage(pageId)?.name).toBe("Live Page");
    // The remote apply notified A's subscribers (engine onRemoteBatch → notify).
    expect(notifications).toBeGreaterThan(before);
    expect(clientA.status().cursorSeq).toBe(1);

    clientA.stopRealtime();
    expect(clientA.isRealtimeActive()).toBe(false);
    expect(clientA.status().realtime).toBe(false);
    unsubscribe();
  });

  it("status() surfaces the pending backlog after a failed push", async () => {
    const relay = new MemoryRelay();
    const gate = { offline: false };
    const transport = new MemoryTransport(relay, {
      hooks: {
        beforeSendBatch: async () => {
          if (gate.offline) throw new Error("transport offline (test gate)");
        },
      },
    });
    const client = await WorkspaceClient.create({
      transport,
      actorId: ACTOR,
      sqlJs: sqlModule,
    });
    clients.push(client);
    await client.bootstrapWorkspace(WS);

    // Local-first: the write applies immediately; the push fails and stays pending.
    gate.offline = true;
    await client.createObject({ nodeType: "page", name: "Pending Page" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = client.status();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("transport offline (test gate)");
    // Outbox state machine: the failed op waits out its backoff as "failed".
    expect(snapshot.pending).toBe(0);
    expect(snapshot.failed).toBe(1);

    // The backlog recovers once the transport heals.
    gate.offline = false;
    await client.sync();
    expect(client.status()).toMatchObject({ status: "idle", pending: 0 });
  });
});

describe("worker wire protocol: realtime cases", () => {
  function createMemoryOpfs(): { opfs: OpfsStore; files: Map<string, Uint8Array> } {
    const files = new Map<string, Uint8Array>();
    const opfs: OpfsStore = {
      loadFile: async (name) => {
        const bytes = files.get(name);
        return bytes === undefined ? null : new Uint8Array(bytes);
      },
      saveFile: async (name, bytes) => {
        files.set(name, new Uint8Array(bytes));
      },
    };
    return { opfs, files };
  }

  function createRealtimeContext(): {
    ctx: WorkerContext;
    relay: MemoryRelay;
  } {
    const { opfs } = createMemoryOpfs();
    const relay = new MemoryRelay();
    const ctx: WorkerContext = {
      core: null,
      init: async (init: WorkerInitMessage) => {
        const core = await WorkerCore.create({
          SQL: sqlModule,
          opfs,
          fileName: `${init.workspaceId}.db`,
          workspaceId: init.workspaceId,
          transport: new MemoryTransport(relay),
        });
        cores.push(core);
        ctx.core = core;
      },
    };
    return { ctx, relay };
  }

  async function send(
    ctx: WorkerContext,
    method: string,
    args: unknown[] = [],
    id = 1,
  ): Promise<WorkerResponseMessage> {
    const message: WorkerRequestMessage = { id, method, args };
    return handleMessage(ctx, message);
  }

  const initMessage: WorkerInitMessage = {
    sqlWasmUrl: "/assets/sql-wasm.wasm",
    workspaceId: WS,
    serverUrl: "https://notees.example.com",
    apiKey: "test-key",
  };

  it("routes startRealtime / stopRealtime / status and applies ops frames", async () => {
    const { ctx, relay } = createRealtimeContext();
    const init = await send(ctx, "init", [initMessage]);
    expect(init.error).toBeUndefined();

    const started = await send(ctx, "startRealtime", [], 2);
    expect(started.error).toBeUndefined();

    const statusLive = await send(ctx, "status", [], 3);
    expect(statusLive.error).toBeUndefined();
    expect(statusLive.result).toMatchObject({
      status: "idle",
      pending: 0,
      realtime: true,
      cursorSeq: 0,
    });

    // Another device commits over the shared relay; the ops frame applies
    // inside the worker through the engine's realtime path.
    const deviceB = new MemoryTransport(relay);
    await deviceB.sendBatch([makeEnvelope("device-b", T0 + 10, "0192a000-0000-7000-8000-0000000000c1", "From B")]);

    const listed = await send(ctx, "listPages", [], 4);
    expect(listed.error).toBeUndefined();
    const pages = listed.result as Array<{ id: string; name: string | null }>;
    expect(pages.map((page) => page.name)).toContain("From B");

    const statusApplied = await send(ctx, "status", [], 5);
    expect(statusApplied.result).toMatchObject({ cursorSeq: 1 });

    const stopped = await send(ctx, "stopRealtime", [], 6);
    expect(stopped.error).toBeUndefined();
    const statusStopped = await send(ctx, "status", [], 7);
    expect(statusStopped.result).toMatchObject({ realtime: false });
  });

  it("rejects startRealtime before init like every other method", async () => {
    const { ctx } = createRealtimeContext();
    const response = await send(ctx, "startRealtime", [], 9);
    expect(response.result).toBeUndefined();
    expect(response.error).toMatch(/init required/);
  });
});
