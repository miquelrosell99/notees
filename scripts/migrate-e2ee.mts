/**
 * Plan 06 one-time migration: seal an existing deployment's relay log + CAS
 * assets in place (E2EE history migration).
 *
 * Every PLAINTEXT envelope payload in the relay log becomes the reserved
 * `{"$e": {iv, ct}}` slot; every plaintext asset blob is sealed with a fresh
 * per-asset IV (stored in the asset row; the blob is `tag(16) ‖ ct`). Ruling
 * (supersedes the spec's "fresh HLCs" generality): ids, HLCs, timestamps and
 * ALL envelope metadata are preserved — ONLY the payload changes. Nothing
 * semantic moves; LWW/conflict outcomes are byte-identical. The wire is
 * untouched (the slot has been schema-reserved since envelope v2) — no
 * fixture, no lockstep debt.
 *
 * Per member workspace a workspace key is generated, wrapped under the
 * account master key (plan-02 `workspace_key` row, first write wins), and the
 * wrapped record is what later sessions unwrap. The account master key is
 * derived from the account password (env `MIGRATE_E2EE_PASSWORD` or an
 * interactive prompt that never echoes) via the kdf record stored in
 * relay.db — verifier fail-fast. The derived key lives only for this process
 * and is never persisted.
 *
 * CLIENT CONVERGENCE rides the existing wipe-resync mechanism: restore_epoch
 * is bumped per migrated workspace (clients park unsent ops, wipe, re-pull),
 * stale server snapshots are dropped (they image the plaintext log), and the
 * server-side derived workspace stores are pruned (they would skip `$e` and
 * become content-empty anyway).
 *
 * Idempotent: already-`$e` envelopes and already-`iv`-carrying assets are
 * skipped and counted; a partial run seals only what remains.
 *
 * OPERATOR RUNBOOK (the stack is stopped for a real run):
 *   1. PAUSE the clients (stop the stack / keep users out).
 *   2. BACK UP the data dir (the script also writes a timestamped relay.db
 *      backup before any write; rollback = restore relay.db + assets).
 *   3. DRY-RUN:   pnpm --filter @notees/server exec tsx ../../scripts/migrate-e2ee.mts \
 *                   --data-dir ../../config/notees/sync --email <you@example> --dry-run
 *   4. MIGRATE:   … same without --dry-run (MIGRATE_E2EE_PASSWORD set, or type
 *      it at the prompt).
 *   5. VERIFY:    … same with --verify (read-only decrypt+validate pass — a
 *      green verify is the ONLY allowed "done" signal).
 *   6. Flip NOTEES_E2EE=on (the web image) and restart the stack + clients.
 *
 * Usage (from the repo root, stack stopped for a real run):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-e2ee.mts \
 *     --data-dir ../../config/notees/sync --email you@example.com --dry-run
 *
 * Exit codes: 0 success (dry-run included), 1 any error (a failed seal/verify
 * aborts loudly — never a silent partial state beyond the per-workspace
 * transaction boundary).
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

// The script lives outside the server package, so the bare specifier does not
// resolve from here — go through the server's dependency (the same
// better-sqlite3 build the relay storage uses). Protocol via src (tsx), the
// same dev-condition the house migration scripts use.
// @ts-expect-error the deep import carries no types (bare specifier does not
// resolve from scripts/) — the local Db alias below is the typed surface.
import Database from "../apps/server/node_modules/better-sqlite3/lib/index.js";
import {
  decryptAssetBytes,
  decryptEnvelope,
  encryptAssetBytes,
  encryptEnvelope,
  envelopeSchema,
  exportWorkspaceKey,
  generateWorkspaceKey,
  importWorkspaceKey,
  isEncryptedPayload,
  payloadSchemaFor,
  unwrapMasterKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
  type Envelope,
  type KdfRecord,
} from "../packages/protocol/src/index.ts";

// WebCrypto's CryptoKey is ambient in the DOM lib but not under @types/node 20
// (the server package compiles against lib ES2022, no DOM) — derive it.
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Db = InstanceType<typeof Database>;

export interface MigrateOptions {
  dataDir: string;
  email: string;
  password: string;
  dryRun: boolean;
  verify: boolean;
  workspace?: string | undefined;
}

export interface MigrateReport {
  mode: "dry-run" | "migrate" | "verify";
  workspaces: WorkspaceReport[];
}

export interface WorkspaceReport {
  workspaceId: string;
  envelopes: { sealed: number; skippedAlreadySealed: number; failed: number };
  workspaceKey: "created" | "already-present" | "dry-run";
  assets: { sealed: number; skippedAlreadySealed: number; failed: number };
  restoreEpoch: "bumped" | "dry-run";
}

// --- arguments -------------------------------------------------------------------

export function parseArgs(argv: string[]): Omit<MigrateOptions, "password"> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verify") args.verify = true;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args["dry-run"] === true && args.verify === true) {
    throw new Error("--dry-run and --verify are mutually exclusive");
  }
  if (typeof args.email !== "string" || args.email === "") {
    throw new Error("--email <account email> is required");
  }
  return {
    dataDir: resolve(String(args["data-dir"] ?? "config/notees/sync")),
    email: args.email,
    dryRun: args.dryRun === true,
    verify: args.verify === true,
    ...(typeof args.workspace === "string" ? { workspace: args.workspace } : {}),
  };
}

// --- password --------------------------------------------------------------------

/** Interactive prompt that never echoes (readline writes through a muted sink). */
export function promptPassword(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // The muted sink swallows the echo (terminal: false — no raw-mode line
    // editing, but the password never prints and pipes still work).
    const muted = { write: (): boolean => true };
    const rl = createInterface({ input: process.stdin, output: muted as never, terminal: false });
    rl.question("Account password: ", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer);
    });
    rl.on("error", (error) => rejectPromise(error));
  });
}

