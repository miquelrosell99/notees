/**
 * WorkerCore — framework-agnostic core of the store Web Worker (browser
 * persistence slice). Given an initialized sql.js module, an OpfsStore, a
 * file name, and (optionally) a Transport, it:
 *
 *  - opens the Store (sqljsBackend), restoring saved OPFS bytes when present,
 *    else fresh — an unreachable relay never blocks boot (local-first);
 *  - bootstraps the WorkspaceClient sync engine for the workspace;
 *  - exposes the worker API: applyBatch (remote frames), the read surface
 *    (getPage / listPages / getBlockTree / search / getBacklinks /
 *    resolveAlias / aliasNodesOf /
 *    getLinkedReferences / getReferences / getReferenceCount /
 *    getUnlinkedReferences / getChildPages / getChildren
 *    / runQueryAst / runAggregateAst / getBacklinkCount / getChildPageCount / getDisplayName /
 *    getNode / getNodeRaw / getEffectiveProperties / getAssetInfo /
 *    getAnnotationsForAsset / listPropertySchemas / isFeatureEnabled /
 *    listFeatureRows / getFeatureInstanceCount), the batched read surface
 *    (multiRead — one round-trip per cache refresh), the write
 *    surface (createObject / updateObject / deleteObject / moveObject /
 *    setClassProperty / unsetClassProperty / createPropertySchema /
 *    setProperty / unsetProperty / attachAsset), the session undo journal
 *    (undoState / undo / redo), syncOnce, the realtime
 *    acceleration path (startRealtime / stopRealtime), status, exportBytes,
 *    stats, the per-user UI prefs reads/writes (getPrefs / patchPrefs), the
 *    hosted section views surface (listSectionViews / createSectionView /
 *    renameSectionView / reorderSectionViews / deleteSectionView — the
 *    prefs-channel custom tabs), and flush;
 *  - persists db.export() bytes to OPFS debounced (~500 ms, coalesced) after
 *    every mutation, each save awaiting the previous one (serialized chain);
 *    flush() forces the pending write now (close path, tests).
 *
 * No Worker globals in this file: the worker entry (store-worker.ts) and the
 * Node tests both drive the same code through handleMessage().
 */

import type { SqlJsStatic } from "sql.js";

import type { WorkspaceFeature } from "@notees/protocol";

import { Store, validateEnvelope } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";
import type { CatchUpResponse, SendBatchResult, SnapshotMeta, SyncConflict, Transport } from "@notees/sync";

import {
  WorkspaceClient,
  type AssetInfo,
  type AssetUploadResult,
  type BlockTreeNode,
  type ChangeNotification,
  type ClientEdge,
  type ClientNode,
  type ClientPropertySchema,
  type CreateObjectInput,
  type CreatePropertySchemaInput,
  type DeleteObjectOptions,
  type EffectiveProperty,
  type PrefsPatch,
  type ReferenceEntry,
  type SetClassPropertyInput,
  type SyncStatusSnapshot,
  type UpdateObjectInput,
  type UpdatePropertySchemaInput,
} from "../core/workspace-client.js";

import type { OpfsStore } from "./opfs.js";

// --- wire protocol (shared by the worker entry, the main-thread proxy, tests) -

export interface WorkerInitMessage {
  sqlWasmUrl: string;
  workspaceId: string;
  serverUrl: string;
  apiKey: string;
  /** Offline-first mode: no server calls at all; edits stay on the device. */
  offline?: boolean;
}

export interface WorkerRequestMessage {
  id: number;
  method: string;
  args: unknown[];
}

export interface WorkerResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

/** Everything handleMessage needs beyond the core; init wiring (sql.js init, OPFS, transport) lives in the caller. */
export interface WorkerContext {
  core: WorkerCore | null;
  init: (init: WorkerInitMessage) => Promise<void>;
}

/**
 * Dispatch one `{id, method, args}` message to `{id, result}` / `{id, error}`.
 * Shared verbatim by the worker entry and the protocol tests so both exercise
 * the same shapes; "init" is special — it builds the core via ctx.init.
 */
