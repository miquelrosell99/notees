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
  type Transport,
} from "@notees/sync";

import { sqljsBackend } from "@notees/store/sqljs";

/** Sensible default depth cap for getBlockTree (cycle protection). */
const DEFAULT_TREE_DEPTH = 64;

/** Default actor for the single-user M1 client (overridable per client). */
const DEFAULT_ACTOR_ID = "01920000-0000-7000-8000-0000000000a1";

const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

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
    for (const listener of this.listeners) listener();
  }

  close(): void {
    this.store.close();
  }
}
