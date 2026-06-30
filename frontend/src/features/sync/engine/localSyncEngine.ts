/**
 * LocalSyncEngine — local-first write gateway for the v2 sync protocol.
 *
 * Responsibilities:
 * - Persist every local operation to IndexedDB before (or alongside) it is
 *   applied to OperationRuntime, so edits survive crashes and reloads.
 * - Own the outbox entries, including retry metadata (attemptCount, lastError,
 *   nextRetryAt, createdAt).
 * - Provide the pending entries to SyncManagerV2 for dispatch.
 *
 * Runtime application still happens through RuntimeEventBus / UndoEngine so the
 * existing UI pipeline does not need to become async. This engine is called
 * after runtime apply to stage the operation for persistence and dispatch.
 */

import { getOperationRuntime, type Operation } from '@/runtime';
import {
  saveOutboxStateV2,
  loadOutboxStateV2,
  clearOutboxStateV2,
  type OutboxEntry,
  type OutboxStateV2,
} from '@/lib/operationStorage';
import type { BaseVector } from '@/features/sync';

class LocalSyncEngine {
  private entries: OutboxEntry[] = [];
  private ackedVector: BaseVector = {};
  private nextSeq = 0;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Initialize from IndexedDB. Safe to call multiple times. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._load();
    return this.initPromise;
  }

  private async _load(): Promise<void> {
    const state = await loadOutboxStateV2();
    this.entries = state.entries;
    this.ackedVector = state.ackedVector;
    this.nextSeq = state.nextSeq;
    this.initialized = true;
  }

  /** Return the current pending outbox entries. */
  getPendingEntries(): OutboxEntry[] {
    return this.entries;
  }

  /** Return the last server-confirmed vector. */
  getAckedVector(): BaseVector {
    return this.ackedVector;
  }

  /** Update the acked vector and persist. */
  setAckedVector(vector: BaseVector): void {
    this.ackedVector = vector;
    this._scheduleFlush();
  }

  /** Return the next client sequence number to use. */
  getNextSeq(): number {
    return this.nextSeq;
  }

  /** Increment and return the next client sequence number. */
  consumeSeq(): number {
    this.nextSeq += 1;
    this._scheduleFlush();
    return this.nextSeq;
  }

  /**
   * Apply one or more operations to the runtime and stage them in the outbox.
   * Awaits IndexedDB persistence before resolving.
   */
  async apply(operation: Operation): Promise<void> {
    await this.applyMany([operation]);
  }

  async applyMany(operations: Operation[]): Promise<void> {
    await this.init();
    const runtime = getOperationRuntime();
    const now = Date.now();
    const newEntries: OutboxEntry[] = operations.map((op) => ({
      op,
      attemptCount: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: now,
    }));

    // Apply to runtime first so the UI updates immediately.
    for (const op of operations) {
      runtime.applyOperation(op);
    }

    // Then persist. If persistence fails, the operations are still in the
    // runtime and will be re-staged on the next change or beforeunload.
    this.entries.push(...newEntries);
    await this._persist();
  }

  /**
   * Persist operations to the outbox before they are applied to the runtime.
   *
   * Used for structural intents so that the IndexedDB write completes before
   * the UI acks the change. The caller is responsible for applying the
   * operations to the runtime after this resolves.
   */
  async prepareStructuralOperations(operations: Operation[]): Promise<void> {
    await this.init();
    const now = Date.now();
    const newEntries: OutboxEntry[] = operations.map((op) => ({
      op,
      attemptCount: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: now,
    }));
    this.entries.push(...newEntries);
    await this._persist();
  }

  /**
   * Stage operations that are already applied to the runtime (e.g. by the
   * existing event bus). Persists them without re-applying.
   */
  async stageOperations(operations: Operation[]): Promise<void> {
    await this.init();
    const now = Date.now();
    const newEntries: OutboxEntry[] = operations.map((op) => ({
      op,
      attemptCount: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: now,
    }));
    this.entries.push(...newEntries);
    await this._persist();
  }

  /** Fire-and-forget variant of stageOperations. */
  stageOperationsFireAndForget(operations: Operation[]): void {
    void this.stageOperations(operations);
  }

  /** Find an entry by operation id. */
  getEntry(operationId: string): OutboxEntry | undefined {
    return this.entries.find((e) => e.op.id === operationId);
  }

  /** Mark an entry as acknowledged and remove it from the outbox. */
  async acknowledge(operationId: string): Promise<void> {
    await this.init();
    this.entries = this.entries.filter((e) => e.op.id !== operationId);
    await this._persist();
  }

  /**
   * Record a dispatch failure for an entry and schedule its next retry.
   * If the entry is missing, it is created with the failure metadata.
   */
  async fail(operationId: string, error: string, nextRetryAt: number | null): Promise<void> {
    await this.init();
    const entry = this.entries.find((e) => e.op.id === operationId);
    if (entry) {
      entry.attemptCount += 1;
      entry.lastError = error;
      entry.nextRetryAt = nextRetryAt;
    } else {
      const runtime = getOperationRuntime();
      const op = runtime.getOperations().find((o) => o.id === operationId);
      if (op) {
        this.entries.push({
          op,
          attemptCount: 1,
          lastError: error,
          nextRetryAt,
          createdAt: Date.now(),
        });
      }
    }
    await this._persist();
  }

  /** Remove an entry (e.g. on explicit cancel or successful 409 resolution). */
  async remove(operationId: string): Promise<void> {
    await this.init();
    this.entries = this.entries.filter((e) => e.op.id !== operationId);
    await this._persist();
  }

  /** Clear the entire outbox and acked vector. */
  async clear(): Promise<void> {
    this.entries = [];
    this.ackedVector = {};
    this.nextSeq = 0;
    await clearOutboxStateV2();
  }

  /** Force an immediate flush to IndexedDB. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this._persist();
  }

  private _scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this._persist();
    }, 50);
  }

  private async _persist(): Promise<void> {
    const state: OutboxStateV2 = {
      entries: this.entries,
      ackedVector: this.ackedVector,
      nextSeq: this.nextSeq,
    };
    await saveOutboxStateV2(state);
  }
}

export const localSyncEngine = new LocalSyncEngine();
