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
