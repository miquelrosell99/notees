/**
 * WorkspaceClient — the Notees web data path (slice 1).
 *
 * A thin, fully Node-testable layer over three pieces: a Store over the sql.js
 * backend (local derived state), a SyncEngine (outbox push + seq-cursor
 * catch-up pull + snapshot shortcut), and a Transport (HttpTransport against a
 * relay server in the app, MemoryTransport over a MemoryRelay in tests).
 *
 * Reads always hit the LOCAL store. Writes build protocol envelopes
 * (`newEnvelope`, deviceId "web"), apply optimistically via the engine's
 * enqueue (local-first), then push. `subscribe` is a naive notification fired
 * on local apply and on sync completion — enough for a render-refresh loop.
 */

import initSqlJs, { type SqlJsStatic } from "sql.js";
import { uuidv7 } from "uuidv7";

import { deriveDisplayName } from "@notees/domain";
import {
  Clock,
  newEnvelope,
  type ContentAst,
  type Envelope,
} from "@notees/protocol";
import { Store, type NodeRow } from "@notees/store";
import {
  HttpTransport,
  SyncEngine,
  type SyncConflict,
  type SyncStatus,
  type Transport,
} from "@notees/sync";

import { sqljsBackend } from "@notees/store/sqljs";

/** Sensible default depth cap for getBlockTree (cycle protection). */
const DEFAULT_TREE_DEPTH = 64;

/** Default actor for the single-user M1 client (overridable per client). */
const DEFAULT_ACTOR_ID = "01920000-0000-7000-8000-0000000000a1";

const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Sync-state snapshot for status UI: engine state, the pending-push backlog,
 * and whether the realtime (WS) acceleration path is wired.
 */
export interface SyncStatusSnapshot {
  status: SyncStatus;
  /** Engine last error message (sync or realtime); null when healthy. */
  error: string | null;
  pending: number;
  failed: number;
  quarantined: number;
  /** Ops parked by a server restore, awaiting re-push. */
  parked: number;
  realtime: boolean;
  cursorSeq: number;
}

const IDLE_SNAPSHOT: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

export interface ClientNode {
  id: string;
  workspaceId: string;
  nodeType: "page" | "block" | "class";
  parentId: string | null;
  classIds: string[];
  name: string | null;
  contentAst: ContentAst;
  icon: string | null;
  color: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BlockTreeNode {
  node: ClientNode;
  children: BlockTreeNode[];
}

export interface ClientEdge {
  id: string;
  sourceId: string;
  targetId: string | null;
  type: string;
  verb: string | null;
  metadata: string | null;
}

/**
 * One row of a references section (linked or unlinked): the node carrying the
 * link / literal-text match, plus the breadcrumb of its containing page
 * (nearest page-type ancestor — the source itself when it is a page).
 */
export interface ReferenceEntry {
  source: ClientNode;
  containingPageId: string;
  containingPageName: string;
}

export interface CreateObjectInput {
  /** Defaults to a fresh UUIDv7. */
  id?: string;
  nodeType?: "page" | "block" | "class";
  /** Omit for a workspace-root page; null is accepted explicitly. */
  parentId?: string | null;
  name?: string;
  contentAst?: ContentAst;
  classIds?: string[];
}

export interface UpdateObjectInput {
  nodeType?: "page" | "block" | "class";
  name?: string;
  contentAst?: ContentAst;
  icon?: string;
  color?: string;
}

export interface DeleteObjectOptions {
  /** Soft-delete (trash subtree) by default; true hard-deletes. */
  permanent?: boolean;
}

export interface WorkspaceClientOptions {
  transport: Transport;
  /** Defaults to a fixed local actor; pass a real user id when known. */
  actorId?: string;
  deviceId?: string;
  client?: string;
  /** Pre-initialized sql.js module (tests); defaults to initSqlJs(). */
  sqlJs?: SqlJsStatic;
  /** Config for the internal initSqlJs() call (browser wasm locateFile). */
  sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  /** Semantic conflicts between remote batches and local pending ops. */
  onConflict?: (conflicts: SyncConflict[]) => void;
  onSyncError?: (error: Error) => void;
}

/** Parse a node row's serialized content (mirror of the store's parser). */
function parseContentAst(raw: string | null | undefined): ContentAst {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentAst) : [];
  } catch {
    return [];
  }
}

