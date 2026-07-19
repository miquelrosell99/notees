import initSqlJs, { type Database } from 'sql.js';
import { createSchema } from './schema';
import { loadWorkspaceDatabase, saveWorkspaceDatabase } from '../persistence/indexedDb';

let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let sqlInitError: Error | null = null;

function isRealBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  // jsdom (used in tests) identifies itself in the user agent; use the default
  // Node wasm loader there instead of a browser-relative URL.
  return !navigator.userAgent.includes('jsdom');
}

async function getSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (sqlInitError) {
    throw sqlInitError;
  }

  if (!sqlModule) {
    try {
      sqlModule = await initSqlJs(
        isRealBrowser() ? { locateFile: () => `/sql-wasm.wasm` } : undefined
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sqlInitError = new Error(
        `Failed to load sql.js (SQLite wasm): ${message}. ` +
          'Your workspace database cannot be opened. Try refreshing the page.`'
      );
      throw sqlInitError;
    }
  }
  return sqlModule;
}

/** Returns the last sql.js initialization error, if any. */
export function getSqlInitError(): Error | null {
  return sqlInitError;
}

/** Clears the cached sql.js initialization error. Used by tests. */
export function clearSqlInitError(): void {
  sqlInitError = null;
}

/** Eagerly initializes sql.js so that failures can be detected early. */
export async function ensureSqlInitialized(): Promise<void> {
  await getSqlModule();
}

export async function createDatabase(data?: ArrayBuffer | Uint8Array): Promise<Database> {
  const SQL = await getSqlModule();
  const db = new SQL.Database(data);
  createSchema(db);
  return db;
}

export async function openWorkspaceDatabase(workspaceId: string): Promise<Database> {
  // In a real browser, load persisted bytes from IndexedDB. Tests and jsdom
  // fall back to a fresh in-memory database.
  if (isRealBrowser()) {
    const saved = await loadWorkspaceDatabase(workspaceId);
    if (saved) {
      return createDatabase(saved);
    }
  }
  return createDatabase();
}

export function exportDatabase(db: Database): Uint8Array {
  return db.export();
}

export async function persistWorkspaceDatabase(
  workspaceId: string,
  db: Database
): Promise<void> {
  if (!isRealBrowser()) return;
  await saveWorkspaceDatabase(workspaceId, db.export());
}
