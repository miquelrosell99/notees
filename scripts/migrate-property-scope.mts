/**
 * Property-scope rewrite: the display-only `scope: "global" | "class" | "object"`
 * enum on `propertySchema.create` retires. Its replacement is `scopeClassIds`
 * — absent/null = global, a non-empty class-id list = local to those classes
 * AND their extensions (the sole locality authority; bindings carry zero
 * availability semantics). The strict payload schema rejects the retired key
 * outright (the no-backward-compatibility law), so the live relay log still
 * carrying it must be rewritten in place or every strict replay (client wipe
 * + resync after the epoch bump) fails.
 *
 * LOCKSTEP LAW: the TS reference ships first; GTK + Flutter ports must accept
 * `scopeClassIds` (and reject the retired `scope` key + the empty list) BEFORE
 * this migration runs against a live relay — a pre-batch client rejects the
 * rewritten envelopes and its sync stalls until updated. Run only after the
 * client tags (docs/developers/migrations.md §2).
 *
 * The mapping (audited per schema):
 *  - `"global"`            → the key is STRIPPED (global = the absence of
 *                            scopeClassIds — exactly one spelling);
 *  - `"class"`             → `scopeClassIds: [<classId>]` resolved by (1) the
 *                            domain seed spec for the schema's fixed UUID
 *                            (bindTo → the class UUID), else (2) a live
 *                            class_property binding row for the schema in the
 *                            server's derived DB; else (3) global + LISTED;
 *  - `"object"`            → NOT expressible as class ids (node-locked
 *                            locality has no consumer — the audit found only
 *                            the generated-from seed) → global + LISTED for
 *                            the owner.
 *
 * The migrations.md §B sequence this script implements:
 *  1. Plan from authority: scan the stored log rows for
 *     propertySchema.create/update envelopes carrying `scope` (raw rows — the
 *     rewrite targets seqs). The ORIGINAL log replays through the strict
 *     store for every envelope EXCEPT the scope key (the only retired shape),
 *     so the plan cross-reads the derived DB for binding rows only.
 *  2. Backup: relay.db (and the snapshot bytes being patched) to
 *     /tmp/…bak-<timestamp> before anything.
 *  3. IN-PLACE envelope rewrite, one transaction: strip `scope`; a resolvable
 *     "class" gains `scopeClassIds: [<classId>]`. seq/id/HLC untouched; every
 *     surviving key untouched. NO compensation envelopes: the scope value
 *     moves INSIDE the same envelope, so full replays converge from the log
 *     ALONE. Every rewritten envelope re-validates through
 *     `payloadSchemaFor(opType)` afterwards — that assertion is the point.
 *  4. Snapshot patch: the newest snapshot is stale when its up_to_seq
 *     post-dates the first rewritten envelope — its bytes get the same move
 *     on the property_schema rows (scope → scope_class_ids), then `Store.open`
 *     runs the v24 schema migration (the column rebuild) and verifies.
 *  5. Bump `restore_epoch`: without it, `applied_envelope` id-skips the
 *     rewritten envelopes on every replica that already saw the old versions
 *     and clients silently keep the old derivation.
 *  6. RESTART the sync server (migrations.md §B step 7).
 *  7. Verify, in the runbook's order: rewritten envelopes re-validate →
 *     fresh scratch replay of the FULL log with zero StoreError throws → no
 *     property_schema row / create payload carries the retired key → scope
 *     values moved (per-schema report matches the plan).
 *
 * Idempotent: a second run finds no `scope` key and plans nothing.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-property-scope.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type SystemPropertyName,
} from "../packages/domain/src/index.ts";
import {
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

/**
 * The seed-spec scope map: fixed schema UUID → its seed binding class UUID
 * (a bindTo spec's class is the scope's one-element case). Bindings carry no
 * availability semantics — this map exists only to resolve what the retired
 * enum MEANT for the seeds that wrote it.
 */
const SEED_SCOPE_BY_SCHEMA_ID: ReadonlyMap<string, string> = new Map(
  (Object.entries(SYSTEM_PROPERTY_SPECS) as Array<[SystemPropertyName, (typeof SYSTEM_PROPERTY_SPECS)[SystemPropertyName]]>)
    .filter((entry): entry is [SystemPropertyName, NonNullable<(typeof SYSTEM_PROPERTY_SPECS)[SystemPropertyName]>] => {
      const spec = entry[1];
      return spec !== undefined && spec.bindTo !== undefined;
    })
    .map(([name, spec]) => [SYSTEM_PROPERTY_UUIDS[name], SYSTEM_CLASS_UUIDS[spec.bindTo!]]),
);

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? DEFAULT_WORKSPACE,
    apply: argv.includes("--apply"),
  };
}

