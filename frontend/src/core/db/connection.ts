import initSqlJs, { type Database } from 'sql.js';
import { createSchema } from './schema';

let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlModule) {
    sqlModule = await initSqlJs({
      locateFile: () => `/sql-wasm.wasm`,
    });
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
