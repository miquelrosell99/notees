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
  AssetInfo,
  AssetUploadResult,
  BlockTreeNode,
  ClassBinding,
  ClientEdge,
  ClientNode,
  ClientPropertySchema,
  CreateAnnotationInput,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  EffectiveProperty,
  QueryAggregateResult,
  QueryRunResult,
  ReferenceEntry,
  SetClassPropertyInput,
  SyncStatusSnapshot,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
} from "./workspace-client.js";
import { createAnnotation, fetchAssetBlob, postAssetUpload } from "./workspace-client.js";
import type {
  WorkerInitMessage,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "../worker/worker-core.js";

export interface WorkerClientOptions {
  /** Credential: operator API key or account session token (server accepts both). */
  serverUrl: string;
  apiKey: string;
  workspaceId: string;
  sqlWasmUrl: string;
  /** Offline-first mode: no server, edits stay on the device. */
  offline?: boolean;
  /** Test seam: supply a fake worker instead of spawning the real one. */
  spawn?: () => Worker;
}

export class WorkerClient {
  private readonly worker: Worker;
  private readonly workspaceId: string;
  /** Server REST access for the main-thread asset upload/download calls. */
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly offline: boolean;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly cache = new Map<string, unknown>();
  /**
   * Read-cache convergence, dirty-set style: every seeded key (and every
   * cached key on a worker "changed") lands here and a batched macrotask
   * drain fetches them all. The previous in-flight/queue design could strand
   * a key seeded while a refresh was finishing (in-flight but queue already
   * drained) — every boot-time seed landed exactly there and the synced
   * workspace rendered as an empty sidebar with zero errors.
   */
  private readonly refreshDirty = new Set<string>();
  private refreshScheduled = false;
  private refreshRunning = false;
  private closed = false;

  private constructor(
    worker: Worker,
    workspaceId: string,
    serverUrl: string,
    apiKey: string,
    offline: boolean,
  ) {
    this.worker = worker;
    this.workspaceId = workspaceId;
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.offline = offline;
    worker.onmessage = this.handleMessage;
  }

  /** Spawn the worker, post init, and wait until the store is booted. */
  static async create(options: WorkerClientOptions): Promise<WorkerClient> {
    const worker =
      options.spawn?.() ??
      new Worker(new URL("../worker/store-worker.ts", import.meta.url), { type: "module" });
    const client = new WorkerClient(
      worker,
      options.workspaceId,
      options.serverUrl,
      options.apiKey,
      options.offline === true,
    );
    const init: WorkerInitMessage = {
      sqlWasmUrl: options.sqlWasmUrl,
      workspaceId: options.workspaceId,
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      offline: options.offline === true,
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
      for (const key of this.cache.keys()) this.refreshDirty.add(key);
      this.scheduleRefresh();
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
    this.refreshDirty.add(key);
    this.scheduleRefresh();
    return empty;
  }

  /** Batched on a macrotask so a render burst seeds once and drains once. */
  private scheduleRefresh(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    setTimeout(() => {
      this.refreshScheduled = false;
      void this.drainRefresh();
    }, 0);
  }

  private async drainRefresh(): Promise<void> {
    if (this.refreshRunning) return; // the running drain re-checks dirty keys before exit
    this.refreshRunning = true;
    try {
      // Loop: reads seeded mid-drain mark themselves dirty and are fetched too.
      while (this.refreshDirty.size > 0) {
        const batch = Array.from(this.refreshDirty);
        this.refreshDirty.clear();
        for (const key of batch) {
          if (!this.cache.has(key)) continue;
          const [method, args] = JSON.parse(key) as [string, unknown[]];
          try {
            this.cache.set(key, await this.call(method, args));
          } catch (error) {
            // Keep the previous value; the next "changed" retries. Surface the
            // failure loudly, though: a silent stale cache is how real outages
            // hid (an FTS5 snapshot restore made every search return [] with
            // zero console output). The message crosses the worker RPC
            // boundary, so the original stack stays on the worker — the
            // engine logs it there.
            console.error(
              `WorkerClient: read "${method}" failed; keeping the cached value:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
      this.notify();
    } finally {
      this.refreshRunning = false;
      // Keys seeded after the last batch but before the finally (or while a
      // wedged call delayed this drain) get another drain.
      if (this.refreshDirty.size > 0) this.scheduleRefresh();
    }
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

  effectiveClassColor(classId: string): string | null {
    return this.cachedRead("effectiveClassColor", [classId], null);
  }

  effectiveClassIcon(classId: string): string | null {
    return this.cachedRead("effectiveClassIcon", [classId], null);
  }

  effectiveNodeIcon(node: { icon: string | null; classIds: string[] }): string | null {
    return this.cachedRead(
      "effectiveNodeIcon",
      [{ icon: node.icon, classIds: node.classIds }],
      null,
    );
  }

  effectiveNodeColor(node: { color: string | null; classIds: string[] }): string | null {
    return this.cachedRead(
      "effectiveNodeColor",
      [{ color: node.color, classIds: node.classIds }],
      null,
    );
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

  getClassChildren(classId: string): import("@/core/workspace-client.js").ClientNode[] {
    return this.cachedRead("getClassChildren", [classId], []);
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

  /** Asset metadata for a node reference (derived node_asset rows). */
  getAssetInfo(id: string): AssetInfo | undefined {
    return this.cachedRead<AssetInfo | undefined>("getAssetInfo", [id], undefined);
  }

  /** Highlight-classed annotations whose highlight_asset links this asset node. */
  getAnnotationsForAsset(assetId: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getAnnotationsForAsset", [assetId], []);
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

  getChildren(id: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getChildren", [id], []);
  }

  /**
   * Live-query bridge (async RPC; an invalid AST rejects with the worker's
   * Error message — the view renders the "invalid query" placeholder).
   */
  runQueryAst(rawAst: unknown): Promise<QueryRunResult> {
    return this.call("runQueryAst", [rawAst]) as Promise<QueryRunResult>;
  }

  /** Aggregation counterpart of runQueryAst (grouped grid for aggregated ASTs). */
  runAggregateAst(rawAst: unknown): Promise<QueryAggregateResult> {
    return this.call("runAggregateAst", [rawAst]) as Promise<QueryAggregateResult>;
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

  getUnlinkedReferenceCount(id: string): number {
    return this.cachedRead<number>("getUnlinkedReferenceCount", [id], 0);
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

  /** OR-set class membership remove (the class chip's × gesture). */
  async unassignClass(id: string, classId: string): Promise<void> {
    await this.call("unassignClass", [id, classId]);
  }

  async assignTag(id: string, tagId: string): Promise<void> {
    await this.call("assignTag", [id, tagId]);
  }

  async unassignTag(id: string, tagId: string): Promise<void> {
    await this.call("unassignTag", [id, tagId]);
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

  /** Patch a property schema (propertySchema.update — name/options/dates). */
  async updatePropertySchema(
    propertySchemaId: string,
    fields: UpdatePropertySchemaInput,
  ): Promise<void> {
    await this.call("updatePropertySchema", [propertySchemaId, fields]);
  }

  /** Author a property value (property.set) — shadows any derived default. */
  async setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx?: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.call("setProperty", [objectId, propertySchemaId, value, idx, metadata]);
  }

  /** Clear an authored property value (property.unset). */
  async unsetProperty(objectId: string, propertySchemaId: string, idx?: number): Promise<void> {
    await this.call("unsetProperty", [objectId, propertySchemaId, idx]);
  }

  /** Ensure the year/month/day chain for a date; returns the three node ids. */
  async ensureDateChain(
    isoDate: string,
  ): Promise<{ year: string; month: string; day: string }> {
    return (await this.call("ensureDateChain", [isoDate])) as {
      year: string;
      month: string;
      day: string;
    };
  }

  /** Set a date value at the schema's precision (chain create + property.set). */
  async setDateProperty(
    objectId: string,
    propertySchemaId: string,
    isoDate: string,
    idx?: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.call("setDateProperty", [objectId, propertySchemaId, isoDate, idx, metadata]);
  }

  /** Set a date_range value ({start, end} refs, either side open). */
  async setDateRangeProperty(
    objectId: string,
    propertySchemaId: string,
    start: string | null,
    end: string | null,
    idx?: number,
  ): Promise<void> {
    await this.call("setDateRangeProperty", [objectId, propertySchemaId, start, end, idx]);
  }

  /** Create an annotation on an asset (composed write over the RPC primitives). */
  createAnnotation(input: CreateAnnotationInput): Promise<string> {
    return createAnnotation(this, input);
  }

  // --- assets (REST upload/download on the main thread; the link op runs in
  // the worker, which owns the store) ----------------------------------------

  /** Upload file bytes to the server's CAS asset store (POST /api/v1/assets). */
  async uploadAsset(file: Blob, filename: string): Promise<AssetUploadResult> {
    return postAssetUpload(this.serverUrl, this.apiKey, this.workspaceId, file, filename);
  }

  /** Record an uploaded asset on a node (asset.attach op, enqueued in the worker). */
  async attachAsset(objectId: string, asset: AssetUploadResult): Promise<void> {
    await this.call("attachAsset", [objectId, asset]);
  }

  /** Download an asset's bytes (workspace key) and open them in a new tab. */
  async downloadAsset(assetId: string): Promise<void> {
    const blob = await fetchAssetBlob(this.serverUrl, this.apiKey, assetId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
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
    if (this.offline) return; // nothing to subscribe to
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