export async function handleMessage(
  ctx: WorkerContext,
  message: WorkerRequestMessage,
): Promise<WorkerResponseMessage> {
  try {
    if (message.method === "init") {
      await ctx.init(message.args[0] as WorkerInitMessage);
      return { id: message.id, result: null };
    }
    if (ctx.core === null) {
      throw new Error(`worker: init required before "${message.method}"`);
    }
    const result = await ctx.core.invoke(message.method, message.args);
    return { id: message.id, result };
  } catch (error) {
    return { id: message.id, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- core ----------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 500;
/**
 * Notification coalescing window: the client notifies per applied
 * batch, and a sync burst (local apply + push + echo + ack) can fire hundreds
 * of notifications per second — each of which used to make the main thread
 * refetch its whole read cache. One emission on the leading edge plus at most
 * one trailing emission per window caps the message rate at ~2/window while
 * keeping first-paint immediacy and burst convergence; payloads merge
 * (affected-union, structural-OR).
 */
const DEFAULT_NOTIFY_DEBOUNCE_MS = 50;

/**
 * Read-only methods served through the main thread's read cache (the exact
 * `cachedRead` surface of WorkerClient). `multiRead` refuses anything else —
 * a batch refresh must never become a write path.
 */
const READ_METHODS: ReadonlySet<string> = new Set([
  "getNode",
  "getNodeRaw",
  "getDisplayName",
  "effectiveClassColor",
  "effectiveClassIcon",
  "effectiveNodeIcon",
  "effectiveNodeColor",
  "getPage",
  "listPages",
  "roots",
  "listClasses",
  "classIcons",
  "effectiveClassIcons",
  "getClassParents",
  "getClassChildren",
  "getClassMembers",
  "getClassMemberCount",
  "getClassBindings",
  "getRegistryBindings",
  "getEffectiveProperties",
  "getPropertyReferences",
  "getAssetInfo",
  "getAnnotationsForAsset",
  "listPropertySchemas",
  "getBlockTree",
  "search",
  "getSearchSnippet",
  "resolveNodeByName",
  "getChildren",
  "getBacklinks",
  "resolveAlias",
  "aliasNodesOf",
  "getLinkedReferences",
  "getReferences",
  "getReferenceCount",
  "getUnlinkedReferences",
  "getUnlinkedReferenceCount",
  "getChildPages",
  "getBacklinkCount",
  "getChildPageCount",
  "isFeatureEnabled",
  "listFeatureRows",
  "getFeatureInstanceCount",
]);

/** Default when no transport is configured: sync attempts fail without blocking local boot. */
class NullTransport implements Transport {
  private fail(): never {
    throw new Error("worker-core: no transport configured");
  }
  async sendBatch(): Promise<SendBatchResult> {
    this.fail();
  }
  async catchUp(): Promise<CatchUpResponse> {
    this.fail();
  }
  async getSnapshotMeta(): Promise<SnapshotMeta> {
    this.fail();
  }
  async getSnapshotData(): Promise<Uint8Array> {
    this.fail();
  }
}

export interface WorkerCoreOptions {
  /** Pre-initialized sql.js module (the entry inits it with locateFile). */
  SQL: SqlJsStatic;
  /** Persistence target; the entry passes opfsStore(), tests a Map-backed fake. */
  opfs: OpfsStore;
  /** File name within the opfs root (e.g. `<workspaceId>.db`). */
  fileName: string;
  workspaceId: string;
  transport?: Transport;
  actorId?: string;
  deviceId?: string;
  /**
   * REST config for the client (per-user prefs). The entry forwards
   * the init message's serverUrl/apiKey; tests omit it (local fallback).
   */
  serverUrl?: string;
  apiKey?: string;
  /** Persist debounce after mutations; defaults to 500 ms. */
  debounceMs?: number;
  /** Notification coalescing window; defaults to 50 ms. */
  notifyDebounceMs?: number;
  /** Fired on local apply and sync completion (the payload is coalesced — see scheduleNotify). */
  onNotify?: (change: ChangeNotification) => void;
  onConflict?: (conflicts: SyncConflict[]) => void;
  onSyncError?: (error: Error) => void;
}

export interface WorkerCoreStats {
  nodes: number;
  activeNodes: number;
  edges: number;
  appliedEnvelopes: number;
  cursorSeq: number;
  dirty: boolean;
  lastPersistError: string | null;
}

export class WorkerCore {
  private readonly client: WorkspaceClient;
  private readonly opfs: OpfsStore;
  private readonly fileName: string;
  private readonly debounceMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly onNotify: ((change: ChangeNotification) => void) | undefined;
  private readonly notifyDebounceMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Coalescing window timer; non-null between the leading and trailing emit. */
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Payload merged from notifications that arrived inside the current window. */
  private notifyPending: ChangeNotification | null = null;
  private dirty = false;
  private closed = false;
  private lastPersistError: Error | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(
    client: WorkspaceClient,
    options: WorkerCoreOptions,
    setTimer: typeof setTimeout,
    clearTimer: typeof clearTimeout,
  ) {
    this.client = client;
    this.opfs = options.opfs;
    this.fileName = options.fileName;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.notifyDebounceMs = options.notifyDebounceMs ?? DEFAULT_NOTIFY_DEBOUNCE_MS;
    this.onNotify = options.onNotify;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  /** Open (restoring saved bytes when present) and bootstrap the workspace. */
  static async create(options: WorkerCoreOptions): Promise<WorkerCore> {
    const saved = await options.opfs.loadFile(options.fileName);
    const store = Store.open(sqljsBackend(options.SQL));
    if (saved !== null && saved.byteLength > 0) {
      store.restore(saved);
    }
    const client = WorkspaceClient.wrap(store, {
      transport: options.transport ?? new NullTransport(),
      ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.serverUrl !== undefined ? { serverUrl: options.serverUrl } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.onConflict !== undefined ? { onConflict: options.onConflict } : {}),
      ...(options.onSyncError !== undefined ? { onSyncError: options.onSyncError } : {}),
    });
    const core = new WorkerCore(
      client,
      options,
      // Bind the host timers: these are stored and called later as plain
      // functions, and DOM-defined timers (WorkerGlobalScope.setTimeout)
      // throw "Illegal invocation" when detached from their `this` — Node's
      // timers don't, which is why no in-process test ever caught it.
      setTimeout.bind(globalThis),
      clearTimeout.bind(globalThis),
    );
    client.subscribe((change) => {
      core.schedulePersist();
      core.scheduleNotify(change);
    });
    try {
      await client.bootstrapWorkspace(options.workspaceId);
    } catch {
      // Local-first: an unreachable relay must not block boot from local
      // bytes; the failure surfaces via onSyncError / engine status and the
      // next syncOnce() retries.
    }
    return core;
  }

  // --- persistence ---------------------------------------------------------------

  /** Debounced, coalescing persist: call after any mutation (local or remote). */
  private schedulePersist(): void {
    this.dirty = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.persistNow();
    }, this.debounceMs);
  }

  /**
   * Queue a save of the current db bytes. Chained behind every previous save
   * so OPFS writes never overlap; bytes are captured when the write starts,
   * so a queued write always persists the newest state.
   */
  private persistNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.saveChain = this.saveChain.then(async () => {
      const bytes = this.exportBytes();
      await this.opfs.saveFile(this.fileName, bytes);
      this.lastPersistError = null;
    });
    this.saveChain = this.saveChain.catch((error: unknown) => {
      // Keep the chain alive; stay dirty so a later flush() retries.
      this.lastPersistError = error instanceof Error ? error : new Error(String(error));
      this.dirty = true;
    });
  }

  /** Force the pending save now and wait until it (and all prior saves) land. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.persistNow();
    await this.saveChain;
    if (this.dirty) {
      // The save above failed and re-marked dirty; retry once so flush() is
      // deterministic for "save & close".
      this.persistNow();
      await this.saveChain;
    }
    this.flushPendingNotify();
  }

  // --- notification coalescing ---------------------------------------------------

  /**
   * Leading+trailing coalescer over the client's notifications. The first
   * notification in a quiet period emits immediately; notifications inside
   * the window merge into `notifyPending` and re-arm one trailing emission,
   * so a burst of N notifies costs at most 2 messages per window and the
   * merged payload never loses a structural flag or an affected id.
   */
  private scheduleNotify(change: ChangeNotification): void {
    if (this.closed) return;
    if (this.notifyTimer !== null) {
      this.notifyPending = WorkerCore.mergeChangeNotifications(this.notifyPending, change);
      return;
    }
    this.emitNotify(change);
    this.notifyTimer = this.setTimer(() => {
      this.notifyTimer = null;
      const pending = this.notifyPending;
      this.notifyPending = null;
      if (pending !== null) this.scheduleNotify(pending);
    }, this.notifyDebounceMs);
  }

  /** Emit a notification still sitting in its coalescing window (flush/close). */
  private flushPendingNotify(): void {
    if (this.notifyTimer !== null) {
      this.clearTimer(this.notifyTimer);
      this.notifyTimer = null;
    }
    const pending = this.notifyPending;
    this.notifyPending = null;
    if (pending !== null) this.emitNotify(pending);
  }

  private emitNotify(change: ChangeNotification): void {
    if (this.closed) return;
    this.onNotify?.(change);
  }

  /**
   * Union of coalesced payloads: unknown scope (neither field) dominates
   * (a subscriber cannot scope what it cannot see); structural ORs; the
   * affected sets union; revision takes the max (revisions are monotonic).
   */
  private static mergeChangeNotifications(
    pending: ChangeNotification | null,
    next: ChangeNotification,
  ): ChangeNotification {
    if (pending === null) return next;
    const pendingUnknown = pending.affectedNodeIds === undefined && pending.structural !== true;
    const nextUnknown = next.affectedNodeIds === undefined && next.structural !== true;
    if (pendingUnknown || nextUnknown) return { revision: Math.max(pending.revision, next.revision) };
    const affected = new Set(pending.affectedNodeIds ?? []);
    for (const id of next.affectedNodeIds ?? []) affected.add(id);
    return {
      revision: Math.max(pending.revision, next.revision),
      affectedNodeIds: [...affected],
      structural: pending.structural === true || next.structural === true,
    };
  }

  // --- remote apply ----------------------------------------------------------------

  /** Apply a batch of remote envelopes (realtime frames / external injection). */
  applyBatch(envelopes: unknown[]): void {
    const validated = envelopes.map((input) => validateEnvelope(input));
    this.client.applyRemoteBatch(validated);
    this.schedulePersist();
  }

  // --- reads (local store only) -------------------------------------------------------

  getNode(id: string): ClientNode | undefined {
    return this.client.getNode(id);
  }

  getNodeRaw(id: string): ClientNode | undefined {
    return this.client.getNodeRaw(id);
  }

  getDisplayName(id: string): string | null {
    return this.client.getDisplayName(id);
  }

  getPage(id: string): ClientNode | undefined {
    return this.client.getPage(id);
  }

  listPages(): ClientNode[] {
    return this.client.listPages();
  }

  roots(): ClientNode[] {
    return this.client.roots();
  }

  listClasses(): ClientNode[] {
    return this.client.listClasses();
  }

  classIcons(): ReadonlyMap<string, string | null> {
    return this.client.classIcons();
  }

  effectiveClassIcons(): ReadonlyMap<string, string | null> {
    return this.client.effectiveClassIcons();
  }

  getBlockTree(pageId: string, depth?: number): BlockTreeNode[] {
    return this.client.getBlockTree(pageId, depth);
  }

  search(query: string, limit?: number | null): ClientNode[] {
    return this.client.search(query, limit ?? undefined);
  }

  getBacklinks(id: string): ClientEdge[] {
    return this.client.getBacklinks(id);
  }

  getLinkedReferences(id: string): ReferenceEntry[] {
    return this.client.getLinkedReferences(id);
  }

  getReferences(id: string): ClientNode[] {
    return this.client.getReferences(id);
  }

  getReferenceCount(id: string): number {
    return this.client.getReferenceCount(id);
  }

  getUnlinkedReferences(id: string): ReferenceEntry[] {
    return this.client.getUnlinkedReferences(id);
  }

  getUnlinkedReferenceCount(id: string): number {
    return this.client.getUnlinkedReferenceCount(id);
  }

  getChildPages(id: string): ClientNode[] {
    return this.client.getChildPages(id);
  }

  getChildren(id: string): ClientNode[] {
    return this.client.getChildren(id);
  }

  getBacklinkCount(id: string): number {
    return this.client.getBacklinkCount(id);
  }

  getChildPageCount(id: string): number {
    return this.client.getChildPageCount(id);
  }

  getEffectiveProperties(id: string): EffectiveProperty[] {
    return this.client.getEffectiveProperties(id);
  }

  getAssetInfo(id: string): AssetInfo | undefined {
    return this.client.getAssetInfo(id);
  }

  /** Highlight-classed annotations whose highlight_asset links this asset node. */
  getAnnotationsForAsset(assetId: string): ClientNode[] {
    return this.client.getAnnotationsForAsset(assetId);
  }

  listPropertySchemas(): ClientPropertySchema[] {
    return this.client.listPropertySchemas();
  }

  // --- writes (optimistic local apply + outbox push) -------------------------------------

  createObject(partial: CreateObjectInput): Promise<string> {
    return this.client.createObject(partial);
  }

  updateObject(id: string, fields: UpdateObjectInput): Promise<void> {
    return this.client.updateObject(id, fields);
  }

  deleteObject(id: string, opts?: DeleteObjectOptions): Promise<void> {
    return this.client.deleteObject(id, opts);
  }

  moveObject(id: string, parentId: string | null, afterId?: string, beforeId?: string): Promise<void> {
    return this.client.moveObject(id, parentId, afterId, beforeId);
  }

  /** Record an uploaded asset on a node (asset.attach op; optimistic local apply). */
  attachAsset(objectId: string, asset: AssetUploadResult): Promise<void> {
    return this.client.attachAsset(objectId, asset);
  }

  // --- sync & lifecycle ---------------------------------------------------------------------

  /** One push+pull cycle against the relay. */
  syncOnce(): Promise<void> {
    return this.client.sync();
  }

  async push(): Promise<void> {
    await this.client.push();
  }

  async pull(): Promise<void> {
    await this.client.pull();
  }

  /** Wire the WS acceleration path (no-op when the transport has no subscribe). */
  startRealtime(): void {
    this.client.startRealtime();
  }

  stopRealtime(): void {
    this.client.stopRealtime();
  }

  /** Engine + outbox + realtime state for the footer status indicator. */
  status(): SyncStatusSnapshot {
    return this.client.status();
  }

  /** Current db.export() bytes (OPFS image / backup). */
  exportBytes(): Uint8Array {
    return this.client.store.snapshot();
  }

  /**
   * Batched read for the main thread's cache refresh: N cache keys
   * (`JSON.stringify([method, args])`) resolved in ONE round-trip instead of
   * N awaited RPCs. Only READ_METHODS are accepted — a refresh batch must
   * never become a write path.
   */
  private async multiRead(keys: string[]): Promise<unknown[]> {
    return Promise.all(
      keys.map(async (key) => {
        const [method, args] = JSON.parse(key) as [string, unknown[]];
        if (!READ_METHODS.has(method)) {
          throw new Error(`multiRead: "${method}" is not a read method`);
        }
        return this.invoke(method, args);
      }),
    );
  }

  stats(): WorkerCoreStats {
    const db = this.client.store.database;
    const count = (sql: string): number =>
      (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
    return {
      nodes: count("SELECT COUNT(*) AS n FROM node"),
      activeNodes: count("SELECT COUNT(*) AS n FROM node WHERE is_active = 1"),
      edges: count("SELECT COUNT(*) AS n FROM edge"),
      appliedEnvelopes: count("SELECT COUNT(*) AS n FROM applied_envelope"),
      cursorSeq:
        (
          db
            .prepare("SELECT cursor_seq AS n FROM sync_state WHERE workspace_id = ?")
            .get(this.client.getWorkspaceId()) as { n: number } | undefined
        )?.n ?? 0,
      dirty: this.dirty,
      lastPersistError: this.lastPersistError?.message ?? null,
    };
  }

  /** Dispatch one protocol method; used by handleMessage (entry + tests). */
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "multiRead":
        return this.multiRead(args[0] as string[]);
      case "applyBatch":
        return this.applyBatch(args[0] as unknown[]);
      case "getNode":
        return this.getNode(args[0] as string);
      case "getNodeRaw":
        return this.getNodeRaw(args[0] as string);
      case "getDisplayName":
        return this.getDisplayName(args[0] as string);
      case "effectiveClassColor":
        return this.client.effectiveClassColor(args[0] as string);
      case "effectiveClassIcon":
        return this.client.effectiveClassIcon(args[0] as string);
      case "effectiveNodeIcon":
        return this.client.effectiveNodeIcon(
          args[0] as {
            icon: string | null;
            classIds: string[];
            isClass: boolean;
            presentAsMain: boolean;
            parentId: string | null;
          },
        );
      case "effectiveNodeColor":
        return this.client.effectiveNodeColor(args[0] as { color: string | null; classIds: string[] });
      case "getPage":
        return this.getPage(args[0] as string);
      case "listPages":
        return this.listPages();
      case "roots":
        return this.roots();
      case "listClasses":
        return this.listClasses();
      case "classIcons":
        return this.classIcons();
      case "effectiveClassIcons":
        return this.effectiveClassIcons();
      case "getClassParents":
        return this.client.getClassParents(args[0] as string);
      case "getClassChildren":
        return this.client.getClassChildren(args[0] as string);
      case "getClassMembers":
        return this.client.getClassMembers(args[0] as string);
      case "getClassMemberCount":
        return this.client.getClassMemberCount(args[0] as string);
      case "getClassBindings":
        return this.client.getClassBindings(args[0] as string);
      case "getRegistryBindings":
        return this.client.getRegistryBindings(args[0] as string);
      case "getBlockTree":
        return this.getBlockTree(args[0] as string, args[1] as number | undefined);
      case "search":
        return this.search(args[0] as string, args[1] as number | null | undefined);
      case "searchPage":
        return this.client.searchPage(
          args[0] as string,
          args[1] as { limit?: number; cursor?: string | null } | null | undefined,
        );
      case "getSearchSnippet":
        return this.client.getSearchSnippet(
          args[0] as string,
          args[1] as string,
          args[2] as { maxTokens?: number; ellipsis?: string } | null | undefined,
        );
      case "resolveNodeByName":
        return this.client.resolveNodeByName(args[0] as string);
      case "fetchOperationsFor":
        return this.client.fetchOperationsFor(
          args[0] as string,
          args[1] as string,
        );
      case "getBacklinks":
        return this.getBacklinks(args[0] as string);
      case "resolveAlias":
        return this.client.resolveAlias(args[0] as string);
      case "aliasNodesOf":
        return this.client.aliasNodesOf(args[0] as string);
      case "getLinkedReferences":
        return this.getLinkedReferences(args[0] as string);
      case "getReferences":
        return this.getReferences(args[0] as string);
      case "getReferenceCount":
        return this.getReferenceCount(args[0] as string);
      case "getUnlinkedReferences":
        return this.getUnlinkedReferences(args[0] as string);
      case "getUnlinkedReferenceCount":
        return this.getUnlinkedReferenceCount(args[0] as string);
      case "getChildPages":
        return this.getChildPages(args[0] as string);
      case "getChildren":
        return this.getChildren(args[0] as string);
      case "runQueryAst":
        return this.client.runQueryAst(args[0]);
      case "runAggregateAst":
        return this.client.runAggregateAst(args[0]);
      case "getBacklinkCount":
        return this.getBacklinkCount(args[0] as string);
      case "getChildPageCount":
        return this.getChildPageCount(args[0] as string);
      case "isFeatureEnabled":
        return this.client.isFeatureEnabled(args[0] as WorkspaceFeature);
      case "listFeatureRows":
        return this.client.listFeatureRows();
      case "getFeatureInstanceCount":
        return this.client.getFeatureInstanceCount(args[0] as WorkspaceFeature);
      case "getEffectiveProperties":
        return this.getEffectiveProperties(args[0] as string);
      case "getPropertyReferences":
        return this.client.getPropertyReferences(args[0] as string);
      case "getAssetInfo":
        return this.getAssetInfo(args[0] as string);
      case "getAnnotationsForAsset":
        return this.getAnnotationsForAsset(args[0] as string);
      case "listPropertySchemas":
        return this.listPropertySchemas();
      case "setClassProperty":
        return this.client.setClassProperty(
          args[0] as string,
          args[1] as string,
          args[2] as SetClassPropertyInput,
        );
      case "unsetClassProperty":
        return this.client.unsetClassProperty(args[0] as string, args[1] as string);
      case "createPropertySchema":
        return this.client.createPropertySchema(args[0] as CreatePropertySchemaInput);
      case "updatePropertySchema":
        return this.client.updatePropertySchema(
          args[0] as string,
          args[1] as UpdatePropertySchemaInput,
        );
      case "deletePropertySchema":
        return this.client.deletePropertySchema(args[0] as string);
      case "setProperty":
        return this.client.setProperty(
          args[0] as string,
          args[1] as string,
          args[2] as unknown,
          args[3] as number | undefined,
          args[4] as Record<string, unknown> | undefined,
        );
      case "unsetProperty":
        return this.client.unsetProperty(
          args[0] as string,
          args[1] as string,
          args[2] as number | undefined,
        );
      case "ensureDateChain":
        return this.client.ensureDateChain(args[0] as string);
      case "setDateProperty":
        return this.client.setDateProperty(
          args[0] as string,
          args[1] as string,
          args[2] as string,
          args[3] as number | undefined,
          args[4] as Record<string, unknown> | undefined,
        );
      case "setDateRangeProperty":
        return this.client.setDateRangeProperty(
          args[0] as string,
          args[1] as string,
          args[2] as string | null,
          args[3] as string | null,
          args[4] as number | undefined,
        );
      case "createObject":
        return this.createObject(args[0] as CreateObjectInput);
      case "updateObject":
        return this.updateObject(args[0] as string, args[1] as UpdateObjectInput);
      case "deleteObject":
        return this.deleteObject(args[0] as string, args[1] as DeleteObjectOptions | undefined);
      case "moveObject":
        return this.moveObject(
          args[0] as string,
          args[1] as string | null,
          args[2] as string | undefined,
          args[3] as string | undefined,
        );
      case "attachAsset":
        return this.attachAsset(args[0] as string, args[1] as AssetUploadResult);
      case "assignClass":
        return this.client.assignClass(args[0] as string, args[1] as string);
      case "assignTag":
        return this.client.assignTag(args[0] as string, args[1] as string);
      case "unassignTag":
        return this.client.unassignTag(args[0] as string, args[1] as string);
      case "unassignClass":
        return this.client.unassignClass(args[0] as string, args[1] as string);
      case "reorderClasses":
        return this.client.reorderClasses(args[0] as string, args[1] as string[]);
      case "createClass":
        return this.client.createClass(
          args[0] as string,
          args[1] as { icon?: string; color?: string } | undefined,
        );
      case "setClassExtends":
        return this.client.setClassExtends(args[0] as string, args[1] as string[]);
      case "setFeatureEnabled":
        return this.client.setFeatureEnabled(
          args[0] as Parameters<WorkspaceClient["setFeatureEnabled"]>[0],
          args[1] as boolean,
        );
      case "bootstrapWorkspace":
        return this.client.bootstrapWorkspace(args[0] as string);
      case "syncOnce":
        return this.syncOnce();
      case "push":
        return this.push();
      case "pull":
        return this.pull();
      case "startRealtime":
        return this.startRealtime();
      case "stopRealtime":
        return this.stopRealtime();
      case "status":
        return this.status();
      case "conflictHistory":
        return this.client.conflictHistory();
      case "getPrefs":
        return this.client.getPrefs();
      case "patchPrefs":
        return this.client.patchPrefs(args[0] as PrefsPatch);
      case "listSectionViews":
        return this.client.listSectionViews(args[0] as string, args[1] as string);
      case "createSectionView":
        return this.client.createSectionView(
          args[0] as Parameters<WorkspaceClient["createSectionView"]>[0],
        );
      case "renameSectionView":
        return this.client.renameSectionView(
          args[0] as string,
          args[1] as string,
          args[2] as string,
          args[3] as string,
        );
      case "reorderSectionViews":
        return this.client.reorderSectionViews(
          args[0] as string,
          args[1] as string,
          args[2] as string[],
        );
      case "deleteSectionView":
        return this.client.deleteSectionView(
          args[0] as string,
          args[1] as string,
          args[2] as string,
        );
      case "exportBytes":
        return this.exportBytes();
      case "stats":
        return this.stats();
      case "graphTopology":
        return this.client.graphTopology(
          (args[0] as import("@notees/store").GraphOptions | null | undefined) ?? undefined,
        );
      case "undoState":
        return this.client.undoState();
      case "undoHistory":
        return this.client.undoHistory();
      case "undo":
        return this.client.undo();
      case "redo":
        return this.client.redo();
      case "flush":
        return this.flush();
      case "close":
        return this.close();
      default:
        throw new Error(`worker-core: unknown method "${method}"`);
    }
  }

  /** Flush pending bytes and close the store. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.client.close();
  }
}
