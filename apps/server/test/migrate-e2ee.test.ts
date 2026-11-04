/**
 * scripts/migrate-e2ee.mts integration tests (plan 06): a temp relay.db
 * fixture (two member workspaces + one non-member, plaintext envelopes +
 * a plaintext asset) drives the operator migration end-to-end:
 *
 *   --dry-run makes ZERO writes → migrate seals envelopes + assets in place
 *   (ids/HLC/metadata preserved, non-member workspace untouched) → --verify
 *   is green → a re-run is fully idempotent (all skipped) → a client-shaped
 *   decrypt of the rewritten log reproduces the original payloads.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createKdfRecord,
  decryptEnvelope,
  generateMasterKey,
  isEncryptedPayload,
  unwrapWorkspaceKey,
  type Envelope,
  type KdfRecord,
} from "@notees/protocol";

import { run } from "../../../scripts/migrate-e2ee.mts";

const EMAIL = "owner@example.com";
const PASSWORD = "migration-password-1";
const USER_ID = "0192a000-0000-7000-8000-0000000000u1";
const ACTOR = "0192a000-0000-7000-8000-0000000000a1";
const WS_A = "0192a000-0000-7000-8000-000000000001";
const WS_B = "0192a000-0000-7000-8000-000000000002";
const WS_C_NON_MEMBER = "0192a000-0000-7000-8000-000000000099";
const PAGE_A = "0192a000-0000-7000-8000-0000000000a2";

const ORIGINAL_PAYLOADS: Record<string, Record<string, unknown>> = {
  [WS_A]: {
    objectId: PAGE_A,
    contentAst: [{ type: "text", text: "Sealed page" }],
    isEmbedded: false,
    classIds: [],
  },
  [WS_B]: { objectId: PAGE_A, icon: "book" }, // object.update carrier
};

let masterKdf: KdfRecord;

beforeAll(async () => {
  const master = await generateMasterKey();
  masterKdf = await createKdfRecord(master, PASSWORD);
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Fixture {
  dataDir: string;
  dbPath: string;
  assetOriginal: Buffer;
  assetHash: string;
}

/** Build the temp deployment: minimal relay.db schema + asset bytes on disk. */
function buildFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-migrate-e2ee-"));
  dirs.push(dataDir);
  const dbPath = join(dataDir, "relay.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT, display_name TEXT, is_admin INTEGER DEFAULT 0, created_at INTEGER,
      name TEXT, surnames TEXT, avatar_url TEXT,
      kdf_salt TEXT, kdf_n INTEGER, kdf_r INTEGER, kdf_p INTEGER,
      wrapped_master_key TEXT, key_verifier TEXT);
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, created_by TEXT, created_at INTEGER);
    CREATE TABLE workspace_member (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, user_id));
    CREATE TABLE workspace_key (workspace_id TEXT PRIMARY KEY, wrapped_key TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE envelope (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, device_id TEXT NOT NULL, client TEXT,
      physical INTEGER NOT NULL, logical INTEGER NOT NULL,
      affected_node_ids TEXT NOT NULL DEFAULT '[]', op_type TEXT NOT NULL, payload TEXT NOT NULL,
      protocol_version INTEGER NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE asset (asset_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, hash TEXT NOT NULL,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL, original_name TEXT NOT NULL,
      uploaded_at TEXT NOT NULL, iv TEXT);
    CREATE TABLE asset_ref (hash TEXT PRIMARY KEY, refs_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE restore_epoch (workspace_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE snapshot (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      hlc_physical INTEGER NOT NULL, hlc_logical INTEGER NOT NULL, up_to_seq INTEGER NOT NULL,
      size INTEGER NOT NULL, created_at TEXT NOT NULL);
  `);
  db.prepare(
    `INSERT INTO "user" (id, email, password_hash, created_at, kdf_salt, kdf_n, kdf_r, kdf_p, wrapped_master_key, key_verifier)
     VALUES (?, ?, 'scrypt$x', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(USER_ID, EMAIL, masterKdf.salt, masterKdf.N, masterKdf.r, masterKdf.p, masterKdf.wrappedMasterKey, masterKdf.keyVerifier);
  for (const ws of [WS_A, WS_B, WS_C_NON_MEMBER]) {
    db.prepare("INSERT INTO workspace (id, name, created_by, created_at) VALUES (?, ?, ?, 1)").run(ws, ws, USER_ID);
  }
  db.prepare("INSERT INTO workspace_member (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1)").run(WS_A, USER_ID);
  db.prepare("INSERT INTO workspace_member (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1)").run(WS_B, USER_ID);

  const insertEnv = db.prepare(
    `INSERT INTO envelope (id, workspace_id, actor_id, device_id, client, physical, logical,
       affected_node_ids, op_type, payload, protocol_version, timestamp)
     VALUES (?, ?, ?, 'test-device', 'web', ?, 0, '[]', ?, ?, 3, ?)`,
  );
  insertEnv.run("0192a000-0000-7000-8000-0000000000e1", WS_A, ACTOR, 1727200000000, "object.create", JSON.stringify(ORIGINAL_PAYLOADS[WS_A]), "2026-09-24T12:00:00.000Z");
  insertEnv.run("0192a000-0000-7000-8000-0000000000e2", WS_A, ACTOR, 1727200001000, "object.update", JSON.stringify({ objectId: PAGE_A, icon: "book" }), "2026-09-24T12:00:01.000Z");
  insertEnv.run("0192a000-0000-7000-8000-0000000000e3", WS_B, ACTOR, 1727200002000, "object.update", JSON.stringify(ORIGINAL_PAYLOADS[WS_B]), "2026-09-24T12:00:02.000Z");
  insertEnv.run("0192a000-0000-7000-8000-0000000000e9", WS_C_NON_MEMBER, ACTOR, 1727200003000, "object.create", JSON.stringify({ objectId: PAGE_A, isEmbedded: false }), "2026-09-24T12:00:03.000Z");

  const assetOriginal = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("jpeg-bytes-migrate-e2ee")]);
  const assetHash = createHash("sha256").update(assetOriginal).digest("hex");
  const assetPath = join(dataDir, "workspaces", WS_A, "assets", assetHash.slice(0, 4), assetHash);
  mkdirSync(dirname(assetPath), { recursive: true });
  writeFileSync(assetPath, assetOriginal);
  db.prepare(
    `INSERT INTO asset (asset_id, workspace_id, hash, mime_type, size, original_name, uploaded_at, iv)
     VALUES ('0192a000-0000-7000-8000-0000000000f1', ?, ?, 'image/jpeg', ?, 'cover.jpg', '2026-09-24T12:00:00.000Z', NULL)`,
  ).run(WS_A, assetHash, assetOriginal.length);
  db.prepare("INSERT INTO asset_ref (hash, refs_count) VALUES (?, 1)").run(assetHash);

  db.prepare(
    "INSERT INTO snapshot (id, workspace_id, hlc_physical, hlc_logical, up_to_seq, size, created_at) VALUES ('snap-stale', ?, 1, 0, 2, 10, '2026-09-24T12:00:00.000Z')",
  ).run(WS_A);
  mkdirSync(join(dataDir, "snapshots"), { recursive: true });
  writeFileSync(join(dataDir, "snapshots", "snap-stale.db"), Buffer.from("stale plaintext image"));
  mkdirSync(join(dataDir, "derived"), { recursive: true });
  writeFileSync(join(dataDir, "derived", `${WS_A}.db`), Buffer.from("derived plaintext"));
  writeFileSync(join(dataDir, "derived", `${WS_C_NON_MEMBER}.db`), Buffer.from("derived non-member"));
  db.close();
  return { dataDir, dbPath, assetOriginal, assetHash };
}

function open(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

function dump(db: Database.Database): Record<string, unknown[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>).map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as unknown[];
  }
  return out;
}

describe("migrate-e2ee (plan 06)", () => {
  it("dry-run plans the full scope with ZERO writes; migrate seals in place; verify is green; re-run is idempotent; clients can read the log back", async () => {
    const fixture = buildFixture();
    const before = open(fixture.dbPath);
    const dumpBefore = JSON.stringify(dump(before));
    const dbBytesBefore = readFileSync(fixture.dbPath);
    before.close();

    // 1. DRY-RUN: plans everything, writes nothing.
    const dry = await run({ dataDir: fixture.dataDir, email: EMAIL, password: PASSWORD, dryRun: true, verify: false });
    expect(dry.workspaces.map((w) => w.workspaceId)).toEqual([WS_A, WS_B]);
    const dryA = dry.workspaces[0]!;
    expect(dryA.envelopes.sealed).toBe(2);
    expect(dryA.assets.sealed).toBe(1);
    expect(dryA.workspaceKey).toBe("dry-run");
    expect(dryA.restoreEpoch).toBe("dry-run");
    const afterDry = open(fixture.dbPath);
    expect(JSON.stringify(dump(afterDry))).toBe(dumpBefore);
    afterDry.close();
    expect(readFileSync(fixture.dbPath).equals(dbBytesBefore)).toBe(true);
    expect(existsSync(`${fixture.dbPath}.bak-`)).toBe(false);

    // 2. MIGRATE: seals member workspaces in place; preserves all metadata.
    await run({ dataDir: fixture.dataDir, email: EMAIL, password: PASSWORD, dryRun: false, verify: false });
    const db = open(fixture.dbPath);
    const rows = db.prepare("SELECT * FROM envelope ORDER BY seq ASC").all() as unknown as Array<Record<string, unknown>>;
    // ids, HLCs, timestamps, actors — everything except the payload is byte-identical.
    const rowsBefore = (JSON.parse(dumpBefore) as Record<string, unknown[]>)["envelope"] as Array<Record<string, unknown>>;
    for (const [i, row] of rows.entries()) {
      const pre = rowsBefore[i]!;
      for (const key of ["id", "workspace_id", "actor_id", "device_id", "client", "physical", "logical", "affected_node_ids", "op_type", "protocol_version", "timestamp"]) {
        expect(row[key]).toEqual(pre[key]);
      }
    }
    // Member workspaces are sealed; the non-member workspace is untouched.
    for (const row of rows.filter((r) => r.workspace_id !== WS_C_NON_MEMBER)) {
      expect(isEncryptedPayload(JSON.parse(row.payload as string))).toBe(true);
    }
    const nonMember = rows.find((r) => r.workspace_id === WS_C_NON_MEMBER)!;
    expect(JSON.parse(nonMember.payload as string)).toEqual({ objectId: PAGE_A, isEmbedded: false });
    // Workspace keys landed for members only.
    const keys = db.prepare("SELECT workspace_id FROM workspace_key ORDER BY workspace_id").all() as unknown as Array<{ workspace_id: string }>;
    expect(keys.map((k) => k.workspace_id)).toEqual([WS_A, WS_B]);
    // Asset sealed: new hash, iv set, size grew by the tag, file moved.
    const asset = db.prepare("SELECT * FROM asset WHERE asset_id = '0192a000-0000-7000-8000-0000000000f1'").get() as Record<string, unknown>;
    expect(asset.iv).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/) as unknown as string);
    expect(asset.hash).not.toBe(fixture.assetHash);
    expect(asset.size).toBe(fixture.assetOriginal.length + 16);
    expect(existsSync(join(fixture.dataDir, "workspaces", WS_A, "assets", (asset.hash as string).slice(0, 4), asset.hash as string))).toBe(true);
    expect(existsSync(join(fixture.dataDir, "workspaces", WS_A, "assets", fixture.assetHash.slice(0, 4), fixture.assetHash))).toBe(false);
    // restore_epoch bumped for members, snapshots + derived pruned.
    const epochs = db.prepare("SELECT workspace_id, epoch FROM restore_epoch ORDER BY workspace_id").all() as unknown as Array<{ workspace_id: string; epoch: number }>;
    expect(epochs).toEqual([
      { workspace_id: WS_A, epoch: 1 },
      { workspace_id: WS_B, epoch: 1 },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM snapshot").get() as { n: number }).n).toBe(0);
    expect(existsSync(join(fixture.dataDir, "snapshots", "snap-stale.db"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "derived", `${WS_A}.db`))).toBe(false);
    // The non-member workspace's derived store is OUT of scope and survives.
    expect(existsSync(join(fixture.dataDir, "derived", `${WS_C_NON_MEMBER}.db`))).toBe(true);
    // A timestamped backup was written first.
    expect(existsSync(fixture.dbPath)).toBe(true);
    db.close();

    // 3. VERIFY: the read-only decrypt+validate pass is the green signal.
    await expect(
      run({ dataDir: fixture.dataDir, email: EMAIL, password: PASSWORD, dryRun: false, verify: true }),
    ).resolves.toBeDefined();

    // 4. IDEMPOTENCE: a re-run seals nothing (all skipped).
    const rerun = await run({ dataDir: fixture.dataDir, email: EMAIL, password: PASSWORD, dryRun: false, verify: false });
    for (const report of rerun.workspaces) {
      expect(report.envelopes.sealed).toBe(0);
      expect(report.envelopes.skippedAlreadySealed).toBe(report.workspaceId === WS_A ? 2 : 1);
      expect(report.assets.sealed).toBe(0);
      expect(report.assets.skippedAlreadySealed).toBe(report.workspaceId === WS_A ? 1 : 0);
      expect(report.workspaceKey).toBe("already-present");
    }

    // 5. CLIENT-SHAPED READ: unwrap the workspace key and read the log back —
    //    the opened payloads equal the originals byte-for-byte.
    const master = await (async () => {
      const { unwrapMasterKey } = await import("@notees/protocol");
      return unwrapMasterKey(PASSWORD, masterKdf);
    })();
    const verifyDb = open(fixture.dbPath);
    const wrapped = (verifyDb.prepare("SELECT wrapped_key FROM workspace_key WHERE workspace_id = ?").get(WS_A) as { wrapped_key: string }).wrapped_key;
    const wsKey = await unwrapWorkspaceKey(master, wrapped);
    const sealedRows = verifyDb.prepare("SELECT * FROM envelope WHERE workspace_id = ? ORDER BY seq ASC").all(WS_A) as unknown as Array<Record<string, unknown>>;
    const rebuild = (row: Record<string, unknown>): Envelope =>
      ({
        id: row.id,
        protocolVersion: row.protocol_version,
        workspaceId: row.workspace_id,
        actorId: row.actor_id,
        deviceId: row.device_id,
        client: row.client,
        hlc: { physical: row.physical, logical: row.logical },
        affectedNodeIds: JSON.parse(row.affected_node_ids as string),
        opType: row.op_type,
        timestamp: row.timestamp,
        payload: JSON.parse(row.payload as string),
      }) as Envelope;
    const openedFirst = await decryptEnvelope(wsKey, rebuild(sealedRows[0]!));
    expect(openedFirst.payload).toEqual(ORIGINAL_PAYLOADS[WS_A]);
    const openedSecond = await decryptEnvelope(wsKey, rebuild(sealedRows[1]!));
    expect(openedSecond.payload).toEqual({ objectId: PAGE_A, icon: "book" });
    verifyDb.close();
  });

  it("fails loud at the verifier on a wrong password (login-level, never a silent keyless run)", async () => {
    const fixture = buildFixture();
    await expect(
      run({ dataDir: fixture.dataDir, email: EMAIL, password: "wrong-password", dryRun: false, verify: false }),
    ).rejects.toThrow(/verifier|password/i);
    // Nothing was written.
    const db = open(fixture.dbPath);
    const row = db.prepare("SELECT payload FROM envelope WHERE workspace_id = ?").get(WS_A) as { payload: string };
    expect(isEncryptedPayload(JSON.parse(row.payload))).toBe(false);
    db.close();
  });

  it("rejects a verify against an un-migrated workspace (still-plaintext rows fail the green signal)", async () => {
    const fixture = buildFixture();
    await expect(
      run({ dataDir: fixture.dataDir, email: EMAIL, password: PASSWORD, dryRun: false, verify: true }),
    ).rejects.toThrow(/no workspace_key row|still plaintext/);
  });
});
