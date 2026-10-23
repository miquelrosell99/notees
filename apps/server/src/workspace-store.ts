/**
 * Per-workspace @notees/store instances (derived state at
 * <dataDir>/derived/<workspaceId>.db), hydrated by replaying the relay log.
 *
 * One write path for everything: `apply` persists the envelopes to the relay
 * log FIRST and only then applies the newly-saved ones to the derived store
 * (the original order; the log is the durability boundary). A simple in-process promise
 * queue per workspace serializes writers (better-sqlite3 is synchronous, but
 * the ingest+apply pair must not interleave across concurrent requests).
 *
 * Hydration converges after crashes at any point: envelopes already in the
 * log but not in applied_envelope are simply applied on open, in seq order,
 * one at a time (a schema-valid but not-yet-applicable envelope — e.g. a
 * create whose parent has not arrived — is skipped and retried on the next
 * boot, instead of poisoning the whole replay). Fast path: an empty store
 * with a snapshot covering the log tail restores the snapshot bytes first.
 * Post-replay, a workspace whose log has no snapshot at all gets one from
 * the freshly converged store so the next fresh client restores
 * instead of replaying the whole log.
 *
 * Workspace images (clone/import): snapshotImage takes a consistent online
 * backup of a live store; installImage rewrites a cloned image's
 * workspace_id rows into an ENVELOPE-EMPTY workspace's derived file (the
 * next storeFor hydrates from it — the snapshot fast path only fires while
 * the log is empty, so installing into a workspace with seed envelopes would
 * silently never apply).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { isEncryptedPayload, type Envelope } from "@notees/protocol";
import { Store, StoreError } from "@notees/store";
import type { ChangeSummary } from "@notees/store";
import { uuidv7 } from "uuidv7";

import type { RelayStorage } from "./relay-storage.js";

/**
 * Post-replay snapshot self-heal threshold. Below one catch-up
 * page a fresh client converges from seq 0 about as fast as a snapshot
 * restore, so the server-side snapshot write would buy nothing; the client
 * upload path covers those smaller logs in steady state.
 */
export const SNAPSHOT_REBUILD_MIN_ENVELOPES = 1_000;

interface WorkspaceHandle {
  store: Store;
  queue: Promise<unknown>;
  hydrated: boolean;
  /** Envelopes skipped during replay (not yet applicable). */
  pending: number;
}

export interface ApplyOutcome {
  savedIds: string[];
  seqs: Record<string, number>;
  summaries: ChangeSummary[];
}

/**
 * Snapshot-image refusal (clone/import). `status` is the HTTP status the
 * route surfaces: 409 `conflict` for a workspace-state clash (open handle,
 * non-empty log), 422 `validation_failed` for an unusable image or source.
 */
export type WorkspaceImageErrorCode =
  | "no_store_file"
  | "empty_workspace"
  | "workspace_open"
  | "workspace_not_empty"
  | "invalid_image";

export class WorkspaceImageError extends Error {
  constructor(
    readonly code: WorkspaceImageErrorCode,
    message: string,
    readonly status: 409 | 422,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

type Db = InstanceType<typeof Database>;

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0");

/**
 * Re-point every workspace-scoped row of a store image at `workspaceId`.
 * An image cloned from another workspace still carries the source's
 * workspace_id everywhere; every table with such a column is rewritten in
 * place (measured ~0.1 s for 54k rows on a 125 MB image).
 */
function rewriteImageWorkspaceId(db: Db, workspaceId: string): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "workspace_id")) continue;
    db.prepare(`UPDATE ${quoted} SET workspace_id = ?`).run(workspaceId);
  }
}

export class WorkspaceManager {
  private readonly handles = new Map<string, WorkspaceHandle>();

  constructor(
    private readonly relay: RelayStorage,
    private readonly derivedDir: string,
  ) {}

  private handle(workspaceId: string): WorkspaceHandle {
    let handle = this.handles.get(workspaceId);
    if (handle !== undefined) return handle;
    mkdirSync(dirname(this.pathFor(workspaceId)), { recursive: true });
    handle = {
      store: Store.openFile(this.pathFor(workspaceId)),
      queue: Promise.resolve(),
      hydrated: false,
      pending: 0,
    };
    this.handles.set(workspaceId, handle);
    this.hydrate(handle, workspaceId);
    return handle;
  }

  private pathFor(workspaceId: string): string {
    return join(this.derivedDir, `${workspaceId}.db`);
  }