// --- account + custody --------------------------------------------------------------

interface UserRow {
  id: string;
  kdf_salt: string | null;
  kdf_n: number | null;
  kdf_r: number | null;
  kdf_p: number | null;
  wrapped_master_key: string | null;
  key_verifier: string | null;
}

/** The account row, fail-loud on unknown email / missing kdf record. */
export function loadAccount(db: Db, email: string): UserRow {
  const row = db.prepare("SELECT * FROM \"user\" WHERE email = ?").get(email) as UserRow | undefined;
  if (row === undefined) {
    throw new Error(`no account for email ${email}`);
  }
  if (
    row.kdf_salt === null ||
    row.kdf_n === null ||
    row.kdf_r === null ||
    row.kdf_p === null ||
    row.wrapped_master_key === null ||
    row.key_verifier === null
  ) {
    throw new Error(`account ${email} carries no kdf record (kdf columns are NULL)`);
  }
  return row;
}

/** Build the kdf record shape from the stored user row. */
export function kdfRecordOf(user: UserRow): KdfRecord {
  return {
    algorithm: "scrypt",
    N: user.kdf_n!,
    r: user.kdf_r!,
    p: user.kdf_p!,
    salt: user.kdf_salt!,
    wrappedMasterKey: user.wrapped_master_key!,
    keyVerifier: user.key_verifier!,
  };
}

/**
 * Derive the account master key (throws at the verifier on a wrong password —
 * a login-level failure, never a silent keyless migration).
 */
export async function deriveAccountMaster(db: Db, email: string, password: string): Promise<CryptoKey> {
  return unwrapMasterKey(password, kdfRecordOf(loadAccount(db, email)));
}

/** The workspaces the account is a member of (the migration scope). */
export function memberWorkspaceIds(db: Db, userId: string, filter?: string | undefined): string[] {
  const rows = db
    .prepare("SELECT workspace_id FROM workspace_member WHERE user_id = ? ORDER BY workspace_id ASC")
    .all(userId) as unknown as Array<{ workspace_id: string }>;
  const ids = rows.map((row) => row.workspace_id);
  if (filter !== undefined) {
    if (!ids.includes(filter)) {
      throw new Error(`workspace ${filter} is not a member workspace of this account`);
    }
    return [filter];
  }
  return ids;
}

// --- envelope sealing ----------------------------------------------------------------

interface EnvelopeRow {
  seq: number;
  id: string;
  workspace_id: string;
  actor_id: string;
  device_id: string;
  client: string | null;
  physical: number;
  logical: number;
  affected_node_ids: string;
  op_type: string;
  payload: string;
  protocol_version: number;
  timestamp: string;
}

