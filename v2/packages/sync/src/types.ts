/**
 * Sync engine shared types: the transport contract (per WIRE.md), the outbox
 * state machine shapes, and the engine callback surface. Ported from v1
 * `frontend/src/core/{sync.ts,transport.ts}`, adapted to v2: seq-only cursor
 * (HLC is causality metadata, never a catch-up ordering), camelCase bodies,
 * single-user M1 (API-key auth, no E2EE slot handling, no presence).
 */

import type { Envelope, Hlc } from "@notees/protocol";

import type { SyncConflict } from "./conflicts.js";

export type SyncStatus = "idle" | "syncing" | "error";

// --- transport contract (WIRE.md §1–2) ---------------------------------------

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
}

export interface RealtimeHello {
  latestSeq: number;
  restoreEpoch: number;
}

/** Handlers for the realtime (WebSocket) acceleration path (WIRE.md §2). */
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
  /** PUT /snapshot/data (best-effort client-produced snapshot). */
  uploadSnapshot?(bytes: Uint8Array, hlc: Hlc): Promise<void>;
  /** Optional realtime channel (WIRE.md §2); HttpTransport implements it over WebSocket. */
  subscribe?(handlers: RealtimeHandlers): () => void;
}

// --- engine callbacks (v1 SyncEngineCallbacks, minus E2EE/presence) ----------

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
  applied: number;
  total: number;
}

export interface SyncEngineCallbacks {
  onPush?: (envelopeCount: number) => void;
  onPull?: (envelopeCount: number) => void;
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
  onRemoteBatch?: (appliedCount: number) => void;
}
