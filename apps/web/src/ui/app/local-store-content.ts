/**
 * local-store-content — the persisted-store emptiness probe for the F2
 * adoption offer.
 *
 * Detection arm #3: an offline-created workspace opened online earns its
 * publish OFFER only when the local store actually holds content. The probe
 * mirrors the client-seed gate's `storeIsEmpty` idiom (client-sync.ts):
 * `SELECT COUNT(*) FROM node` against the derived store, non-empty meaning
 * publishable.
 *
 * The connect path runs BEFORE any client exists, so the probe reads the
 * persisted image directly: the worker store pages one SQLite image per
 * workspace at OPFS `notees/<workspaceId>.db` (worker/opfs.ts). In-process
 * mode persists nothing, so it always probes empty — an offline workspace's
 * content cannot survive to an online open there. A WAL sibling means recent
 * writes may not be checkpointed into the main image: rather than
 * under-report content, that counts as non-empty (the user can decline).
 * A persisted file that fails to read still counts as non-empty — offering
 * beats silently skipping a publishable workspace.
 */

import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import { detectStoreMode } from "./storeMode.js";

type ProbeFn = (workspaceId: string) => Promise<boolean>;

let probeForTests: ProbeFn | undefined;

/** Test seam (fake-indexeddb idiom): stand in for the OPFS + sql.js probe. */
export function setLocalStoreContentProbeForTests(probe: ProbeFn | undefined): void {
  probeForTests = probe;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * True when the persisted local store for `workspaceId` holds node rows.
 * Never throws: every failure mode resolves to a boolean (see header).
 */
export async function localStoreHasContent(workspaceId: string): Promise<boolean> {
  if (probeForTests !== undefined) return probeForTests(workspaceId);
  if (detectStoreMode() !== "worker") return false;
  try {
    const root = await navigator.storage.getDirectory();
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await root.getDirectoryHandle("notees");
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    let file: FileSystemFileHandle;
    try {
      file = await dir.getFileHandle(`${workspaceId}.db`);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    try {
      await dir.getFileHandle(`${workspaceId}.db-wal`);
      // Recent writes may live only in the WAL — treat as non-empty.
      return true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    if (bytes.byteLength === 0) return false;
    const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    const db = new SQL.Database(bytes);
    try {
      const result = db.exec("SELECT COUNT(*) AS n FROM node");
      const n = result[0]?.values[0]?.[0];
      return typeof n === "number" && n > 0;
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn(
      `[notees-web] local-store content probe failed for ${workspaceId}; ` +
        "treating the store as non-empty (the adoption offer stays available):",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}
