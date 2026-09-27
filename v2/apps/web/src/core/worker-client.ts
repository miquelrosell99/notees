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
  ClassBinding,
  ClientEdge,
  ClientNode,
  ClientPropertySchema,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  EffectiveProperty,
  ReferenceEntry,
  SetClassPropertyInput,
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

  listClasses(): ClientNode[] {
    return this.cachedRead<ClientNode[]>("listClasses", [], []);
  }

  getClassParents(classId: string): string[] {
    return this.cachedRead<string[]>("getClassParents", [classId], []);
  }

  getClassMembers(classId: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getClassMembers", [classId], []);
  }

  getClassBindings(classId: string): ClassBinding[] {
    return this.cachedRead<ClassBinding[]>("getClassBindings", [classId], []);
  }

  getEffectiveProperties(id: string): EffectiveProperty[] {
    return this.cachedRead<EffectiveProperty[]>("getEffectiveProperties", [id], []);
  }

  listPropertySchemas(): ClientPropertySchema[] {
    return this.cachedRead<ClientPropertySchema[]>("listPropertySchemas", [], []);
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

  getLinkedReferences(id: string): ReferenceEntry[] {
    return this.cachedRead<ReferenceEntry[]>("getLinkedReferences", [id], []);
  }

  getUnlinkedReferences(id: string): ReferenceEntry[] {
    return this.cachedRead<ReferenceEntry[]>("getUnlinkedReferences", [id], []);
  }

  getChildPages(id: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getChildPages", [id], []);
  }

  getBacklinkCount(id: string): number {
    return this.cachedRead<number>("getBacklinkCount", [id], 0);
  }

  getChildPageCount(id: string): number {
    return this.cachedRead<number>("getChildPageCount", [id], 0);
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

  /** Reparent a node (outliner indent/outdent; `afterId` = sibling placement). */
  async moveObject(id: string, parentId: string | null, afterId?: string): Promise<void> {
    await this.call("moveObject", [id, parentId, afterId]);
  }

  /** OR-set class membership add (the `#` / `+` set gesture). */
  async assignClass(id: string, classId: string): Promise<void> {
    await this.call("assignClass", [id, classId]);
  }

  /** Create a class (class.create); returns the new class id. */
  async createClass(name: string, opts?: { icon?: string; color?: string }): Promise<string> {
    return (await this.call("createClass", [name, opts])) as string;
  }

  /** Replace a class's full extends parent set (class.setExtends, m2m). */
  async setClassExtends(classId: string, parentClassIds: string[]): Promise<void> {
    await this.call("setClassExtends", [classId, parentClassIds]);
  }

  /** Upsert a class → property-schema binding (class.property.set, patch). */
  async setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void> {
    await this.call("setClassProperty", [classId, propertySchemaId, fields]);
  }

  /** Remove a class → property-schema binding (class.property.unset). */
  async unsetClassProperty(classId: string, propertySchemaId: string): Promise<void> {
    await this.call("unsetClassProperty", [classId, propertySchemaId]);
  }

  /** Create a property schema (propertySchema.create); returns the new id. */
  async createPropertySchema(input: CreatePropertySchemaInput): Promise<string> {
    return (await this.call("createPropertySchema", [input])) as string;
  }

  /** Author a property value (property.set) — shadows any derived default. */
  async setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx?: number,
  ): Promise<void> {
    await this.call("setProperty", [objectId, propertySchemaId, value, idx]);
  }

  /** Clear an authored property value (property.unset). */
  async unsetProperty(objectId: string, propertySchemaId: string, idx?: number): Promise<void> {
    await this.call("unsetProperty", [objectId, propertySchemaId, idx]);
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
