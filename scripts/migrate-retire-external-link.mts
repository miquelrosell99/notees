/**
 * external_link retirement: the inline external-link
 * token is retired — links live as markdown `[label](href)` spans inside
 * ordinary `text` tokens, parsed at render time (SCHEMA.md render grammar).
 * Rationale: the token was invisible in the web editor (zero-length prose
 * span), authored only by the `/url` slash command with text = href, and
 * silently dropped by the document-chrome content flatten — markdown-in-text
 * survives every boundary and is what imports already produce.
 *
 * The strict `contentTokenSchema` no longer lists the type (the
 * no-backward-compatibility law), and the op payload's `contentAst` is a
 * loose `z.array(z.unknown())` — runtime ingest never validates token types,
 * so an un-migrated log would still APPLY but the retired token would render
 * as nothing (web), a placeholder (Flutter), or fail GTK's strict test-time
 * grammar port. The live relay log carrying `external_link` envelopes must
 * be rewritten in place so the data matches the grammar.
 *
 * LOCKSTEP LAW (migrations.md §2): the TS reference ships first, then the
 * GTK + Flutter ports, and only then does this run.
 *
 * The migrations.md §B sequence this script implements:
 *  1. Plan from authority: scan the relay `envelope` table for payloads
 *     containing the retired token type (raw rows — the rewrite targets
 *     seqs). Tokens are rewritten top-level and inside quote/heading
 *     children; `contentDeltaB64` payloads abort the run loudly (the carrier
 *     is designed-not-implemented — there must be none).
 *  2. Backup: `relay.db` + the server derived DBs to /tmp.
 *  3. IN-PLACE envelope rewrite, one transaction: each retired token becomes
 *     a `text` token — `[text](href)` when the pair satisfies the render
 *     grammar (http/https/mailto href without whitespace/parens; label
 *     without `]`/newline/backslash), otherwise `text (href)` so the URL
 *     stays visible and never a broken link. seq/id/HLC untouched; every
 *     rewritten payload re-validates through `payloadSchemaFor(opType)`
 *     BEFORE it is written. NO compensation envelopes (pure token→token).
 *  4. Snapshot patch: every `snapshots/*.db` whose `node.content` carries
 *     the retired token gets the same rewrite in a per-file transaction,
 *     asserted clean afterwards. (Note: document-chrome derived rows may
 *     not carry the token at all — the pre-retirement flatten silently
 *     dropped it; the LIKE scan finds whichever rows do.)
 *  5. Server derived DBs: same patch in place.
 *  6. Bump `restore_epoch` (per affected workspace): without it,
 *     `applied_envelope` id-skips the rewritten envelopes on every replica.
 *  7. Verify, in the runbook's order: rewritten envelopes re-validate →
 *     fresh scratch replay of the FULL personal-workspace log with zero
 *     StoreError throws and zero retired bytes → every snapshot file and
 *     derived DB reports zero remaining occurrences.
 *
 * Idempotent: a second run finds no retired tokens and plans nothing.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies.
 *
 * THE SYNC SERVER MUST BE STOPPED BEFORE --apply (relay.db may never be
 * edited while the server runs — operations law 1).
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-retire-external-link.mts \
 *     --data-dir ../../config/notees/sync [--apply]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import {
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const PERSONAL_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const RETIRED = "external_link";

// The SCHEMA.md render grammar (kept in sync with packages/domain
// markdownLinks.ts): the label holds no `]` or newline, the href holds no
// whitespace or parentheses, and only http/https/mailto hrefs linkify.
const LINKABLE_HREF_RE = /^(https?:\/\/|mailto:)/i;
const HREF_SAFE_RE = /^[^()\s]+$/;
const LABEL_SAFE_RE = /^[^\]\n\\]+$/;

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    apply: argv.includes("--apply"),
  };
}

// --- helpers ------------------------------------------------------------------

interface PlannedEnvelope {
  seq: number;
  id: string;
  workspaceId: string;
  opType: string;
  payload: Record<string, unknown>;
  tokens: number;
}

/** The markdown text a retired token reincarnates as (see module doc). */
function replacementText(text: string, href: string): string {
  if (LINKABLE_HREF_RE.test(href) && HREF_SAFE_RE.test(href) && LABEL_SAFE_RE.test(text)) {
    return `[${text}](${href})`;
  }
  return `${text} (${href})`;
}