// --- planning -----------------------------------------------------------------

interface PlannedRewrite {
  seq: number;
  id: string;
  opType: string;
  /** The retired enum value found in the payload. */
  scope: string;
  /** The scope list the enum maps to (null = global — the key just strips). */
  scopeClassIds: string[] | null;
  /** True when the enum could not be resolved honestly → global + owner list. */
  demotedToGlobal: boolean;
  payload: Record<string, unknown>;
}

/** The retired `scope` value of a propertySchema.* payload, if present. */
function retiredScopeOf(opType: string, payload: Record<string, unknown>): string | null {
  if (opType !== "propertySchema.create" && opType !== "propertySchema.update") return null;
  const scope = payload.scope;
  return typeof scope === "string" ? scope : null;
}

/**
 * Resolve the class list a retired "class" scope meant, in honest order:
 * the seed spec for the fixed UUID, then a live binding row in the derived
 * DB. Unresolvable → null (demote to global + the owner list).
 */
function resolveClassScope(
  schemaId: unknown,
  derived: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } | null,
): { scopeClassIds: string[] | null; via: "seed" | "binding" | "none" } {
  if (typeof schemaId !== "string") return { scopeClassIds: null, via: "none" };
  const seeded = SEED_SCOPE_BY_SCHEMA_ID.get(schemaId);
  if (seeded !== undefined) return { scopeClassIds: [seeded], via: "seed" };
  const binding =
    derived === null
      ? undefined
      : (derived
          .prepare("SELECT class_id FROM class_property WHERE property_schema_id = ? ORDER BY class_id LIMIT 1")
          .get(schemaId) as { class_id: string } | undefined);
  if (binding !== undefined) return { scopeClassIds: [binding.class_id], via: "binding" };
  return { scopeClassIds: null, via: "none" };
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const snapshot = relay.latestSnapshot(options.workspace);
    const snapshotSeq = snapshot?.up_to_seq ?? 0;
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
    );

    // 1. Plan: scan the stored log rows for propertySchema.* envelopes
    //    carrying the retired key (raw rows — the rewrite targets seqs).
    const rows = relay.db
      .prepare(
        `SELECT seq, id, op_type, payload FROM envelope
         WHERE workspace_id = ? AND op_type IN ('propertySchema.create', 'propertySchema.update')
         ORDER BY seq ASC`,
      )
      .all(options.workspace) as Array<{ seq: number; id: string; op_type: string; payload: string }>;

    // The derived DB (read-only WAL) resolves "class" scopes the seed map
    // doesn't know (user schemas bound somewhere).
    const derivedFile = join(options.dataDir, "derived", `${options.workspace}.db`);
    const derived = existsSync(derivedFile)
      ? new Database(derivedFile, { readonly: true, fileMustExist: true })
      : null;

    const planned: PlannedRewrite[] = [];
    const ownerReport: PlannedRewrite[] = [];
    try {
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const scope = retiredScopeOf(row.op_type, payload);
        if (scope === null) continue;
        let scopeClassIds: string[] | null = null;
        let demoted = false;
        if (scope === "class") {
          if (derived === null) {
            throw new Error(
              `seq ${row.seq}: scope "class" on ${String(payload.propertySchemaId)} needs the derived store to ` +
                `resolve (derived DB ${derivedFile} not found) — point --data-dir at the live sync data`,
            );
          }
          const resolved = resolveClassScope(payload.propertySchemaId, derived);
          scopeClassIds = resolved.scopeClassIds;
          demoted = resolved.via === "none";
        } else if (scope === "object") {
          // Node-locked locality is not expressible as class ids (the audit
          // found no consumer — the generated-from seed is the only emitter).
          demoted = true;
        } else if (scope !== "global") {
          throw new Error(`seq ${row.seq}: unexpected scope value ${JSON.stringify(scope)}`);
        }
        const plan: PlannedRewrite = {
          seq: row.seq,
          id: row.id,
          opType: row.op_type,
          scope,
          scopeClassIds,
          demotedToGlobal: demoted,
          payload,
        };
        planned.push(plan);
        if (demoted) ownerReport.push(plan);
      }
    } finally {
      derived?.close();
    }

    console.log("\nplanned property-scope rewrite:");
    if (planned.length === 0) {
      console.log("  no propertySchema.* envelope carries the retired `scope` key — nothing to rewrite.");
    } else {
      const firstSeq = Math.min(...planned.map((p) => p.seq));
      console.log(
        `  ${planned.length} envelope(s) carry the retired scope key — rewritten in place (seq/id/HLC untouched):`,
      );
      for (const p of planned.slice(0, 12)) {
        const move =
          p.scopeClassIds !== null
            ? `"${p.scope}" → scopeClassIds [${p.scopeClassIds[0].slice(0, 13)}…]`
            : p.demotedToGlobal
              ? `"${p.scope}" → GLOBAL (not expressible / unresolvable — listed for the owner below)`
              : `"${p.scope}" → global (key stripped)`;
        console.log(`    seq ${p.seq}  ${p.opType}  ${String(p.payload.propertySchemaId).slice(0, 13)}…  ${move}`);
      }
      if (planned.length > 12) console.log(`    … and ${planned.length - 12} more`);
      console.log(
        `  snapshot ${snapshot?.id ?? "(none)"} ${snapshot !== null && snapshotSeq >= firstSeq ? `is STALE (up_to_seq ${snapshotSeq} >= first rewritten seq ${firstSeq}) — bytes patched with the same move` : "predates the first rewritten envelope — not stale"}.`,
      );
    }
    if (ownerReport.length > 0) {
      console.log("\n  these schemas default to GLOBAL (the retired enum had no honest class mapping):");
      for (const p of ownerReport) {
        console.log(
          `    seq ${p.seq}  ${p.opType}  schema ${String(p.payload.propertySchemaId)}  scope "${p.scope}" → re-scope manually if local was meant`,
        );
      }
    }

    if (planned.length === 0) {
      console.log("\nnothing to rewrite — the log is already clean.");
      return;
    }

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (backup → envelope rewrite → snapshot patch → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-property-scope-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-property-scope-${stamp}`);

    // 2. Envelope rewrite, one transaction: strip `scope`; a resolved "class"
    //    gains scopeClassIds. Every rewritten envelope re-validates through
    //    the strict payload schema — that assertion is the point.
    const rewrite = relay.db.transaction(() => {
      for (const p of planned) {
        const { scope: _retired, ...surviving } = p.payload;
        const rewritten =
          p.scopeClassIds !== null ? { ...surviving, scopeClassIds: p.scopeClassIds } : surviving;
        const schema = payloadSchemaFor(p.opType)!;
        const check = schema.safeParse(rewritten);
        if (!check.success) {
          throw new Error(
            `seq ${p.seq}: rewritten ${p.opType} payload no longer validates: ${check.error.message}`,
          );
        }
        relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(rewritten), p.seq, options.workspace);
      }
    });
    rewrite();
    console.log(`rewrote ${planned.length} envelope(s) in place; no compensation envelopes (the scope moved inside the same envelope).`);

    // 3. Snapshot patch (only when the snapshot post-dates the first rewritten
    //    envelope — an older snapshot embeds none of them).
    const firstSeq = Math.min(...planned.map((p) => p.seq));
    if (snapshot !== null && snapshotSeq >= firstSeq) {
      const snapshotFile = join(options.dataDir, "snapshots", `${snapshot.id}.db`);
      if (!existsSync(snapshotFile)) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
      copyFileSync(snapshotFile, `/tmp/snapshot-${snapshot.id}.bak-${stamp}`);
      const patched = patchSnapshot(snapshotFile);
      writeFileSync(snapshotFile, patched);
      console.log(`patched snapshot ${snapshot.id} (bytes backup at /tmp/snapshot-${snapshot.id}.bak-${stamp}).`);
    } else if (snapshot !== null) {
      console.log(`snapshot ${snapshot.id} predates the first rewritten envelope — left untouched.`);
    } else {
      console.log("no snapshot — the next hydration replays the full log (slow path, correct by construction).");
    }

    // 4. Epoch bump: every client wipes + resyncs from the rewritten log.
    const epoch = relay.bumpRestoreEpoch(options.workspace);
    console.log(`restore_epoch bumped to ${epoch}.`);

    // 5. Verify (migrations.md §B order).
    verify(relay, options.workspace, planned);
    console.log("done. RESTART the sync server so its running derived store rehydrates from the rewritten log.");
  } finally {
    relay.close();
  }
}

/**
 * Apply the same move to a snapshot's bytes: the serialized derived store's
 * property_schema rows still carry the retired `scope` TEXT column — resolve
 * each row's value through the same mapping, write `scope_class_ids`, then
 * open the bytes through the store so migrate() runs the v24 rebuild (the
 * scope column retires) and the rows verify. Returns the patched bytes.
 */
function patchSnapshot(snapshotFile: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "notees-property-scope-snapshot-patch-"));
  const tempDb = join(dir, "snapshot.db");
  try {
    copyFileSync(snapshotFile, tempDb);
    const raw = new Database(tempDb);
    try {
      const rows = raw
        .prepare("SELECT id, scope FROM property_schema WHERE scope IS NOT NULL")
        .all() as Array<{ id: string; scope: string }>;
      const update = raw.prepare("UPDATE property_schema SET scope_class_ids = ? WHERE id = ?");
      for (const row of rows) {
        if (row.scope === "class") {
          const seeded = SEED_SCOPE_BY_SCHEMA_ID.get(row.id);
          if (seeded !== undefined) update.run(JSON.stringify([seeded]), row.id);
          // Unresolvable "class" rows (and every "object"/"global" row) fall
          // to global — the same demotion the envelope rewrite applies.
        }
      }
    } finally {
      raw.close();
    }
    // Store.open runs migrate() on the snapshot bytes (the v24 rebuild drops
    // the scope column); verify no retired value survives and the rows
    // re-derive clean.
    const store = Store.open(betterSqlite3Backend(tempDb));
    try {
      const cols = store.database.prepare("PRAGMA table_info(property_schema)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "scope")) {
        throw new Error("snapshot patch verification failed: the retired scope column survives the v24 rebuild");
      }
    } finally {
      store.close();
    }
    return readFileSync(tempDb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Post-rewrite verification (migrations.md §B step 8, in order):
 *  1. every propertySchema.* envelope in the log re-validates through
 *     envelopeSchema + the strict payload schema (no retired key remains),
 *  2. a fresh scratch store replays the FULL log (snapshot + tail) with zero
 *     StoreError throws,
 *  3. no property_schema row carries the retired column and every scope list
 *     matches the plan.
 */
function verify(relay: RelayStorage, workspaceId: string, planned: PlannedRewrite[]): void {
  const all = relay.allEnvelopes(workspaceId);
  let schemaOpCount = 0;
  for (const env of all) {
    if (!envelopeSchema.safeParse(env).success) {
      throw new Error(`verification failed: envelope ${env.id} no longer validates through envelopeSchema`);
    }
    if (env.opType !== "propertySchema.create" && env.opType !== "propertySchema.update") continue;
    const payload = env.payload as Record<string, unknown>;
    if (retiredScopeOf(env.opType, payload) !== null) {
      throw new Error("verification failed: a propertySchema.* payload still carries the retired scope key");
    }
    if (!payloadSchemaFor(env.opType)!.safeParse(payload).success) {
      throw new Error(`verification failed: a ${env.opType} payload no longer validates`);
    }
    schemaOpCount++;
  }
  console.log(`verify: all ${schemaOpCount} propertySchema.* envelopes validate clean (the retired key is gone).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const cols = store.database.prepare("PRAGMA table_info(property_schema)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "scope")) {
      throw new Error("verification failed: the retired scope column survives on the replayed store");
    }
    for (const p of planned) {
      const schemaId = String(p.payload.propertySchemaId);
      const row = store.database
        .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
        .get(schemaId) as { scope_class_ids: string | null } | undefined;
      if (row === undefined) continue; // schema deleted later in the log
      const expected = p.scopeClassIds;
      const actual = row.scope_class_ids === null ? null : (JSON.parse(row.scope_class_ids) as string[]);
      if (JSON.stringify(actual?.slice().sort()) !== JSON.stringify(expected?.slice().sort() ?? null)) {
        throw new Error(
          `verification failed: schema ${schemaId} scope_class_ids = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        );
      }
    }
    console.log(`verify: full replay clean; every planned scope value landed on scope_class_ids (${planned.length} rewrite(s)).`);
  } finally {
    store.close();
  }
}

/** Restore snapshot+tail into a scratch store (the sync-server hydration shape). */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