/** Rebuild the typed envelope from a stored row (metadata preserved verbatim). */
export function envelopeOf(row: EnvelopeRow): Envelope {
  return envelopeSchema.parse({
    id: row.id,
    protocolVersion: row.protocol_version,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    ...(row.client !== null ? { client: row.client } : {}),
    hlc: { physical: row.physical, logical: row.logical },
    affectedNodeIds: JSON.parse(row.affected_node_ids),
    opType: row.op_type,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload),
  });
}

/**
 * Seal one envelope's payload (ids/HLC/metadata untouched). The payload is
 * re-validated against the strict per-opType schema BEFORE sealing — the
 * opened payload MUST validate, so a payload that already fails is a loud
 * abort, never a sealed surprise.
 */
export async function sealEnvelope(workspaceKey: CryptoKey, row: EnvelopeRow): Promise<Record<string, unknown>> {
  const envelope = envelopeOf(row);
  if (isEncryptedPayload(envelope.payload)) {
    throw new Error(`envelope seq ${row.seq}: already sealed`);
  }
  const schema = payloadSchemaFor(row.op_type);
  if (schema === undefined) {
    throw new Error(`envelope seq ${row.seq}: no payload schema for opType ${row.op_type}`);
  }
  const checked = schema.safeParse(envelope.payload);
  if (!checked.success) {
    throw new Error(
      `envelope seq ${row.seq}: ${row.op_type} payload fails the strict schema: ${checked.error.issues[0]?.message}`,
    );
  }
  const sealed = await encryptEnvelope(workspaceKey, envelope);
  return sealed.payload as Record<string, unknown>;
}

// --- asset sealing -------------------------------------------------------------------

function assetPath(dataDir: string, workspaceId: string, hash: string): string {
  return join(dataDir, "workspaces", workspaceId, "assets", hash.slice(0, 4), hash);
}

interface AssetRow {
  asset_id: string;
  workspace_id: string;
  hash: string;
  mime_type: string;
  size: number;
  original_name: string;
  uploaded_at: string;
  iv: string | null;
}

export function assetRowOf(row: Record<string, unknown>): AssetRow {
  return {
    asset_id: row.asset_id as string,
    workspace_id: row.workspace_id as string,
    hash: row.hash as string,
    mime_type: row.mime_type as string,
    size: row.size as number,
    original_name: row.original_name as string,
    uploaded_at: row.uploaded_at as string,
    iv: (row.iv as string | null | undefined) ?? null,
  };
}

/** Per-asset seal result — the file move + row update are applied by the caller. */
export interface SealedAssetPlan {
  assetId: string;
  oldHash: string;
  newHash: string;
  newSize: number;
  iv: string;
  blob: Uint8Array;
  oldPath: string;
  newPath: string;
}

/** Seal one plaintext asset row's bytes (plan only — no writes here). */
export async function planAssetSeal(
  dataDir: string,
  workspaceKey: CryptoKey,
  row: AssetRow,
): Promise<SealedAssetPlan> {
  const oldPath = assetPath(dataDir, row.workspace_id, row.hash);
  if (!existsSync(oldPath)) {
    throw new Error(`asset ${row.asset_id}: bytes missing at ${oldPath}`);
  }
  const bytes = new Uint8Array(readFileSync(oldPath));
  const { iv, blob } = await encryptAssetBytes(workspaceKey, bytes);
  const newHash = createHash("sha256").update(blob).digest("hex");
  return {
    assetId: row.asset_id,
    oldHash: row.hash,
    newHash,
    newSize: blob.length,
    iv: Buffer.from(iv).toString("base64url"),
    blob,
    oldPath,
    newPath: assetPath(dataDir, row.workspace_id, newHash),
  };
}

/**
 * Apply one sealed-asset plan: write the sealed bytes to the new content-hash
 * path (the CAS layout), commit the row update + asset_ref bookkeeping, then
 * remove the old file. Crash-safe ordering: a crash before the commit leaves
 * the row pointing at the OLD hash whose file still exists (a re-run seals it
 * again with a fresh IV); a crash after the commit leaves harmless orphan
 * bytes at the old path.
 */
