/**
 * WorkerClient — main-thread proxy for the store Web Worker with the same
 * public surface as WorkspaceClient, so App can swap the in-process client
 * for the worker-backed one without UI changes.
 *
 * The worker owns the only store. Reads are synchronous here, so they are
 * served from a small local cache keyed by method+args; the worker posts a
 * {type:"changed"} notification after every local apply and sync completion,
 * and the proxy then re-fetches every cached key and notifies its own
 * subscribers. A first read of an unseen key returns the empty default and
 * kicks a refresh, so the UI converges on the next notification.
 */

import type {
  BlockTreeNode,
  ClientEdge,
  ClientNode,
  CreateObjectInput,
  DeleteObjectOptions,
  SyncStatusSnapshot,
  UpdateObjectInput,
} from "./workspace-client.js";
import type {
  WorkerInitMessage,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "../worker/worker-core.js";

export interface WorkerClientOptions {
  serverUrl: string;
  apiKey: string;
  workspaceId: string;
  sqlWasmUrl: string;
  /** Test seam: supply a fake worker instead of spawning the real one. */
  spawn?: () => Worker;
}

export class WorkerClient {
  private readonly worker: Worker;
  private readonly workspaceId: string;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly cache = new Map<string, unknown>();
  /** Keys queued for the current refresh; grows if reads arrive mid-refresh. */
  private refreshQueue: string[] | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private closed = false;

  private constructor(worker: Worker, workspaceId: string) {
    this.worker = worker;
    this.workspaceId = workspaceId;
    worker.onmessage = this.handleMessage;
  }

  /** Spawn the worker, post init, and wait until the store is booted. */
  static async create(options: WorkerClientOptions): Promise<WorkerClient> {
    const worker =
      options.spawn?.() ??
      new Worker(new URL("../worker/store-worker.ts", import.meta.url), { type: "module" });
    const client = new WorkerClient(worker, options.workspaceId);
    const init: WorkerInitMessage = {
      sqlWasmUrl: options.sqlWasmUrl,
      workspaceId: options.workspaceId,
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
    };
    await client.call("init", [init]);
    return client;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  // --- RPC plumbing ------------------------------------------------------------

  private handleMessage = (event: MessageEvent): void => {
    const message = event.data as WorkerResponseMessage | { type: "changed" };
    if ("type" in message && message.type === "changed") {
      void this.refreshCache();
      return;
    }
    const response = message as WorkerResponseMessage;
    const entry = this.pending.get(response.id);
    if (entry === undefined) return;
    this.pending.delete(response.id);
    if (response.error !== undefined) entry.reject(new Error(response.error));
    else entry.resolve(response.result);
  };

  private call(method: string, args: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("WorkerClient: closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: WorkerRequestMessage = { id, method, args };
      this.worker.postMessage(message);
    });
  }

  // --- read cache -------------------------------------------------------------------

  private cachedRead<T>(method: string, args: unknown[], empty: T): T {
    const key = JSON.stringify([method, args]);
    if (this.cache.has(key)) return this.cache.get(key) as T;
    this.cache.set(key, empty);
    if (this.refreshInFlight !== null && this.refreshQueue !== null) {
      // A refresh is running; extend its queue so the new key is fetched too.
      this.refreshQueue.push(key);
    } else {
      void this.refreshCache();
    }
    return empty;
  }

  private refreshCache(): Promise<void> {
    if (this.refreshInFlight !== null) return this.refreshInFlight;
    this.refreshQueue = Array.from(this.cache.keys());
    this.refreshInFlight = (async () => {
      try {
        const queue = this.refreshQueue;
        if (queue === null) return;
        // Indexed loop: keys pushed mid-refresh (new cached reads) are fetched too.
        for (let i = 0; i < queue.length; i += 1) {
          const key = queue[i]!;
          if (!this.cache.has(key)) continue;
          const [method, args] = JSON.parse(key) as [string, unknown[]];
          try {
            this.cache.set(key, await this.call(method, args));
          } catch {
            // Keep the previous value; the next "changed" retries.
          }
        }
        this.notify();
      } finally {
        this.refreshInFlight = null;
        this.refreshQueue = null;
      }
    })();
    return this.refreshInFlight;
  }

  // --- read API (served from the cache; converges via "changed") -------------------------

  getNode(id: string): ClientNode | undefined {
    return this.cachedRead("getNode", [id], undefined);
  }

  getNodeRaw(id: string): ClientNode | undefined {
    return this.cachedRead("getNodeRaw", [id], undefined);
  }

  getDisplayName(id: string): string | null {
    return this.cachedRead("getDisplayName", [id], null);
  }

  getPage(id: string): ClientNode | undefined {
    return this.cachedRead("getPage", [id], undefined);
  }

  listPages(): ClientNode[] {
    return this.cachedRead<ClientNode[]>("listPages", [], []);
  }

  getBlockTree(pageId: string, depth?: number): BlockTreeNode[] {
    return this.cachedRead<BlockTreeNode[]>("getBlockTree", [pageId, depth], []);
  }

  search(query: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("search", [query], []);
  }

  getBacklinks(id: string): ClientEdge[] {
    return this.cachedRead<ClientEdge[]>("getBacklinks", [id], []);
  }

  // --- write API & sync (RPC; the worker's "changed" drives the cache refresh) --------

  async createObject(partial: CreateObjectInput): Promise<string> {
    return (await this.call("createObject", [partial])) as string;
  }

  async updateObject(id: string, fields: UpdateObjectInput): Promise<void> {
    await this.call("updateObject", [id, fields]);
  }

  async deleteObject(id: string, opts?: DeleteObjectOptions): Promise<void> {
    await this.call("deleteObject", [id, opts]);
  }

  /** No-op when the worker already booted this workspace (init bootstraps it). */
  async bootstrapWorkspace(workspaceId: string): Promise<void> {
    await this.call("bootstrapWorkspace", [workspaceId]);
  }

  /** One push+pull cycle against the relay. */
  async sync(): Promise<void> {
    await this.call("syncOnce", []);
  }

  async push(): Promise<void> {
    await this.call("push", []);
  }

  async pull(): Promise<void> {
    await this.call("pull", []);
  }

  /** Wire the WS acceleration path in the worker. */
  async startRealtime(): Promise<void> {
    await this.call("startRealtime", []);
  }

  async stopRealtime(): Promise<void> {
    await this.call("stopRealtime", []);
  }

  /** Engine + outbox + realtime state for the footer status indicator. */
  async status(): Promise<SyncStatusSnapshot> {
    return (await this.call("status", [])) as SyncStatusSnapshot;
  }

  // --- notifications ----------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Terminate the worker; pending calls reject. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.reject(new Error("WorkerClient: closed"));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
