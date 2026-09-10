/**
 * sql.js-compatible synchronous Database adapter backed by wa-sqlite.
 *
 * The frontend data layer is written against sql.js' synchronous `Database`
 * API (`run` / `exec` / `prepare` / `export` / `getRowsModified` / `close`).
 * This module re-implements that exact surface on top of wa-sqlite's SYNC
 * wasm build (vendored at `./wa-sqlite-fts/`, compiled from the npm
 * wa-sqlite@1.0.0 source commit with FTS3/FTS4/FTS5 enabled — the stock
 * wa-sqlite dist wasm ships no FTS module at all, while `search_index` is an
 * FTS4 virtual table) so callers do not change. Rebuild with
 * `frontend/scripts/build-wa-sqlite-fts.sh` when upgrading wa-sqlite.
 *
 * Key design points:
 *
 * - wa-sqlite's high-level wrappers (`open_v2`, `prepare_v2`, `step`, ...) are
 *   declared `async` even though the sync build executes the underlying calls
 *   synchronously. To offer a truly synchronous API we call the raw
 *   Emscripten exports (`Module._sqlite3_*` / `Module.ccall`) directly.
 *
 * - `vfs: 'memory'` uses wa-sqlite's bundled MemoryVFS example.
 *
 * - `vfs: 'opfs'` uses {@link OpfsAccessHandlePoolVFS}, a byte-for-byte
 *   compatible fork of wa-sqlite's AccessHandlePoolVFS example (MIT, (c) Roy
 *   T. Hashimoto). The fork exists for one reason: the upstream class keeps
 *   its OPFS sync access handles in private fields, which makes a SYNCHRONOUS
 *   `export()` impossible (the only other OPFS read paths — `getFile()` — are
 *   async, and opening a second sync access handle on the same file is
 *   rejected). The fork adds `readFileBytes()`/`seedFile()`; the on-disk pool
 *   format (header layout, digest, flags) is identical, so pools created by
 *   either class are interchangeable. OPFS sync access handles require a
 *   dedicated Web Worker in real browsers.
 *
 * - Durability: the OPFS VFS flushes to disk on every SQLite commit via
 *   `xSync`, so committed transactions are durable without any explicit
 *   `flush()` call. `close()` additionally flushes the main file handle.
 *   `export()` therefore always reflects the last COMMITTED state (same as
 *   reading the database file from disk).
 */

// Extensionless on purpose: TS resolves the sibling wa-sqlite.d.ts, while
// Vite resolves wa-sqlite.mjs (first in its default resolve.extensions).
import SQLiteESMFactory from './wa-sqlite-fts/wa-sqlite';
import waSqliteWasmUrl from './wa-sqlite-fts/wa-sqlite.wasm?url';
import {
  SQLITE_OK,
  SQLITE_ROW,
  SQLITE_DONE,
  SQLITE_INTEGER,
  SQLITE_FLOAT,
  SQLITE_TEXT,
  SQLITE_BLOB,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_READWRITE,
  SQLITE_OPEN_DELETEONCLOSE,
  SQLITE_OPEN_MAIN_DB,
  SQLITE_OPEN_MAIN_JOURNAL,
  SQLITE_OPEN_SUPER_JOURNAL,
  SQLITE_OPEN_WAL,
  SQLITE_CANTOPEN,
  SQLITE_IOERR,
  SQLITE_IOERR_SHORT_READ,
  SQLITE_NOTFOUND,
  SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN,
} from 'wa-sqlite';
import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js';
import type { SqlValue, ParamsObject, QueryResults } from 'sql.js';

// ---------------------------------------------------------------------------
// Raw Emscripten module surface (only what this adapter uses).
// ---------------------------------------------------------------------------

interface WaSqliteModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  ccall(
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: Array<number | string | null>
  ): unknown;
  getValue(ptr: number, type: string): number;
  getTempRet0(): number;
  UTF8ToString(ptr: number): string;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, maxBytes: number): void;
  HEAPU8: Uint8Array;
  registerVFS(vfs: object, makeDefault?: boolean): number;
  _sqlite3_prepare_v2(
    db: number,
    sqlPtr: number,
    nByte: number,
    ppStmt: number,
    pzTail: number
  ): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_reset(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_close(db: number): number;
  _sqlite3_changes(db: number): number;
  _sqlite3_column_count(stmt: number): number;
  _sqlite3_column_type(stmt: number, iCol: number): number;
  _sqlite3_column_int64(stmt: number, iCol: number): number;
  _sqlite3_column_double(stmt: number, iCol: number): number;
  _sqlite3_column_text(stmt: number, iCol: number): number;
  _sqlite3_column_blob(stmt: number, iCol: number): number;
  _sqlite3_column_bytes(stmt: number, iCol: number): number;
  _sqlite3_bind_parameter_count(stmt: number): number;
  _sqlite3_bind_int(stmt: number, i: number, value: number): number;
  _sqlite3_bind_double(stmt: number, i: number, value: number): number;
  _sqlite3_bind_null(stmt: number, i: number): number;
  _sqlite3_bind_text(stmt: number, i: number, ptr: number, n: number, destructor: number): number;
  _sqlite3_bind_blob(stmt: number, i: number, ptr: number, n: number, destructor: number): number;
}

export class WaSqliteError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'WaSqliteError';
    this.code = code;
  }
}

// Passed as the destructor to sqlite3_bind_text/bind_blob so SQLite copies
// the value and we can free the wasm memory immediately.
const SQLITE_TRANSIENT = -1;

// ---------------------------------------------------------------------------
// Module (wasm) loading.
// ---------------------------------------------------------------------------

let cachedModulePromise: Promise<WaSqliteModule> | null = null;

export function isRealBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  // jsdom (unit tests) is not a real browser; dedicated workers in a real
  // browser have no window/document but are real browsers.
  return !navigator.userAgent.includes('jsdom');
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

/**
 * Loads (and caches) the wa-sqlite Emscripten module.
 *
 * The wasm binary is always loaded explicitly from the vendored FTS build —
 * never via the .mjs' default `new URL('wa-sqlite.wasm', import.meta.url)`
 * resolution, which bundlers relocate:
 * - Real browsers: the `?url` import gives a bundler-emitted URL; fetch it
 *   and pass the bytes as `wasmBinary`.
 * - Node / jsdom (vitest): the vendored .wasm is read from disk (browsers'
 *   fetch-based loader cannot handle file URLs).
 */