export function applyAssetSeal(db: Db, plan: SealedAssetPlan): void {
  mkdirSync(dirname(plan.newPath), { recursive: true });
  if (!existsSync(plan.newPath)) {
    writeFileSync(plan.newPath, plan.blob);
  }
  const run = db.transaction(() => {
    db.prepare("UPDATE asset SET hash = ?, size = ?, iv = ? WHERE asset_id = ?").run(
      plan.newHash,
      plan.newSize,
      plan.iv,
      plan.assetId,
    );
    db.prepare(
      `INSERT INTO asset_ref (hash, refs_count) VALUES (?, 1)
       ON CONFLICT(hash) DO UPDATE SET refs_count = refs_count + 1`,
    ).run(plan.newHash);
    const remaining = (
      db.prepare("SELECT refs_count FROM asset_ref WHERE hash = ?").get(plan.oldHash) as
        | { refs_count: number }
        | undefined
    )?.refs_count;
    if (remaining !== undefined) {
      if (remaining <= 1) db.prepare("DELETE FROM asset_ref WHERE hash = ?").run(plan.oldHash);
      else db.prepare("UPDATE asset_ref SET refs_count = refs_count - 1 WHERE hash = ?").run(plan.oldHash);
    }
  });
  run();
  if (existsSync(plan.oldPath)) {
    unlinkSync(plan.oldPath);
  }
}

// --- orchestration ---------------------------------------------------------------------

async function migrateWorkspace(
  db: Db,
  dataDir: string,
  workspaceId: string,
  masterKey: CryptoKey,
  dryRun: boolean,
): Promise<WorkspaceReport> {
  // Workspace key: first write wins (idempotent across re-runs).
  const existing = db
    .prepare("SELECT wrapped_key FROM workspace_key WHERE workspace_id = ?")
    .get(workspaceId) as { wrapped_key: string } | undefined;
  let workspaceKey: CryptoKey | null = null;
  let wrappedKey: string;
  let keyState: WorkspaceReport["workspaceKey"];
  if (existing !== undefined) {
    wrappedKey = existing.wrapped_key;
    keyState = "already-present";
    if (!dryRun) workspaceKey = await unwrapWorkspaceKey(masterKey, wrappedKey);
  } else {
    const fresh = await generateWorkspaceKey();
    wrappedKey = await wrapWorkspaceKey(masterKey, fresh);
    keyState = dryRun ? "dry-run" : "created";
    if (!dryRun) workspaceKey = fresh;
  }

  // Envelope pass: seal each plaintext payload (async), then commit the
  // workspace's rewrites in one transaction.
  const envelopeStats: WorkspaceReport["envelopes"] = { sealed: 0, skippedAlreadySealed: 0, failed: 0 };
  const rows = db
    .prepare("SELECT * FROM envelope WHERE workspace_id = ? ORDER BY seq ASC")
    .all(workspaceId) as unknown as EnvelopeRow[];
  const pending: Array<{ seq: number; payload: string }> = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      throw new Error(`envelope seq ${row.seq}: payload is not valid JSON`);
    }
    if (isEncryptedPayload(payload)) {
      envelopeStats.skippedAlreadySealed += 1;
      continue;
    }
    if (dryRun) {
      envelopeStats.sealed += 1;
      continue;
    }
    if (workspaceKey === null) throw new Error("workspace key unavailable");
    const sealedPayload = await sealEnvelope(workspaceKey, row);
    pending.push({ seq: row.seq, payload: JSON.stringify(sealedPayload) });
    envelopeStats.sealed += 1;
  }
  if (!dryRun && pending.length > 0) {
    const run = db.transaction(() => {
      const update = db.prepare("UPDATE envelope SET payload = ? WHERE seq = ?");
      for (const plan of pending) update.run(plan.payload, plan.seq);
    });
    run();
    // The workspace key row lands only after its envelopes sealed cleanly.
    if (existing === undefined) {
      db.prepare(
        "INSERT INTO workspace_key (workspace_id, wrapped_key, updated_at) VALUES (?, ?, ?)",
      ).run(workspaceId, wrappedKey, Date.now());
    }
  }

  // Asset pass.
  const assetStats: WorkspaceReport["assets"] = { sealed: 0, skippedAlreadySealed: 0, failed: 0 };
  const assetRows = db
    .prepare("SELECT * FROM asset WHERE workspace_id = ? ORDER BY asset_id ASC")
    .all(workspaceId) as unknown as Record<string, unknown>[];
  for (const raw of assetRows) {
    const row = assetRowOf(raw);
    if (row.iv !== null) {
      assetStats.skippedAlreadySealed += 1;
      continue;
    }
    if (dryRun) {
      assetStats.sealed += 1;
      continue;
    }
    if (workspaceKey === null) throw new Error("workspace key unavailable");
    const plan = await planAssetSeal(dataDir, workspaceKey, row);
    applyAssetSeal(db, plan);
    assetStats.sealed += 1;
  }

  // restore_epoch bump (the wipe-resync signal clients already implement).
  if (dryRun) {
    return { workspaceId, envelopes: envelopeStats, workspaceKey: keyState, assets: assetStats, restoreEpoch: "dry-run" };
  }
  db.prepare(
    `INSERT INTO restore_epoch (workspace_id, epoch) VALUES (?, 1)
     ON CONFLICT(workspace_id) DO UPDATE SET epoch = epoch + 1`,
  ).run(workspaceId);
  return { workspaceId, envelopes: envelopeStats, workspaceKey: keyState, assets: assetStats, restoreEpoch: "bumped" };
}

