/**
 * Sync engine shared types: the transport contract (per WIRE.md), the outbox
 * state machine shapes, and the engine callback surface. Ported from
 * `frontend/src/core/{sync.ts,transport.ts}`: seq-only cursor
 * (HLC is causality metadata, never a catch-up ordering), camelCase bodies,
 * single-user (API-key auth, no presence). E2EE is an optional boundary (see
 * EnvelopeCrypto): when a crypto provider is installed the wire carries only
 * encrypted payloads and sealed snapshots; when absent everything is plaintext.
 */

import type { Envelope, Hlc } from "@notees/protocol";

import type { BatchChangeInfo } from "./change-info.js";
import type { SyncConflict } from "./conflicts.js";

export type SyncStatus = "idle" | "syncing" | "error";

// --- transport contract (WIRE.md) ------------------------------------------------

export interface SendBatchResult {
  savedCount: number;
  savedIds: string[];
}

export interface CatchUpResponse {
  envelopes: unknown[];
  /** Exclusive lower bound for the next page; covers the tail on the final page. */
  nextAfterSeq: number | null;
  hasMore: boolean;
  restoreEpoch: number;
  /** Envelopes with seq > afterSeq including this page (progress denominator). */
  totalRemaining: number;
}

export interface SnapshotMeta {
  snapshotId: string;
  hlc: Hlc;
  hasSnapshot: boolean;
  restoreEpoch: number;
  upToSeq: number | null;
  /** True when the blob is a SEALED image (a keyed client sealed it); false = a plaintext derived store (a keyless client upload, or the server's own snapshot built from its derived state). */
  sealed: boolean;
}

export interface RealtimeHello {
  latestSeq: number;
  restoreEpoch: number;
}

/** Handlers for the realtime (WebSocket) acceleration path (WIRE.md). */
export interface RealtimeHandlers {
  onHello?: (hello: RealtimeHello) => void;
  onOps?: (envelopes: Envelope[], seqs: Record<string, number>) => void;
  /** Server committed the ids of a client-sent `batch` frame. */
  onAck?: (savedIds: string[]) => void;
  /**
   * Server `error` frame or a local connection failure (including the
   * fail-loud newer-framing-version close).
   */
  onError?: (error: Error) => void;
}

export interface Transport {
  /** POST /batch; duplicate ids are silently ignored server-side (idempotent retry). */
  sendBatch(envelopes: Envelope[]): Promise<SendBatchResult>;
  /** POST /catch-up; pages ascending by server-assigned seq. */
  catchUp(afterSeq: number, limit?: number): Promise<CatchUpResponse>;
  /** GET /snapshot (metadata probe; fetch the blob only when newer). */
  getSnapshotMeta(): Promise<SnapshotMeta>;
  /** GET /snapshot/data (404 when absent). */
  getSnapshotData(): Promise<Uint8Array>;
  /** PUT /snapshot/data (best-effort client-produced snapshot). `sealed` declares the blob is a sealed image (the engine's crypto branch is the only sealer) — the relay stores the flag on the snapshot row and serves it in GET /snapshot meta. */
  uploadSnapshot?(bytes: Uint8Array, hlc: Hlc, sealed?: boolean): Promise<void>;
  /**
   * PUT /snapshot/data/part — one chunk of a multipart snapshot upload
   * (index-addressed under the upload id). Parts are committed with
   * `commitSnapshot`. Optional — engines fall back to the single PUT.
   */
  uploadSnapshotPart?(bytes: Uint8Array, uploadId: string, index: number): Promise<void>;
  /**
   * POST /snapshot/data/commit — concatenate the parts of a multipart
   * upload, run the relay's sanity gate, and store the checkpoint. `sealed`
   * is stored on the snapshot row like the single PUT's flag.
   */
  commitSnapshot?(uploadId: string, parts: number, hlc: Hlc, sealed: boolean): Promise<void>;
  /**
   * Streaming variant: the image is read lazily (OPFS-VFS clients avoid
   * materializing it in the WASM/JS heap). Optional — engines fall back to
   * `uploadSnapshot`.
   */
  uploadSnapshotStream?(hlc: Hlc, open: () => ReadableStream<Uint8Array>): Promise<void>;
  /**
   * PUT /snapshot/data/part — one chunk of a multipart snapshot upload
   * (index-addressed under the upload id). Parts are stored verbatim and
   * committed with `commitSnapshot`. Optional — engines fall back to the
   * single PUT.
   */
  uploadSnapshotPart?(bytes: Uint8Array, uploadId: string, index: number): Promise<void>;
  /**
   * POST /snapshot/data/commit — concatenate the parts of a multipart
   * upload, run the relay's sanity gate, and store the checkpoint. `sealed`
   * is stored on the snapshot row like the single PUT's flag.
   */
  commitSnapshot?(uploadId: string, parts: number, hlc: Hlc, sealed: boolean): Promise<void>;
  /** Optional realtime channel (WIRE.md); HttpTransport implements it over WebSocket. */
  subscribe?(handlers: RealtimeHandlers): () => void;
}

// --- engine callbacks (SyncEngineCallbacks, minus E2EE/presence) -----------------

export interface OutboxStatusCounts {
  pending: number;
  failed: number;
  quarantined: number;
}

export interface SyncPushProgress {
  sent: number;
  total: number;
}

export interface SyncPullProgress {
  /** Running count of applied envelopes across the pull's pages. */
  applied: number;
  /** The projected final count (applied + still-remaining after this page); creeps upward when the log grows mid-replay. */
  total: number;
}

export interface SyncEngineCallbacks {
  onPush?: (envelopeCount: number, info?: BatchChangeInfo) => void;
  onPull?: (envelopeCount: number, info?: BatchChangeInfo) => void;
  onPullProgress?: (progress: SyncPullProgress | null) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: SyncStatus, error: Error | null) => void;
  /** Honest backlog after pushes/pulls so the UI can show quarantined ops. */
  onOutboxCounts?: (counts: OutboxStatusCounts) => void;
  /** Un-synced ops parked by a server restore (count 0 once recovered). */
  onParkedChanges?: (count: number) => void;
  /** Semantic conflicts between remote batches and local pending ops; never blocks apply. */
  onConflict?: (conflicts: SyncConflict[]) => void;
  onSyncPhase?: (phase: string, message: string) => void;
  /** A realtime (WS) frame was applied to the store; the embedding client refreshes. */
  onRemoteBatch?: (appliedCount: number, info?: BatchChangeInfo) => void;
  /** A local envelope was enqueued (durable local-op-log hook). */
  onEnqueued?: (envelope: Envelope) => void;
  /** A chunk of local envelopes was acknowledged by the server (durable-log hook). */
  onAcknowledged?: (ids: string[]) => void;
}

// --- E2EE boundary (spec §2) --------------------------------------------------------

/**
 * E2EE boundary (spec §2): encrypt at the push boundary, decrypt after
 * receive/before apply, seal snapshot blobs. The engine is key-agnostic —
 * the client owns custody and passes a provider (or null to disable).
 */
export interface EnvelopeCrypto {
  encryptEnvelope(envelope: Envelope): Promise<Envelope>;
  decryptEnvelope(envelope: Envelope): Promise<Envelope>;
  encryptSnapshot(bytes: Uint8Array): Promise<Uint8Array>;
  decryptSnapshot(bytes: Uint8Array): Promise<Uint8Array>;
}
