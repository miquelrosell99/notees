/**
 * store-worker — the Web Worker entry (~30 lines). Wires self.onmessage to the
 * shared handleMessage protocol over a WorkerCore. The init message carries
 * { sqlWasmUrl, workspaceId, serverUrl, apiKey }: the worker initializes
 * sql.js (locateFile → sqlWasmUrl), builds an HttpTransport, and opens the
 * OPFS-backed core. Spawnable via:
 *
 *   new Worker(new URL("./store-worker.ts", import.meta.url), { type: "module" })
 *
 * After every local apply / sync completion the core fires onNotify and the
 * worker posts a {type:"changed"} notification so the main-thread proxy can
 * refresh its read cache.
 */

import initSqlJs from "sql.js";

import { HttpTransport } from "@notees/sync";

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
  init: async ({ sqlWasmUrl, workspaceId, serverUrl, apiKey }) => {
    const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    const transport = new HttpTransport({ baseUrl: serverUrl, apiKey, workspaceId });
    ctx.core = await WorkerCore.create({
      SQL,
      opfs: opfsStore(),
      fileName: `${workspaceId}.db`,
      workspaceId,
      transport,
      onNotify: () => workerScope.postMessage({ type: "changed" }),
    });
  },
};

workerScope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  void handleMessage(ctx, event.data).then((response) => workerScope.postMessage(response));
};