/** Drop stale snapshots + prune server-side derived workspace stores. */
export function pruneServerState(db: Db, dataDir: string, workspaceIds: string[], dryRun: boolean): void {
  const snapshotRows = db.prepare("SELECT id, workspace_id FROM snapshot").all() as unknown as Array<{
    id: string;
    workspace_id: string;
  }>;
  const stale = snapshotRows.filter((row) => workspaceIds.includes(row.workspace_id));
  if (!dryRun && stale.length > 0) {
    const run = db.transaction(() => {
      db.prepare(`DELETE FROM snapshot WHERE id IN (${stale.map(() => "?").join(",")})`).run(...stale.map((r) => r.id));
    });
    run();
  }
  for (const snapshot of stale) {
    try {
      if (!dryRun) unlinkSync(join(dataDir, "snapshots", `${snapshot.id}.db`));
    } catch {
      // Blob already gone.
    }
  }
  const derivedDir = join(dataDir, "derived");
  if (existsSync(derivedDir)) {
    for (const name of readdirSync(derivedDir).filter((n) => /\.db(-wal|-shm|-journal)?$/.test(n))) {
      try {
        if (!dryRun) unlinkSync(join(derivedDir, name));
      } catch {
        // File already gone.
      }
    }
  }
}

// --- verify -----------------------------------------------------------------------------

/**
 * The read-only green signal: reopen the DB, unwrap each migrated workspace's
 * key, decrypt every `$e` envelope (strict schema validation on the OPENED
 * payload), and reopen every sealed asset. Throws on the first failure.
 */
export async function verifyMigration(db: Db, dataDir: string, email: string, password: string): Promise<void> {
  const masterKey = await deriveAccountMaster(db, email, password);
  const user = loadAccount(db, email);
  const workspaceIds = memberWorkspaceIds(db, user.id);
  for (const workspaceId of workspaceIds) {
    const keyRow = db
      .prepare("SELECT wrapped_key FROM workspace_key WHERE workspace_id = ?")
      .get(workspaceId) as { wrapped_key: string } | undefined;
    if (keyRow === undefined) {
      throw new Error(`verify: workspace ${workspaceId} has no workspace_key row`);
    }
    const workspaceKey = await unwrapWorkspaceKey(masterKey, keyRow.wrapped_key);

    const rows = db
      .prepare("SELECT * FROM envelope WHERE workspace_id = ? ORDER BY seq ASC")
      .all(workspaceId) as unknown as EnvelopeRow[];
    let sealedCount = 0;
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as unknown;
      if (!isEncryptedPayload(payload)) {
        throw new Error(`verify: workspace ${workspaceId} envelope seq ${row.seq} is still plaintext`);
      }
      const opened = await decryptEnvelope(workspaceKey, envelopeOf(row));
      const schema = payloadSchemaFor(row.op_type);
      if (schema === undefined) throw new Error(`verify: no payload schema for ${row.op_type}`);
      const checked = schema.safeParse(opened.payload);
      if (!checked.success) {
        throw new Error(
          `verify: workspace ${workspaceId} envelope seq ${row.seq} opened payload fails the strict schema: ${checked.error.issues[0]?.message}`,
        );
      }
      sealedCount += 1;
    }

    const assetRows = db
      .prepare("SELECT * FROM asset WHERE workspace_id = ? ORDER BY asset_id ASC")
      .all(workspaceId) as unknown as Record<string, unknown>[];
    let assetCount = 0;
    for (const raw of assetRows) {
      const row = assetRowOf(raw);
      if (row.iv === null) continue; // plaintext asset in a keyed workspace is legal (mixed)
      const path = assetPath(dataDir, workspaceId, row.hash);
      if (!existsSync(path)) {
        throw new Error(`verify: asset ${row.asset_id} bytes missing at ${path}`);
      }
      const blob = new Uint8Array(readFileSync(path));
      if (blob.length !== row.size) {
        throw new Error(`verify: asset ${row.asset_id} size mismatch (row ${row.size}, file ${blob.length})`);
      }
      await decryptAssetBytes(workspaceKey, new Uint8Array(Buffer.from(row.iv, "base64url")), blob);
      assetCount += 1;
    }
    console.log(
      `verify: workspace ${workspaceId}: ${sealedCount} sealed envelope(s) decrypt+validate, ${assetCount} sealed asset(s) reopen`,
    );
  }
  console.log(`verify: OK — ${workspaceIds.length} workspace(s) fully sealed and readable`);
}

