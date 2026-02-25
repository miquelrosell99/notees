/**
 * importState - Module-level transfer channel for pre-collected Logseq import data.
 *
 * When the unified ImportOptionsModal collects EDN text or a SQLite file before
 * the target workspace exists, it stores that state here. ImportLogseqModal then
 * reads and clears it when it opens so the user does not need to re-supply the data.
 *
 * A module-level variable is used (rather than Zustand) because File objects are
 * not serialisable and should not be stored in the state tree.
 */

export interface PendingLogseqEdn {
  source: 'edn';
  ednContent: string;
}

export interface PendingLogseqSqlite {
  source: 'sqlite';
  sqliteFile: File;
}

export type PendingLogseqState = PendingLogseqEdn | PendingLogseqSqlite;

let _pending: PendingLogseqState | null = null;

/** Store pending import state before opening ImportLogseqModal. */
export function setPendingLogseqImport(state: PendingLogseqState | null): void {
  _pending = state;
}

/**
 * Read and clear the pending state.
 * Call once inside ImportLogseqModal when `isOpen` becomes true.
 */
export function consumePendingLogseqImport(): PendingLogseqState | null {
  const s = _pending;
  _pending = null;
  return s;
}
