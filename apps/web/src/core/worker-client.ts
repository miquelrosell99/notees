/**
 * WorkerClient — main-thread proxy for the store Web Worker with the same
 * public surface as WorkspaceClient, so App can swap the in-process client
 * for the worker-backed one without UI changes.
 *
 * The worker owns the only store. Reads are synchronous here, so they are
 * served from a small local cache keyed by method+args; the worker posts a
 * {type:"changed"} notification after every local apply and sync completion
 * (coalesced worker-side), and the proxy then re-fetches the
 * impacted cache keys — in ONE multiRead round-trip per drain, and only the
 * keys the change payload actually invalidates — and notifies its own
 * subscribers. A first read of an unseen key returns the empty default and
 * kicks a refresh, so the UI converges on the next notification.
 */

import { startTransition } from "react";

import type { WorkspaceFeature } from "@notees/protocol";
import type { GraphOptions, GraphTopology } from "@notees/store";
import type {
  AssetInfo,
  AssetUploadResult,
  BlockTreeNode,
  ClassBinding,
  ClientEdge,
  ClientNode,
  ClientPropertySchema,
  ChangeNotification,
  ConflictHistoryEntry,
  CreateAnnotationInput,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  EffectiveProperty,
  OperationFeedEntry,
  QueryAggregateResult,
  QueryRunResult,
  ReferenceEntry,
  SearchPageResult,
  SearchSnippetData,
  SetClassPropertyInput,
  SyncStatusSnapshot,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
} from "./workspace-client.js";
import {
  createAnnotation,
  fetchAssetBlob,
  postAssetUpload,
  readBlobAsDataUrl,
  type PrefsPatch,
  type SectionView,
  type UserPrefs,
  type UserPrefsSource,
} from "./workspace-client.js";
import type { UndoHistoryEntry, UndoUiState } from "./undo-journal.js";
import type {
  WorkerInitMessage,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "../worker/worker-core.js";

/**
 * Invalidation class for a cached read key, consulted only for
 * content-only changes with a known affected set (`structural` or unknown
 * scope invalidates everything and never reaches this table):
 *
 *  - "change": read embeds titles/link marks from anywhere (search,
 *    reference edges, the page listings) — any content edit may alter it.
 *  - "structure": read resolves definitions/membership (class chains, pure
 *    node-snapshot functions like effectiveNodeIcon) — only
 *    listing-affecting ops invalidate it.
 *  - "scope": read is parameterized by a node/class id — invalidated when
 *    the id is in the (ancestor-expanded) affected set. args[0] is the id.
 *  - absent (default): invalidate on any change — the conservative fallback.
 */
const READ_INVALIDATION: Record<string, "change" | "structure" | "scope"> = {
  // Node-scoped reads (args[0] = the node/class id).
  getNode: "scope",
  getNodeRaw: "scope",
  getDisplayName: "scope",
  getPage: "scope",
  getChildren: "scope",
  getChildPages: "scope",
  getBacklinkCount: "scope",
  getChildPageCount: "scope",
  getEffectiveProperties: "scope",
  getAssetInfo: "scope",
  getAnnotationsForAsset: "scope",
  getClassParents: "scope",
  getClassChildren: "scope",
  getClassMembers: "scope",
  getClassMemberCount: "scope",
  getClassBindings: "scope",
  getBlockTree: "scope",
  // Node-alias reads: a chain link ANYWHERE (args[0]'s chain is not an
  // ancestor relation of the affected set) may change the answer — the
  // conservative content-global class is the honest one.
  resolveAlias: "change",
  aliasNodesOf: "change",
  // Content-global reads: titles and typed link marks flow in from anywhere.
  search: "change",
  getSearchSnippet: "change",
  resolveNodeByName: "change",
  getBacklinks: "change",
  getLinkedReferences: "change",
  getReferences: "change",
  getReferenceCount: "change",
  getUnlinkedReferences: "change",
  getUnlinkedReferenceCount: "change",
  getPropertyReferences: "change",
  getCoverReferences: "change",
  listPages: "change",
  roots: "change",
  // Structural-global reads: definitions/membership/pure-of-args functions.
  listClasses: "structure",
  classIcons: "structure",
  effectiveClassIcons: "structure",
  listPropertySchemas: "structure",
  listFeatureRows: "structure",
  getFeatureInstanceCount: "structure",
  isFeatureEnabled: "structure",
  effectiveNodeIcon: "structure",
  effectiveNodeColor: "structure",
  effectiveClassColor: "structure",
  effectiveClassIcon: "structure",
};

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
    const message = event.data as
      | WorkerResponseMessage
      | (ChangeNotification & { type: "changed" });
    if ("type" in message && message.type === "changed") {
      this.handleChanged(message);
      return;
    }
    const response = message as WorkerResponseMessage;
    const entry = this.pending.get(response.id);
    if (entry === undefined) return;
    this.pending.delete(response.id);
    if (response.error !== undefined) entry.reject(new Error(response.error));
    else entry.resolve(response.result);
  };

  /**
   * Incremental cache invalidation: a structural or scope-unknown
   * change dirties every cached key; a content-only change dirties only the
   * keys its affected set (ancestor-expanded) touches — scoped reads, plus
   * the content-global class (search/reference listings embed titles and
   * link marks from anywhere).
   */
  private handleChanged(change: ChangeNotification & { type: "changed" }): void {
    const structural = change.structural === true;
    const affected = change.affectedNodeIds;
    const full = structural || affected === undefined;
    const affectedSet = full ? null : new Set(affected);
    // A scoped payload with an empty affected set means "nothing is stale"
    // (status flips, no-op sync cycles): run the notify cycle for
    // subscribers, but dirty no cache keys.
    if (affectedSet !== null && affectedSet.size === 0) {
      this.scheduleRefresh();
      return;
    }
    for (const key of this.cache.keys()) {
      if (full || this.isKeyInvalidated(key, affectedSet!)) {
        this.refreshDirty.add(key);
      }
    }
    this.scheduleRefresh();
  }

  private isKeyInvalidated(key: string, affectedSet: Set<string>): boolean {
    let method: string;
    let args: unknown[];
    try {
      [method, args] = JSON.parse(key) as [string, unknown[]];
    } catch {
      return true; // unparseable key: conservatively invalidate
    }
    const kind = READ_INVALIDATION[method] ?? "change";
    if (kind === "change") return true;
    if (kind === "structure") return false;
    const scopeId = args[0];
    return typeof scopeId === "string" && affectedSet.has(scopeId);
  }

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
        const batch = Array.from(this.refreshDirty).filter((key) => this.cache.has(key));
        this.refreshDirty.clear();
        if (batch.length === 0) continue;
        // ONE round-trip for the whole batch instead of an awaited
        // RPC per key: a keystroke used to cost hundreds of postMessage
        // round-trips through the worker.
        try {
          const results = (await this.call("multiRead", [batch])) as unknown[];
          if (!Array.isArray(results) || results.length !== batch.length) {
            throw new Error(
              `multiRead returned ${Array.isArray(results) ? results.length : "a non-array"} results for ${batch.length} keys`,
            );
          }
          batch.forEach((key, index) => {
            this.cache.set(key, results[index]);
          });
        } catch (error) {
          // Keep the previous values; the next "changed" retries. Surface the
          // failure loudly, though: a silent stale cache is how real outages
          // hid (an FTS5 snapshot restore made every search return [] with
          // zero console output). The message crosses the worker RPC
          // boundary, so the original stack stays on the worker — the
          // engine logs it there.
          const methods = batch.map((key) => {
            try {
              return (JSON.parse(key) as [string])[0];
            } catch {
              return key;
            }
          });
          console.error(
            `WorkerClient: read "${methods.join('", "')}" failed; keeping the cached values:`,
            error instanceof Error ? error.message : error,
          );
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

  effectiveClassIcon(classId: string): string {
    // Never null — the class default is the chain's tail; "" seeds the cache
    // until the worker refresh lands (Icon renders nothing for empty).
    return this.cachedRead<string>("effectiveClassIcon", [classId], "");
  }

  effectiveNodeIcon(node: {
    icon: string | null;
    classIds: string[];
    isClass: boolean;
    presentAsMain: boolean;
    parentId: string | null;
  }): string | null {
    return this.cachedRead(
      "effectiveNodeIcon",
      [
        {
          icon: node.icon,
          classIds: node.classIds,
          isClass: node.isClass,
          presentAsMain: node.presentAsMain,
          parentId: node.parentId,
        },
      ],
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

  roots(): ClientNode[] {
    return this.cachedRead<ClientNode[]>("roots", [], []);
  }

  listClasses(): ClientNode[] {
    return this.cachedRead<ClientNode[]>("listClasses", [], []);
  }

  /** The narrow id → icon read behind the UI icon maps. */
  classIcons(): ReadonlyMap<string, string | null> {
    return this.cachedRead<ReadonlyMap<string, string | null>>("classIcons", [], new Map());
  }

  /** The chain-resolved id → effective icon read (#1 follow-up). */
  effectiveClassIcons(): ReadonlyMap<string, string | null> {
    return this.cachedRead<ReadonlyMap<string, string | null>>("effectiveClassIcons", [], new Map());
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

  /** The classed-nodes section badge (same membership projection as a COUNT). */
  getClassMemberCount(classId: string): number {
    return this.cachedRead<number>("getClassMemberCount", [classId], 0);
  }

  getClassBindings(classId: string): ClassBinding[] {
    return this.cachedRead<ClassBinding[]>("getClassBindings", [classId], []);
  }

  /**
   * The class's OWN registry rows — no extends inheritance, no seed-spec
   * fallback (the deploy-path existence read; see WorkspaceClient).
   */
  getRegistryBindings(classId: string): ClassBinding[] {
    return this.cachedRead<ClassBinding[]>("getRegistryBindings", [classId], []);
  }

  getEffectiveProperties(id: string): EffectiveProperty[] {
    return this.cachedRead<EffectiveProperty[]>("getEffectiveProperties", [id], []);
  }

  /** Nodes carrying an authored value for the schema (the PropertyView references). */
  getPropertyReferences(schemaId: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getPropertyReferences", [schemaId], []);
  }

  /** Nodes whose coverAssetId wire field points at the asset (the Cover badge). */
  getCoverReferences(assetId: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getCoverReferences", [assetId], []);
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

  search(query: string, limit?: number): ClientNode[] {
    return this.cachedRead<ClientNode[]>("search", [query, limit ?? null], []);
  }

  /**
   * Cursor-paginated ranked search: raw RPC (not the read cache —
   * the cache key would include the cursor, so a load-more could never reuse
   * the first page anyway). `cursor` is the previous page's `nextCursor`.
   */
  searchPage(query: string, opts?: { limit?: number; cursor?: string | null }): Promise<SearchPageResult> {
    return this.call("searchPage", [query, opts ?? null]) as Promise<SearchPageResult>;
  }

  /**
   * Match-context snippet for one node + query. Served from the
   * read cache like `search`: the first read seeds null and converges on the
   * worker's "changed" notification.
   */
  getSearchSnippet(
    nodeId: string,
    query: string,
    opts?: { maxTokens?: number; ellipsis?: string },
  ): SearchSnippetData | null {
    return this.cachedRead<SearchSnippetData | null>("getSearchSnippet", [nodeId, query, opts ?? null], null);
  }

  /** Name→id resolution: exact display-name match; null when unknown. */
  resolveNodeByName(name: string): string | null {
    return this.cachedRead<string | null>("resolveNodeByName", [name], null);
  }

  /**
   * Property value history feed — async RPC into the worker's
   * WorkspaceClient (the REST call needs no store; the worker owns the REST
   * config). Rejects with the feed error when the server is unreachable.
   */
  async fetchOperationsFor(objectId: string, propertySchemaId: string): Promise<OperationFeedEntry[]> {
    return (await this.call("fetchOperationsFor", [objectId, propertySchemaId])) as OperationFeedEntry[];
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

  /**
   * The terminal of a node-alias chain (the navigation seam — unresolved
   * seeds as the id itself, converging on the worker's refresh).
   */
  resolveAlias(id: string): string {
    return this.cachedRead<string>("resolveAlias", [id], id);
  }

  /** Every live alias page of the node (the title-row aliases listing). */
  aliasNodesOf(id: string): import("@/core/workspace-client.js").ClientNode[] {
    return this.cachedRead("aliasNodesOf", [id], []);
  }

  getLinkedReferences(id: string): ReferenceEntry[] {
    return this.cachedRead<ReferenceEntry[]>("getLinkedReferences", [id], []);
  }

  getReferences(id: string): ClientNode[] {
    return this.cachedRead<ClientNode[]>("getReferences", [id], []);
  }

  getReferenceCount(id: string): number {
    return this.cachedRead<number>("getReferenceCount", [id], 0);
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

  /** Feature-toggle read — absent row means enabled (default on). */
  isFeatureEnabled(feature: WorkspaceFeature): boolean {
    return this.cachedRead<boolean>("isFeatureEnabled", [feature], true);
  }

  /** Toggled feature rows only (untoggled features are absent, not listed). */
  listFeatureRows(): Array<{ feature: string; enabled: boolean }> {
    return this.cachedRead<Array<{ feature: string; enabled: boolean }>>("listFeatureRows", [], []);
  }

  /** Active instance count across the feature's managed classes (the disable confirmation). */
  getFeatureInstanceCount(feature: WorkspaceFeature): number {
    return this.cachedRead<number>("getFeatureInstanceCount", [feature], 0);
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

  /** Reparent a node (outliner indent/outdent; `afterId`/`beforeId` = sibling placement). */
  async moveObject(
    id: string,
    parentId: string | null,
    afterId?: string,
    beforeId?: string,
  ): Promise<void> {
    await this.call("moveObject", [id, parentId, afterId, beforeId]);
  }

  /** OR-set class membership add (the `#` / `+` set gesture). */
  async assignClass(id: string, classId: string): Promise<void> {
    await this.call("assignClass", [id, classId]);
  }

  /** OR-set class membership remove (the class chip's × gesture). */
  async unassignClass(id: string, classId: string): Promise<void> {
    await this.call("unassignClass", [id, classId]);
  }

  async reorderClasses(id: string, classIds: string[]): Promise<void> {
    await this.call("reorderClasses", [id, classIds]);
  }

  async assignTag(id: string, tagId: string): Promise<void> {
    await this.call("assignTag", [id, tagId]);
  }

  async unassignTag(id: string, tagId: string): Promise<void> {
    await this.call("unassignTag", [id, tagId]);
  }

  /** Create a class (class.create); returns the new class id. */
  async createClass(
    name: string,
    opts?: { icon?: string; color?: string; id?: string },
  ): Promise<string> {
    return (await this.call("createClass", [name, opts])) as string;
  }

  /** Replace a class's full extends parent set (class.setExtends, m2m). */
  /** Write a feature toggle (workspace.feature.set, LWW by HLC). */
  async setFeatureEnabled(feature: WorkspaceFeature, enabled: boolean): Promise<void> {
    await this.call("setFeatureEnabled", [feature, enabled]);
  }

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

  /** Soft-delete a property schema (propertySchema.delete — the PG3 convert flow). */
  async deletePropertySchema(propertySchemaId: string): Promise<void> {
    await this.call("deletePropertySchema", [propertySchemaId]);
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

  /** Upload file bytes to the server's CAS asset store (POST /api/assets). */
  async uploadAsset(file: Blob, filename: string): Promise<AssetUploadResult> {
    return postAssetUpload(this.serverUrl, this.apiKey, this.workspaceId, file, filename);
  }

  /** Record an uploaded asset on a node (asset.attach op, enqueued in the worker). */
  async attachAsset(objectId: string, asset: AssetUploadResult): Promise<void> {
    await this.call("attachAsset", [objectId, asset]);
  }

  /** Download an asset's bytes (workspace key); the export engine's include-assets read. */
  async fetchAssetBytes(assetId: string): Promise<Blob> {
    return fetchAssetBlob(this.serverUrl, this.apiKey, assetId, this.workspaceId);
  }

  /** Download an asset's bytes (workspace key) and open them in a new tab. */
  async downloadAsset(assetId: string): Promise<void> {
    const blob = await fetchAssetBlob(this.serverUrl, this.apiKey, assetId, this.workspaceId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
  }

  /** An image asset's bytes as a data URL (card covers / thumbnails). */
  async getAssetDataUrl(assetNodeId: string): Promise<string | null> {
    // Bypass the synchronous read cache: cachedRead seeds the EMPTY value and
    // fills it on a macrotask, so a same-tick consumer (this async path reads
    // getAssetInfo synchronously inside) would always see undefined and the
    // thumbnail cache would pin the null for the session — covers rendered
    // "No image bytes" even with complete data (2026-10-04). Await the worker
    // read directly; this path is already async.
    const info = (await this.call("getAssetInfo", [assetNodeId])) as AssetInfo | undefined;
    if (info === undefined || !info.mimeType.startsWith("image/")) return null;
    try {
      const blob = await fetchAssetBlob(this.serverUrl, this.apiKey, info.assetId, this.workspaceId);
      return await readBlobAsDataUrl(blob);
    } catch {
      return null;
    }
  }

  /** No-op when the worker already booted this workspace (init bootstraps it). */
  async bootstrapWorkspace(workspaceId: string): Promise<void> {
    await this.call("bootstrapWorkspace", [workspaceId]);
  }

  // --- session undo journal (the journal lives worker-side, per tab) --------------

  /** Availability + the "Undo <verb>"/"Redo <verb>" labels for chrome. */
  undoState(): Promise<UndoUiState> {
    return this.call("undoState", []) as Promise<UndoUiState>;
  }

  /** The browsable history (oldest-first) behind the jump-to menu. */
  undoHistory(): Promise<UndoHistoryEntry[]> {
    return this.call("undoHistory", []) as Promise<UndoHistoryEntry[]>;
  }

  /**
   * The graph-view topology projection. Uncached by design — the
   * graph view debounces its own reloads on `subscribe` notifications, and a
   * workspace-scale projection must never ride the key-value cache.
   */
  graphTopology(options?: GraphOptions): Promise<GraphTopology> {
    return this.call("graphTopology", [options ?? null]) as Promise<GraphTopology>;
  }

  /** Undo the most recent journaled local write; false when the journal is empty. */
  async undo(): Promise<boolean> {
    return (await this.call("undo", [])) as boolean;
  }

  /** Redo the most recently undone entry; false when the redo stack is empty. */
  async redo(): Promise<boolean> {
    return (await this.call("redo", [])) as boolean;
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

  /**
   * Recent semantic sync conflicts: raw RPC (not cached) — the
   * sync details modal reads it on open and on worker notifications.
   */
  async conflictHistory(): Promise<ConflictHistoryEntry[]> {
    return (await this.call("conflictHistory", [])) as ConflictHistoryEntry[];
  }

  /**
   * Per-user UI prefs (favorites/recents, server-side). RPC into
   * the worker (it owns the REST config); resolves the device-local cache
   * when offline, tagged `source`.
   */
  async getPrefs(): Promise<UserPrefs & { source: UserPrefsSource }> {
    return (await this.call("getPrefs", [])) as UserPrefs & { source: UserPrefsSource };
  }

  /** Merge-patch per-user UI prefs (see WorkspaceClient.patchPrefs). */
  async patchPrefs(patch: PrefsPatch): Promise<UserPrefs & { source: UserPrefsSource }> {
    return (await this.call("patchPrefs", [patch])) as UserPrefs & { source: UserPrefsSource };
  }

  // --- per-user hosted section views (custom tabs — the prefs channel) --------

  /** The section's custom views in tab order (REST through the worker). */
  async listSectionViews(nodeId: string, sectionKey: string): Promise<SectionView[]> {
    return (await this.call("listSectionViews", [nodeId, sectionKey])) as SectionView[];
  }

  /** POST a new view (appended; 409 = name collision). */
  async createSectionView(input: {
    nodeId: string;
    sectionKey: string;
    name: string;
    queryAst: unknown;
    viewMode?: string | null;
  }): Promise<SectionView> {
    return (await this.call("createSectionView", [input])) as SectionView;
  }

  /** PATCH a view's name (404 = missing/foreign). */
  async renameSectionView(
    nodeId: string,
    sectionKey: string,
    viewId: string,
    name: string,
  ): Promise<SectionView> {
    return (await this.call("renameSectionView", [nodeId, sectionKey, viewId, name])) as SectionView;
  }

  /** PUT the full ordered id list; sequences rewrite 0..n-1. */
  async reorderSectionViews(
    nodeId: string,
    sectionKey: string,
    orderedIds: string[],
  ): Promise<SectionView[]> {
    return (await this.call("reorderSectionViews", [
      nodeId,
      sectionKey,
      orderedIds,
    ])) as SectionView[];
  }

  /** DELETE a view (204; 404 = missing/foreign). */
  async deleteSectionView(nodeId: string, sectionKey: string, viewId: string): Promise<void> {
    await this.call("deleteSectionView", [nodeId, sectionKey, viewId]);
  }

  // --- notifications ----------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    // De-prioritize the refresh-driven render: the drain completes
    // on a worker message / macrotask where React would otherwise render
    // synchronously (performSyncWorkOnRoot) ahead of queued input. Inside a
    // transition, keystrokes and clicks win the next frame.
    startTransition(() => {
      for (const listener of this.listeners) listener();
    });
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
