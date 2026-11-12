/**
 * SyncEngine: the client/server sync engine — outbox push, seq-cursor
 * catch-up pull, snapshot shortcut, restoreEpoch wipe+park recovery, realtime
 * acceleration hook, and conflict reporting. Port of
 * `frontend/src/core/sync.ts` (the 968-line SyncEngine) adapted to WIRE.md:
 *  - seq is the only ordering authority (no HLC catch-up; HLC remains the LWW
 *    causality watermark for snapshot decisions);
 *  - envelopes are validated/applied through @notees/store (applied_envelope
 *    idempotency, one transaction per page via applyMany);
 *  - the server seq cursor persists in app_meta (see meta.ts for why not
 *    sync_state.cursor_seq);
 *  - single-user: no presence; E2EE is an OPTIONAL boundary (EnvelopeCrypto)
 *    — with a provider installed the wire and snapshots carry only ciphertext
 *    (decrypt-before-apply); key custody lives in the client. The WS
 *    acceleration path is wired through Transport.subscribe (HttpTransport
 *    implements it).
 */

import {
  compareHlc,
  isEncryptedPayload,
  maxHlc,
  type Clock,
  type Envelope,
  type Hlc,
} from "@notees/protocol";
import { validateEnvelope, type ChangeSummary, type Store } from "@notees/store";

import { detectConflicts, type SyncConflict } from "./conflicts.js";
import { summarizeAppliedChanges, summarizeEnvelopes, mergeChangeInfo, type BatchChangeInfo } from "./change-info.js";
import { TransportError } from "./errors.js";
import { SyncMeta } from "./meta.js";
import { Outbox } from "./outbox.js";
import type {
  EnvelopeCrypto,
  OutboxStatusCounts,
  SnapshotMeta,
  SyncEngineCallbacks,
  SyncPushProgress,
  SyncStatus,
  Transport,
} from "./types.js";

const SQLITE_MAGIC = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33,
  0x00,
]);

/** True when the bytes carry the SQLite header magic (a plaintext image). */
function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC[i]) return false;
  }
  return true;
}

/** Backoff schedule: 5s, 15s, 1m, 5m, 30m; exhausted → quarantined. */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000, 1_800_000] as const;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CATCH_UP_LIMIT = 1000;
const ZERO_HLC: Hlc = { physical: 0, logical: 0 };

/**
 * The default pre-flight snapshot-upload limit, below the relay's route-local
 * body cap (apps/server routes-relay.ts, 512 MiB). Not a mirror of it: the
 * cap exists to protect every observer of browser traffic, not just the
 * relay. A snapshot PUT's body rides CDP as a single Network frame (the
 * verify smoke drives the browser over a pipe), and V8 caps strings at
 * ~512 Mi chars — a ~510 MiB body already produced a 545 MB frame that
 * killed the smoke with ERR_STRING_TOO_LONG. Keep a wide margin.
 *
 * Streaming uploads (the OPFS-VFS backend's snapshotStream) apply this bound
 * to the RAW image size — a conservative upper bound on the compressed body
 * that actually crosses the wire.
 */
export const SNAPSHOT_UPLOAD_BODY_LIMIT = 256 * 1024 * 1024;
/** Raw-image floor for compacting before an upload (free pages don't ride along). */
export const SNAPSHOT_COMPACT_THRESHOLD = 32 * 1024 * 1024;
/** Sealed-image ceiling for the single-PUT path; above it the upload rides part+commit. */
export const SNAPSHOT_CHUNK_THRESHOLD = 48 * 1024 * 1024;
/** Part size for the chunked path (the relay's per-part contract is ≤64 MiB). */
export const SNAPSHOT_PART_SIZE = 64 * 1024 * 1024;

/**
 * Fresh multipart-upload id (uuid where the runtime offers it, an RFC 4122
 * shape built from getRandomValues otherwise — mirrors the offline-id fallback).
 */
function newUploadId(): string {
  const webCrypto = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => Uint8Array }
    | undefined;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * True when an upload failure is the relay's request-body cap (413) — the
 * one error that retrying can never heal. Accepts the typed
 * TransportError and any foreign error carrying a numeric `status`, so a
 * non-HTTP transport implementation can't smuggle a permanent failure past
 * the report latch.
 */
function isBodyTooLarge(error: unknown): boolean {
  if (error instanceof TransportError) return error.status === 413;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 413
  );
}

