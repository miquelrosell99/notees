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
  parsedExport?: LogseqExport;
  autoImport?: boolean;
}

export interface PendingLogseqSqlite {
  source: 'sqlite';
  sqliteFile: File;
  parsedExport?: LogseqExport;
  autoImport?: boolean;
}

export type PendingLogseqState = PendingLogseqEdn | PendingLogseqSqlite;

let _pending: PendingLogseqState | null = null;

export function setPendingLogseqImport(state: PendingLogseqState | null): void {
  _pending = state;
}

export function consumePendingLogseqImport(): PendingLogseqState | null {
  const s = _pending;
  _pending = null;
  return s;
}

// ── Import-complete callback ──────────────────────────────────────────────────

let _onImportComplete: (() => void) | null = null;

export function setImportCompleteCallback(cb: (() => void) | null): void {
  _onImportComplete = cb;
}

export function consumeImportCompleteCallback(): (() => void) | null {
  const cb = _onImportComplete;
  _onImportComplete = null;
  return cb;
}

// ── Cancel-import state ───────────────────────────────────────────────────────

let _workspaceToDeleteUuid: string | null = null;
let _onCancelImport: (() => void) | null = null;

export function setWorkspaceToDelete(uuid: string): void {
  _workspaceToDeleteUuid = uuid;
}

export function consumeWorkspaceToDelete(): string | null {
  const u = _workspaceToDeleteUuid;
  _workspaceToDeleteUuid = null;
  return u;
}

export function setCancelImportCallback(cb: (() => void) | null): void {
  _onCancelImport = cb;
}

export function consumeCancelImportCallback(): (() => void) | null {
  const cb = _onCancelImport;
  _onCancelImport = null;
  return cb;
}

// ── Import progress listener ──────────────────────────────────────────────────
//
// ImportLogseqModal pushes progress updates here during auto-import.
// ImportOptionsModal subscribes so it can show a progress bar without needing
// ImportLogseqModal to render any visible UI.

export interface ImportProgressUpdate {
  status: string;
  progress: number;
}

// Re-export report types from shared TaskReport component
export type { TaskPhaseResult as ImportPhaseResult, TaskReportData as ImportReportData } from '@/components/core/TaskReport';
import type { TaskReportData } from '@/components/core/TaskReport';

let _progressListener: ((update: ImportProgressUpdate) => void) | null = null;
let _reportListener: ((report: TaskReportData) => void) | null = null;
let _errorListener: ((error: string) => void) | null = null;

export function setImportProgressListener(cb: ((update: ImportProgressUpdate) => void) | null): void {
  _progressListener = cb;
}

export function notifyImportProgress(update: ImportProgressUpdate): void {
  _progressListener?.(update);
}

export function setImportReportListener(cb: ((report: ImportReportData) => void) | null): void {
  _reportListener = cb;
}

export function notifyImportReport(report: ImportReportData): void {
  _reportListener?.(report);
}

export function setImportErrorListener(cb: ((error: string) => void) | null): void {
  _errorListener = cb;
}

export function notifyImportError(error: string): void {
  _errorListener?.(error);
}
