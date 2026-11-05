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
  /**
   * The highest relay seq this handle has applied (or confirmed present).
   * The self-heal sweep pages the log from here — an external Path A
   * migration append (a script writing relay.db directly, the documented
   * migrate-*.mts shape) never touches the running process, so an
   * already-open handle would otherwise never learn about the tail until
   * the next boot. The sweep reconciles open handles between boots.
   */
  lastSeq: number;
  /** The self-heal sweep timer (cleared on close/drop). */
  sweepTimer?: NodeJS.Timeout;
}

export interface ApplyOutcome {
  savedIds: string[];
  seqs: Record<string, number>;
  summaries: ChangeSummary[];
}

/**
 * Default self-heal sweep cadence per open workspace handle. Deliberately
 * slow: the sweep exists to converge external appends (Path A migration
 * scripts, a hand-applied fix), which are rare — seconds of lag behind the
 * log is irrelevant next to restart-free convergence.
 */
export const SWEEP_INTERVAL_MS = 20_000;

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
    private readonly sweepIntervalMs: number = SWEEP_INTERVAL_MS,
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
      lastSeq: 0,
    };
    this.handles.set(workspaceId, handle);
    this.hydrate(handle, workspaceId);
    this.startSweep(workspaceId, handle);
    return handle;
  }

  private pathFor(workspaceId: string): string {
    return join(this.derivedDir, `${workspaceId}.db`);
  }

  /**
   * The self-heal sweep: page the relay log from the handle's lastSeq and
   * apply every envelope the derived store has not seen — the exact replay
   * semantics hydration uses (StoreError skips count as pending and are
   * retried on the next pass), so an external append (a Path A migration
   * script writing relay.db while the server runs, the migrate-*.mts idiom)
   * converges the open handle within one interval, no restart needed.
   * Serialized on the workspace queue against writers.
   */
  private startSweep(workspaceId: string, handle: WorkspaceHandle): void {
    if (this.sweepIntervalMs <= 0) return;
    const timer = setInterval(() => {
      const task = handle.queue.then(() => {
        if (!handle.hydrated) return;
        this.replaySince(handle, workspaceId, handle.lastSeq);
      });
      handle.queue = task.catch(() => undefined);
      void task.catch(() => undefined);
    }, this.sweepIntervalMs);
    timer.unref();
    handle.sweepTimer = timer;
  }

  /**
   * Apply every log envelope after `afterSeq` the store has not applied,
   * updating lastSeq/pending. Pages through catchUp (O(delta) per sweep —
   * an allEnvelopes scan per tick would reread a million-row log every
   * interval). StoreError skips count as pending, never poison the pass.
   */
  private replaySince(handle: WorkspaceHandle, workspaceId: string, afterSeq: number): void {
    let cursor = afterSeq;
    let pending = 0;
    for (;;) {
      const page = this.relay.catchUp(workspaceId, cursor, 10_000);
      for (const envelope of page.envelopes) {
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
      if (!page.hasMore || page.nextAfterSeq === null) break;
      cursor = page.nextAfterSeq;
    }
    handle.lastSeq = Math.max(handle.lastSeq, this.relay.latestSeq(workspaceId));
    handle.pending = pending;
  }

  private hydrate(handle: WorkspaceHandle, workspaceId: string): void {
    const appliedCount = (
      handle.store.database
        .prepare("SELECT COUNT(*) AS n FROM applied_envelope")
        .get() as { n: number }
    ).n;
    const snapshot = this.relay.latestSnapshot(workspaceId);
    // Restore the latest snapshot whenever the store is EMPTY — even when
    // the log has moved PAST it. The tail replay below starts at the
    // snapshot's up_to_seq and hasApplied makes any overlap harmless, so a
    // partial-coverage snapshot still saves the full log replay: a 308k-
    // envelope hydrate blocked the event loop for 20+ minutes on a live-
    // scale workspace (2026-11-02) where restore+tail took seconds. The
    // strict up_to_seq >= maxSeq gate only protected against double-
    // applying envelopes the restore already carries — the replay skips
    // them by id, so the gate bought nothing the idempotency didn't.
    let afterSeq = 0;
    if (appliedCount === 0 && snapshot !== null && snapshot.sealed !== 1) {
      const bytes = this.relay.readSnapshotData(snapshot.id);
      if (bytes !== null && bytes.length > 0) {
        handle.store.restore(bytes);
        afterSeq = snapshot.up_to_seq;
      }
    }
    // A SEALED latest snapshot (a keyed client sealed it at upload) is
    // never restored here: the blob cannot open into the server's
    // plaintext projection — restoring it threw SQLITE_NOTADB and
    // poisoned every ingest for the workspace with a 500 (surfaced by the
    // CLI's first keyed sync: the sealed snapshot upload lands, the next
    // batch's hydrate tries to restore it). With the restore skipped the
    // replay below rebuilds the plaintext prefix from the log — encrypted
    // envelopes skip the apply there by the same rule as the self-heal
    // sweep.
    // The E2EE slot ({"$e": …}) rides the log but is not applicable to
    // derived state. StoreError skips count as pending and retry on the
    // next pass (an envelope whose parent has not arrived yet).
    //
    // The full replay runs inside the store's bulk window: per-op
    // node_stats/search maintenance defers to one end-of-rebuild pass —
    // the difference between minutes and seconds at log scale. The sweep's
    // incremental replaySince stays online (never wraps a window).
    handle.store.beginBulk();
    try {
      this.replaySince(handle, workspaceId, afterSeq);
    } finally {
      handle.store.endBulk();
    }
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
      // The server's own image is a PLAINTEXT derived store by construction:
      // sealed envelopes skip the apply, so the blob can never open under a
      // workspace key — the row stays sealed:false (the default) and keyed
      // clients restore it as-is (their meta.sealed branch).
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
    // The poison decision lands BEFORE persistence: an envelope the derived
    // store rejects (a payload-semantic StoreError — e.g. a wrong-typed
    // propertySchema defaultValue) must never sit in the stored log. The
    // persists-then-applies order re-quarantined every such envelope on
    // every future replay (hydration, sweep, fresh-client catch-up).
    // applyMany is one transaction: a mid-batch throw rolls the store back
    // untouched, so a rejected batch leaves no derived state behind either —
    // only the 422 to the writer, whose client-side quarantine owns the op.
    const fresh = envelopes.filter(
      (env) => !this.relay.hasEnvelope(env.id) && !isEncryptedPayload(env.payload),
    );
    let summaries: ChangeSummary[] = [];
    if (fresh.length > 0) {
      summaries = handle.store.applyMany(fresh);
    }
    const { savedIds, seqs } = this.relay.ingest(envelopes);
    if (savedIds.length === 0) {
      return { savedIds, seqs, summaries: [] };
    }
    handle.lastSeq = Math.max(handle.lastSeq, this.relay.latestSeq(workspaceId));
    return { savedIds, seqs, summaries };
  }

  /**
   * Run the self-heal sweep for one workspace NOW (the interval's manual
   * counterpart — admin tooling and tests call this rather than waiting).
   * Serialized on the workspace queue. Returns the post-sweep watermark.
   */
  sweepNow(workspaceId: string): Promise<{ lastSeq: number; pending: number }> {
    const handle = this.handle(workspaceId);
    const task = handle.queue.then(() => {
      this.replaySince(handle, workspaceId, handle.lastSeq);
      return { lastSeq: handle.lastSeq, pending: handle.pending };
    });
    handle.queue = task.catch(() => ({ lastSeq: 0, pending: 0 }));
    return task;
  }

  /**
   * The convergence snapshot the admin surface reports: how far the open
   * handle has applied the log, and how many envelopes are pending skips.
   * Read-only (no sweep trigger — sweepNow is the explicit nudge).
   */
  convergence(workspaceId: string): {
    hydrated: boolean;
    lastSeq: number;
    latestSeq: number;
    pending: number;
    appliedCount: number;
  } {
    const handle = this.handle(workspaceId);
    return {
      hydrated: handle.hydrated,
      lastSeq: handle.lastSeq,
      latestSeq: this.relay.latestSeq(workspaceId),
      pending: handle.pending,
      appliedCount: (
        handle.store.database.prepare("SELECT COUNT(*) AS n FROM applied_envelope").get() as {
          n: number;
        }
      ).n,
    };
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
      if (handle.sweepTimer !== undefined) clearInterval(handle.sweepTimer);
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
      if (handle.sweepTimer !== undefined) clearInterval(handle.sweepTimer);
      await handle.queue.catch(() => undefined);
      handle.store.close();
    }
    this.handles.clear();
  }
}