export interface SyncEngineOptions {
  /** Workspace this engine syncs; keys the persisted watermarks. */
  workspaceId?: string;
  /** Wall clock (ms epoch) for backoff scheduling; defaults to Date.now. */
  now?: () => number;
  /** Push chunk size (WIRE.md caps batches at 1000). */
  batchSize?: number;
  /** Catch-up page size. */
  catchUpLimit?: number;
  /**
   * Pre-flight snapshot-upload body limit (bytes): at or above this the
   * upload is skipped rather than transferred, mirroring the relay's own
   * body cap. Defaults to SNAPSHOT_UPLOAD_BODY_LIMIT (256 MiB — the tooling-safe margin, not the relay's 512 MiB cap).
   */
  snapshotUploadLimit?: number;
  /**
   * Raw-image floor for compacting before an upload (bytes): at or above
   * this the image is VACUUMed before sealing so replay-derived free pages
   * don't ride along. Defaults to SNAPSHOT_COMPACT_THRESHOLD (32 MiB).
   */
  snapshotCompactThreshold?: number;
  /**
   * Sealed-image ceiling for the single-PUT path (bytes): above this the
   * upload rides the part+commit multipart flow instead. Defaults to
   * SNAPSHOT_CHUNK_THRESHOLD (48 MiB).
   */
  snapshotChunkThreshold?: number;
  /** Part size for the chunked path. Defaults to SNAPSHOT_PART_SIZE (64 MiB). */
  snapshotPartSize?: number;
  callbacks?: SyncEngineCallbacks;
  /**
   * Optional E2EE boundary (spec §2): encrypt at the push boundary, decrypt
   * before apply, seal snapshot blobs. Absent → plaintext wire (the default).
   */
  crypto?: EnvelopeCrypto;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class SyncEngine {
  private readonly store: Store;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly outbox = new Outbox();
  private readonly meta: SyncMeta;
  private readonly workspaceId: string;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly catchUpLimit: number;
  /**
   * Pre-flight snapshot-upload body limit (bytes): at or above this the
   * upload is skipped rather than transferred, mirroring the relay's own
   * body cap. Mirrors the SyncEngineOptions field.
   */
  private readonly snapshotUploadLimit: number;
  /** Raw-image compact floor; mirrors the SyncEngineOptions field. */
  private readonly snapshotCompactThreshold: number;
  /** Sealed-image single-PUT ceiling; above it the multipart flow rides. */
  private readonly snapshotChunkThreshold: number;
  /** Part size for the multipart flow. */
  private readonly snapshotPartSize: number;
  private callbacks: SyncEngineCallbacks;
  /** E2EE boundary; null → plaintext wire. Mutable: setCrypto swaps the key. */
  private crypto: EnvelopeCrypto | null;

  private cursorSeq: number;
  private receivedHlc: Hlc;
  private restoreEpoch: number;
  private status: SyncStatus = "idle";
  private lastError: Error | null = null;
  /** HLC watermark of the last snapshot this device uploaded; avoids re-uploading. Durable (app_meta) — see maybeUploadSnapshot. */
  private uploadedSnapshotHlc: Hlc | null = null;
  private snapshotQuarantineReported = false;
  /**
   * The oversize-upload report latch: the relay answers an over-cap
   * snapshot PUT with 413, and unlike transient failures that never heals by
   * retrying, so it is surfaced ONCE per session (log + onError) instead of
   * being swallowed on every sync cycle. Reset when an upload succeeds.
   */
  private snapshotOversizeReported = false;
  private inFlightSync: Promise<void> | null = null;
  private pullInFlight = false;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  private readonly statusListeners = new Set<
    (status: SyncStatus, error: Error | null) => void
  >();
  private readonly conflictListeners = new Set<(conflicts: SyncConflict[]) => void>();
  private wsBuffer: Array<{ envelopes: Envelope[]; seqs: Record<string, number> }> = [];
  /** Reentrancy latch: only one drain (sync or async) may own the buffer. */
  private wsDraining = false;
  /**
   * Locked-skip counter: encrypted envelopes dropped from remote batches
   * because NO crypto provider is installed (the workspace is encrypted but
   * this session has no key). Counted once per batch, logged, never thrown —
   * the cursor still advances, so sync stays green instead of error-looping
   * on the store's $e rejection.
   */
  private lockedSkipTotal = 0;
  /**
   * The lowest seq skipped while locked over the realtime path (see
   * skipEncryptedWithoutKey). Installing a provider rewinds the durable
   * cursor before it so the next pull re-fetches the sealed frames.
   * Persisted (app_meta) so the rewind survives reloads.
   */
  private firstSkippedSeq: number | null = null;
  private unsubscribeRealtime: (() => void) | null = null;

  constructor(store: Store, transport: Transport, clock: Clock, options: SyncEngineOptions = {}) {
    this.store = store;
    this.transport = transport;
    this.clock = clock;
    this.workspaceId = options.workspaceId ?? "00000000-0000-0000-0000-000000000000";
    this.now = options.now ?? (() => Date.now());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.catchUpLimit = options.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
    this.snapshotUploadLimit = options.snapshotUploadLimit ?? SNAPSHOT_UPLOAD_BODY_LIMIT;
    this.snapshotCompactThreshold = options.snapshotCompactThreshold ?? SNAPSHOT_COMPACT_THRESHOLD;
    this.snapshotChunkThreshold = options.snapshotChunkThreshold ?? SNAPSHOT_CHUNK_THRESHOLD;
    this.snapshotPartSize = options.snapshotPartSize ?? SNAPSHOT_PART_SIZE;
    this.callbacks = options.callbacks ?? {};
    this.crypto = options.crypto ?? null;
    this.meta = new SyncMeta(store, `sync:${this.workspaceId}:state`);
    const persisted = this.meta.load();
    this.cursorSeq = persisted?.cursorSeq ?? 0;
    this.receivedHlc = persisted?.receivedHlc ?? ZERO_HLC;
    this.restoreEpoch = persisted?.restoreEpoch ?? 0;
    this.firstSkippedSeq = persisted?.firstSkippedSeq ?? null;
    this.uploadedSnapshotHlc = persisted?.uploadedSnapshotHlc ?? null;
    // The W2 unlock re-open constructs a FRESH engine with crypto in the
    // constructor options — the persisted locked-skip marker must rewind
    // here too (the setCrypto path alone never runs for this flow), else
    // the re-opened engine sits at the advanced cursor with the skipped
    // history unreachable.
    if (this.crypto !== null) this.applyRewindIfNeeded();
  }

  /**
   * The locked-skip rewind (shared by the constructor and setCrypto): a key
   * arrived after locked realtime skips — move the durable cursor before the
   * first skipped seq so the next pull re-fetches the sealed frames.
   * Never rewinds for a null provider (locked stays locked).
   */
  private applyRewindIfNeeded(): void {
    if (this.firstSkippedSeq === null) return;
    this.cursorSeq = Math.min(this.cursorSeq, this.firstSkippedSeq - 1);
    this.firstSkippedSeq = null;
    this.persistState();
  }

  // --- status & subscriptions ---------------------------------------------------

  getStatus(): SyncStatus {
    return this.status;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  getCursorSeq(): number {
    return this.cursorSeq;
  }

  getRestoreEpoch(): number {
    return this.restoreEpoch;
  }

  getOutboxCounts(): OutboxStatusCounts {
    return this.outbox.counts();
  }

  getParkedCount(): number {
    return this.outbox.parkedCount();
  }

  setCallbacks(callbacks: SyncEngineCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Install or rotate the E2EE boundary (null disables: plaintext wire).
   * Installing a key after locked realtime skips rewinds the durable cursor
   * to just before the first skipped seq — the next pull re-fetches and
   * applies the sealed frames (self-heal on unlock; while locked the cursor
   * stays advanced so nothing re-fetches uselessly).
   */
  setCrypto(provider: EnvelopeCrypto | null): void {
    this.crypto = provider;
    if (provider !== null) this.applyRewindIfNeeded();
  }

  subscribeStatus(callback: (status: SyncStatus, error: Error | null) => void): () => void {
    callback(this.status, this.lastError);
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  subscribeConflicts(callback: (conflicts: SyncConflict[]) => void): () => void {
    this.conflictListeners.add(callback);
    return () => this.conflictListeners.delete(callback);
  }

  private setStatus(status: SyncStatus, error: Error | null = null): void {
    if (error !== null) {
      // Surface sync/realtime failures with their full stack: the UI footer
      // shows only the message, and the worker RPC boundary drops stacks
      // entirely (handleMessage serializes { error: message }), so without
      // this the original throw site is unrecoverable.
      console.error(`[notees-sync] status=${status}:`, (error.stack ?? error.message).slice(0, 4096));
    }
    this.status = status;
    this.lastError = error;
    this.callbacks.onStatusChange?.(status, error);
    for (const listener of this.statusListeners) listener(status, error);
  }

  private emitConflicts(conflicts: SyncConflict[]): void {
    if (conflicts.length === 0) return;
    this.callbacks.onConflict?.(conflicts);
    for (const listener of this.conflictListeners) listener(conflicts);
  }

  private reportPhase(phase: string, message: string): void {
    this.callbacks.onSyncPhase?.(phase, message);
  }

  private reportOutboxCounts(): void {
    this.callbacks.onOutboxCounts?.(this.outbox.counts());
  }

  private persistState(): void {
    this.meta.save({
      cursorSeq: this.cursorSeq,
      receivedHlc: this.receivedHlc,
      restoreEpoch: this.restoreEpoch,
      firstSkippedSeq: this.firstSkippedSeq,
      uploadedSnapshotHlc: this.uploadedSnapshotHlc,
    });
  }

  // --- outbox ----------------------------------------------------------------------

  /**
   * Commit a local envelope: applied to the store immediately (local-first)
   * and tracked in the outbox as pending until the server acknowledges it.
   */
  enqueue(envelope: Envelope): ChangeSummary {
    const summary = this.store.apply(envelope);
    this.outbox.add(envelope);
    this.callbacks.onEnqueued?.(envelope);
    return summary;
  }

  /** Requeue quarantined ops and push them. */
  async requeueQuarantined(): Promise<void> {
    this.outbox.requeueQuarantined();
    this.reportOutboxCounts();
    await this.syncOnce();
  }

  /** Re-push ops parked by a server restore. */
  async recoverParkedChanges(): Promise<void> {
    const requeued = this.outbox.requeueParked();
    if (requeued > 0) this.callbacks.onParkedChanges?.(this.outbox.parkedCount());
    this.reportOutboxCounts();
    await this.syncOnce();
  }

  // --- push -------------------------------------------------------------------------

  async push(onProgress?: (progress: SyncPushProgress) => void): Promise<void> {
    const due = this.outbox.due(this.now());
    const total = due.length;
    let sent = 0;
    let changeInfo: BatchChangeInfo | undefined;

    for (let i = 0; i < due.length; i += this.batchSize) {
      const chunk = due.slice(i, i + this.batchSize);
      const ids = chunk.map((entry) => entry.envelope.id);
      this.outbox.markInFlight(ids);
      try {
        // E2EE: encrypt at the push boundary. The outbox stays plaintext in
        // memory (local-first); only the wire gets ciphertext. The changeInfo
        // below summarizes the PLAINTEXT envelopes — the summary vocabulary
        // must not leak what the wire sealed.
        const wireEnvelopes = this.crypto
          ? await Promise.all(chunk.map((entry) => this.crypto!.encryptEnvelope(entry.envelope)))
          : chunk.map((entry) => entry.envelope);
        await this.transport.sendBatch(wireEnvelopes);
        // Whole-chunk ack: a 200 means every envelope is persisted
        // server-side — the server omits duplicate ids from savedIds, but
        // duplicate-only chunks still leave the outbox.
        this.outbox.markAcknowledged(ids);
        this.callbacks.onAcknowledged?.(ids);
        changeInfo = mergeChangeInfo(changeInfo, summarizeEnvelopes(chunk.map((entry) => entry.envelope)));
        sent += chunk.length;
        onProgress?.({ sent, total });
      } catch (err) {
        const error = asError(err);
        this.outbox.markFailed(ids, error.message, this.now(), RETRY_DELAYS_MS);
        this.reportOutboxCounts();
        this.setStatus("error", error);
        this.callbacks.onError?.(error);
        throw error;
      }
    }

    this.reportOutboxCounts();
    if (total > 0) this.callbacks.onPush?.(total, changeInfo);
  }

  // --- pull --------------------------------------------------------------------------

  async pull(options: { ignoreSnapshot?: boolean; skipSnapshotUpload?: boolean } = {}): Promise<void> {
    this.pullInFlight = true;
    try {
      await this.pullInternal(options);
    } finally {
      this.pullInFlight = false;
      void this.drainWsBuffer();
    }
  }

  private async pullInternal(options: {
    ignoreSnapshot?: boolean;
    skipSnapshotUpload?: boolean;
  }): Promise<void> {
    this.reportPhase("fetching-snapshot", "Fetching latest snapshot…");
    const meta = await this.transport.getSnapshotMeta();

    // Server restored/rebuilt: park un-synced ops, wipe, and resync from seq 0.
    if (meta.restoreEpoch !== this.restoreEpoch) {
      await this.resyncFromEpochChange(meta.restoreEpoch);
      return;
    }

    // Snapshot shortcut: restore the blob only when newer than the watermark,
    // then catch up from the seq the snapshot covers (null → 0; envelope-id
    // dedupe protects the replay).
    const snapshotIsNewer =
      !options.ignoreSnapshot &&
      meta.hasSnapshot &&
      compareHlc(meta.hlc, this.receivedHlc) > 0;
    if (snapshotIsNewer) {
      const data = await this.transport.getSnapshotData();
      if (this.crypto && meta.sealed !== true) {
        // Keyed workspace, PLAINTEXT snapshot (a keyless client's upload or
        // the server's own self-heal image — built from its derived store,
        // which SKIPS sealed envelopes, so the image is content-empty while
        // claiming upToSeq = latest). Restoring it and jumping the cursor to
        // upToSeq would blank the workspace (the live incident) — the
        // empty-store trap. Skip the restore with a counted warning; the
        // cursor stays put so the seq catch-up below replays the log from
        // the durable cursor (post-epoch-wipe that is 0 — a full honest
        // replay, minutes at log scale but never wrong).
        this.lockedSkipTotal += 1;
        console.warn(
          `[notees-sync] server snapshot is plaintext for an encrypted workspace ` +
            `(${data.byteLength} bytes) — replaying the log instead; the checkpoint ` +
            "images the server's derived store, which skips sealed envelopes.",
        );
        // The HLC watermark marks this snapshot as seen (no re-download next
        // cycle); the cursor stays put so catch-up replays the log.
        this.receivedHlc = maxHlc(this.receivedHlc, meta.hlc);
        this.persistState();
      } else if (!this.crypto && !hasSqliteMagic(data)) {
        // Locked + sealed snapshot: without a provider the blob is opaque
        // bytes (and a garbage restore would throw). Skip the restore with a
        // counted warning and leave the watermarks untouched — the seq
        // catch-up below covers the content from the durable cursor.
        this.lockedSkipTotal += 1;
        console.warn(
          `[notees-sync] workspace key unavailable: skipped a sealed snapshot ` +
            `(${data.byteLength} bytes) — seq catch-up covers the content; ` +
            "restore it later by unlocking the workspace.",
        );
        // The HLC watermark marks this snapshot as seen (no re-download next
        // cycle); the cursor stays put so catch-up replays the log.
        this.receivedHlc = maxHlc(this.receivedHlc, meta.hlc);
        this.persistState();
      } else {
        // Keyed + declared-sealed (decrypt; a blob the key can't open throws
        // the clear error) or keyless + plaintext (restore as-is, legacy).
        const bytes = this.crypto ? await this.decryptSnapshotOrThrow(data) : data;
        // Awaits staged (OPFS-VFS) restores; synchronous backends fall back
        // inside restoreAsync.
        await this.store.restoreAsync(bytes);
        // The metadata HLC is the authoritative server-side watermark.
        this.receivedHlc = maxHlc(this.receivedHlc, meta.hlc);
        this.cursorSeq = meta.upToSeq ?? 0;
        this.persistState();
      }
    }

    // Page by seq cursor; each page applied in one store transaction before
    // the next fetch, and the cursor advances per page so a crash mid-backlog
    // resumes from the last applied page.
    let afterSeq = this.cursorSeq;
    let totalEnvelopes = 0;
    let appliedOps = 0;
    let changeInfo: BatchChangeInfo | undefined;
    for (;;) {
      const page = await this.transport.catchUp(afterSeq, this.catchUpLimit);
      if (page.restoreEpoch !== this.restoreEpoch) {
        await this.resyncFromEpochChange(page.restoreEpoch);
        return;
      }
      totalEnvelopes += page.envelopes.length;
      this.reportPhase(
        "catching-up",
        `Catching up… ${totalEnvelopes} operations`,
      );

      if (page.envelopes.length > 0) {
        // Validation happens inside applyRemote, AFTER decryption — the
        // wire payloads are opaque $e slots that validateEnvelope rejects.
        // The locked branch needs the page's first seq: catch-up pages carry
        // no per-envelope seqs, and the rewind marker (plan-04 W2 unlock)
        // is recorded from it.
        const pageResult = await this.applyRemote(page.envelopes as Envelope[], null, afterSeq + 1);
        appliedOps += pageResult.applied;
        changeInfo = mergeChangeInfo(changeInfo, pageResult.info);
      }
      // totalRemaining counts THIS page too (relay-storage contract), so the
      // honest denominator subtracts the page's own envelopes — otherwise the
      // fraction double-counts them (a single-page pull would cap at 50%). The
      // total still creeps upward when the log grows mid-replay; the UI clamps.
      this.callbacks.onPullProgress?.({
        applied: appliedOps,
        total: appliedOps + Math.max(0, page.totalRemaining - page.envelopes.length),
      });

      if (page.nextAfterSeq !== null && page.nextAfterSeq > this.cursorSeq) {
        this.cursorSeq = page.nextAfterSeq;
        this.persistState();
      }
      if (!page.hasMore) break;
      if (page.nextAfterSeq === null) {
        // Defensive: a hasMore page without a cursor would loop forever.
        break;
      }
      afterSeq = page.nextAfterSeq;
    }

    this.callbacks.onPull?.(totalEnvelopes, changeInfo ?? { affectedNodeIds: [], structural: false });
    await this.maybeUploadSnapshot(meta, options.skipSnapshotUpload === true);
    this.reportPhase("synced", "Synced");
    this.reportOutboxCounts();
  }

  /** Server restoreEpoch changed: park unsent ops, wipe, full pull, requeue. */
  private async resyncFromEpochChange(newEpoch: number): Promise<void> {
    const parked = this.outbox.parkUnsent();
    if (parked > 0) this.callbacks.onParkedChanges?.(parked);
    this.store.reset();
    this.cursorSeq = 0;
    this.receivedHlc = ZERO_HLC;
    this.restoreEpoch = newEpoch;
    // The server-side wipe voids any snapshot this device uploaded — the
    // watermark resets with the rest of the state, durably (a persisted
    // uploadedSnapshotHlc would otherwise suppress the re-upload the wiped
    // relay needs).
    this.uploadedSnapshotHlc = null;
    this.persistState();

    // The full replay runs inside the store's bulk window (the wipe-rebuild
    // cost the server-side hydrate also pays): per-op node_stats/search
    // maintenance defers to one end-of-rebuild pass. The window survives
    // page-by-page applyMany calls (nesting is depth-counted); an internal
    // snapshot restore abandons it (adopt clears the window) and the tail
    // then applies online — correct either way.
    this.store.beginBulk();
    try {
      await this.pullInternal({});
    } finally {
      this.store.endBulk();
    }
    const requeued = this.outbox.requeueParked();
    if (requeued > 0) this.callbacks.onParkedChanges?.(this.outbox.parkedCount());
    if (requeued > 0 || this.outbox.counts().pending > 0) {
      await this.push();
      await this.pullInternal({});
    }
  }

  /** Open a sealed snapshot, translating any decrypt failure into a clear error. */
  private async decryptSnapshotOrThrow(data: Uint8Array): Promise<Uint8Array> {
    try {
      return await this.crypto!.decryptSnapshot(data);
    } catch (error) {
      throw new Error(
        `snapshot decryption failed: wrong workspace key or corrupted snapshot (${(error as Error).message})`,
      );
    }
  }

  /** Best-effort snapshot upload when the server has none or an older one. */
  private async maybeUploadSnapshot(meta: SnapshotMeta, skip: boolean): Promise<void> {
    const upload = this.transport.uploadSnapshot?.bind(this.transport);
    if (!upload || skip) return;
    // A store that skipped ops (a non-empty quarantine table) must not become
    // the bootstrap source for other devices: the divergence would ride into
    // every fresh client's restore, and ops referencing the skipped state
    // would then fail on those clients in turn (the 2026-10-27 poisoned-
    // snapshot lineage). The full replay converges honestly; the server-side
    // snapshot covers restore meanwhile.
    if (this.store.quarantinedEnvelopes().length > 0) {
      if (!this.snapshotQuarantineReported) {
        this.snapshotQuarantineReported = true;
        console.error(
          "[sync] snapshot upload skipped: the local projection carries quarantined " +
            "envelopes — uploading would spread the divergence. Wipe the local store to " +
            "rehydrate cleanly; the upload resumes once the quarantine table is empty.",
        );
      }
      return;
    }
    const newerThanServer = !meta.hasSnapshot || compareHlc(this.receivedHlc, meta.hlc) > 0;
    const newerThanUploaded =
      this.uploadedSnapshotHlc === null || compareHlc(this.receivedHlc, this.uploadedSnapshotHlc) > 0;
    if (!newerThanServer || !newerThanUploaded) return;
    try {
      if (this.crypto) {
        // E2EE: the streaming source would upload the RAW image (the OPFS
        // stream is unsealed) — buffer, seal, and upload the sealed snapshot
        // instead. Large images get two shrink passes before any size
        // decision: compact first (VACUUM drops the replay's free pages),
        // then seal; when the sealed bytes still exceed the single-body
        // threshold the upload rides the part+commit multipart flow.
        let bytes = this.store.snapshot();
        if (bytes.byteLength >= this.snapshotCompactThreshold) {
          this.store.compact();
          bytes = this.store.snapshot();
        }
        const sealed = await this.crypto.encryptSnapshot(bytes);
        if (sealed.byteLength >= this.snapshotUploadLimit) {
          if (!this.snapshotOversizeReported) {
            this.snapshotOversizeReported = true;
            const message =
              `snapshot upload skipped: the sealed local projection (${Math.round(sealed.byteLength / 1048576)} MiB) ` +
              "meets the relay's body cap — uploading would be rejected. A server-side snapshot covers " +
              "restore; the client upload stays skipped this session.";
            console.error(`[sync] ${message}`);
            this.callbacks.onError?.(new Error(message));
          }
          return;
        }
        const partUpload = this.transport.uploadSnapshotPart?.bind(this.transport);
        const commitParts = this.transport.commitSnapshot?.bind(this.transport);
        if (sealed.byteLength > this.snapshotChunkThreshold && partUpload && commitParts) {
          const uploadId = newUploadId();
          const partCount = Math.ceil(sealed.byteLength / this.snapshotPartSize);
          for (let index = 0; index < partCount; index += 1) {
            const start = index * this.snapshotPartSize;
            await partUpload(
              sealed.subarray(start, Math.min(start + this.snapshotPartSize, sealed.byteLength)),
              uploadId,
              index,
            );
          }
          await commitParts(uploadId, partCount, this.receivedHlc, true);
        } else {
          await upload(sealed, this.receivedHlc, true);
        }
      } else {
      // Prefer the streaming source when BOTH sides have it (the OPFS-VFS
      // backend): the image is checkpointed and read lazily from the OPFS
      // file — the upload never materializes it. byteLength is the raw size,
      // a conservative bound for the pre-flight cap check (compressed is
      // smaller).
      const streamed =
        this.transport.uploadSnapshotStream !== undefined ? await this.store.snapshotStream() : null;
      const projectedSize = streamed !== null ? streamed.byteLength : 0;
      if (streamed !== null && projectedSize >= this.snapshotUploadLimit) {
        if (!this.snapshotOversizeReported) {
          this.snapshotOversizeReported = true;
          const message =
            `snapshot upload skipped: the local projection (${Math.round(projectedSize / 1048576)} MiB) ` +
            "meets the relay's body cap — uploading would be rejected. A server-side snapshot covers " +
            "restore; the client upload stays skipped this session.";
          console.error(`[sync] ${message}`);
          this.callbacks.onError?.(new Error(message));
        }
        return;
      }
      if (streamed !== null) {
        await this.transport.uploadSnapshotStream!(this.receivedHlc, streamed.stream);
      } else {
        const bytes = this.store.snapshot();
        // Pre-flight guard mirroring the relay's route-local body cap: skip
        // the upload rather than transfer a body the relay would reject with
        // 413. The server-side snapshot keeps covering restore either way.
        // Oversized projections also break tooling that observes browser
        // traffic — a single request body can exceed a driver's frame limit.
        if (bytes.byteLength >= this.snapshotUploadLimit) {
          if (!this.snapshotOversizeReported) {
            this.snapshotOversizeReported = true;
            const message =
              `snapshot upload skipped: the local projection (${Math.round(bytes.byteLength / 1048576)} MiB) ` +
              "meets the relay's body cap — uploading would be rejected. A server-side snapshot covers " +
              "restore; the client upload stays skipped this session.";
            console.error(`[sync] ${message}`);
            this.callbacks.onError?.(new Error(message));
          }
          return;
        }
        await upload(bytes, this.receivedHlc);
      }
      }
      this.uploadedSnapshotHlc = this.receivedHlc;
      this.snapshotOversizeReported = false;
      this.snapshotQuarantineReported = false;
      // Durable, not just session state: a short-lived client (a fresh engine
      // per invocation, CLI-style) restarts with this watermark intact, so a
      // relay checkpoint that carries a LOWER hlc than this device's watermark
      // (a lagging compaction, a backup restore) does not trigger a full
      // re-upload on every invocation. Snapshots are an optimization, never
      // authority — skipping the re-upload loses nothing the seq catch-up
      // does not cover.
      this.persistState();
    } catch (error) {
      // Best-effort: a failed upload must not fail sync. The ONE failure
      // that never heals by retrying — the relay's body cap (413 Request
      // entity too large; the route-raised 512 MiB ceiling, but a projection
      // can outgrow any cap) — is surfaced once per
      // session, loudly, instead of silently retried forever: the user
      // learns the client upload is disabled while the server-side
      // snapshot keeps covering restore.
      if (!this.snapshotOversizeReported && isBodyTooLarge(error)) {
        this.snapshotOversizeReported = true;
        const message =
          "snapshot upload rejected: the local projection exceeds the relay's size cap " +
          "(413). A server-side snapshot covers restore; the client upload stays skipped " +
          "this session.";
        console.error(`[sync] ${message}`, error);
        this.callbacks.onError?.(new Error(message));
      }
    }
  }

  // --- shared remote apply path (catch-up pages + realtime frames) -------------------

  /**
   * Apply a remote batch: decrypt first under E2EE (wire payloads are opaque
   * $e slots — the store's validateEnvelope rejects them by design, and
   * everything below reads plaintext: applyMany, the summaries zip, conflict
   * detection, the HLC and seq loops all operate on the opened envelopes, so
   * conflict detection and structural classification stay exact), then one
   * store transaction, conflict detection against local un-acknowledged ops
   * (reported, never blocking), HLC watermark + device clock merge, and (when
   * seqs are known) cursor advancement.
   * Returns the number of newly applied envelopes plus the batch's change
   * info for incremental UI invalidation.
   */
  private async applyRemote(
    envelopes: Envelope[],
    seqs: Record<string, number> | null,
    pageStartSeq?: number,
  ): Promise<{ applied: number; info: BatchChangeInfo }> {
    if (this.crypto) {
      const opened = await Promise.all(
        envelopes.map((envelope) => this.crypto!.decryptEnvelope(envelope)),
      );
      return this.applyRemotePlain(opened, seqs);
    }
    // Locked (no provider): skip encrypted envelopes with a counted warning
    // instead of letting the store's $e rejection kill the batch — plaintext
    // applies, the cursor still advances over the skipped seqs.
    const plain = this.skipEncryptedWithoutKey(envelopes, seqs, pageStartSeq);
    return this.applyRemotePlain(plain, seqs, envelopes);
  }

  /**
   * The locked semantic (shared by the pull and realtime paths): with no
   * crypto provider, encrypted envelopes are filtered out of a remote batch
   * with a counted log warning — never applied, never thrown. Plaintext
   * envelopes in the same batch apply normally. The lowest skipped seq is
   * remembered so a later provider install (setCrypto / a fresh engine with
   * constructor crypto, plan-04 W2's unlock re-open) rewinds the cursor and
   * re-fetches: realtime frames carry per-envelope seqs; catch-up pages don't
   * (the cursor advances by page), so the pull path passes the page's first
   * seq — rewinding there replays already-applied plaintext idempotently.
   */
  private skipEncryptedWithoutKey(
    envelopes: Envelope[],
    seqs: Record<string, number> | null = null,
    pageStartSeq?: number,
  ): Envelope[] {
    const plain: Envelope[] = [];
    let skipped = 0;
    for (const envelope of envelopes) {
      if (isEncryptedPayload(envelope.payload)) {
        skipped += 1;
        if (seqs !== null) {
          const seq = seqs[envelope.id];
          if (seq !== undefined && (this.firstSkippedSeq === null || seq < this.firstSkippedSeq)) {
            this.firstSkippedSeq = seq;
          }
        }
      } else {
        plain.push(envelope);
      }
    }
    if (skipped > 0) {
      if (seqs === null && pageStartSeq !== undefined &&
          (this.firstSkippedSeq === null || pageStartSeq < this.firstSkippedSeq)) {
        this.firstSkippedSeq = pageStartSeq;
      }
      this.lockedSkipTotal += skipped;
      console.warn(
        `[notees-sync] workspace key unavailable: skipped ${skipped} encrypted envelope(s) ` +
          `(${this.lockedSkipTotal} this session); local writes stay plaintext until unlocked. ` +
          "Plaintext envelopes in the batch applied normally.",
      );
      this.persistState();
    }
    return plain;
  }

  /**
   * The synchronous core of applyRemote, run on PLAINTEXT envelopes
   * (decryption, when needed, happens in the async wrapper before this is
   * called — and realtime drain calls it directly to preserve its historical
   * synchronous callback surface when crypto is off).
   */
  private applyRemotePlain(
    opened: Envelope[],
    seqs: Record<string, number> | null,
    /**
     * Envelopes whose seqs count toward cursor advancement even when absent
     * from `opened` — the locked skip passes the pre-filter batch so skipped
     * encrypted envelopes still advance the cursor (no re-fetch loop).
     */
    seqScope?: Envelope[],
  ): { applied: number; info: BatchChangeInfo } {
    // validateEnvelope fails loud on unknown opTypes / newer protocol
    // versions / the $e slot (the last only reachable pre-decrypt) before
    // the transaction opens.
    const plain = opened.map((envelope) => validateEnvelope(envelope));
    const ordered =
      seqs !== null
        ? [...plain].sort((a, b) => (seqs[a.id] ?? 0) - (seqs[b.id] ?? 0))
        : plain;

    const summaries = this.store.applyMany(ordered, { quarantinePoisonOps: true });
    // The workflow evaluator's hook: only FRESHLY applied envelopes (the
    // idempotent replays carry `ignored` and must not re-fire rules).
    const freshApplied = ordered.filter((_envelope, i) => summaries[i]?.ignored !== true);
    if (freshApplied.length > 0) this.callbacks.onBatchApplied?.(freshApplied);
    // summaries pair 1:1 with `ordered` (one entry per envelope, ignored
    // included): the structural check reads the envelope (op type + payload
    // — presentAsMain rides object.update), the affected ids read the
    // summary the applier actually computed.
    const info = summarizeAppliedChanges(
      ordered.map((envelope, i) => ({
        envelope,
        summary: summaries[i] ?? { affectedNodeIds: [], ignored: true },
      })),
    );

    // Quarantined remote envelopes (poison history): surfaced loud — but the
    // batch converged, so this is a report, not a failure.
    const quarantined = summaries.filter((s) => s.quarantined === true);
    if (quarantined.length > 0) {
      this.callbacks.onError?.(
        new Error(
          quarantined
            .map((s) => `quarantined remote ${s.opType}: ${s.error ?? "unknown error"}`)
            .join("; "),
        ),
      );
    }

    const conflicts = detectConflicts(plain, this.outbox.unacknowledgedEnvelopes());
    this.emitConflicts(conflicts);

    let maxIncoming: Hlc | null = null;
    for (const envelope of plain) {
      this.receivedHlc = maxHlc(this.receivedHlc, envelope.hlc);
      maxIncoming = maxIncoming === null ? envelope.hlc : maxHlc(maxIncoming, envelope.hlc);
    }
    if (maxIncoming !== null) this.clock.update(maxIncoming);

    if (seqs !== null) {
      let maxSeq = this.cursorSeq;
      for (const envelope of seqScope ?? plain) {
        const seq = seqs[envelope.id];
        if (seq !== undefined && seq > maxSeq) maxSeq = seq;
      }
      if (maxSeq > this.cursorSeq) this.cursorSeq = maxSeq;
    }
    this.persistState();
    return { applied: summaries.filter((summary) => !summary.ignored).length, info };
  }

  // --- realtime hook surface (WS acceleration path) -------------------------------------

  /**
   * Apply a realtime ops frame (WIRE.md). Strictly an accelerator: frames
   * buffer while a pull runs so the seq cursor cannot regress past applied
   * frames, and any drop is recovered by the cursor on the next pull.
   */
  onRemoteBatch(envelopes: Envelope[], seqs: Record<string, number>): void {
    if (envelopes.length === 0) return;
    this.wsBuffer.push({ envelopes, seqs });
    if (!this.pullInFlight) void this.drainWsBuffer();
  }

  /**
   * Wire the transport's realtime channel (subscribe), if it has one. Every
   * (re)connect sends a fresh `hello`, so a pull from the seq cursor covers
   * anything missed while the socket was down; `ack` frames acknowledge
   * outbox entries pushed over the socket (a no-op for HTTP-pushed ids).
   */
  startRealtime(): () => void {
    if (!this.transport.subscribe) return () => {};
    this.stopRealtime();
    this.unsubscribeRealtime = this.transport.subscribe({
      onOps: (envelopes, seqs) => this.onRemoteBatch(envelopes, seqs),
      onHello: (hello) => {
        if (
          hello.latestSeq > this.cursorSeq ||
          hello.restoreEpoch !== this.restoreEpoch
        ) {
          // Behind (or the server restored): catch up over HTTP — pull also
          // handles restoreEpoch changes.
          void this.pull().catch(() => {});
        } else {
          void this.drainWsBuffer();
        }
      },
      onAck: (savedIds) => {
        this.outbox.markAcknowledged(savedIds);
        this.reportOutboxCounts();
      },
      onError: (error) => {
        this.setStatus("error", error);
        this.callbacks.onError?.(error);
      },
    });
    return () => this.stopRealtime();
  }

  stopRealtime(): void {
    this.unsubscribeRealtime?.();
    this.unsubscribeRealtime = null;
    this.wsBuffer = [];
  }

  private async drainWsBuffer(): Promise<void> {
    if (this.pullInFlight || this.wsDraining) return;
    this.wsDraining = true;
    try {
      while (this.wsBuffer.length > 0 && !this.pullInFlight) {
        const frame = this.wsBuffer.shift()!;
        try {
          // Deliberate branch split: with crypto OFF the whole drain runs
          // synchronously (applyRemotePlain is sync) and the realtime
          // callback surface keeps its historical synchronous semantics;
          // under E2EE the decrypt step is awaited and the loop continues on
          // microtasks. Validation happens inside, after decryption.
          if (this.crypto) {
            const { applied, info } = await this.applyRemote(frame.envelopes, frame.seqs);
            if (applied > 0) this.callbacks.onRemoteBatch?.(applied, info);
          } else {
            const opened = this.skipEncryptedWithoutKey(frame.envelopes, frame.seqs);
            const { applied, info } = this.applyRemotePlain(opened, frame.seqs, frame.envelopes);
            if (applied > 0) this.callbacks.onRemoteBatch?.(applied, info);
          }
        } catch (err) {
          // Drop the remaining buffer — unapplied frames never advanced the
          // cursor, so the next pull re-fetches them through catch-up.
          this.wsBuffer = [];
          this.callbacks.onError?.(asError(err));
          return;
        }
      }
    } finally {
      this.wsDraining = false;
    }
  }

  // --- sync cycle ------------------------------------------------------------------------

  async sync(options: { skipSnapshotUpload?: boolean } = {}): Promise<void> {
    await this.syncOnce(options);
  }

  /** One push+pull cycle; concurrent callers share the in-flight run. */
  syncOnce(options: { skipSnapshotUpload?: boolean } = {}): Promise<void> {
    if (this.inFlightSync) return this.inFlightSync;
    this.inFlightSync = (async (): Promise<void> => {
      this.setStatus("syncing");
      try {
        await this.push();
        await this.pull(options);
        this.setStatus("idle", null);
      } catch (err) {
        const error = asError(err);
        this.setStatus("error", error);
        this.callbacks.onError?.(error);
        throw error;
      } finally {
        this.inFlightSync = null;
      }
    })();
    return this.inFlightSync;
  }

  startAutoSync(intervalMs: number): void {
    this.stopAutoSync();
    this.autoSyncTimer = setInterval(() => {
      void this.syncOnce().catch(() => {});
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}