// --- main ---------------------------------------------------------------------------------

async function run(options: MigrateOptions): Promise<MigrateReport> {
  const dbPath = join(options.dataDir, "relay.db");
  if (!existsSync(dbPath)) {
    throw new Error(`relay DB not found: ${dbPath}`);
  }
  const mode = options.verify ? "verify" : options.dryRun ? "dry-run" : "migrate";
  // dry-run and verify open READ-ONLY (zero writes is a hard guarantee).
  const db: Db = new Database(dbPath, { readonly: options.dryRun || options.verify });
  try {
    db.pragma("busy_timeout = 5000");

    if (options.verify) {
      await verifyMigration(db, options.dataDir, options.email, options.password);
      return { mode, workspaces: [] };
    }

    const masterKey = await deriveAccountMaster(db, options.email, options.password);
    const user = loadAccount(db, options.email);
    const workspaceIds = memberWorkspaceIds(db, user.id, options.workspace);
    if (workspaceIds.length === 0) {
      throw new Error(`account ${options.email} is a member of no workspaces — nothing to migrate`);
    }

    console.log(`relay DB: ${dbPath}`);
    console.log(`mode: ${options.dryRun ? "DRY-RUN (read-only, zero writes)" : "MIGRATE"}`);
    console.log(`account: ${options.email} (${user.id})`);
    console.log(`workspaces in scope: ${workspaceIds.length}`);

    if (!options.dryRun) {
      // Backup first (WAL checkpoint so the main file is complete).
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
      const backupPath = `${dbPath}.bak-${stamp}`;
      db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(dbPath, backupPath);
      const check = new Database(backupPath, { readonly: true });
      const quickCheck = check.pragma("quick_check", { simple: true });
      check.close();
      if (quickCheck !== "ok") {
        throw new Error(`backup integrity check failed (${String(quickCheck)}) — aborting before any write`);
      }
      console.log(`backup written: ${backupPath} (quick_check ok)`);
    }

    const workspaces: WorkspaceReport[] = [];
    for (const workspaceId of workspaceIds) {
      workspaces.push(await migrateWorkspace(db, options.dataDir, workspaceId, masterKey, options.dryRun));
    }
    pruneServerState(db, options.dataDir, workspaceIds, options.dryRun);

    for (const report of workspaces) {
      console.log(`workspace ${report.workspaceId}:`);
      console.log(
        `  envelopes: sealed=${report.envelopes.sealed} skipped($e)=${report.envelopes.skippedAlreadySealed} failed=${report.envelopes.failed}`,
      );
      console.log(`  workspace key: ${report.workspaceKey}`);
      console.log(
        `  assets: sealed=${report.assets.sealed} skipped(iv)=${report.assets.skippedAlreadySealed} failed=${report.assets.failed}`,
      );
      console.log(`  restore_epoch: ${report.restoreEpoch}`);
    }
    if (options.dryRun) {
      console.log("dry-run only — no writes. Re-run without --dry-run to execute (a timestamped backup is written first).");
    } else {
      console.log("migration applied. Next: --verify (the only green signal), then flip NOTEES_E2EE=on and restart clients.");
    }
    return { mode, workspaces };
  } finally {
    db.close();
  }
}

export { run };

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const password = process.env.MIGRATE_E2EE_PASSWORD ?? (await promptPassword());
  if (password === "") {
    throw new Error("empty password");
  }
  await run({ ...options, password });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`migrate-e2ee: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