function mapNode(row: NodeRow): ClientNode {
  let classIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.class_ids);
    if (Array.isArray(parsed)) classIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    classIds = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeType: row.node_type,
    parentId: row.parent_id,
    classIds,
    name: row.name,
    contentAst: parseContentAst(row.content),
    icon: row.icon,
    color: row.color,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceClient {
  readonly store: Store;

  private readonly transport: Transport;
  private readonly actorId: string;
  private readonly deviceId: string;
  private readonly clientClaim: string | undefined;
  private readonly userOnConflict: ((conflicts: SyncConflict[]) => void) | undefined;
  private readonly userOnSyncError: ((error: Error) => void) | undefined;
  private readonly clock: Clock;
  private readonly listeners = new Set<() => void>();

  private workspaceId: string = DEFAULT_WORKSPACE_ID;
  private engine: SyncEngine | null = null;
  /** Combined teardown for the wired realtime channel + status subscription. */
  private realtimeStop: (() => void) | null = null;
  private closed = false;

  private constructor(store: Store, options: WorkspaceClientOptions) {
    this.store = store;
    this.transport = options.transport;
    this.actorId = options.actorId ?? DEFAULT_ACTOR_ID;
    this.deviceId = options.deviceId ?? "web";
    this.clientClaim = options.client;
    this.userOnConflict = options.onConflict;
    this.userOnSyncError = options.onSyncError;
    this.clock = new Clock(this.deviceId);
  }

  /** Open a Store over the sql.js backend and wrap it in a client. */
  static async create(options: WorkspaceClientOptions): Promise<WorkspaceClient> {
    const SQL = options.sqlJs ?? (await initSqlJs(options.sqlJsConfig));
    const store = Store.open(sqljsBackend(SQL));
    return new WorkspaceClient(store, options);
  }

  /**
   * Wrap an already-open Store (worker persistence path: the caller restores
   * saved bytes into the store before wrapping it).
   */
  static wrap(store: Store, options: WorkspaceClientOptions): WorkspaceClient {
    return new WorkspaceClient(store, options);
  }

  /** Factory for the app path: HTTP transport against a relay server. */
  static async createHttp(options: {
    serverUrl: string;
    apiKey: string;
    workspaceId: string;
    sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  }): Promise<WorkspaceClient> {
    const transport = new HttpTransport({
      baseUrl: options.serverUrl,
      apiKey: options.apiKey,
      workspaceId: options.workspaceId,
    });
    return WorkspaceClient.create({
      transport,
      sqlJsConfig: options.sqlJsConfig,
    });
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  private requireEngine(): SyncEngine {
    if (this.engine === null) {
      throw new Error("WorkspaceClient: call bootstrapWorkspace(workspaceId) first");
    }
    return this.engine;
  }

  /**
   * Pull via the SyncEngine (snapshot shortcut when newer, then seq catch-up)
   * so local state converges with the relay. Any locally pending outbox ops
   * are pushed first (local-first, never lost).
   */
  async bootstrapWorkspace(workspaceId: string): Promise<void> {
    this.workspaceId = workspaceId;
    this.engine = new SyncEngine(this.store, this.transport, this.clock, {
      workspaceId,
      callbacks: {
        onConflict: (conflicts) => this.userOnConflict?.(conflicts),
        onError: (error) => this.userOnSyncError?.(error),
        onPush: () => this.notify(),
        onPull: () => this.notify(),
        // Realtime (WS) frames applied to the store refresh the UI exactly
        // like a pull does.
        onRemoteBatch: () => this.notify(),
      },
    });
    await this.engine.sync();
    this.notify();
  }

  /** One push+pull sync cycle against the relay. */
  async sync(): Promise<void> {
    await this.requireEngine().sync();
    this.notify();
  }

  // --- read API (local store only) -------------------------------------------

  /** The node mapped to the client view, or undefined when missing/inactive. */
  getNode(id: string): ClientNode | undefined {
    const row = this.store.getNode(id);
    if (!row || row.is_active !== 1) return undefined;
    return mapNode(row);
  }

  /** A single node, regardless of active state (backlink sources may be trashed). */
  getNodeRaw(id: string): ClientNode | undefined {
    const row = this.store.getNode(id);
    return row ? mapNode(row) : undefined;
  }

  /** Display name for mentions/chips (SCHEMA.md name derivation); null when unknown. */
  getDisplayName(id: string): string | null {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) return null;
    return deriveDisplayName(node) || null;
  }

  getPage(id: string): ClientNode | undefined {
    const node = this.getNode(id);
    return node !== undefined && node.nodeType === "page" ? node : undefined;
  }

  /** All active pages in the workspace, deterministic order. */
  listPages(): ClientNode[] {
    const rows = this.store.database
      .prepare(
        `SELECT * FROM node
         WHERE workspace_id = ? AND node_type = 'page' AND is_active = 1
         ORDER BY COALESCE(name, id), id`,
      )
      .all(this.workspaceId) as NodeRow[];
    return rows.map(mapNode);
  }

  /**
   * Children of a page in child-order, recursive to `depth` levels
   * (bodies only: child pages render in their own section per SCHEMA.md
   * projection rule 3, so the tree is filtered to node_type = 'block').
   */
  getBlockTree(pageId: string, depth: number = DEFAULT_TREE_DEPTH): BlockTreeNode[] {
    const build = (id: string, remaining: number): BlockTreeNode[] => {
      if (remaining <= 0) return [];
      return this.store
        .children(id)
        .filter((row) => row.node_type === "block" && row.is_active === 1)
        .map((row) => ({
          node: mapNode(row),
          children: build(row.id, remaining - 1),
        }));
    };
    return build(pageId, depth);
  }

  /** FTS prefix-AND search over active nodes. */
  search(query: string): ClientNode[] {
    return this.store
      .search(query)
      .map((hit) => this.getNode(hit.nodeId))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /** Edges pointing at the node (mentions, typed links, property refs). */
  getBacklinks(id: string): ClientEdge[] {
    const rows = this.store.backlinks(id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      targetId: row.target_id === null || row.target_id === undefined ? null : String(row.target_id),
      type: String(row.type),
      verb: row.verb === null || row.verb === undefined ? null : String(row.verb),
      metadata: row.metadata === null || row.metadata === undefined ? null : String(row.metadata),
    }));
  }

  /**
   * Linked references (SCHEMA.md system sections): sources of edges pointing
   * at the node, one entry per distinct source, each with the breadcrumb of
   * its containing page.
   */
  getLinkedReferences(id: string): ReferenceEntry[] {
    const seen = new Set<string>();
    const entries: ReferenceEntry[] = [];
    for (const edge of this.getBacklinks(id)) {
      if (seen.has(edge.sourceId)) continue;
      // Live sources only — a trashed node no longer claims a reference.
      const source = this.getNode(edge.sourceId);
      if (!source) continue;
      seen.add(edge.sourceId);
      entries.push(this.referenceEntry(source));
    }
    return entries;
  }

  /**
   * Unlinked references (pages only — blocks never get this section):
   * literal-text FTS matches of the page's display name across the workspace,
   * excluding the page itself and every node that already links to it (the
   * linked-references set). No eager count: computing this IS the query.
   */
  getUnlinkedReferences(id: string): ReferenceEntry[] {
    const node = this.getNode(id);
    if (!node || node.nodeType !== "page") return [];
    const name = deriveDisplayName(node);
    if (!name) return [];
    const linkedSources = new Set(this.getBacklinks(id).map((edge) => edge.sourceId));
    const entries: ReferenceEntry[] = [];
    for (const hit of this.store.search(name)) {
      if (hit.nodeId === id || linkedSources.has(hit.nodeId)) continue;
      const source = this.getNode(hit.nodeId);
      if (!source) continue;
      entries.push(this.referenceEntry(source));
    }
    return entries;
  }

  /** Direct page-typed children (SCHEMA.md projection rule 3: never body blocks). */
  getChildPages(id: string): ClientNode[] {
    return this.store
      .children(id)
      .filter((row) => row.node_type === "page" && row.is_active === 1)
      .map(mapNode);
  }

  /** Materialized backlink count (node_stats) — the linked-references badge. */
  getBacklinkCount(id: string): number {
    const row = this.store.database
      .prepare("SELECT backlink_count AS n FROM node_stats WHERE node_id = ?")
      .get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Direct child-page count (cheap child-order read) — the child-pages badge. */
  getChildPageCount(id: string): number {
    const row = this.store.database
      .prepare(
        `SELECT COUNT(*) AS n FROM node_child_order o
         JOIN node n ON n.id = o.child_id
         WHERE o.parent_id = ? AND n.node_type = 'page' AND n.is_active = 1`,
      )
      .get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Breadcrumb row for a reference: the source plus its containing page. */
  private referenceEntry(source: ClientNode): ReferenceEntry {
    let current = source;
    for (let guard = 0; current.nodeType !== "page" && current.parentId !== null && guard < 64; guard += 1) {
      const parent = this.getNode(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return {
      source,
      containingPageId: current.id,
      containingPageName: deriveDisplayName(current) || current.id,
    };
  }

  // --- write API (optimistic local apply + outbox push) -----------------------

  private buildEnvelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
    return newEnvelope({
      workspaceId: this.workspaceId,
      actorId: this.actorId,
      deviceId: this.deviceId,
      ...(this.clientClaim !== undefined ? { client: this.clientClaim } : {}),
      hlc: this.clock.now(),
      affectedNodeIds: affected,
      opType,
      payload,
    });
  }

  /** Create an object; returns its id. Applied locally, push kicked off. */
  async createObject(partial: CreateObjectInput): Promise<string> {
    const engine = this.requireEngine();
    const id = partial.id ?? uuidv7();
    const payload: Record<string, unknown> = { objectId: id };
    if (partial.nodeType !== undefined) payload.nodeType = partial.nodeType;
    if (partial.classIds !== undefined) payload.classIds = partial.classIds;
    if (partial.name !== undefined) payload.name = partial.name;
    if (partial.contentAst !== undefined) payload.contentAst = partial.contentAst;
    if (partial.parentId !== undefined) payload.parentId = partial.parentId;
    engine.enqueue(this.buildEnvelope("object.create", payload, [id]));
    this.notify();
    this.kickPush();
    return id;
  }

  /** Update object fields (object.update; at least one field required). */
  async updateObject(id: string, fields: UpdateObjectInput): Promise<void> {
    const engine = this.requireEngine();
    const payload: Record<string, unknown> = { objectId: id };
    if (fields.nodeType !== undefined) payload.nodeType = fields.nodeType;
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.contentAst !== undefined) payload.contentAst = fields.contentAst;
    if (fields.icon !== undefined) payload.icon = fields.icon;
    if (fields.color !== undefined) payload.color = fields.color;
    engine.enqueue(this.buildEnvelope("object.update", payload, [id]));
    this.notify();
    this.kickPush();
  }

  /** Trash (default) or permanently delete an object and its subtree. */
  async deleteObject(id: string, opts: DeleteObjectOptions = {}): Promise<void> {
    const engine = this.requireEngine();
    engine.enqueue(
      this.buildEnvelope(
        "object.delete",
        { objectId: id, permanent: opts.permanent ?? false },
        [id],
      ),
    );
    this.notify();
    this.kickPush();
  }

  /**
   * Reparent a node (outliner indent/outdent gesture) — issues `object.move`.
   * `parentId` null means workspace root (pages only; blocks fail loud in the
   * store's placement CHECK). Pass `afterId` to land the node immediately
   * after that sibling in the parent's child order (Enter placement); omit it
   * to append at the end (Tab indent). Applied locally, push kicked off.
   */
  async moveObject(id: string, parentId: string | null, afterId?: string): Promise<void> {
    const engine = this.requireEngine();
    const payload: Record<string, unknown> = { objectId: id, parentId };
    if (afterId !== undefined) payload.afterId = afterId;
    engine.enqueue(this.buildEnvelope("object.move", payload, [id]));
    this.notify();
    this.kickPush();
  }

  /**
   * Push pending outbox ops now. Writes only kick a best-effort push; await
   * this when delivery must be deterministic (tests, "save & close").
   */
  async push(): Promise<void> {
    await this.requireEngine().push();
    this.notify();
  }

  /** Pull now: snapshot shortcut when newer, then seq catch-up. */
  async pull(): Promise<void> {
    await this.requireEngine().pull();
    this.notify();
  }

  // --- realtime (WS acceleration path) ------------------------------------------------

  /**
   * Wire the transport's realtime channel: remote ops frames apply straight
   * to the store (buffered around pulls; the seq cursor remains
   * authoritative) and connection state changes notify subscribers so the UI
   * can refresh its status. Idempotent — restarts the channel when already
   * running.
   */
  startRealtime(): void {
    const engine = this.requireEngine();
    this.stopRealtime();
    const stopChannel = engine.startRealtime();
    // Engine status transitions (incl. realtime errors) reach subscribers.
    const stopStatus = engine.subscribeStatus(() => this.notify());
    this.realtimeStop = () => {
      stopStatus();
      stopChannel();
    };
    this.notify();
  }

  stopRealtime(): void {
    if (this.realtimeStop === null) return;
    this.realtimeStop();
    this.realtimeStop = null;
    this.notify();
  }

  isRealtimeActive(): boolean {
    return this.realtimeStop !== null;
  }

  // --- status snapshot (sync UI) ---------------------------------------------------------

  /** Engine + outbox + realtime state for the footer status indicator. */
  status(): SyncStatusSnapshot {
    if (this.engine === null) return { ...IDLE_SNAPSHOT };
    const counts = this.engine.getOutboxCounts();
    return {
      status: this.engine.getStatus(),
      error: this.engine.getLastError()?.message ?? null,
      pending: counts.pending,
      failed: counts.failed,
      quarantined: counts.quarantined,
      parked: this.engine.getParkedCount(),
      realtime: this.isRealtimeActive(),
      cursorSeq: this.engine.getCursorSeq(),
    };
  }

  /**
   * Apply a batch of remote envelopes (realtime frames / external injection)
   * through the engine: one store transaction, conflict detection against
   * local pending ops, HLC merge. Unknown seqs (null) keep the cursor; the
   * next pull re-fetches anything the batch covered.
   */
  applyRemoteBatch(envelopes: Envelope[], seqs?: Record<string, number> | null): void {
    this.requireEngine().onRemoteBatch(envelopes, seqs ?? {});
    this.notify();
  }

  /** Best-effort background push after a local write; errors go to onSyncError. */
  private kickPush(): void {
    this.requireEngine()
      .push()
      .catch((err: unknown) => {
        this.userOnSyncError?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  // --- notifications -----------------------------------------------------------

  /** Naive notification: fired on local apply and on sync completion. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }

  close(): void {
    if (this.closed) return;
    // Guard before tearing down: stopRealtime() notifies, and a subscriber
    // (e.g. the worker persist scheduler) must not re-arm after close.
    this.closed = true;
    this.stopRealtime();
    this.store.close();
  }
}
