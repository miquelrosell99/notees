/**
 * The shared scratch-store lib — the sealed gate + the keyed-workspace guard
 * every migrate script rides (the 2026-11-06 mandatory-keying slice).
 *
 * `buildScratchStore` is the ONE copy of the scratch-builder every
 * `migrate-*.mts` script carried locally (extracted verbatim from
 * scripts/migrate-repeat-property.mts, the reference implementation): the
 * hydration shape the sync server uses — the workspace's latest snapshot
 * restored into a fresh in-memory store, then every log envelope after it.
 * A SEALED latest snapshot (an E2EE-keyed workspace's checkpoint) is NEVER
 * restored — the blob cannot open into a plaintext projection
 * (workspace-store.ts hydration, the 2026-11-05 ruling), so the tail replay
 * rebuilds the plaintext prefix from the log instead. Encrypted payloads
 * skip the apply and StoreError skips count as pending — a keyed workspace's
 * sealed content is invisible to a server-side plan BY DESIGN (reported via
 * `onSkip`, never silently). Anything else that fails still throws: a
 * plaintext tail that cannot apply must block the migration, not be planned
 * against.
 *
 * `keyedWorkspaceIds` + `refuseIfContentOnKeyed` are the content-class guard:
 * the `workspace_key` custody table (auth.ts, the same relay.db the migrate
 * scripts take via --data-dir) names the workspaces whose content is sealed
 * server-side. A "content"-class migration plans against the derived state —
 * against a keyed workspace that state is missing the sealed prefix by
 * design, so the run refuses loudly and routes through a keyed client;
 * "scaffolding"-class migrations (schema/binding rows the server CAN see)
 * ride the scratch build as before.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

// The lib lives outside the server package, so the bare specifier does not
// resolve from here — go through the server's dependency (the same
// better-sqlite3 build the relay storage uses), the migrate-e2ee.mts idiom.
// @ts-expect-error the deep import carries no types (bare specifier does not
// resolve from scripts/) — the local Db alias below is the typed surface.
import Database from "../../apps/server/node_modules/better-sqlite3/lib/index.js";

import { isEncryptedPayload, type Envelope } from "../../packages/protocol/src/envelope.ts";
import { Store } from "../../packages/store/src/index.ts";
import { StoreError } from "../../packages/store/src/errors.ts";
import { betterSqlite3Backend } from "../../packages/store/src/adapters/better-sqlite3.ts";

import type { RelayStorage } from "../../apps/server/src/relay-storage.ts";

type Db = InstanceType<typeof Database>;

/**
 * The scratch build's skip accounting: sealed envelopes the server cannot open.
 */
export interface ScratchCounts {
  encrypted: number;
  pending: number;
}

/**
 * The third-parameter bag: `onSkip` prints the house skip line; `onApplyError`
 * is the repair-script idiom — called per envelope whose apply throws INSTEAD
 * of the default (StoreError counting as pending, anything else throwing), so
 * the caller classifies the failure and the build continues. Encrypted
 * payloads never reach either hook — they skip the apply by the sealed rule
 * and count toward `onSkip`.
 */
export interface ScratchHooks {
  onSkip?: (counts: ScratchCounts) => void;
  onApplyError?: (envelope: Envelope, error: unknown) => void;
}

/**
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the hydration shape the sync server
 * uses). A SEALED latest snapshot (an E2EE-keyed client's checkpoint) is
 * never restored — the blob cannot open into a plaintext projection
 * (workspace-store.ts hydration, the 2026-11-05 ruling), so the tail replay
 * rebuilds the plaintext prefix from the log instead. Encrypted payloads
 * skip the apply and StoreError skips count as pending — a keyed workspace's
 * sealed content is invisible to a server-side plan BY DESIGN (reported via
 * `onSkip`, never silently). Anything else that fails still throws: a
 * plaintext tail that cannot apply must block the migration, not be planned
 * against.
 *
 * When skips occurred and `onSkip` is given, it is called ONCE with the
 * counts — the caller prints the house skip line.
 *
 * The third parameter is the callback or the {@link ScratchHooks} bag (the
 * repair-script idiom: a per-envelope apply-failure hook that classifies
 * instead of the default skip/throw).
 */
export function buildScratchStore(
  relay: RelayStorage,
  workspaceId: string,
  onSkip?: ((counts: ScratchCounts) => void) | ScratchHooks,
): Store {
  const hooks: ScratchHooks = typeof onSkip === "function" ? { onSkip } : (onSkip ?? {});
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null && snapshot.sealed !== 1) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  let skippedEncrypted = 0;
  let skippedPending = 0;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) {
      if (isEncryptedPayload(envelope.payload)) {
        skippedEncrypted += 1;
        continue;
      }
      try {
        store.apply(envelope);
      } catch (error) {
        if (hooks.onApplyError !== undefined) {
          // The repair idiom: the caller classifies the failure, the build
          // continues (a failed op is never applied, so the as-of state
          // stays consistent for the NEXT envelope).
          hooks.onApplyError(envelope, error);
          continue;
        }
        if (error instanceof StoreError) {
          skippedPending += 1;
          continue;
        }
        store.close();
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`tail apply failed at seq > ${cursor}: ${detail}`);
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  if (skippedEncrypted + skippedPending > 0 && hooks.onSkip !== undefined) {
    hooks.onSkip({ encrypted: skippedEncrypted, pending: skippedPending });
  }
  return store;
}

/**
 * The migration's content class: "content" migrations plan against the
 * object graph (invisible server-side on a keyed workspace — refused), while
 * "scaffolding" migrations touch the schema/binding rows every replica
 * derives identically.
 */
export type MigrationContentClass = "scaffolding" | "content";

/**
 * The ids of every keyed workspace in the data dir — the `workspace_key`
 * custody table (auth.ts) of `<dataDir>/relay.db`, opened READ-ONLY. The
 * table may be absent (an older data dir, a relay that never ran the auth
 * DDL) and the db may not exist at all: both answer an empty set, never a
 * throw.
 */
export function keyedWorkspaceIds(dataDir: string): Set<string> {
  const dbPath = join(dataDir, "relay.db");
  if (!existsSync(dbPath)) return new Set();
  const db: Db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_key'")
      .get();
    if (table === undefined) return new Set();
    const rows = db.prepare("SELECT workspace_id FROM workspace_key").all() as Array<{
      workspace_id: string;
    }>;
    return new Set(rows.map((row) => row.workspace_id));
  } finally {
    db.close();
  }
}

/**
 * The content-class guard: a "content"-class migration refuses to run
 * server-side against a keyed workspace — the sealed content is invisible to
 * the scratch plan by design, so the run routes through a keyed client.
 * "scaffolding"-class runs and unkeyed workspaces pass silent.
 */
export function refuseIfContentOnKeyed(
  dataDir: string,
  workspaceId: string,
  contentClass: MigrationContentClass,
  scriptName: string,
): void {
  if (contentClass !== "content") return;
  if (!keyedWorkspaceIds(dataDir).has(workspaceId)) return;
  throw new Error(
    `${scriptName}: "content"-class migration refuses to run server-side against keyed ` +
      `workspace ${workspaceId} — sealed content is invisible here; run it through a keyed client`,
  );
}
