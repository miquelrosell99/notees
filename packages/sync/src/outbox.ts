/**
 * Outbox: the local-first write-ahead queue the sync engine pushes from.
 * In-memory port of the `sync_outbox` table state machine
 * (frontend/src/core/store.ts): pending → in_flight → acknowledged /
 * failed / quarantined, with attempt_count + next_retry_at driving the
 * backoff schedule, plus the `recovery_operation` equivalent (parked
 * envelopes) for server-restore wipes.
 *
 * Durability note: the engine treats this as the session outbox. A client
 * embedding the engine rehydrates by re-`enqueue`-ing envelopes from its
 * durable op log; parked envelopes survive wipes because parking lives
 * outside the store.
 */

import type { Envelope } from "@notees/protocol";

import type { OutboxStatusCounts } from "./types.js";

export type OutboxState = "pending" | "in_flight" | "acknowledged" | "failed" | "quarantined";

export interface OutboxEntry {
  envelope: Envelope;
  state: OutboxState;
  /** Incremented when the entry is marked in_flight. */
  attemptCount: number;
  /** ms epoch; null = not scheduled (quarantined waits for an explicit requeue). */
  nextRetryAt: number | null;
  lastError: string | null;
}

export class Outbox {
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly parked = new Map<string, Envelope>();

  /** Track an envelope; false when the id is already tracked (idempotent enqueue). */
  add(envelope: Envelope): boolean {
    if (this.entries.has(envelope.id)) return false;
    this.entries.set(envelope.id, {
      envelope,
      state: "pending",
      attemptCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
    return true;
  }

  /**
   * Pushable entries: pending/in_flight, or failed whose backoff has elapsed,
   * ordered by (hlc physical, logical) — getPendingPushOperations semantics,
   * minus the HLC watermark clause (acknowledged envelopes leave the outbox entirely).
   */
  due(now: number): OutboxEntry[] {
    const due: OutboxEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === "pending" || entry.state === "in_flight") {
        due.push(entry);
      } else if (entry.state === "failed" && entry.nextRetryAt !== null && entry.nextRetryAt <= now) {
        due.push(entry);
      }
    }
    due.sort(
      (a, b) =>
        a.envelope.hlc.physical - b.envelope.hlc.physical ||
        a.envelope.hlc.logical - b.envelope.hlc.logical,
    );
    return due;
  }

  markInFlight(ids: string[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || entry.state === "acknowledged") continue;
      entry.state = "in_flight";
      entry.attemptCount += 1;
      entry.nextRetryAt = null;
    }
  }

  /** Acknowledged envelopes leave the outbox; a whole chunk acks together. */
  markAcknowledged(ids: string[]): void {
    for (const id of ids) {
      this.entries.delete(id);
    }
  }

  /**
   * Backoff: attemptCount (already incremented at in_flight) indexes
   * the retry schedule; once the schedule is exhausted the entry quarantines
   * (nextRetryAt null) and stops auto-retrying.
   */
  markFailed(ids: string[], message: string, now: number, retryDelaysMs: readonly number[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || entry.state === "acknowledged") continue;
      entry.lastError = message;
      const delayIndex = entry.attemptCount - 1;
      if (delayIndex >= 0 && delayIndex < retryDelaysMs.length) {
        entry.state = "failed";
        entry.nextRetryAt = now + retryDelaysMs[delayIndex]!;
      } else {
        entry.state = "quarantined";
        entry.nextRetryAt = null;
      }
    }
  }

  /** Move quarantined entries back to pending with a fresh backoff budget. */
  requeueQuarantined(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== "quarantined") continue;
      entry.state = "pending";
      entry.attemptCount = 0;
      entry.nextRetryAt = null;
      entry.lastError = null;
      count += 1;
    }
    return count;
  }

  /** Park every un-acknowledged envelope before a server-restore wipe. */
  parkUnsent(): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      this.parked.set(id, entry.envelope);
      this.entries.delete(id);
      count += 1;
    }
    return count;
  }

  /** Re-push support: parked envelopes return to the outbox as pending. */
  requeueParked(): number {
    let count = 0;
    for (const [id, envelope] of this.parked) {
      if (!this.entries.has(id)) {
        this.entries.set(id, {
          envelope,
          state: "pending",
          attemptCount: 0,
          nextRetryAt: null,
          lastError: null,
        });
        count += 1;
      }
    }
    this.parked.clear();
    return count;
  }

  /** Everything not yet server-acknowledged (outbox + parked) — conflict detection input. */
  unacknowledgedEnvelopes(): Envelope[] {
    const envelopes = [...this.entries.values()].map((entry) => entry.envelope);
    envelopes.push(...this.parked.values());
    return envelopes;
  }

  counts(): OutboxStatusCounts {
    const counts: OutboxStatusCounts = { pending: 0, failed: 0, quarantined: 0 };
    for (const entry of this.entries.values()) {
      if (entry.state === "pending" || entry.state === "in_flight") counts.pending += 1;
      else if (entry.state === "failed") counts.failed += 1;
      else if (entry.state === "quarantined") counts.quarantined += 1;
    }
    return counts;
  }

  parkedCount(): number {
    return this.parked.size;
  }
}
