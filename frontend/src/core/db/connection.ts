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

function isWorker(): boolean {
  // Web Workers expose importScripts and do not have a window object.
  return (
    typeof self !== 'undefined' &&
    typeof (self as { importScripts?: unknown }).importScripts === 'function' &&
    typeof window === 'undefined'
  );
}

const WASM_FETCH_TIMEOUT_MS = 20_000;
const SQL_INIT_TIMEOUT_MS = 30_000;
const SQL_INIT_MAX_RETRIES = 3;

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWasmBinary(): Promise<ArrayBuffer> {
  // Bypass the service worker when fetching the wasm binary so we always hit
  // the network/Vite dev server. Service workers (especially in dev) can
  // return a stale HTML fallback for URLs they do not recognize.
  const response = await fetchWithTimeout('/sql-wasm.wasm', WASM_FETCH_TIMEOUT_MS, {
    cache: 'no-store',
    headers: { 'Service-Worker': 'script' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('text/html')) {
    throw new Error(
      `Server returned HTML instead of wasm (content-type: ${contentType}). ` +
        'The service worker or dev server may be serving a fallback page.'
    );
  }
  return response.arrayBuffer();
}

async function initSqlJsWithTimeout(
  config: Parameters<typeof initSqlJs>[0]
): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  return Promise.race([
    initSqlJs(config),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('sql.js module initialization timed out')),
        SQL_INIT_TIMEOUT_MS
      );
    }),
  ]);
}

async function getSqlModule(attempt = 1): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (sqlInitError) {
    throw sqlInitError;
  }

  if (!sqlModule) {
    try {
      const config: Parameters<typeof initSqlJs>[0] = {};
      if (isRealBrowser()) {
        if (isWorker()) {
          // In a Web Worker, fetch the wasm binary ourselves and pass it as an
          // ArrayBuffer. This avoids sql.js' streaming compile path, which can
          // fail in dev when the service worker returns an HTML fallback.
          config.wasmBinary = await fetchWasmBinary();
        } else {
          config.locateFile = () => `/sql-wasm.wasm`;
        }
      }
      sqlModule = await initSqlJsWithTimeout(config);
    } catch (err) {
      if (attempt < SQL_INIT_MAX_RETRIES) {
        const delayMs = 2 ** attempt * 500;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return getSqlModule(attempt + 1);
      }
      const message = err instanceof Error ? err.message : String(err);
      sqlInitError = new Error(
        `Failed to load sql.js (SQLite wasm): ${message}. ` +
          'Your workspace database cannot be opened. Try refreshing the page.'
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