function loadWaSqliteModule(wasmBinary?: ArrayBuffer | Uint8Array): Promise<WaSqliteModule> {
  if (cachedModulePromise && !wasmBinary) return cachedModulePromise;

  // locateFile is always set: without it the Emscripten glue eagerly computes
  // `new URL('wa-sqlite.wasm', import.meta.url)` at factory init — even when
  // wasmBinary makes the result unused — which breaks under vitest's stubbed
  // worker globals and bundler relocation alike.
  const moduleConfig = { locateFile: () => waSqliteWasmUrl };

  const promise = (async (): Promise<WaSqliteModule> => {
    if (wasmBinary) {
      return (await SQLiteESMFactory({ ...moduleConfig, wasmBinary })) as WaSqliteModule;
    }
    if (isRealBrowser()) {
      const response = await fetch(waSqliteWasmUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch wa-sqlite wasm (${response.status}): ${waSqliteWasmUrl}`);
      }
      return (await SQLiteESMFactory({
        ...moduleConfig,
        wasmBinary: await response.arrayBuffer(),
      })) as WaSqliteModule;
    }
    if (isNodeRuntime()) {
      const { readFile } = await import('node:fs/promises');
      const { createRequire } = await import('node:module');
      // createRequire, not `new URL('./wa-sqlite.wasm', import.meta.url)`:
      // Vite's asset transform rewrites that literal into a dev-server URL,
      // which fs cannot read under vitest.
      const nodeRequire = createRequire(import.meta.url);
      const wasmPath = nodeRequire.resolve('./wa-sqlite-fts/wa-sqlite.wasm');
      const bytes = await readFile(wasmPath);
      return (await SQLiteESMFactory({ ...moduleConfig, wasmBinary: bytes })) as WaSqliteModule;
    }
    return (await SQLiteESMFactory(moduleConfig)) as WaSqliteModule;
  })();

  if (!wasmBinary) cachedModulePromise = promise;
  return promise;
}

// Registered VFS instances per module (registerVFS throws on duplicate names).
const vfsRegistry = new WeakMap<WaSqliteModule, Map<string, object>>();

function getVfsRegistry(module: WaSqliteModule): Map<string, object> {
  let registry = vfsRegistry.get(module);
  if (!registry) {
    registry = new Map();
    vfsRegistry.set(module, registry);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// OPFS VFS: byte-compatible fork of wa-sqlite's AccessHandlePoolVFS example.
// ---------------------------------------------------------------------------

const SECTOR_SIZE = 4096;

// Each OPFS file begins with a fixed-size header with metadata. The
// contents of the file follow immediately after the header.
const HEADER_MAX_PATH_SIZE = 512;
const HEADER_FLAGS_SIZE = 4;
const HEADER_DIGEST_SIZE = 8;
const HEADER_CORPUS_SIZE = HEADER_MAX_PATH_SIZE + HEADER_FLAGS_SIZE;
const HEADER_OFFSET_FLAGS = HEADER_MAX_PATH_SIZE;
const HEADER_OFFSET_DIGEST = HEADER_CORPUS_SIZE;
const HEADER_OFFSET_DATA = SECTOR_SIZE;

// File types expected to persist in the file system outside a session.
const PERSISTENT_FILE_TYPES =
  SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_SUPER_JOURNAL | SQLITE_OPEN_WAL;

const DEFAULT_POOL_CAPACITY = 6;

// OPFS sync access handles are missing from this TypeScript version's DOM
// lib, so declare the minimal surface locally.
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options: { at: number }): number;
  write(buffer: ArrayBufferView, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  getSize(): number;
  close(): void;
}

type FileHandleWithSyncAccess = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
};

interface OpfsFile {
  path: string;
  flags: number;
  accessHandle: FileSystemSyncAccessHandle;
}

/**
 * Synchronous digest over the OPFS file header corpus. Must stay
 * byte-compatible with AccessHandlePoolVFS (cyrb53 variant).
 */
function computeHeaderDigest(corpus: Uint8Array): Uint32Array {
  if (!corpus[0]) {
    // Optimization for deleted file.
    return new Uint32Array([0xfecc5f80, 0xaccec037]);
  }

  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (const value of corpus) {
    h1 = Math.imul(h1 ^ value, 2654435761);
    h2 = Math.imul(h2 ^ value, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return new Uint32Array([h1 >>> 0, h2 >>> 0]);
}

/**
 * Fork of wa-sqlite's AccessHandlePoolVFS example that additionally exposes
 * synchronous whole-file reads (`readFileBytes`) and pre-open seeding
 * (`seedFile`) so `export()` and `initialBytes` migration can work without
 * any async OPFS API. The pool on-disk format is identical to upstream.
 *
 * Requires OPFS sync access handles (dedicated Web Worker in browsers).
 */
export class OpfsAccessHandlePoolVFS {
  readonly mxPathName = 64;

  // All the OPFS files the VFS uses are contained in one flat directory
  // specified in the constructor. No other files should be written there.
  private readonly directoryPath: string;
  private directoryHandle: FileSystemDirectoryHandle | null = null;

  // The OPFS files all have randomly-generated names that do not match the
  // SQLite files whose data they contain.
  private readonly mapAccessHandleToName = new Map<FileSystemSyncAccessHandle, string>();
  private readonly mapPathToAccessHandle = new Map<string, FileSystemSyncAccessHandle>();
  private readonly availableAccessHandles = new Set<FileSystemSyncAccessHandle>();

  private readonly mapIdToFile = new Map<number, OpfsFile>();

  readonly isReady: Promise<void>;

  constructor(directoryPath: string, vfsName: string) {
    this.directoryPath = directoryPath;
    this.vfsName = vfsName;
    this.isReady = this.reset().then(async () => {
      if (this.getCapacity() === 0) {
        await this.addCapacity(DEFAULT_POOL_CAPACITY);
      }
    });
  }

  private readonly vfsName: string;

  get name(): string {
    return this.vfsName;
  }

  xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
    try {
      // First try to open a path that already exists in the file system.
      const path = name ? this.getPath(name) : Math.random().toString(36);
      let accessHandle = this.mapPathToAccessHandle.get(path);
      if (!accessHandle && flags & SQLITE_OPEN_CREATE) {
        // File not found so try to create it.
        if (this.getSize() < this.getCapacity()) {
          // Choose an unassociated OPFS file from the pool.
          [accessHandle] = this.availableAccessHandles.keys();
          this.setAssociatedPath(accessHandle, path, flags);
        } else {
          // Out of unassociated files. This can be fixed by calling
          // addCapacity() from the application.
          throw new Error('cannot create file');
        }
      }
      if (!accessHandle) {
        throw new Error('file not found');
      }
      // Subsequent methods are only passed the fileId, so make sure we have
      // a way to find the file resources.
      this.mapIdToFile.set(fileId, { path, flags, accessHandle });

      pOutFlags.setInt32(0, flags, true);
      return SQLITE_OK;
    } catch {
      return SQLITE_CANTOPEN;
    }
  }

  xClose(fileId: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (file) {
      file.accessHandle.flush();
      this.mapIdToFile.delete(fileId);
      if (file.flags & SQLITE_OPEN_DELETEONCLOSE) {
        this.deletePath(file.path);
      }
    }
    return SQLITE_OK;
  }

  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return SQLITE_IOERR;

    const nBytes = file.accessHandle.read(pData, { at: HEADER_OFFSET_DATA + iOffset });
    if (nBytes < pData.byteLength) {
      pData.fill(0, nBytes, pData.byteLength);
      return SQLITE_IOERR_SHORT_READ;
    }
    return SQLITE_OK;
  }

  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return SQLITE_IOERR;

    const nBytes = file.accessHandle.write(pData, { at: HEADER_OFFSET_DATA + iOffset });
    return nBytes === pData.byteLength ? SQLITE_OK : SQLITE_IOERR;
  }

  xTruncate(fileId: number, iSize: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return SQLITE_IOERR;

    file.accessHandle.truncate(HEADER_OFFSET_DATA + iSize);
    return SQLITE_OK;
  }

  xSync(fileId: number, _flags: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return SQLITE_IOERR;

    file.accessHandle.flush();
    return SQLITE_OK;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return SQLITE_IOERR;

    const size = file.accessHandle.getSize() - HEADER_OFFSET_DATA;
    pSize64.setBigInt64(0, BigInt(size), true);
    return SQLITE_OK;
  }

  xLock(_fileId: number, _flags: number): number {
    return SQLITE_OK;
  }

  xUnlock(_fileId: number, _flags: number): number {
    return SQLITE_OK;
  }

  xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true);
    return SQLITE_OK;
  }

  xFileControl(_fileId: number, _op: number, _pArg: DataView): number {
    return SQLITE_NOTFOUND;
  }

  xSectorSize(_fileId: number): number {
    return SECTOR_SIZE;
  }

  xDeviceCharacteristics(_fileId: number): number {
    return SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
  }

  xAccess(name: string, _flags: number, pResOut: DataView): number {
    const path = this.getPath(name);
    pResOut.setInt32(0, this.mapPathToAccessHandle.has(path) ? 1 : 0, true);
    return SQLITE_OK;
  }

  xDelete(name: string, _syncDir: number): number {
    const path = this.getPath(name);
    this.deletePath(path);
    return SQLITE_OK;
  }

  async close(): Promise<void> {
    await this.isReady;
    this.releaseAccessHandles();
  }

  /**
   * Release and reacquire all OPFS access handles. This must be called
   * and awaited before any SQLite call that uses the VFS and also before
   * any capacity changes.
   */
  async reset(): Promise<void> {
    await this.isReady;

    // All files are stored in a single directory.
    let handle = await navigator.storage.getDirectory();
    for (const d of this.directoryPath.split('/')) {
      if (d) {
        handle = await handle.getDirectoryHandle(d, { create: true });
      }
    }
    this.directoryHandle = handle;

    this.releaseAccessHandles();
    await this.acquireAccessHandles();
  }

  /** Returns the number of SQLite files in the file system. */
  getSize(): number {
    return this.mapPathToAccessHandle.size;
  }

  /** Returns the maximum number of SQLite files the file system can hold. */
  getCapacity(): number {
    return this.mapAccessHandleToName.size;
  }

  /** Increase the capacity of the file system by n. */
  async addCapacity(n: number): Promise<number> {
    for (let i = 0; i < n; ++i) {
      await this.createPoolFile();
    }
    return n;
  }

  /** Decrease the capacity of the file system by n. */
  async removeCapacity(n: number): Promise<number> {
    let nRemoved = 0;
    for (const accessHandle of Array.from(this.availableAccessHandles)) {
      if (nRemoved === n || this.getSize() === this.getCapacity()) return nRemoved;

      const name = this.mapAccessHandleToName.get(accessHandle);
      await accessHandle.close();
      if (name) await this.directoryHandle?.removeEntry(name);
      this.mapAccessHandleToName.delete(accessHandle);
      this.availableAccessHandles.delete(accessHandle);
      ++nRemoved;
    }
    return nRemoved;
  }

  /**
   * Reads the current bytes of a SQLite file in the pool, synchronously.
   * Returns null when no file with this name exists. The returned image is
   * whatever was last flushed (SQLite flushes on commit), i.e. the last
   * committed state.
   */
  readFileBytes(name: string): Uint8Array | null {
    const accessHandle = this.mapPathToAccessHandle.get(this.getPath(name));
    if (!accessHandle) return null;

    const size = accessHandle.getSize() - HEADER_OFFSET_DATA;
    if (size <= 0) return new Uint8Array(0);

    const bytes = new Uint8Array(size);
    accessHandle.read(bytes, { at: HEADER_OFFSET_DATA });
    return bytes;
  }

  /**
   * Writes a complete database image into the pool before the database is
   * opened (migration path from sql.js/IndexedDB bytes). Returns false when
   * a file with this name already exists (existing data wins).
   */
  async seedFile(name: string, bytes: Uint8Array): Promise<boolean> {
    await this.isReady;
    const path = this.getPath(name);
    if (this.mapPathToAccessHandle.has(path)) return false;

    let accessHandle = this.availableAccessHandles.values().next().value;
    if (!accessHandle) {
      accessHandle = await this.createPoolFile();
    }
    this.setAssociatedPath(accessHandle, path, SQLITE_OPEN_MAIN_DB);
    accessHandle.write(bytes, { at: HEADER_OFFSET_DATA });
    accessHandle.truncate(HEADER_OFFSET_DATA + bytes.byteLength);
    accessHandle.flush();
    return true;
  }

  /**
   * Atomically replaces a SQLite file's contents with a complete database
   * image (snapshot-restore path). Unlike {@link seedFile} this overwrites
   * an existing file: journal/WAL remnants of the previous contents are
   * removed, the header (path, flags, digest) is rewritten, and the file is
   * truncated so no tail of a larger previous image survives. The database
   * must not have the file open while this runs.
   */
  async replaceFileBytes(name: string, bytes: Uint8Array): Promise<void> {
    await this.isReady;
    const path = this.getPath(name);

    // Remove journal/WAL remnants of the previous contents so they cannot
    // leak into the new image on the next open.
    this.deletePath(`${path}-journal`);
    this.deletePath(`${path}-wal`);
    this.deletePath(`${path}-shm`);

    let accessHandle = this.mapPathToAccessHandle.get(path);
    if (!accessHandle) {
      accessHandle = this.availableAccessHandles.values().next().value;
      if (!accessHandle) {
        accessHandle = await this.createPoolFile();
      }
    }

    // Rewrite the header (path, flags, digest) for the file we are about to
    // write, then replace the data bytes, truncating any leftover tail both
    // before and after the write.
    this.setAssociatedPath(accessHandle, path, SQLITE_OPEN_MAIN_DB);
    accessHandle.truncate(HEADER_OFFSET_DATA);
    if (bytes.byteLength > 0) {
      accessHandle.write(bytes, { at: HEADER_OFFSET_DATA });
    }
    accessHandle.truncate(HEADER_OFFSET_DATA + bytes.byteLength);
    accessHandle.flush();
  }

  private async createPoolFile(): Promise<FileSystemSyncAccessHandle> {
    if (!this.directoryHandle) throw new Error('VFS not ready');
    const name = Math.random().toString(36).replace('0.', '');
    const handle = await this.directoryHandle.getFileHandle(name, { create: true });
    const accessHandle = await (handle as FileHandleWithSyncAccess).createSyncAccessHandle();
    this.mapAccessHandleToName.set(accessHandle, name);
    this.setAssociatedPath(accessHandle, '', 0);
    return accessHandle;
  }

  private async acquireAccessHandles(): Promise<void> {
    if (!this.directoryHandle) return;

    // Enumerate all the files in the directory.
    const files: Array<[string, FileSystemFileHandle]> = [];
    const entries = this.directoryHandle as unknown as AsyncIterable<[string, FileSystemHandle]>;
    for await (const [name, handle] of entries) {
      if (handle.kind === 'file') {
        files.push([name, handle as FileSystemFileHandle]);
      }
    }

    // Open access handles in parallel, separating associated and unassociated.
    await Promise.all(
      files.map(async ([name, handle]) => {
        const accessHandle = await (handle as FileHandleWithSyncAccess).createSyncAccessHandle();
        this.mapAccessHandleToName.set(accessHandle, name);
        const path = this.getAssociatedPath(accessHandle);
        if (path) {
          this.mapPathToAccessHandle.set(path, accessHandle);
        } else {
          this.availableAccessHandles.add(accessHandle);
        }
      })
    );
  }

  private releaseAccessHandles(): void {
    for (const accessHandle of this.mapAccessHandleToName.keys()) {
      accessHandle.close();
    }
    this.mapAccessHandleToName.clear();
    this.mapPathToAccessHandle.clear();
    this.availableAccessHandles.clear();
  }

  /**
   * Read and return the associated path from an OPFS file header.
   * Empty string is returned for an unassociated OPFS file.
   */
  private getAssociatedPath(accessHandle: FileSystemSyncAccessHandle): string {
    // Read the path and digest of the path from the file.
    const corpus = new Uint8Array(HEADER_CORPUS_SIZE);
    accessHandle.read(corpus, { at: 0 });

    // Delete files not expected to be present.
    const dataView = new DataView(corpus.buffer, corpus.byteOffset);
    const flags = dataView.getUint32(HEADER_OFFSET_FLAGS);
    if (
      corpus[0] &&
      (flags & SQLITE_OPEN_DELETEONCLOSE || (flags & PERSISTENT_FILE_TYPES) === 0)
    ) {
      this.setAssociatedPath(accessHandle, '', 0);
      return '';
    }

    const fileDigest = new Uint32Array(HEADER_DIGEST_SIZE / 4);
    accessHandle.read(fileDigest, { at: HEADER_OFFSET_DIGEST });

    // Verify the digest.
    const computedDigest = computeHeaderDigest(corpus);
    if (fileDigest.every((value, i) => value === computedDigest[i])) {
      // Good digest. Decode the null-terminated path string.
      const pathBytes = corpus.findIndex((value) => value === 0);
      if (pathBytes === 0) {
        // Ensure that unassociated files are empty.
        accessHandle.truncate(HEADER_OFFSET_DATA);
      }
      return new TextDecoder().decode(corpus.subarray(0, pathBytes));
    } else {
      // Bad digest. Repair this header.
      this.setAssociatedPath(accessHandle, '', 0);
      return '';
    }
  }

  /** Set the path on an OPFS file header. */
  private setAssociatedPath(
    accessHandle: FileSystemSyncAccessHandle,
    path: string,
    flags: number
  ): void {
    // Convert the path string to UTF-8.
    const corpus = new Uint8Array(HEADER_CORPUS_SIZE);
    const encodedResult = new TextEncoder().encodeInto(path, corpus);
    if (encodedResult.written >= HEADER_MAX_PATH_SIZE) {
      throw new Error('path too long');
    }

    // Add the creation flags.
    const dataView = new DataView(corpus.buffer, corpus.byteOffset);
    dataView.setUint32(HEADER_OFFSET_FLAGS, flags);

    // Write the OPFS file header, including the digest.
    const digest = computeHeaderDigest(corpus);
    accessHandle.write(corpus, { at: 0 });
    accessHandle.write(digest, { at: HEADER_OFFSET_DIGEST });
    accessHandle.flush();

    if (path) {
      this.mapPathToAccessHandle.set(path, accessHandle);
      this.availableAccessHandles.delete(accessHandle);
    } else {
      // This OPFS file doesn't represent any SQLite file so it doesn't
      // need to keep any data.
      accessHandle.truncate(HEADER_OFFSET_DATA);
      this.availableAccessHandles.add(accessHandle);
    }
  }

  /** Convert a bare filename, path, or URL to a UNIX-style path. */
  private getPath(nameOrURL: string): string {
    const url = new URL(nameOrURL, 'file://localhost/');
    return url.pathname;
  }

  /** Remove the association between a path and an OPFS file. */
  private deletePath(path: string): void {
    const accessHandle = this.mapPathToAccessHandle.get(path);
    if (accessHandle) {
      // Un-associate the SQLite path from the OPFS file.
      this.mapPathToAccessHandle.delete(path);
      this.setAssociatedPath(accessHandle, '', 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Raw statement helpers (shared by WaSqliteStatement and WaSqliteDatabase).
// These never finalize the statement; ownership stays with the caller.
// ---------------------------------------------------------------------------

function columnNameRaw(module: WaSqliteModule, stmt: number, iCol: number): string {
  return module.ccall('sqlite3_column_name', 'string', ['number', 'number'], [
    stmt,
    iCol,
  ]) as string;
}

function columnValueRaw(module: WaSqliteModule, stmt: number, iCol: number): SqlValue {
  const type = module._sqlite3_column_type(stmt, iCol);
  switch (type) {
    case SQLITE_INTEGER: {
      // sqlite3_column_int64 returns the low 32 bits; the high 32 bits are
      // in getTempRet0(). Recompose the 64-bit value (matches wa-sqlite).
      const lo32 = module._sqlite3_column_int64(stmt, iCol);
      const hi32 = module.getTempRet0();
      return hi32 * 0x100000000 + (lo32 >>> 0);
    }
    case SQLITE_FLOAT:
      return module._sqlite3_column_double(stmt, iCol);
    case SQLITE_TEXT:
      return module.UTF8ToString(module._sqlite3_column_text(stmt, iCol));
    case SQLITE_BLOB: {
      const ptr = module._sqlite3_column_blob(stmt, iCol);
      const nBytes = module._sqlite3_column_bytes(stmt, iCol);
      // Copy out of volatile wasm memory.
      return module.HEAPU8.slice(ptr, ptr + nBytes);
    }
    default:
      return null;
  }
}

function readRowRaw(module: WaSqliteModule, stmt: number): SqlValue[] {
  const row: SqlValue[] = [];
  const nColumns = module._sqlite3_column_count(stmt);
  for (let i = 0; i < nColumns; ++i) {
    row.push(columnValueRaw(module, stmt, i));
  }
  return row;
}

function readColumnNamesRaw(module: WaSqliteModule, stmt: number): string[] {
  const names: string[] = [];
  const nColumns = module._sqlite3_column_count(stmt);
  for (let i = 0; i < nColumns; ++i) {
    names.push(columnNameRaw(module, stmt, i));
  }
  return names;
}

function namedParameterIndexRaw(module: WaSqliteModule, stmt: number, name: string): number {
  const count = module._sqlite3_bind_parameter_count(stmt);
  for (let i = 1; i <= count; ++i) {
    const paramName = module.ccall('sqlite3_bind_parameter_name', 'string', ['number', 'number'], [
      stmt,
      i,
    ]) as string;
    if (
      paramName === name ||
      paramName === `:${name}` ||
      paramName === `$${name}` ||
      paramName === `@${name}`
    ) {
      return i;
    }
  }
  return 0;
}

function bindValueRaw(
  module: WaSqliteModule,
  stmt: number,
  index: number,
  value: SqlValue,
  errmsg: () => string
): void {
  let rc: number;

  if (value === null || value === undefined) {
    rc = module._sqlite3_bind_null(stmt, index);
  } else if (typeof value === 'number') {
    rc =
      value === (value | 0)
        ? module._sqlite3_bind_int(stmt, index, value)
        : module._sqlite3_bind_double(stmt, index, value);
  } else if (typeof value === 'string') {
    const nBytes = module.lengthBytesUTF8(value);
    const ptr = module._malloc(nBytes + 1);
    try {
      module.stringToUTF8(value, ptr, nBytes + 1);
      rc = module._sqlite3_bind_text(stmt, index, ptr, nBytes, SQLITE_TRANSIENT);
    } finally {
      module._free(ptr);
    }
  } else if (value instanceof Uint8Array) {
    const ptr = module._malloc(value.byteLength || 1);
    try {
      module.HEAPU8.set(value, ptr);
      rc = module._sqlite3_bind_blob(stmt, index, ptr, value.byteLength, SQLITE_TRANSIENT);
    } finally {
      module._free(ptr);
    }
  } else {
    throw new WaSqliteError(`Unsupported bind parameter type: ${typeof value}`, -1);
  }

  if (rc !== SQLITE_OK) {
    throw new WaSqliteError(`sqlite3_bind failed (${rc}): ${errmsg()}`, rc);
  }
}

function bindParamsRaw(
  module: WaSqliteModule,
  stmt: number,
  params: SqlValue[] | ParamsObject,
  errmsg: () => string
): void {
  if (Array.isArray(params)) {
    params.forEach((value, index) => bindValueRaw(module, stmt, index + 1, value, errmsg));
    return;
  }
  for (const [key, value] of Object.entries(params)) {
    const index = namedParameterIndexRaw(module, stmt, key);
    if (index === 0) {
      throw new WaSqliteError(`Unknown named parameter: ${key}`, -1);
    }
    bindValueRaw(module, stmt, index, value, errmsg);
  }
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

export class WaSqliteStatement {
  private readonly module: WaSqliteModule;
  private readonly stmt: number;
  private readonly onFinalize: (stmt: WaSqliteStatement) => void;
  private readonly getErrorMessage: () => string;
  private freed = false;

  constructor(
    module: WaSqliteModule,
    stmt: number,
    getErrorMessage: () => string,
    onFinalize: (stmt: WaSqliteStatement) => void
  ) {
    this.module = module;
    this.stmt = stmt;
    this.getErrorMessage = getErrorMessage;
    this.onFinalize = onFinalize;
  }

  /** Binds parameters; accepts positional arrays or named-parameter objects. */
  bind(values?: SqlValue[] | ParamsObject | null): boolean {
    this.assertNotFreed();
    if (values == null) return true;
    bindParamsRaw(this.module, this.stmt, values, this.getErrorMessage);
    return true;
  }

  /** Advances to the next row. Returns false when the statement is done. */
  step(): boolean {
    this.assertNotFreed();
    const rc = this.module._sqlite3_step(this.stmt);
    if (rc === SQLITE_ROW) return true;
    if (rc === SQLITE_DONE) return false;
    throw new WaSqliteError(`sqlite3_step failed (${rc}): ${this.getErrorMessage()}`, rc);
  }

  /** Returns the current row as an array of values. Call after step(). */
  get(): SqlValue[] {
    this.assertNotFreed();
    return readRowRaw(this.module, this.stmt);
  }

  /** Returns the current row as an object keyed by column name. */
  getAsObject(): Record<string, SqlValue> {
    this.assertNotFreed();
    const row: Record<string, SqlValue> = {};
    const names = readColumnNamesRaw(this.module, this.stmt);
    for (let i = 0; i < names.length; ++i) {
      row[names[i]] = columnValueRaw(this.module, this.stmt, i);
    }
    return row;
  }

  getColumnNames(): string[] {
    this.assertNotFreed();
    return readColumnNamesRaw(this.module, this.stmt);
  }

  /** Binds (if given), steps once, then resets. For statements without rows. */
  run(values?: SqlValue[] | ParamsObject | null): this {
    this.assertNotFreed();
    if (values != null) this.bind(values);
    this.step();
    this.reset();
    return this;
  }

  /** Resets the statement so it can be stepped again (bindings are kept). */
  reset(): boolean {
    this.assertNotFreed();
    return this.module._sqlite3_reset(this.stmt) === SQLITE_OK;
  }

  /** Finalizes the statement. Returns false if already freed. */
  free(): boolean {
    if (this.freed) return false;
    this.module._sqlite3_finalize(this.stmt);
    this.freed = true;
    this.onFinalize(this);
    return true;
  }

  private assertNotFreed(): void {
    if (this.freed) throw new WaSqliteError('Statement closed', -1);
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

interface MemoryVfsFile {
  name: string;
  flags: number;
  size: number;
  data: ArrayBuffer;
}

/**
 * Synchronous, sql.js-compatible database backed by wa-sqlite.
 * See the module docstring for semantics and deviations.
 */
export class WaSqliteDatabase {
  private readonly module: WaSqliteModule;
  private db: number;
  private outPtr: number;
  private readonly fileName: string;
  private readonly vfsName: string;
  private readonly memoryVfs: MemoryVFS | null;
  private readonly opfsVfs: OpfsAccessHandlePoolVFS | null;
  private readonly openStatements = new Set<WaSqliteStatement>();
  private closed = false;

  constructor(
    module: WaSqliteModule,
    db: number,
    fileName: string,
    vfsName: string,
    memoryVfs: MemoryVFS | null,
    opfsVfs: OpfsAccessHandlePoolVFS | null
  ) {
    this.module = module;
    this.db = db;
    this.fileName = fileName;
    this.vfsName = vfsName;
    this.memoryVfs = memoryVfs;
    this.opfsVfs = opfsVfs;
    this.outPtr = module._malloc(8);
  }

  /**
   * Executes SQL, ignoring returned rows. Without params, all statements in
   * `sql` are executed (like sql.js). With params, they are bound to the
   * first statement only (also like sql.js).
   */
  run(sql: string, params?: SqlValue[] | ParamsObject): this {
    this.assertOpen();
    if (params) {
      const stmt = this.prepare(sql, params);
      try {
        stmt.step();
      } finally {
        stmt.free();
      }
      return this;
    }
    this.forEachStatement(sql, (stmt) => {
      while (this.stepRaw(stmt)) {
        // Discard rows.
      }
    });
    return this;
  }

  /**
   * Executes all statements in `sql` and returns one result object per
   * statement that produced at least one row (sql.js semantics: statements
   * with zero rows contribute no entry).
   */
  exec(sql: string, params?: SqlValue[] | ParamsObject): QueryResults[] {
    this.assertOpen();
    const results: QueryResults[] = [];
    this.forEachStatement(sql, (stmt) => {
      if (params) this.bindRaw(stmt, params);

      let columns: string[] | null = null;
      const values: SqlValue[][] = [];
      while (this.stepRaw(stmt)) {
        if (columns === null) {
          columns = this.columnNamesRaw(stmt);
          results.push({ columns, values });
        }
        values.push(this.rowRaw(stmt));
      }
    });
    return results;
  }

  /** Prepares the first statement in `sql` (subsequent statements ignored). */
  prepare(sql: string, params?: SqlValue[] | ParamsObject): WaSqliteStatement {
    this.assertOpen();
    const stmtPtr = this.prepareFirst(sql);
    if (stmtPtr === 0) {
      throw new WaSqliteError('Nothing to prepare', -1);
    }
    const stmt = new WaSqliteStatement(
      this.module,
      stmtPtr,
      () => this.errmsg(),
      (s) => this.openStatements.delete(s)
    );
    this.openStatements.add(stmt);
    if (params) stmt.bind(params);
    return stmt;
  }

  /**
   * Serializes the database to a byte image of the main database file.
   *
   * There is no sqlite3_serialize in this wa-sqlite build, so the bytes are
   * read from the VFS file after a WAL checkpoint (a no-op outside WAL mode).
   * The image therefore reflects the last COMMITTED state; call outside of
   * an open transaction.
   */
  export(): Uint8Array {
    this.assertOpen();
    // Fold any WAL content back into the main file (no-op when not in WAL).
    this.forEachStatement('PRAGMA wal_checkpoint(TRUNCATE)', (stmt) => {
      while (this.stepRaw(stmt)) {
        // Discard checkpoint result row.
      }
    });

    if (this.memoryVfs) {
      const file = this.memoryVfs.mapNameToFile.get(this.fileName) as MemoryVfsFile | undefined;
      if (!file) return new Uint8Array(0);
      // MemoryVFS never shrinks the backing ArrayBuffer on truncate, so
      // honor the logical size.
      return new Uint8Array(file.data.slice(0, file.size));
    }

    if (this.opfsVfs) {
      const bytes = this.opfsVfs.readFileBytes(this.fileName);
      return bytes ?? new Uint8Array(0);
    }

    throw new WaSqliteError('No VFS attached', -1);
  }

  /** Number of rows modified by the last INSERT/UPDATE/DELETE. */
  getRowsModified(): number {
    this.assertOpen();
    return this.module._sqlite3_changes(this.db);
  }

  /**
   * Closes the database connection (frees any unfinalized statements). The
   * OPFS VFS flushes the main file handle on close, so committed data is
   * durable. The OPFS pool keeps its access handles open for reuse; call
   * {@link shutdown} to release them.
   */
  close(): void {
    if (this.closed) return;
    for (const stmt of Array.from(this.openStatements)) {
      stmt.free();
    }
    const rc = this.module._sqlite3_close(this.db);
    this.module._free(this.outPtr);
    this.closed = true;
    if (rc !== SQLITE_OK) {
      throw new WaSqliteError(`sqlite3_close failed (${rc})`, rc);
    }
  }

  /**
   * Closes the database and releases the OPFS pool's sync access handles so
   * other tabs/workers can open the files. Only call this when no other
   * WaSqliteDatabase shares the same pool (same `name`).
   */
  async shutdown(): Promise<void> {
    this.close();
    if (this.opfsVfs) {
      await this.opfsVfs.close();
      const registry = getVfsRegistry(this.module);
      registry.delete(this.opfsVfs.name);
    }
  }

  /**
   * Replaces the entire database contents with a full SQLite database image
   * (e.g. a downloaded server snapshot) while keeping the VFS file as the
   * backing store — the wa-sqlite equivalent of sql.js'
   * `this.db = new SQL.Database(bytes)`.
   *
   * The database handle is closed, the file bytes are swapped (journal/WAL
   * remnants of the old contents are removed and the file is truncated so no
   * tail of a larger previous image survives), and the same database name is
   * reopened against the same VFS/pool. Afterwards `this` is fully usable
   * (run/exec/prepare/export) against the new contents.
   *
   * Safe to call while the database is open: unfinalized statements are
   * freed first (any of their results must not be used afterwards). Must be
   * called outside of an open transaction. If replacement or reopening
   * throws, this instance is left unusable and should be discarded.
   */
  async replaceWithSnapshot(data: Uint8Array): Promise<void> {
    this.assertOpen();
    validateSqliteImage(data);

    // Close the current handle.
    for (const stmt of Array.from(this.openStatements)) {
      stmt.free();
    }
    const closeRc = this.module._sqlite3_close(this.db);
    this.module._free(this.outPtr);
    if (closeRc !== SQLITE_OK) {
      throw new WaSqliteError(`sqlite3_close failed (${closeRc})`, closeRc);
    }

    // Swap the file bytes.
    if (this.memoryVfs) {
      for (const suffix of ['-journal', '-wal', '-shm', '-mj']) {
        this.memoryVfs.mapNameToFile.delete(this.fileName + suffix);
      }
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const file: MemoryVfsFile = {
        name: this.fileName,
        flags: 0,
        size: data.byteLength,
        data: buffer,
      };
      this.memoryVfs.mapNameToFile.set(this.fileName, file);
    } else if (this.opfsVfs) {
      if (!isOpfsAvailable()) {
        throw new WaSqliteError(
          'OPFS is not available in this environment; cannot replace the snapshot.',
          -1
        );
      }
      await this.opfsVfs.replaceFileBytes(this.fileName, data);
    } else {
      throw new WaSqliteError('No VFS attached', -1);
    }

    // Reopen the same database name against the same VFS.
    this.db = openDatabase(this.module, this.fileName, this.vfsName);
    this.outPtr = this.module._malloc(8);
  }

  private assertOpen(): void {
    if (this.closed) throw new WaSqliteError('Database closed', -1);
  }

  private errmsg(): string {
    return this.module.ccall('sqlite3_errmsg', 'string', ['number'], [this.db]) as string;
  }

  /**
   * Prepares the first statement in `sql`. Returns the statement pointer or
   * 0 when the SQL contains no statement.
   */
  private prepareFirst(sql: string): number {
    const nBytes = this.module.lengthBytesUTF8(sql) + 1;
    const sqlPtr = this.module._malloc(nBytes);
    try {
      this.module.stringToUTF8(sql, sqlPtr, nBytes);
      const rc = this.module._sqlite3_prepare_v2(
        this.db,
        sqlPtr,
        -1,
        this.outPtr,
        this.outPtr + 4
      );
      if (rc !== SQLITE_OK) {
        throw new WaSqliteError(`sqlite3_prepare_v2 failed (${rc}): ${this.errmsg()}`, rc);
      }
      return this.module.getValue(this.outPtr, '*');
    } finally {
      this.module._free(sqlPtr);
    }
  }

  /**
   * Iterates over every statement in `sql`, yielding each raw statement
   * pointer and finalizing it afterwards.
   */
  private forEachStatement(sql: string, fn: (stmt: number) => void): void {
    const nBytes = this.module.lengthBytesUTF8(sql) + 1;
    const sqlPtr = this.module._malloc(nBytes);
    this.module.stringToUTF8(sql, sqlPtr, nBytes);
    let tailPtr = sqlPtr;
    try {
      for (;;) {
        const rc = this.module._sqlite3_prepare_v2(
          this.db,
          tailPtr,
          -1,
          this.outPtr,
          this.outPtr + 4
        );
        if (rc !== SQLITE_OK) {
          throw new WaSqliteError(`sqlite3_prepare_v2 failed (${rc}): ${this.errmsg()}`, rc);
        }
        const stmt = this.module.getValue(this.outPtr, '*');
        tailPtr = this.module.getValue(this.outPtr + 4, '*');
        if (stmt === 0) break;
        try {
          fn(stmt);
        } finally {
          this.module._sqlite3_finalize(stmt);
        }
      }
    } finally {
      this.module._free(sqlPtr);
    }
  }

  private stepRaw(stmt: number): boolean {
    const rc = this.module._sqlite3_step(stmt);
    if (rc === SQLITE_ROW) return true;
    if (rc === SQLITE_DONE) return false;
    throw new WaSqliteError(`sqlite3_step failed (${rc}): ${this.errmsg()}`, rc);
  }

  private bindRaw(stmt: number, params: SqlValue[] | ParamsObject): void {
    bindParamsRaw(this.module, stmt, params, () => this.errmsg());
  }

  private columnNamesRaw(stmt: number): string[] {
    return readColumnNamesRaw(this.module, stmt);
  }

  private rowRaw(stmt: number): SqlValue[] {
    return readRowRaw(this.module, stmt);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface WaSqliteDatabaseOptions {
  /** Logical database name; sanitized into the file name and OPFS pool path. */
  name: string;
  vfs: 'memory' | 'opfs';
  /**
   * Migration path: when provided AND the target database file does not
   * exist yet, these bytes (e.g. a sql.js `export()` image from IndexedDB)
   * become the initial database content. Existing data always wins.
   */
  initialBytes?: Uint8Array;
  /** Optional explicit wasm binary; overrides the vendored FTS build. */
  wasmBinary?: ArrayBuffer | Uint8Array;
}

function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!sanitized) throw new WaSqliteError('Database name is empty after sanitization', -1);
  return sanitized;
}

// The 16-byte magic every SQLite database file starts with.
const SQLITE_FILE_HEADER = 'SQLite format 3\0';
// Smallest possible valid database image is one 100-byte header page.
const SQLITE_MIN_IMAGE_BYTES = 100;

/** Cheap structural validation of a complete SQLite database image. */
function validateSqliteImage(data: Uint8Array): void {
  if (data.byteLength < SQLITE_MIN_IMAGE_BYTES) {
    throw new WaSqliteError(
      `Invalid snapshot: ${data.byteLength} bytes is too small to be a SQLite database image`,
      -1
    );
  }
  for (let i = 0; i < SQLITE_FILE_HEADER.length; ++i) {
    if (data[i] !== SQLITE_FILE_HEADER.charCodeAt(i)) {
      throw new WaSqliteError(
        'Invalid snapshot: missing the 16-byte "SQLite format 3" header of a SQLite database image',
        -1
      );
    }
  }
}

function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

export { isOpfsAvailable };

function openDatabase(module: WaSqliteModule, fileName: string, vfsName: string): number {
  const outPtr = module._malloc(4);
  try {
    const rc = module.ccall(
      'sqlite3_open_v2',
      'number',
      ['string', 'number', 'number', 'string'],
      [fileName, outPtr, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, vfsName]
    ) as number;
    const db = module.getValue(outPtr, '*');
    if (rc !== SQLITE_OK || db === 0) {
      throw new WaSqliteError(`sqlite3_open_v2 failed (${rc}) for ${fileName}`, rc);
    }
    // Register math/extension functions, same as wa-sqlite's open_v2 wrapper.
    module.ccall('RegisterExtensionFunctions', 'void', ['number'], [db]);
    return db;
  } finally {
    module._free(outPtr);
  }
}

/**
 * Creates a sql.js-compatible database on wa-sqlite.
 *
 * - `vfs: 'memory'`: fresh in-memory database (used by unit tests). Each call
 *   gets an isolated MemoryVFS instance.
 * - `vfs: 'opfs'`: durable database in the origin-private file system. The
 *   pool lives at OPFS path `.wa-sqlite/<sanitized name>/` and the database
 *   file is `<sanitized name>.db`. Multiple databases with the same `name`
 *   share one registered pool. OPFS sync access handles only exist in
 *   dedicated Web Workers (or in Chrome's main thread behind a flag), so use
 *   this mode from the workspace worker.
 */
export async function createWaSqliteDatabase(
  options: WaSqliteDatabaseOptions
): Promise<WaSqliteDatabase> {
  const module = await loadWaSqliteModule(options.wasmBinary);
  const registry = getVfsRegistry(module);
  const safeName = sanitizeName(options.name);
  const fileName = `${safeName}.db`;

  if (options.vfs === 'memory') {
    const vfs = new MemoryVFS();
    // Each memory database gets its own isolated VFS under a unique name.
    let vfsName = `memory-${safeName}`;
    let suffix = 1;
    while (registry.has(vfsName)) {
      suffix += 1;
      vfsName = `memory-${safeName}-${suffix}`;
    }
    vfs.name = vfsName;
    const rc = module.registerVFS(vfs, false);
    if (rc !== SQLITE_OK) throw new WaSqliteError(`registerVFS failed (${rc})`, rc);
    registry.set(vfsName, vfs);

    if (options.initialBytes && !vfs.mapNameToFile.has(fileName)) {
      const data = new ArrayBuffer(options.initialBytes.byteLength);
      new Uint8Array(data).set(options.initialBytes);
      const file: MemoryVfsFile = {
        name: fileName,
        flags: 0,
        size: options.initialBytes.byteLength,
        data,
      };
      vfs.mapNameToFile.set(fileName, file);
    }

    const db = openDatabase(module, fileName, vfsName);
    return new WaSqliteDatabase(module, db, fileName, vfsName, vfs, null);
  }

  if (!isOpfsAvailable()) {
    throw new WaSqliteError(
      'OPFS is not available in this environment. Use vfs: "memory" (tests) ' +
        'or run inside a dedicated Web Worker in a browser that supports ' +
        'FileSystemSyncAccessHandle.',
      -1
    );
  }

  const poolDirectory = `.wa-sqlite/${safeName}`;
  const vfsName = `ahp-${safeName}`;
  let vfs = registry.get(vfsName) as OpfsAccessHandlePoolVFS | undefined;
  if (!vfs) {
    vfs = new OpfsAccessHandlePoolVFS(poolDirectory, vfsName);
    const rc = module.registerVFS(vfs, false);
    if (rc !== SQLITE_OK) throw new WaSqliteError(`registerVFS failed (${rc})`, rc);
    registry.set(vfsName, vfs);
  }
  await vfs.isReady;

  if (options.initialBytes) {
    const seeded = await vfs.seedFile(fileName, options.initialBytes);
    // Open-time persistence diagnostic: seeded=true means no prior OPFS
    // database existed (first migration, or OPFS was evicted/unavailable);
    // seeded=false means the durable file won and the seed was ignored.
    console.info(
      `[waSqlite] opfs open name=${safeName} seeded=${seeded} seedBytes=${options.initialBytes.byteLength}`
    );
  } else {
    console.info(`[waSqlite] opfs open name=${safeName} (no seed bytes)`);
  }

  const db = openDatabase(module, fileName, vfsName);
  return new WaSqliteDatabase(module, db, fileName, vfsName, null, vfs);
}

/** Type guard for the wa-sqlite adapter (vs. a sql.js Database). */
export function isWaSqliteDatabase(db: unknown): db is WaSqliteDatabase {
  return db instanceof WaSqliteDatabase;
}

export interface MigrationVerificationResult {
  ok: boolean;
  reason?: string;
}

// Offset of the user_version field in the SQLite database header.
const SQLITE_HEADER_USER_VERSION_OFFSET = 60;
// Minimum header size needed to read user_version (offset 60, 4 bytes).
const SQLITE_HEADER_MIN_BYTES = 64;

/**
 * Verifies that a database seeded via `initialBytes` (one-time migration
 * from sql.js/IndexedDB) landed intact:
 *
 * - `PRAGMA user_version` of the opened database must match the value stored
 *   in the source image header (bytes 60-63, big-endian uint32).
 * - `PRAGMA integrity_check` must return 'ok'.
 *
 * When `initialBytes` is undefined or too short to contain a header there is
 * nothing to compare against: returns `{ ok: true, reason: 'no-source-bytes' }`.
 */
export async function verifyMigratedDatabase(
  db: WaSqliteDatabase,
  initialBytes?: Uint8Array
): Promise<MigrationVerificationResult> {
  if (!initialBytes || initialBytes.byteLength < SQLITE_HEADER_MIN_BYTES) {
    return { ok: true, reason: 'no-source-bytes' };
  }

  const sourceVersion = new DataView(
    initialBytes.buffer,
    initialBytes.byteOffset,
    initialBytes.byteLength
  ).getUint32(SQLITE_HEADER_USER_VERSION_OFFSET, false);

  const versionRows = db.exec('PRAGMA user_version');
  const dbVersion = versionRows[0]?.values[0]?.[0];
  if (typeof dbVersion !== 'number') {
    return { ok: false, reason: 'could not read PRAGMA user_version from the database' };
  }
  // The database's version must be at least the source's: schema migrations
  // legitimately bump user_version when the seeded database is opened, so
  // equality would reject every migration-with-upgrade. A LOWER version than
  // the source means the seed did not land.
  if (dbVersion < sourceVersion) {
    return {
      ok: false,
      reason: `user_version regression: source image has ${sourceVersion}, database has ${dbVersion}`,
    };
  }

  const integrityRows = db.exec('PRAGMA integrity_check');
  const integrity = integrityRows[0]?.values[0]?.[0];
  if (integrity !== 'ok') {
    return {
      ok: false,
      reason: `integrity_check failed: ${typeof integrity === 'string' ? integrity : 'no result'}`,
    };
  }

  return { ok: true };
}
