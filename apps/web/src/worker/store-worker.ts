/**
 * store-worker — the Web Worker entry (~30 lines). Wires self.onmessage to the
 * shared handleMessage protocol over a WorkerCore. The init message carries
 * { sqlWasmUrl, workspaceId, serverUrl, apiKey }: the worker initializes
 * sql.js (locateFile → sqlWasmUrl), builds an HttpTransport, and opens the
 * OPFS-backed core. With `offline: true` it builds an OfflineTransport
 * instead (no server, no account; edits stay on the device until the
 * workspace is later connected). Spawnable via:
 *
 *   new Worker(new URL("./store-worker.ts", import.meta.url), { type: "module" })
 *
 * After every local apply / sync completion the core fires onNotify and the
 * worker posts a {type:"changed"} notification so the main-thread proxy can
 * refresh its read cache.
 */

import initSqlJs from "sql.js";

import { HttpTransport, OfflineTransport } from "@notees/sync";

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
  init: async ({ sqlWasmUrl, workspaceId, serverUrl, apiKey, offline }) => {
    const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    const transport = offline
      ? new OfflineTransport()
      : new HttpTransport({ baseUrl: serverUrl, apiKey, workspaceId });
    ctx.core = await WorkerCore.create({
      SQL,
      opfs: opfsStore(),
      fileName: `${workspaceId}.db`,
      workspaceId,
      transport,
      // §34.61: the per-user prefs calls (getPrefs/patchPrefs) are plain REST
      // — the worker owns the REST config, so forward it into the client.
      serverUrl,
      apiKey,
      // The change payload (revision/affected/structural, §34.114) rides
      // along so the main-thread cache refreshes incrementally.
      onNotify: (change) => workerScope.postMessage({ type: "changed", ...change }),
    });
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
        error instanceof Error ? (error.stack ?? error.message) : error,
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
