/**
 * Per-workspace @notees/store instances (derived state at
 * <dataDir>/derived/<workspaceId>.db), hydrated by replaying the relay log.
 *
 * One write path for everything: `apply` persists the envelopes to the relay
 * log FIRST and only then applies the newly-saved ones to the derived store
 * (v1 order; the log is the durability boundary). A simple in-process promise
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
 * the freshly converged store (§34.48) so the next fresh client restores
 * instead of replaying the whole log.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { isEncryptedPayload, type Envelope } from "@notees/protocol";
import { Store, StoreError } from "@notees/store";
import type { ChangeSummary } from "@notees/store";
import { uuidv7 } from "uuidv7";

import type { RelayStorage } from "./relay-storage.js";

/**
 * §34.48 — post-replay snapshot self-heal threshold. Below one catch-up
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
    // makes the overlap with a restored snapshot harmless. The M3 E2EE slot
    // ({"$e": …}) rides the log but is not applicable to derived state in M1.
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
   * §34.48 — snapshot self-heal. A workspace whose log has NO snapshot (a
   * post-restore wipe dropped them; a fresh relay never had a client upload
   * one) leaves every fresh client to replay the whole log (~minutes at
   * live scale — the missing-snapshot gap after the §34.43 migration). The
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

  async close(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.queue.catch(() => undefined);
      handle.store.close();
    }
    this.handles.clear();
  }
}
