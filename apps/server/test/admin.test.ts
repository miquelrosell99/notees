/**
 * The operator-key admin surface (routes-admin.ts): POST /api/admin/append
 * (the apply-through-server migration path) and GET /api/admin/convergence
 * (the honest post-migration check), plus the WorkspaceManager self-heal
 * sweep (sweepNow — an EXTERNAL append to relay.db, the Path A migration
 * script idiom, converges an already-open handle without a restart).
 *
 * Pins: operator-only auth (user sessions get 403, missing credentials 401);
 * the whole batch is protocol-validated before anything is ingested (an
 * invalid envelope answers 422 and writes nothing); append applies to the
 * derived store BEFORE the response (no restart needed); duplicate ids are
 * ignored (idempotent re-runs answer an empty savedIds); convergence reports
 * the handle watermark + pending skips + per-envelope applied state; the
 * sweep reconciles a handle after a direct RelayStorage.ingest bypass.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import {
  closeTestServer,
  makeTestServer,
  testEnvelope,
  ingest,
  type TestServer,
} from "./helpers";

import { RelayStorage } from "../src/relay-storage.ts";

let server: TestServer | null = null;

const WORKSPACE = "4b7d1a00-2222-4000-8000-000000000003";
const PMID_SCHEMA = "00000000-0000-0000-0006-000000000056";

function admin(method: string, url: string, payload?: unknown) {
  return server!.app.inject({
    method: method as "GET",
    url,
    headers: { "content-type": "application/json", ...server!.authHeaders },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** A migration-style batch: one schema create + one pinned binding. */
let batchCounter = 0;
function migrationBatch(): Envelope[] {
  const physical = Date.now();
  let logical = batchCounter++ * 10;
  const stamp = (opType: string, payload: Record<string, unknown>): Envelope =>
    newEnvelope({
      workspaceId: WORKSPACE,
      actorId: "01920000-0000-7000-8000-0000000000a7",
      deviceId: "admin-test-migration",
      client: "admin-test",
      hlc: { physical, logical: logical++ },
      affectedNodeIds: [],
      opType,
      payload,
    });
  return [
    stamp("propertySchema.create", {
      propertySchemaId: PMID_SCHEMA,
      name: "PMID",
      type: "text",
      scopeClassIds: ["00000000-0000-0000-0001-000000000023"],
    }),
    stamp("class.property.set", {
      classId: "00000000-0000-0000-0001-000000000023",
      propertySchemaId: PMID_SCHEMA,
      pinned: true,
    }),
  ];
}

beforeEach(async () => {
  server = await makeTestServer();
  await ingest(server, [
    testEnvelope({
      workspaceId: WORKSPACE,
      opType: "class.create",
      payload: {
        classId: "00000000-0000-0000-0001-000000000023",
        contentAst: [{ type: "text", text: "Source" }],
      },
    }),
  ]);
});

afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("POST /api/admin/append", () => {
  it("applies a migration batch through the one write path — derived converged before the response", async () => {
    const batch = migrationBatch();
    const res = await admin("POST", "/api/admin/append", { workspaceId: WORKSPACE, envelopes: batch });
    expect(res.statusCode).toBe(200);
    expect(res.json().savedIds).toHaveLength(2);
    expect(res.json().pending).toBe(0);

    // The honest check: the server's OWN store has the rows, no restart.
    const convergence = await admin(
      "GET",
      `/api/admin/convergence?workspaceId=${WORKSPACE}&envelopeIds=${batch.map((e) => e.id).join(",")}`,
    );
    expect(convergence.statusCode).toBe(200);
    expect(convergence.json().envelopes).toEqual({ [batch[0]!.id]: true, [batch[1]!.id]: true });
    expect(convergence.json().pending).toBe(0);
  });

  it("is idempotent: a second identical batch answers an empty savedIds", async () => {
    const batch = migrationBatch();
    const first = await admin("POST", "/api/admin/append", { workspaceId: WORKSPACE, envelopes: batch });
    expect(first.statusCode).toBe(200);
    const second = await admin("POST", "/api/admin/append", { workspaceId: WORKSPACE, envelopes: batch });
    expect(second.statusCode).toBe(200);
    expect(second.json().savedIds).toEqual([]);
  });

  it("rejects the whole batch when one envelope is invalid — nothing is written", async () => {
    const batch = migrationBatch();
    const broken = { ...batch[0]!, payload: { bogus: true } } as unknown as Envelope;
    const res = await admin("POST", "/api/admin/append", {
      workspaceId: WORKSPACE,
      envelopes: [batch[0]!, broken],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
    // The valid envelope of the pair must NOT have landed either.
    const convergence = await admin(
      "GET",
      `/api/admin/convergence?workspaceId=${WORKSPACE}&envelopeIds=${batch[0]!.id}`,
    );
    expect(convergence.json().envelopes[batch[0]!.id]).toBe(false);
  });

  it("user sessions and missing credentials are refused (operator key only)", async () => {
    const setup = await server!.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    const token = setup.json().token as string;
    const asUser = await server!.app.inject({
      method: "POST",
      url: "/api/admin/append",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { workspaceId: WORKSPACE, envelopes: migrationBatch() },
    });
    expect(asUser.statusCode).toBe(403);

    const anonymous = await server!.app.inject({
      method: "POST",
      url: "/api/admin/append",
      headers: { "content-type": "application/json" },
      payload: { workspaceId: WORKSPACE, envelopes: migrationBatch() },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("hydration with a partial-coverage snapshot", () => {
  it("restores the snapshot and replays only the tail — no whole-log replay (the 2026-11-02 wedge fix)", async () => {
    const WS = "4b7d1a00-2222-4000-8000-000000000004";
    // A six-envelope client history appended DIRECTLY to the relay (the
    // manager never sees these — the workspace handle is opened later).
    const history = Array.from({ length: 6 }, (_, index) =>
      testEnvelope({
        workspaceId: WS,
        opType: "propertySchema.create",
        payload: {
          propertySchemaId: `01920000-0000-7000-8000-0000000000${String(index + 10).padStart(2, "0")}`,
          name: `Probe ${index}`,
          type: "text",
        },
      }),
    );
    const relay = new RelayStorage(
      join(server!.dataDir, "relay.db"),
      join(server!.dataDir, "snapshots"),
    );
    try {
      const { seqs } = relay.ingest(history);
      // A client snapshot covering only the FIRST FOUR envelopes (the live
      // case: a client uploaded at a seq behind the log head).
      const scratch = Store.open(betterSqlite3Backend(":memory:"));
      for (const env of history.slice(0, 4)) scratch.apply(env);
      const bytes = scratch.snapshot();
      scratch.close();
      relay.saveSnapshot(
        WS,
        "01920000-0000-7000-8000-0000000000f0",
        relay.maxHlc(WS),
        seqs[history[3]!.id]!,
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      );
    } finally {
      relay.close();
    }

    // Opening the handle must converge: restore (4) + tail replay (2) —
    // not a six-envelope-from-zero replay, and not a snapshot-coverage
    // gate skip that would replay the whole log either.
    const convergence = await admin(
      "GET",
      `/api/admin/convergence?workspaceId=${WS}&envelopeIds=${history[5]!.id}`,
    );
    expect(convergence.statusCode).toBe(200);
    expect(convergence.json().envelopes[history[5]!.id]).toBe(true);
    // All six schemas present in the server's derived store.
    const store = server!.ctx.workspaces.storeFor(WS);
    expect(
      (store.database.prepare("SELECT COUNT(*) n FROM property_schema").get() as { n: number }).n,
    ).toBe(6);
  });
});

describe("the self-heal sweep", () => {
  it("an EXTERNAL relay append (the Path A script idiom) converges an open handle via sweepNow — no restart", async () => {
    // Open the handle and converge it.
    const batch = migrationBatch();
    const res = await admin("POST", "/api/admin/append", { workspaceId: WORKSPACE, envelopes: batch });
    expect(res.statusCode).toBe(200);

    // A second batch appended DIRECTLY to relay.db, bypassing the running
    // server (exactly what a scripts/migrate-*.mts --apply does today).
    const externalBatch = migrationBatch().map((env, index) =>
      newEnvelope({
        workspaceId: env.workspaceId,
        actorId: env.actorId,
        deviceId: "external-script",
        client: "external-script",
        hlc: { physical: Date.now() + 1000 + index, logical: index },
        affectedNodeIds: [],
        opType: env.opType,
        payload: env.payload,
      }),
    );
    const relay = new RelayStorage(
      join(server!.dataDir, "relay.db"),
      join(server!.dataDir, "snapshots"),
    );
    try {
      relay.ingest(externalBatch);
    } finally {
      relay.close();
    }

    // Before the sweep: the server has NOT applied the external tail.
    const before = await admin(
      "GET",
      `/api/admin/convergence?workspaceId=${WORKSPACE}&envelopeIds=${externalBatch.map((e) => e.id).join(",")}`,
    );
    expect(before.json().envelopes[externalBatch[0]!.id]).toBe(false);

    // The sweep reconciles the open handle.
    const swept = await server!.ctx.workspaces.sweepNow(WORKSPACE);
    expect(swept.lastSeq).toBe(before.json().latestSeq);

    const after = await admin(
      "GET",
      `/api/admin/convergence?workspaceId=${WORKSPACE}&envelopeIds=${externalBatch.map((e) => e.id).join(",")}`,
    );
    expect(after.json().envelopes[externalBatch[0]!.id]).toBe(true);
    expect(after.json().envelopes[externalBatch[1]!.id]).toBe(true);
    expect(after.json().pending).toBe(0);
  });
});
