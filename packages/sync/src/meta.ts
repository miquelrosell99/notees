/**
 * Engine watermark persistence in the store's app_meta table.
 *
 * The server seq cursor, received-HLC watermark, and server restoreEpoch live
 * here — NOT in sync_state.cursor_seq, which store.applyMany repurposes as the
 * local apply watermark (MAX+1 per applied envelope). app_meta is device-local
 * bookkeeping; snapshot restores may carry a foreign copy, which the engine
 * overwrites on the next persist (a crash before that only re-fetches overlap
 * the id dedupe already handles).
 */

import type { Hlc } from "@notees/protocol";
import type { Store } from "@notees/store";

export interface PersistedSyncState {
  cursorSeq: number;
  receivedHlc: Hlc;
  restoreEpoch: number;
  /**
   * The lowest server seq skipped while locked (a realtime `$e` frame with no
   * crypto provider). Non-null ⇒ the durable cursor was advanced past sealed
   * frames this session could not read; installing a key rewinds the cursor
   * to re-fetch them. Null/absent = nothing skipped.
   */
  firstSkippedSeq?: number | null;
  /**
   * The receivedHlc watermark at the last snapshot this device uploaded to
   * the relay. Persisted so a short-lived client (CLI-style — a fresh engine
   * every invocation) does not re-upload the whole projection after every
   * restart whenever the relay's checkpoint carries a lower hlc than this
   * device's watermark (a lagging device's compaction/upload, a backup
   * restore): within one session uploadedSnapshotHlc already gates the
   * re-upload, and restarts must not weaken that. Null/absent = nothing
   * uploaded yet this epoch (an epoch bump resets it).
   */
  uploadedSnapshotHlc?: Hlc | null;
}

export class SyncMeta {
  constructor(
    private readonly store: Store,
    private readonly key: string,
  ) {}

  load(): PersistedSyncState | null {
    const row = this.store.database
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(this.key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as PersistedSyncState;
    } catch {
      return null;
    }
  }

  save(state: PersistedSyncState): void {
    this.store.database
      .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
      .run(this.key, JSON.stringify(state));
  }
}