/** Rewrite retired tokens in one token array; returns the token count. */
function rewriteTokenArray(tokens: unknown): { tokens: unknown; count: number } {
  if (!Array.isArray(tokens)) return { tokens, count: 0 };
  let count = 0;
  const rewritten = tokens.map((token) => {
    if (token === null || typeof token !== "object") return token;
    const record = token as Record<string, unknown>;
    if (record.type === RETIRED) {
      const text = typeof record.text === "string" ? record.text : "";
      const href = typeof record.href === "string" ? record.href : "";
      count++;
      return { type: "text", text: replacementText(text, href) };
    }
    // The two nested containers (quote/heading) carry inline token arrays.
    if ((record.type === "quote" || record.type === "heading") && Array.isArray(record.children)) {
      const children = rewriteTokenArray(record.children);
      if (children.count > 0) {
        count += children.count;
        return { ...record, children: children.tokens };
      }
    }
    return token;
  });
  return count === 0 ? { tokens, count: 0 } : { tokens: rewritten, count };
}

/** The retired-token count inside a payload's contentAst, if any. */
function retiredTokensOf(payload: Record<string, unknown>): number {
  if (payload.contentDeltaB64 !== undefined) {
    throw new Error(
      `payload carries contentDeltaB64 (the designed-not-implemented CRDT carrier) — cannot rewrite safely; investigate by hand`,
    );
  }
  return rewriteTokenArray(payload.contentAst).count;
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

/**
 * Patch one derived-format DB (a snapshot or the server derived store):
 * rewrite the retired tokens inside every `node.content` row that carries
 * them, in a transaction; assert zero occurrences remain. Returns the
 * row/token counts. (`node.content` IS the AST JSON array.)
 */
function patchStoreDb(file: string): { rows: number; tokens: number } {
  const db = new Database(file);
  try {
    const hits = db
      .prepare(`SELECT id, content FROM node WHERE content LIKE '%${RETIRED}%'`)
      .all() as Array<{ id: string; content: string }>;
    let tokens = 0;
    const update = db.prepare("UPDATE node SET content = ? WHERE id = ?");
    const tx = db.transaction(() => {
      for (const row of hits) {
        const result = rewriteTokenArray(JSON.parse(row.content));
        if (result.count > 0) {
          update.run(JSON.stringify(result.tokens), row.id);
          tokens += result.count;
        }
      }
    });
    tx();
    const remaining = (
      db.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
    ).n;
    if (remaining > 0) {
      throw new Error(`snapshot/derived patch verification failed: ${remaining} row(s) still carry ${RETIRED}`);
    }
    return { rows: hits.length, tokens };
  } finally {
    db.close();
  }
}

/** List the *.db files under a directory (excluding sqlite sidecars). */
function dbFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => join(dir, f));
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    // 1. Plan: scan the stored log rows for payloads carrying the retired
    //    token (any workspace).
    const rows = relay.db
      .prepare(`SELECT seq, id, workspace_id, op_type, payload FROM envelope WHERE payload LIKE '%${RETIRED}%' ORDER BY seq ASC`)
      .all() as Array<{ seq: number; id: string; workspace_id: string; op_type: string; payload: string }>;
    const affected: PlannedEnvelope[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const tokens = retiredTokensOf(payload);
      if (tokens > 0) affected.push({ seq: row.seq, id: row.id, workspaceId: row.workspace_id, opType: row.op_type, payload, tokens });
    }

    console.log(`${RETIRED} retirement (data dir ${options.dataDir}):`);
    if (affected.length === 0) {
      console.log("  no envelope carries the retired token — nothing to rewrite.");
      return;
    }
    const workspaces = [...new Set(affected.map((env) => env.workspaceId))];
    const totalTokens = affected.reduce((sum, env) => sum + env.tokens, 0);
    console.log(
      `  ${affected.length} envelope(s) across ${workspaces.length} workspace(s) carry ${totalTokens} retired token(s) — rewritten in place (seq/id/HLC untouched):`,
    );
    for (const env of affected.slice(0, 8)) {
      console.log(`    seq ${env.seq}  ${env.opType}  ${env.id.slice(0, 13)}…  (${env.tokens} token(s))`);
    }
    if (affected.length > 8) console.log(`    … and ${affected.length - 8} more`);

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (STOP the sync server first; backup → envelope rewrite → snapshot + derived patch → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------

    // 2. Backup: the relay log (the authority) + the server derived DBs.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(tmpdir(), `notees-external-link-bak-${stamp}`);
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(join(options.dataDir, "relay.db"), join(backupDir, "relay.db"));
    let backedUp = 1;
    for (const file of dbFiles(join(options.dataDir, "derived"))) {
      copyFileSync(file, join(backupDir, basename(file)));
      backedUp++;
    }
    console.log(`\nbackup: ${backupDir} (${backedUp} file(s) — relay.db + derived; snapshots are log-derivations, patched in place without bytes-backup).`);

    // 3. Envelope rewrite, one transaction. Every rewritten payload
    //    re-validates through the strict payload schema BEFORE it is written.
    const rewrite = relay.db.transaction(() => {
      for (const env of affected) {
        const rewrittenPayload = {
          ...env.payload,
          contentAst: rewriteTokenArray(env.payload.contentAst).tokens,
        };
        const schema = payloadSchemaFor(env.opType);
        if (schema === undefined || !schema.safeParse(rewrittenPayload).success) {
          throw new Error(`rewritten envelope ${env.id} (seq ${env.seq}) fails payloadSchemaFor('${env.opType}') — aborting before write`);
        }
        relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(rewrittenPayload), env.seq, env.workspaceId);
      }
    });
    rewrite();
    console.log(`rewrote ${affected.length} envelope(s) in place (${totalTokens} token(s) → text tokens); no compensation envelopes.`);

    // 4. Snapshot patch: every snapshot DB carrying the retired token gets
    //    the same rewrite, verified per file.
    const snapshotsDir = join(options.dataDir, "snapshots");
    const snapshotFiles = dbFiles(snapshotsDir);
    let patchedSnapshots = 0;
    let snapshotFailures = 0;
    for (const file of snapshotFiles) {
      const probe = new Database(file, { readonly: true, fileMustExist: true });
      let hits: number;
      try {
        hits = (
          probe.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
        ).n;
      } catch {
        hits = 0; // not a store-format DB — leave it alone.
      } finally {
        probe.close();
      }
      if (hits === 0) continue;
      try {
        const result = patchStoreDb(file);
        patchedSnapshots++;
        if (patchedSnapshots <= 5 || patchedSnapshots % 50 === 0) {
          console.log(`  snapshot ${basename(file)}: ${result.rows} row(s), ${result.tokens} token(s) rewritten`);
        }
      } catch (error) {
        snapshotFailures++;
        console.error(`  snapshot ${basename(file)} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`patched ${patchedSnapshots} snapshot DB(s); ${snapshotFailures} failure(s).`);
    if (snapshotFailures > 0) {
      throw new Error("aborting: snapshot patch failures — inspect the failures above before bumping the epoch");
    }

    // 5. Server derived DBs: same patch (the restart rehydrates them anyway).
    for (const file of dbFiles(join(options.dataDir, "derived"))) {
      const result = patchStoreDb(file);
      console.log(`derived ${basename(file)}: ${result.rows} row(s), ${result.tokens} token(s) rewritten`);
    }

    // 6. Epoch bump: every affected workspace's clients wipe + resync clean.
    for (const workspaceId of workspaces) {
      const epoch = relay.bumpRestoreEpoch(workspaceId);
      console.log(`restore_epoch for ${workspaceId} bumped to ${epoch}.`);
    }

    // 7. Verify (migrations.md §B step 8, in order).
    verify(relay, PERSONAL_WORKSPACE, snapshotsDir);
    console.log("done. START the sync server so its derived store rehydrates from the rewritten log.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification (migrations.md §B step 8):
 *  1. every envelope re-validates through envelopeSchema (no retired token
 *     remains anywhere in the log),
 *  2. a fresh scratch store replays the FULL personal-workspace log
 *     (snapshot + tail) with zero StoreError throws and zero retired bytes,
 *  3. every snapshot file reports zero remaining occurrences.
 */
function verify(relay: RelayStorage, workspaceId: string, snapshotsDir: string): void {
  const all = relay.allEnvelopes(workspaceId);
  for (const env of all) {
    if (!envelopeSchema.safeParse(env).success) {
      throw new Error(`verification failed: envelope ${env.id} no longer validates through envelopeSchema`);
    }
  }
  const remainingLog = (
    relay.db.prepare(`SELECT COUNT(*) AS n FROM envelope WHERE payload LIKE '%${RETIRED}%'`).get() as { n: number }
  ).n;
  if (remainingLog > 0) {
    throw new Error(`verification failed: ${remainingLog} envelope payload(s) still carry ${RETIRED}`);
  }
  console.log(`verify: all ${all.length} personal-workspace envelopes validate clean (retired token gone from the log).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const remaining = (
      store.database.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
    ).n;
    if (remaining > 0) {
      throw new Error(`verification failed: ${remaining} node row(s) in the full replay still carry ${RETIRED}`);
    }
    const markdown = (
      store.database.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%](http%'`).get() as { n: number }
    ).n;
    console.log(`verify: full replay clean — ${markdown} node row(s) carry markdown link text.`);
  } finally {
    store.close();
  }

  let snapshotRemaining = 0;
  for (const file of dbFiles(snapshotsDir)) {
    const probe = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const n = (
        probe.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
      ).n;
      snapshotRemaining += n;
    } catch {
      // not a store-format DB — nothing to verify.
    } finally {
      probe.close();
    }
  }
  if (snapshotRemaining > 0) {
    throw new Error(`verification failed: ${snapshotRemaining} snapshot node row(s) still carry ${RETIRED}`);
  }
  console.log("verify: every snapshot DB reports zero retired occurrences.");
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
