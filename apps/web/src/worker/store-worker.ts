/**
 * store-worker — the Web Worker entry (~30 lines). Wires self.onmessage to the
 * shared handleMessage protocol over a WorkerCore. The init message carries
 * { sqlWasmUrl, sqliteWasmUrl, workspaceId, serverUrl, apiKey }: the worker
 * initializes the store backend and builds an HttpTransport. With `offline:
 * true` it builds an OfflineTransport instead (no server, no account; edits
 * stay on the device until the workspace is later connected). Spawnable via:
 *
 *   new Worker(new URL("./store-worker.ts", import.meta.url), { type: "module" })
 *
 * Backend selection (the streamed-snapshot-restore slice): PREFERRED is the
 * official sqlite-wasm build over the OPFS VFS — database pages live in OPFS
 * and only the working set touches WASM memory, so a snapshot restore stages
 * the (gzipped) bytes into the OPFS file and opens by name instead of holding
 * the whole image in the heap. ANY unavailability (no `sqliteWasmUrl`, init
 * failure, no `opfs` VFS — non-secure contexts, no AccessHandles) falls back
 * to the sql.js backend with whole-file OPFS persistence, byte-identical
 * behavior from the worker core's perspective.
 *
 * After every local apply / sync completion the core fires onNotify and the
 * worker posts a {type:"changed"} notification so the main-thread proxy can
 * refresh its read cache.
 */

import initSqlJs from "sql.js";
import { default as initSqliteWasm } from "@sqlite.org/sqlite-wasm";

import { HttpTransport, OfflineTransport } from "@notees/sync";

import { sqliteWasmBackend, type SqliteWasmModule } from "@notees/store/sqlitewasm";

import { opfsStore } from "./opfs.js";
import {
  WorkerCore,
  handleMessage,
  type WorkerContext,
  type WorkerRequestMessage,
} from "./worker-core.js";

const workerScope = self as unknown as Worker;

const ctx: WorkerContext = {
  core: null,
  init: async ({ sqlWasmUrl, sqliteWasmUrl, workspaceId, serverUrl, apiKey, offline }) => {
    const transport = offline
      ? new OfflineTransport()
      : new HttpTransport({ baseUrl: serverUrl, apiKey, workspaceId });
    const fileName = `${workspaceId}.db`;
    const opfs = opfsStore();
    // The change payload (revision/affected/structural) rides
    // along so the main-thread cache refreshes incrementally.
    const onNotify = (change: object) => workerScope.postMessage({ type: "changed", ...change });
    const common = {
      opfs,
      fileName,
      workspaceId,
      transport,
      // The per-user prefs calls (getPrefs/patchPrefs) are plain REST
      // — the worker owns the REST config, so forward it into the client.
      serverUrl,
      apiKey,
      onNotify,
    };

    if (sqliteWasmUrl !== undefined) {
      try {
        // The types declare a zero-arg init; the emscripten locateFile hook
        // is accepted at runtime (mirrors sql.js' locateFile contract).
        const init = initSqliteWasm as unknown as (opts: {
          locateFile: (file: string) => string;
        }) => Promise<unknown>;
        const sqlite3 = (await init({ locateFile: () => sqliteWasmUrl })) as SqliteWasmModule;
        if (sqlite3.capi.sqlite3_vfs_find("opfs") && sqlite3.oo1.OpfsDb !== undefined) {
          ctx.core = await WorkerCore.create({
            ...common,
            backend: sqliteWasmBackend(sqlite3, {
              kind: "opfs",
              fileName,
              // Staged restore: the snapshot bytes land in the OPFS file,
              // then the connection opens by name (restoreAsync).
              writeFile: (bytes) => opfs.saveFile(fileName, bytes),
            }),
            // The VFS persists pages through — no whole-file export saves.
            persistent: true,
          });
          return;
        }
      } catch (error: unknown) {
        console.warn(
          "store-worker: sqlite-wasm/OPFS backend unavailable, falling back to sql.js:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    ctx.core = await WorkerCore.create({ SQL, ...common });
  },
};

workerScope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  // Both fulfillment and rejection must post a response: a caller awaits its
  // id forever otherwise (a silent hang — the read cache then strands its
  // in-flight refresh and every cached read stays at its seeded empty value).
  void handleMessage(ctx, event.data).then(
    (response) => workerScope.postMessage(response),
    (error: unknown) => {
      console.error(
        "store-worker: message handler failed without a response:",
        error instanceof Error ? (error.stack ?? error.message).slice(0, 4096) : String(error).slice(0, 4096),
      );
      const id = (event.data as { id?: unknown }).id;
      if (typeof id === "number") {
        workerScope.postMessage({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
};
