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
import type { LogseqExport } from '@/utils/ednParser';

export interface PendingLogseqEdn {
  source: 'edn';
  ednContent: string;
  /** Pre-parsed export so ImportLogseqModal can skip parsing on open. */
  parsedExport?: LogseqExport;
  /** When true, ImportLogseqModal skips the configuration form and starts import immediately. */
  autoImport?: boolean;
}

export interface PendingLogseqSqlite {
  source: 'sqlite';
  sqliteFile: File;
  /** Pre-parsed export so ImportLogseqModal can skip SQLite parsing on open. */
  parsedExport?: LogseqExport;
  /** When true, ImportLogseqModal skips the configuration form and starts import immediately. */
  autoImport?: boolean;
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

// ── Import-complete callback ──────────────────────────────────────────────────
//
// WorkspaceManagementView sets this before opening ImportLogseqModal in
// auto-import mode.  ImportLogseqModal calls it when the results report is
// closed, so workspace navigation happens AFTER the import finishes rather
// than as soon as the workspace is created.

let _onImportComplete: (() => void) | null = null;

/** Register a one-time callback to be invoked when the Logseq import report is closed. */
export function setImportCompleteCallback(cb: (() => void) | null): void {
  _onImportComplete = cb;
}

/** Read and clear the import-complete callback. */
export function consumeImportCompleteCallback(): (() => void) | null {
  const cb = _onImportComplete;
  _onImportComplete = null;
  return cb;
}

// ── Cancel-import state ───────────────────────────────────────────────────────
//
// When ImportOptionsModal creates a workspace for a Logseq import it stores
// that workspace's UUID here so ImportLogseqModal can delete it on cancel.
// A cancel callback (set by WorkspaceManagementView) handles re-showing the
// workspace management screen.

let _workspaceToDeleteUuid: string | null = null;
let _onCancelImport: (() => void) | null = null;

/** Store the UUID of the workspace that should be deleted on import cancel. */
export function setWorkspaceToDelete(uuid: string): void {
  _workspaceToDeleteUuid = uuid;
}

/** Read and clear the workspace UUID to delete. */
export function consumeWorkspaceToDelete(): string | null {
  const u = _workspaceToDeleteUuid;
  _workspaceToDeleteUuid = null;
  return u;
}

/** Register a one-time callback invoked when the user cancels an auto-import. */
export function setCancelImportCallback(cb: (() => void) | null): void {
  _onCancelImport = cb;
}

/** Read and clear the cancel-import callback. */
export function consumeCancelImportCallback(): (() => void) | null {
  const cb = _onCancelImport;
  _onCancelImport = null;
  return cb;
}
