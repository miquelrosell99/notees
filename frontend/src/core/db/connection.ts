import initSqlJs, { type Database } from 'sql.js';
import { createSchema } from './schema';

let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;

function isRealBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  // jsdom (used in tests) identifies itself in the user agent; use the default
  // Node wasm loader there instead of a browser-relative URL.
  return !navigator.userAgent.includes('jsdom');
}

async function getSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlModule) {
    sqlModule = await initSqlJs(
      isRealBrowser() ? { locateFile: () => `/sql-wasm.wasm` } : undefined
    );
  }
  return sqlModule;
}

export async function createDatabase(data?: ArrayBuffer | Uint8Array): Promise<Database> {
  const SQL = await getSqlModule();
  const db = new SQL.Database(data);
  createSchema(db);
  return db;
}

export async function openWorkspaceDatabase(_workspaceId: string): Promise<Database> {
  // In a browser environment this would read from OPFS/IndexedDB using
  // workspaceId as the key. For now the in-memory sql.js Database is returned.
  return createDatabase();
}