  private hydrate(handle: WorkspaceHandle, workspaceId: string): void {
    const appliedCount = (
      handle.store.database
        .prepare("SELECT COUNT(*) AS n FROM applied_envelope")
        .get() as { n: number }
    ).n;
    const snapshot = this.relay.latestSnapshot(workspaceId);
    const maxSeq = this.relay.latestSeq(workspaceId);
    if (appliedCount === 0 && snapshot !== null && snapshot.up_to_seq >= maxSeq) {
      const bytes = this.relay.readSnapshotData(snapshot.id);
      if (bytes !== null && bytes.length > 0) {
        handle.store.restore(bytes);
      }
    }
    // Replay remaining log envelopes; applyMany-style idempotency (applied_envelope)
    // makes the overlap with a restored snapshot harmless. The E2EE slot
    // ({"$e": …}) rides the log but is not applicable to derived state.
    const log = this.relay.allEnvelopes(workspaceId);
    let pending = 0;
    for (const envelope of log) {
      if (handle.store.hasApplied(envelope.id)) continue;
      if (isEncryptedPayload(envelope.payload)) continue;
      try {
        handle.store.apply(envelope);
      } catch (error) {
        if (error instanceof StoreError) {
          pending += 1;
          continue;
        }
        throw error;
      }
    }
    handle.pending = pending;
    handle.hydrated = true;
    this.ensureSnapshotAfterReplay(workspaceId, handle);
  }

  /**
   * Snapshot self-heal. A workspace whose log has NO snapshot (a
   * post-restore wipe dropped them; a fresh relay never had a client upload
   * one) leaves every fresh client to replay the whole log (~minutes at
   * live scale — the missing-snapshot gap after the log migration). The
   * store was just converged by the replay above, so the server's own
   * derived state is the natural snapshot source: persist it once, covering
   * the log tail. Snapshots are an optimization, never authority — the log
   * stays the durability boundary, restore + catch-up from `up_to_seq`
   * converges to the same state as a full replay, and a failed write here
   * changes nothing about correctness.
   *
   * Fires at most once per wipe: only when no snapshot row exists at all.
   * Below the envelope threshold the write buys nothing (see the constant).
   */
  private ensureSnapshotAfterReplay(workspaceId: string, handle: WorkspaceHandle): void {
    if (this.relay.latestSnapshot(workspaceId) !== null) return;
    if (this.relay.envelopeCount(workspaceId) < SNAPSHOT_REBUILD_MIN_ENVELOPES) return;
    try {
      const bytes = handle.store.snapshot();
      this.relay.saveSnapshot(
        workspaceId,
        uuidv7(),
        this.relay.maxHlc(workspaceId),
        this.relay.latestSeq(workspaceId),
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      );
    } catch {
      // Best-effort, mirroring the client engine's maybeUploadSnapshot: a
      // failed snapshot write must never fail hydration.
    }
  }

  /**
   * Enqueue an ingest+apply for the workspace. Resolves with the envelopes
   * actually saved (duplicates ignored) and their summaries.
   */
  apply(workspaceId: string, envelopes: Envelope[]): Promise<ApplyOutcome> {
    const handle = this.handle(workspaceId);
    const task = handle.queue.then(() => this.applyNow(handle, workspaceId, envelopes));
    handle.queue = task.catch(() => undefined);
    return task;
  }

  private applyNow(handle: WorkspaceHandle, workspaceId: string, envelopes: Envelope[]): ApplyOutcome {
    const { savedIds, seqs } = this.relay.ingest(envelopes);
    if (savedIds.length === 0) {
      return { savedIds, seqs, summaries: [] };
    }
    const saved = new Set(savedIds);
    const fresh = envelopes.filter(
      (env) => saved.has(env.id) && !isEncryptedPayload(env.payload),
    );
    if (fresh.length === 0) {
      return { savedIds, seqs, summaries: [] };
    }
    const summaries = handle.store.applyMany(fresh);
    return { savedIds, seqs, summaries };
  }

  /** Read access: the (hydrated) store for a workspace. */
  storeFor(workspaceId: string): Store {
    return this.handle(workspaceId).store;
  }

  isHydrated(workspaceId: string): boolean {
    return this.handle(workspaceId).hydrated;
  }

  /** Drop a workspace's derived handle and database file (workspace deletion). */
  async drop(workspaceId: string): Promise<void> {
    const handle = this.handles.get(workspaceId);
    if (handle !== undefined) {
      await handle.queue.catch(() => undefined);
      handle.store.close();
      this.handles.delete(workspaceId);
    }
    try {
      unlinkSync(this.pathFor(workspaceId));
    } catch {
      // File already gone — nothing to unlink.
    }
  }

  /**
   * A consistent byte image of a workspace's derived store: drain the
   * workspace's write queue, then an online backup of the LIVE database to a
   * temp file under the derived dir (better-sqlite3's backup API — a plain
   * file copy could tear mid-write). Throws when the workspace has no
   * derived store file or carries no node rows (nothing to clone).
   */
  async snapshotImage(workspaceId: string): Promise<Buffer> {
    let handle = this.handles.get(workspaceId);
    if (handle === undefined) {
      if (!existsSync(this.pathFor(workspaceId))) {
        throw new WorkspaceImageError(
          "no_store_file",
          `workspace ${workspaceId} has no derived store — nothing to snapshot`,
          422,
        );
      }
      handle = this.handle(workspaceId);
    }
    await handle.queue.catch(() => undefined);
    const nodeCount = (
      handle.store.database.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number }
    ).n;
    if (nodeCount === 0) {
      throw new WorkspaceImageError(
        "empty_workspace",
        `workspace ${workspaceId} has no nodes — nothing to snapshot`,
        422,
      );
    }
    mkdirSync(this.derivedDir, { recursive: true });
    const tempPath = join(this.derivedDir, `.image-${workspaceId}-${uuidv7()}.tmp.db`);
    try {
      try {
        unlinkSync(tempPath);
      } catch {
        // Fresh temp name — nothing to unlink.
      }
      // `database` is the store package's backend-neutral wrapper; the
      // server always runs the better-sqlite3 file backend, whose raw
      // connection's backup API takes the consistent online snapshot.
      const wrapped = handle.store.database as unknown as { raw?: Db };
      if (wrapped.raw === undefined || typeof wrapped.raw.backup !== "function") {
        throw new Error("workspace store is not backed by better-sqlite3 — cannot snapshot");
      }
      await wrapped.raw.backup(tempPath);
      return readFileSync(tempPath);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Temp already gone — nothing to unlink.
      }
    }
  }

  /**
   * Install a snapshot image (serialized @notees/store bytes, usually cloned
   * from another workspace) as this workspace's derived store file, rewriting
   * every workspace_id row to `workspaceId`. The workspace must be
   * ENVELOPE-EMPTY: the next storeFor hydrates by restoring the snapshot, and
   * that fast path only fires while the log is empty (up_to_seq >= maxSeq).
   * Refuses when a handle is open here (the live store would shadow the file)
   * or the relay log already carries envelopes. Opens nothing — the next
   * storeFor hydrates from the file. A stale derived file from a previous
   * process is overwritten.
   */
  installImage(workspaceId: string, bytes: Buffer): { nodeCount: number } {
    if (this.handles.has(workspaceId)) {
      throw new WorkspaceImageError(
        "workspace_open",
        `workspace ${workspaceId} has an open derived store in this process — drop it before installing an image`,
        409,
      );
    }
    if (this.relay.envelopeCount(workspaceId) > 0) {
      throw new WorkspaceImageError(
        "workspace_not_empty",
        `workspace ${workspaceId} already has a relay log — images only install into envelope-empty workspaces`,
        409,
      );
    }
    if (bytes.length < SQLITE_MAGIC.length || !bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      throw new WorkspaceImageError(
        "invalid_image",
        "image is not a serialized @notees/store database (bad SQLite magic)",
        422,
      );
    }
    mkdirSync(this.derivedDir, { recursive: true });
    const tempPath = join(this.derivedDir, `.install-${workspaceId}-${uuidv7()}.tmp.db`);
    let nodeCount = 0;
    try {
      writeFileSync(tempPath, bytes);
      const db = new Database(tempPath);
      try {
        rewriteImageWorkspaceId(db, workspaceId);
        nodeCount = (db.prepare("SELECT COUNT(*) AS n FROM node").get() as { n: number }).n;
      } catch (error) {
        throw new WorkspaceImageError(
          "invalid_image",
          `image is not a @notees/store database with a node table: ${
            error instanceof Error ? error.message : String(error)
          }`,
          422,
        );
      } finally {
        db.close();
      }
      if (nodeCount === 0) {
        throw new WorkspaceImageError(
          "invalid_image",
          "image carries no node rows — refusing to install an empty workspace image",
          422,
        );
      }
      try {
        unlinkSync(this.pathFor(workspaceId));
      } catch {
        // No stale file — nothing to unlink.
      }
      renameSync(tempPath, this.pathFor(workspaceId));
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Installed (renamed) or already removed — nothing to clean.
      }
    }
    return { nodeCount };
  }

  async close(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.queue.catch(() => undefined);
      handle.store.close();
    }
    this.handles.clear();
  }
}
