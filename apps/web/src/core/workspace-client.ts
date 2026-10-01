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

import {
  chainNodeIds,
  dateNodeId,
  dateNodeLabel,
  deriveDisplayName,
  parseIsoDate,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type DatePrecision,
} from "@notees/domain";
import {
  Clock,
  newEnvelope,
  type ContentAst,
  type Envelope,
} from "@notees/protocol";
import { parseQueryAst, runAggregate, runQuery, type QueryAst } from "@notees/query";
import { Store, type NodeRow } from "@notees/store";
import {
  HttpTransport,
  OfflineTransport,
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
  tagIds: string[];
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

/**
 * Typed error for a `query` content token whose serialized AST fails
 * validation (`parseQueryAst` — unknown condition types / versions fail loud)
 * or whose compilation the M1 engine does not support. The query block view
 * renders an "invalid query" placeholder for it; the worker RPC path surfaces
 * the same shape as an Error message.
 */
export class InvalidQueryAstError extends Error {
  readonly code = "invalid_query_ast" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryAstError";
  }
}

/** One row of a query run result: the node summary the list view renders. */
export interface QueryRunSummary {
  id: string;
  name: string | null;
  nodeType: "page" | "block" | "class";
  parentId: string | null;
  /** node.created_at (ISO-8601) — the table view's Created column. */
  createdAt: string | null;
}

/**
 * The web slice of @notees/query's QueryResult: deterministic ids (the count
 * badge reads ids.length) + node summaries, projected from the store rows.
 */
export interface QueryRunResult {
  ids: string[];
  rows: QueryRunSummary[];
}

/**
 * The web slice of @notees/query's AggregateResult: the grouped grid a
 * `query` token with an `aggregation` renders in table mode (dimension
 * columns in declared order, then measures).
 */
export interface QueryAggregateResult {
  columns: string[];
  rows: unknown[][];
}

/**
 * One class → property-schema binding, as projected by the Class View.
 * Registry rows (class_property joined to property_schema) now that
 * class.property.set authors them; the designed system seeds
 * (@notees/domain) fill schemas the registry does not bind yet, with
 * registry rows winning per schema.
 */
export interface ClassBinding {
  propertySchemaId: string;
  name: string;
  type: string;
  multi: boolean;
  /** Bound target class names (seed spec), null when unconstrained. */
  targetClassFilter: string[] | null;
  sequence: number;
  required: boolean | null;
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
  defaultValue: string | null;
  /** SCHEMA.md "Dates": schema-row date behavior (null = day / not qualified). */
  datePrecision: DatePrecision | null;
  dateQualified: boolean | null;
}

/** Editable fields of a class.property.set write (all optional — patch). */
export interface SetClassPropertyInput {
  sequence?: number;
  required?: boolean | null;
  readonly?: boolean | null;
  hideWhenEmpty?: boolean | null;
  defaultValue?: unknown;
}

/** Editable fields of a propertySchema.update write (all optional — patch). */
export interface UpdatePropertySchemaInput {
  name?: string;
  options?: Array<{ id: string; label: string }>;
  datePrecision?: DatePrecision;
  dateQualified?: boolean;
}

/** A property schema row as listed by the bindings picker's candidate set. */
export interface ClientPropertySchema {
  id: string;
  name: string;
  type: string;
  multi: boolean;
  scope: string;
  options: Array<{ id: string; label: string }> | null;
  targetClassFilter: string[] | null;
  /** SCHEMA.md "Dates": finest granularity a date value may claim (null = day). */
  datePrecision: DatePrecision | null;
  /** SCHEMA.md "Dates": node-typed values may carry date qualifiers. */
  dateQualified: boolean | null;
}

export interface CreatePropertySchemaInput {
  name: string;
  type: string;
  multi?: boolean;
  scope?: string;
  options?: Array<{ id: string; label: string }>;
  targetClassFilter?: string[];
  datePrecision?: DatePrecision;
  dateQualified?: boolean;
}

/**
 * One effective (schema, idx) row of a node (SCHEMA.md "Class properties"):
 * authored values and derived class-binding defaults, aggregated across all
 * the node's classes (first-class-applied-wins). `boundBy` names the class
 * supplying the binding metadata, or null when no current class binds the
 * schema (an authored value that outlived its bindings).
 */
export interface EffectiveProperty {
  propertySchemaId: string;
  idx: number;
  schema: {
    id: string;
    name: string;
    type: string;
    multi: boolean;
    datePrecision: DatePrecision | null;
    dateQualified: boolean | null;
  } | null;
  value: unknown;
  metadata: Record<string, unknown> | null;
  source: "authored" | "default";
  boundBy: string | null;
  required: boolean | null;
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
  sequence: number | null;
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
  /**
   * Linked references only: "direct" = the edge targets the node itself;
   * "containment" = the edge is an outward link from inside the node's
   * subtree (01 §8 source-side containment roll-up). Unlinked references are
   * always "direct".
   */
  kind: "direct" | "containment";
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
  tagIds?: string[];
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

/**
 * One row of the derived node_asset table (asset.attach op), as read by the
 * panel: the link between a node (usually an asset-class node referenced by a
 * node-typed property value) and its content-addressed file metadata.
 */
export interface AssetInfo {
  assetId: string;
  hash: string;
  mimeType: string;
  size: number;
  originalName: string;
  uploadedAt: string | null;
}

/** POST /api/v1/assets response shape (the fields the client consumes). */
export interface AssetUploadResult {
  assetId: string;
  hash: string;
  mimeType: string;
  size: number;
  originalName: string;
}

/**
 * Input of an annotation write (SCHEMA.md annotation family, seeded
 * `highlight` class): the quote excerpt names the object, the seeded
 * highlight_asset property (…000000000020) links the asset node, the seeded
 * provenance property (…000000000019) records origin (+ page context in M1),
 * and an optional note becomes a child block of the annotation page.
 */
export interface CreateAnnotationInput {
  /** The asset NODE id the highlight_asset property links (a chip ref). */
  assetId: string;
  /** The quoted text — becomes the annotation object's name. */
  quote: string;
  /** Optional page number (free text) — recorded in the provenance string. */
  page?: string;
  /** Optional note — authored as a child block of the annotation page. */
  note?: string;
}

/** Stored name cap for an annotation (the quote excerpt names the object). */
const ANNOTATION_NAME_MAX = 160;

/** The write surface createAnnotation composes (both client classes satisfy it). */
interface AnnotationWriteSurface {
  createObject(partial: CreateObjectInput): Promise<string>;
  setProperty(objectId: string, propertySchemaId: string, value: unknown, idx?: number): Promise<void>;
}

/**
 * Compose an annotation write from the primitive client ops: the
 * highlight-classed object named by the quote excerpt, the highlight_asset
 * link, the provenance text, and the optional note child block. Shared by
 * WorkspaceClient and WorkerClient (each exposes a thin method over this).
 */
export async function createAnnotation(
  writes: AnnotationWriteSurface,
  input: CreateAnnotationInput,
): Promise<string> {
  const quote = input.quote.trim();
  if (quote === "") throw new Error("createAnnotation: quote text is required");
  const page = input.page?.trim() ?? "";
  const note = input.note?.trim() ?? "";
  const id = await writes.createObject({
    nodeType: "page",
    name: quote.slice(0, ANNOTATION_NAME_MAX),
    classIds: [SYSTEM_CLASS_UUIDS.highlight],
  });
  await writes.setProperty(id, SYSTEM_PROPERTY_UUIDS.highlightAsset, { nodeId: input.assetId }, 0);
  // M1 has no seeded locator property (v1 …0018 withdrawn, never reused), so
  // the page context rides in the provenance string; the PDF-anchored capture
  // will need a structured position instead.
  await writes.setProperty(
    id,
    SYSTEM_PROPERTY_UUIDS.provenance,
    page === "" ? "web" : `web · p. ${page}`,
    0,
  );
  if (note !== "") {
    await writes.createObject({
      nodeType: "block",
      parentId: id,
      contentAst: [{ type: "text", text: note }],
    });
  }
  return id;
}

export interface WorkspaceClientOptions {
  transport: Transport;
  /** Defaults to a fixed local actor; pass a real user id when known. */
  actorId?: string;
  deviceId?: string;
  client?: string;
  /**
   * Server REST access (POST /api/v1/assets upload + download). createHttp
   * passes these through; tests inject them beside a MemoryTransport so
   * uploadAsset/downloadAsset can run against a mocked fetch.
   */
  serverUrl?: string;
  apiKey?: string;
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

/**
 * POST /api/v1/assets (multipart, CAS upload). The web client's upload path:
 * the server sniffs magic bytes, stores the bytes content-addressed, records
 * the asset metadata and returns the new asset id + original name. Auth is
 * the workspace API key header, same as the relay transport.
 * Shared by WorkspaceClient (in-process) and WorkerClient (main-thread proxy
 * — the worker owns the store, but the REST call needs no store).
 */
export async function postAssetUpload(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  file: Blob,
  filename: string,
): Promise<AssetUploadResult> {
  const form = new FormData();
  form.append("file", file, filename);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1/assets`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "X-Workspace-Id": workspaceId },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`asset upload failed: HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as Partial<AssetUploadResult>;
  if (
    typeof body.assetId !== "string" ||
    typeof body.originalName !== "string" ||
    typeof body.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.hash)
  ) {
    throw new Error("asset upload failed: response missing assetId/originalName/hash");
  }
  return {
    assetId: body.assetId,
    hash: body.hash,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream",
    size: typeof body.size === "number" ? body.size : file.size,
    originalName: body.originalName,
  };
}

/**
 * GET /api/v1/assets/:id (auth; Range-capable). Fetched with the API key
 * header (a bare window.open cannot set headers), then opened as a blob URL
 * so the chip click lands in a new tab without leaking the key into a URL.
 */
export async function fetchAssetBlob(serverUrl: string, apiKey: string, assetId: string): Promise<Blob> {
  const response = await fetch(
    `${serverUrl.replace(/\/$/, "")}/api/v1/assets/${encodeURIComponent(assetId)}`,
    { headers: { "X-API-Key": apiKey } },
  );
  if (!response.ok) {
    throw new Error(`asset download failed: HTTP ${response.status}`);
  }
  return response.blob();
}

function mapNode(row: NodeRow): ClientNode {
  // Each column parses independently: a missing/legacy column must never
  // wipe the other (cross-version snapshots can predate a column).
  let classIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.class_ids);
    if (Array.isArray(parsed)) classIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    classIds = [];
  }
  let tagIds: string[] = [];
  try {
    const parsedTags: unknown = JSON.parse(row.tag_ids ?? "[]");
    if (Array.isArray(parsedTags)) {
      tagIds = parsedTags.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    tagIds = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeType: row.node_type,
    parentId: row.parent_id,
    classIds,
    tagIds,
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
  /** Server REST access (asset upload/download); null without serverUrl/apiKey. */
  private readonly restServerUrl: string | null;
  private readonly restApiKey: string | null;

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
    this.restServerUrl =
      options.serverUrl !== undefined && options.serverUrl !== "" ? options.serverUrl : null;
    this.restApiKey = options.apiKey !== undefined && options.apiKey !== "" ? options.apiKey : null;
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

  /** Factory for the app path: HTTP transport against a relay server. The
   * `apiKey` slot carries the credential — the operator API key or an
   * account session token (the server accepts both, see routes-auth). */
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
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      sqlJsConfig: options.sqlJsConfig,
    });
  }

  /**
   * Offline-first factory: no server, no account. Edits apply locally and
   * are recorded in the durable local op log; when the user later connects
   * this workspace to a server (login), the backlog pushes through the
   * normal outbox path.
   */
  static async createOffline(options: {
    workspaceId: string;
    sqlJs?: SqlJsStatic;
    sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  }): Promise<WorkspaceClient> {
    return WorkspaceClient.create({
      transport: new OfflineTransport(),
      ...(options.sqlJs !== undefined ? { sqlJs: options.sqlJs } : {}),
      ...(options.sqlJsConfig !== undefined ? { sqlJsConfig: options.sqlJsConfig } : {}),
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
        // Durable local op log: locally-authored envelopes survive reloads
        // (the outbox is memory-only), and acknowledged envelopes are
        // cleared so the log holds only the unpushed backlog.
        onEnqueued: (envelope) => this.store.recordLocalEnvelope(envelope),
        onAcknowledged: (ids) => {
          this.store.markLocalEnvelopesPushed(ids);
          this.store.prunePushedLocalEnvelopes();
        },
      },
    });
    // Re-envelope the durable unpushed backlog (offline work from a previous
    // session): apply is idempotent by envelope id, so already-applied ops
    // are no-ops and the rest re-enter the outbox for the next push. Only
    // envelopes of THIS workspace re-enter — a backlog from another local
    // workspace never leaks across a workspace switch.
    for (const env of this.store.unpushedEnvelopes()) {
      if ((env as Envelope).workspaceId === workspaceId) {
        this.engine.enqueue(env as Envelope);
      }
    }
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

  /** All active classes in the workspace, deterministic order (# capture). */
  listClasses(): ClientNode[] {
    const rows = this.store.database
      .prepare(
        `SELECT * FROM node
         WHERE workspace_id = ? AND node_type = 'class' AND is_active = 1
         ORDER BY COALESCE(name, id), id`,
      )
      .all(this.workspaceId) as NodeRow[];
    return rows.map(mapNode);
  }

  /** Direct extends parents of a class (m2m), deterministic order. */
  getClassParents(classId: string): string[] {
    return this.store.classParentIds(classId);
  }

  /** Nodes with present OR-set membership in the class, display order. */
  getClassMembers(classId: string): ClientNode[] {
    return this.store.classMembers(classId).map(mapNode);
  }

  /**
   * The class's property bindings in sequence order. Registry rows
   * (`class_property` joined to `property_schema`, authored by
   * class.property.set) win; the designed system seeds (@notees/domain,
   * keyed by the class's stored name) fill the schemas the registry does not
   * bind yet — so a seeded class keeps its designed bindings, and user
   * classes (no seed spec) show exactly their registry rows.
   */
  getClassBindings(classId: string): ClassBinding[] {
    const node = this.getNode(classId);
    if (node === undefined || node.nodeType !== "class" || node.name === null) {
      return [];
    }
    const decodeDefault = (raw: string | null): string | null => {
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      } catch {
        return raw;
      }
    };
    const rows = this.store.database
      .prepare(
        `SELECT cp.property_schema_id, cp.sequence, cp.required, cp.readonly, cp.hide_when_empty,
                cp.default_value, ps.name, ps.type, ps.multi, ps.target_class_filter, ps.active,
                ps.date_precision, ps.date_qualified
         FROM class_property cp
         LEFT JOIN property_schema ps ON ps.id = cp.property_schema_id
         WHERE cp.class_id = ?
         ORDER BY cp.sequence, cp.property_schema_id`,
      )
      .all(classId) as Array<Record<string, unknown>>;
    const parsePrecision = (raw: unknown): DatePrecision | null =>
      raw === "year" || raw === "month" || raw === "day" ? raw : null;
    const bindings: ClassBinding[] = rows.map((row) => {
      let targetClassFilter: string[] | null = null;
      try {
        const parsed: unknown = JSON.parse((row.target_class_filter as string | null) ?? "null");
        if (Array.isArray(parsed)) {
          targetClassFilter = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        targetClassFilter = null;
      }
      return {
        propertySchemaId: String(row.property_schema_id),
        name: (row.name as string | null) ?? "(missing schema)",
        type: (row.type as string | null) ?? "",
        multi: row.multi === 1,
        targetClassFilter,
        sequence: (row.sequence as number) ?? 0,
        required: row.required === null || row.required === undefined ? null : row.required === 1,
        readonly: row.readonly === null || row.readonly === undefined ? null : row.readonly === 1,
        hideWhenEmpty:
          row.hide_when_empty === null || row.hide_when_empty === undefined
            ? null
            : row.hide_when_empty === 1,
        defaultValue: decodeDefault((row.default_value as string | null) ?? null),
        datePrecision: parsePrecision(row.date_precision),
        dateQualified:
          row.date_qualified === null || row.date_qualified === undefined
            ? null
            : row.date_qualified === 1,
      };
    });
    const bound = new Set(bindings.map((b) => b.propertySchemaId));
    let fallbackSeq = bindings.length;
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      if (spec === undefined || spec.bindTo !== node.name) continue;
      const id = SYSTEM_PROPERTY_UUIDS[name as keyof typeof SYSTEM_PROPERTY_UUIDS];
      if (bound.has(id)) continue;
      bindings.push({
        propertySchemaId: id,
        name,
        type: spec.type,
        multi: spec.multi ?? false,
        targetClassFilter: spec.targetClassFilter ?? null,
        sequence: fallbackSeq++,
        required: null,
        readonly: null,
        hideWhenEmpty: null,
        defaultValue: spec.defaultValue ?? null,
        datePrecision: null,
        dateQualified: null,
      });
    }
    return bindings.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
  }

  /**
   * Effective properties of a node (SCHEMA.md "Class properties"): authored
   * values plus derived binding defaults, aggregated across all its classes
   * with first-class-applied-wins conflicts. Pure read over the local store.
   */
  getEffectiveProperties(id: string): EffectiveProperty[] {
    return this.store.getEffectiveProperties(id);
  }

  /**
   * Asset metadata for a node reference (the derived node_asset rows that
   * asset.attach/detach maintain): the panel resolves attachment chips to
   * original names and download ids through this read. Purely local; the row
   * arrives with the asset.attach op (optimistic local write or catch-up).
   */
  getAssetInfo(id: string): AssetInfo | undefined {
    const row = this.store.database
      .prepare(
        `SELECT asset_id, hash, mime_type, size, original_name, uploaded_at
         FROM node_asset WHERE node_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    const mapped = (r: Record<string, unknown>): AssetInfo => ({
      assetId: String(r.asset_id),
      hash: String(r.hash),
      mimeType: String(r.mime_type),
      size: Number(r.size),
      originalName: String(r.original_name),
      uploadedAt: r.uploaded_at === null || r.uploaded_at === undefined ? null : String(r.uploaded_at),
    });
    if (row !== undefined) return mapped(row);
    // Fallback: id is an asset id itself (e.g. resolved from an asset_ref).
    const byAsset = this.store.database
      .prepare(
        `SELECT asset_id, hash, mime_type, size, original_name, uploaded_at
         FROM node_asset WHERE asset_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return byAsset !== undefined ? mapped(byAsset) : undefined;
  }

  /**
   * Annotations on an asset (SCHEMA.md annotation family): active objects
   * classed with the seeded `highlight` class whose highlight_asset property
   * (…000000000020) links this asset node. The read runs over the derived
   * edge index — node-typed property values project into edge (type
   * 'property', verb = propertySchemaId), so this is an indexed lookup by
   * target id, not a workspace scan. Pure read over the local store;
   * deterministic display order (name, then id).
   */
  getAnnotationsForAsset(assetId: string): ClientNode[] {
    const rows = this.store.database
      .prepare(
        `SELECT source_id FROM edge
         WHERE target_id = ? AND type = 'property' AND verb = ?
         ORDER BY source_id`,
      )
      .all(assetId, SYSTEM_PROPERTY_UUIDS.highlightAsset) as Array<{ source_id: string }>;
    const seen = new Set<string>();
    const annotations: ClientNode[] = [];
    for (const row of rows) {
      const sourceId = String(row.source_id);
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const node = this.getNode(sourceId);
      if (node === undefined || !node.classIds.includes(SYSTEM_CLASS_UUIDS.highlight)) continue;
      annotations.push(node);
    }
    return annotations.sort(
      (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id),
    );
  }

  /** Active property schemas of the workspace (the add-binding picker set). */
  listPropertySchemas(): ClientPropertySchema[] {
    const rows = this.store.database
      .prepare(
        `SELECT id, name, type, multi, scope, options, target_class_filter, date_precision, date_qualified
         FROM property_schema WHERE workspace_id = ? AND active = 1
         ORDER BY name, id`,
      )
      .all(this.workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const parseJsonArray = (raw: unknown): string[] | null => {
        if (raw === null || raw === undefined) return null;
        try {
          const parsed: unknown = JSON.parse(raw as string);
          return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
        } catch {
          return null;
        }
      };
      let options: Array<{ id: string; label: string }> | null = null;
      try {
        const parsed: unknown = JSON.parse((row.options as string | null) ?? "null");
        if (Array.isArray(parsed)) {
          options = parsed.filter(
            (v): v is { id: string; label: string } =>
              typeof v === "object" && v !== null && "id" in v && "label" in v,
          );
        }
      } catch {
        options = null;
      }
      return {
        id: String(row.id),
        name: String(row.name),
        type: String(row.type),
        multi: row.multi === 1,
        scope: String(row.scope),
        options,
        targetClassFilter: parseJsonArray(row.target_class_filter),
        datePrecision:
          row.date_precision === "year" || row.date_precision === "month" || row.date_precision === "day"
            ? row.date_precision
            : null,
        dateQualified:
          row.date_qualified === null || row.date_qualified === undefined
            ? null
            : row.date_qualified === 1,
      };
    });
  }

  /**
   * Children of a page in child-order, recursive to `depth` levels
   * (bodies only: child pages render in their own section per SCHEMA.md
   * projection rule 3, so the tree is filtered to node_type = 'block').
   */
  /**
   * Block-subtree rooted at `id`, capped at `depth` levels (cycle protection).
   * `depth` normalizes null → default: the worker RPC boundary turns an
   * omitted optional into JSON null, and `null <= 0` is true — without the
   * normalization the worker path silently renders every page with zero
   * block rows.
   */
  getBlockTree(pageId: string, depth?: number | null): BlockTreeNode[] {
    const cap = depth ?? DEFAULT_TREE_DEPTH;
    // Node-backed property values (text-property carrier blocks) live as
    // children of the owner but render inside the property cell — exclude
    // them here or they appear twice (child list + property cell).
    const propertyRefIds = new Set<string>();
    for (const row of this.store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ?")
      .all(pageId) as { value: string }[]) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "nodeId" in parsed &&
          typeof (parsed as { nodeId: unknown }).nodeId === "string"
        ) {
          propertyRefIds.add((parsed as { nodeId: string }).nodeId);
        }
      } catch {
        // Scalar value — not a node reference.
      }
    }
    const build = (id: string, remaining: number): BlockTreeNode[] => {
      if (remaining <= 0) return [];
      return this.store
        .children(id)
        .filter(
          (row) =>
            row.node_type === "block" &&
            row.is_active === 1 &&
            !propertyRefIds.has(row.id),
        )
        .map((row) => ({
          node: mapNode(row),
          children: build(row.id, remaining - 1),
        }));
    };
    return build(pageId, cap);
  }

  /** FTS prefix-AND search over active nodes. */
  search(query: string): ClientNode[] {
    return this.store
      .search(query)
      .map((hit) => this.getNode(hit.nodeId))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /**
   * Live-query bridge for `query` content tokens: validate the token's
   * serialized AST with @notees/query's fail-loud parser (unknown condition
   * types / versions throw InvalidQueryAstError — the view renders an
   * "invalid query" placeholder) and execute it against the local store. The
   * Store satisfies the query package's structural QueryStore interface, so
   * no mapping layer is needed. Rows come back as node summaries (id, name,
   * nodeType, parentId, createdAt) — enough for the result list, the simple
   * table, and the containing-page walk. ASTs carrying an aggregation run
   * through runAggregateAst instead.
   */
  runQueryAst(rawAst: unknown): QueryRunResult {
    let ast: QueryAst;
    try {
      ast = parseQueryAst(rawAst);
    } catch (error) {
      throw new InvalidQueryAstError(
        `invalid query AST: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (ast.aggregation !== undefined) {
      throw new InvalidQueryAstError(
        "query run: AST carries an aggregation — run it through runAggregateAst",
      );
    }
    let result: ReturnType<typeof runQuery>;
    try {
      result = runQuery(this.store, ast);
    } catch (error) {
      throw new InvalidQueryAstError(
        `query not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      ids: result.ids,
      rows: result.rows.map((row) => ({
        id: String(row.id),
        name: (row.name as string | null) ?? null,
        nodeType: row.node_type as QueryRunSummary["nodeType"],
        parentId: (row.parent_id as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
      })),
    };
  }

  /**
   * Aggregation counterpart of runQueryAst: the grouped grid (columns +
   * rows) for a `query` token whose AST carries an `aggregation`. Throws
   * InvalidQueryAstError for unparseable ASTs and ASTs without one.
   */
  runAggregateAst(rawAst: unknown): QueryAggregateResult {
    let ast: QueryAst;
    try {
      ast = parseQueryAst(rawAst);
    } catch (error) {
      throw new InvalidQueryAstError(
        `invalid query AST: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return runAggregate(this.store, ast);
    } catch (error) {
      throw new InvalidQueryAstError(
        `query not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Direct children of a node in child order, active only (export's nested-bullets read). */
  getChildren(id: string): ClientNode[] {
    return this.store
      .children(id)
      .filter((row) => row.is_active === 1)
      .map(mapNode);
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
   * Linked references (SCHEMA.md system sections): direct backlinks of the
   * node PLUS source-side containment roll-up (01 §8, query-time traversal) —
   * outward links from inside the node's subtree (a block inside France
   * linking Paris references France by containment). Ordered direct first,
   * then containment by subtree depth. Each entry carries the breadcrumb of
   * its containing page (the actual linking block's chain) and a `kind`.
   * The section badge reads getBacklinkCount (direct only) — unchanged, so a
   * containment-heavy page shows a longer list than its badge number.
   */
  getLinkedReferences(id: string): ReferenceEntry[] {
    const seen = new Set<string>();
    const entries: ReferenceEntry[] = [];
    for (const row of this.store.backlinksWithRollup(id) as Array<Record<string, unknown>>) {
      const sourceId = String(row.source_id);
      if (seen.has(sourceId)) continue;
      // Links written inside the node's OWN subtree (e.g. a link to a page
      // mentioned in that page's own blocks) are content, not references.
      // Live sources only — a trashed node no longer claims a reference.
      const source = this.getNode(sourceId);
      if (!source) continue;
      const entry = this.referenceEntry(source);
      if (entry === null) continue;
      // Links written inside the node's OWN subtree (a link mentioned in the
      // page's own blocks) are content, not references.
      if (entry.containingPageId === id || entry.source.id === id) continue;
      seen.add(sourceId);
      entries.push({
        ...entry,
        kind: row.kind === "containment" ? "containment" : "direct",
      });
    }
    return entries;
  }

  /**
   * Unlinked references (pages only — blocks never get this section):
   * literal-text FTS matches of the page's display name across the workspace,
   * excluding the page itself and every node that already links to it (the
   * linked-references set).
   */
  getUnlinkedReferences(id: string): ReferenceEntry[] {
    const entries: ReferenceEntry[] = [];
    for (const nodeId of this.unlinkedReferenceIds(id)) {
      const source = this.getNode(nodeId);
      if (!source) continue;
      entries.push(this.referenceEntry(source));
    }
    return entries;
  }

  /**
   * Eager unlinked-reference count for the SystemSections visibility rule
   * (hide the section at 0). Same cost as one unlinked query — the section
   * header must know emptiness without an expand, and windowed feeds (the
   * journal) mount too few pages for the per-page query to matter.
   */
  getUnlinkedReferenceCount(id: string): number {
    return this.unlinkedReferenceIds(id).length;
  }

  /** Source ids matching the page's name, minus itself and linked sources. */
  private unlinkedReferenceIds(id: string): string[] {
    const node = this.getNode(id);
    if (!node || node.nodeType !== "page") return [];
    const name = deriveDisplayName(node);
    if (!name) return [];
    const linkedSources = new Set(this.getBacklinks(id).map((edge) => edge.sourceId));
    const ids: string[] = [];
    for (const hit of this.store.search(name)) {
      if (hit.nodeId === id || linkedSources.has(hit.nodeId)) continue;
      ids.push(hit.nodeId);
    }
    return ids;
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
      // Direct by default; getLinkedReferences overrides for containment rows.
      kind: "direct",
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
    if (partial.tagIds !== undefined) payload.tagIds = partial.tagIds;
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
   * OR-set class membership add (the `#` / `+` set gesture). No-op when the
   * class is already assigned. Membership is NOT an object.update field:
   * class_ids is a CRDT OR-Set whose add carrier is a re-issued
   * object.create on the same id — the applier's exists-branch seeds
   * class_member_set add-wins per pair without touching the tree
   * (store/appliers.ts applyObjectCreate, conflicts.ts class_conflict).
   * Immediate (not debounced) — a discrete gesture with the same optimistic
   * envelope path as any write.
   */
  async assignClass(id: string, classId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`assignClass: node ${id} not found`);
    if (node.classIds.includes(classId)) return;
    await this.createObject({
      id,
      nodeType: node.nodeType,
      parentId: node.parentId,
      contentAst: node.contentAst,
      classIds: [classId],
      // exactOptionalPropertyTypes: only present the key when set.
      ...(node.name !== null ? { name: node.name } : {}),
    });
  }

  /**
   * OR-set class membership remove — the class chip's × gesture
   * (class.unassign). No-op when the class is not assigned. The applier
   * tombstones the class_member_set pair add-wins and recomputes class_ids;
   * the effective read drops the class's derived defaults automatically and
   * authored property values survive (SCHEMA.md "Class properties").
   * Immediate (not debounced) — a discrete gesture, same optimistic envelope
   * path as any write.
   */
  async unassignClass(id: string, classId: string): Promise<void> {
    const engine = this.requireEngine();
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`unassignClass: node ${id} not found`);
    if (!node.classIds.includes(classId)) return;
    engine.enqueue(this.buildEnvelope("class.unassign", { objectId: id, classId }, [id]));
    this.notify();
    this.kickPush();
  }

  /**
   * Assign a tag (any page) to a node — pages AND blocks (owner rule:
   * tags are node-scoped, the block metadata section renders them). The
   * add carrier is a re-issued object.create with the single tag, the same
   * OR-Set convergence pattern as classes.
   */
  async assignTag(id: string, tagId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`assignTag: node ${id} not found`);
    if (node.tagIds.includes(tagId)) return;
    await this.createObject({
      id,
      nodeType: node.nodeType,
      parentId: node.parentId,
      contentAst: node.contentAst,
      tagIds: [tagId],
      ...(node.name !== null ? { name: node.name } : {}),
    });
  }

  /** Remove a tag (OR-Set tombstone; loses to a concurrent newer add). */
  async unassignTag(id: string, tagId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`unassignTag: node ${id} not found`);
    if (!node.tagIds.includes(tagId)) return;
    const engine = this.requireEngine();
    engine.enqueue(this.buildEnvelope("tag.unassign", { objectId: id, tagId }, [id]));
    this.notify();
    this.kickPush();
  }

  /**
   * Create a class (class.create: node row + class registry row — the
   * registry row is what keeps the extends closure rebuild authoritative).
   * The store seeds the hierarchy self-row at create time, so no setExtends
   * is needed for a class that never extends anything.
   * Returns the new class id. Applied locally, push kicked off.
   */
  async createClass(name: string, opts?: { icon?: string; color?: string }): Promise<string> {
    const engine = this.requireEngine();
    const id = uuidv7();
    const payload: Record<string, unknown> = { classId: id, name };
    if (opts?.icon !== undefined) payload.icon = opts.icon;
    if (opts?.color !== undefined) payload.color = opts.color;
    engine.enqueue(this.buildEnvelope("class.create", payload, [id]));
    this.notify();
    this.kickPush();
    return id;
  }

  /**
   * Replace a class's full extends parent set (class.setExtends — m2m,
   * replace semantics; an empty array detaches all parents). The store keeps
   * the transitive closure in sync and fails loud on cycles (CycleError),
   * which callers surface as a transient message.
   */
  async setClassExtends(classId: string, parentClassIds: string[]): Promise<void> {
    const engine = this.requireEngine();
    engine.enqueue(
      this.buildEnvelope(
        "class.setExtends",
        { classId, parentClassIds },
        [classId, ...parentClassIds],
      ),
    );
    this.notify();
    this.kickPush();
  }

  /**
   * Upsert a class → property-schema binding (class.property.set). The
   * payload PATCHES the row: omitted fields keep their existing values.
   * Applied locally, push kicked off.
   */
  async setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void> {
    const engine = this.requireEngine();
    const payload: Record<string, unknown> = { classId, propertySchemaId };
    if (fields.sequence !== undefined) payload.sequence = fields.sequence;
    if (fields.required !== undefined) payload.required = fields.required;
    if (fields.readonly !== undefined) payload.readonly = fields.readonly;
    if (fields.hideWhenEmpty !== undefined) payload.hideWhenEmpty = fields.hideWhenEmpty;
    if (fields.defaultValue !== undefined) payload.defaultValue = fields.defaultValue;
    engine.enqueue(this.buildEnvelope("class.property.set", payload, [classId]));
    this.notify();
    this.kickPush();
  }

  /** Remove a class → property-schema binding (class.property.unset). */
  async unsetClassProperty(classId: string, propertySchemaId: string): Promise<void> {
    const engine = this.requireEngine();
    engine.enqueue(
      this.buildEnvelope(
        "class.property.unset",
        { classId, propertySchemaId },
        [classId],
      ),
    );
    this.notify();
    this.kickPush();
  }

  /**
   * Create a property schema (propertySchema.create); returns the new id.
   * The bindings picker's "+ new schema" path.
   */
  async createPropertySchema(input: CreatePropertySchemaInput): Promise<string> {
    const engine = this.requireEngine();
    const id = uuidv7();
    const payload: Record<string, unknown> = {
      propertySchemaId: id,
      name: input.name,
      type: input.type,
    };
    if (input.multi !== undefined) payload.multi = input.multi;
    if (input.scope !== undefined) payload.scope = input.scope;
    if (input.options !== undefined) payload.options = input.options;
    if (input.targetClassFilter !== undefined) payload.targetClassFilter = input.targetClassFilter;
    if (input.datePrecision !== undefined) payload.datePrecision = input.datePrecision;
    if (input.dateQualified !== undefined) payload.dateQualified = input.dateQualified;
    engine.enqueue(this.buildEnvelope("propertySchema.create", payload, []));
    this.notify();
    this.kickPush();
    return id;
  }

  /**
   * Patch a property schema's metadata (propertySchema.update): name/options
   * plus the SCHEMA.md "Dates" fields (the Class View bindings editor's
   * precision/qualified controls). Omitted fields keep their values.
   */
  async updatePropertySchema(propertySchemaId: string, fields: UpdatePropertySchemaInput): Promise<void> {
    const engine = this.requireEngine();
    const payload: Record<string, unknown> = { propertySchemaId };
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.options !== undefined) payload.options = fields.options;
    if (fields.datePrecision !== undefined) payload.datePrecision = fields.datePrecision;
    if (fields.dateQualified !== undefined) payload.dateQualified = fields.dateQualified;
    engine.enqueue(this.buildEnvelope("propertySchema.update", payload, []));
    this.notify();
    this.kickPush();
  }

  /**
   * Author a property value (property.set) — the panel's edit path. Writing
   * an authored value shadows any derived class-binding default at the slot.
   * `metadata` carries per-value qualifiers (SCHEMA.md "Dates": dateQualified
   * schemas persist startDate/endDate here).
   */
  async setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx = 0,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const engine = this.requireEngine();
    const payload: Record<string, unknown> = { objectId, propertySchemaId, value, idx };
    if (metadata !== undefined) payload.metadata = metadata;
    engine.enqueue(this.buildEnvelope("property.set", payload, [objectId]));
    this.notify();
    this.kickPush();
  }

  /** Clear an authored property value (property.unset) — the default resurfaces. */
  async unsetProperty(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    const engine = this.requireEngine();
    engine.enqueue(
      this.buildEnvelope(
        "property.unset",
        { objectId, propertySchemaId, idx },
        [objectId],
      ),
    );
    this.notify();
    this.kickPush();
  }

  // --- dates (SCHEMA.md "Dates" — a date is a node, not a string) --------------

  /** The schema's date precision (default day when the row predates the field). */
  private datePrecisionOf(propertySchemaId: string): DatePrecision {
    const schema = this.listPropertySchemas().find((s) => s.id === propertySchemaId);
    return schema?.datePrecision ?? "day";
  }

  /**
   * Ensure the year/month/day node chain for an ISO date exists (v1 journal
   * layout: year as a workspace-root page, month under year, day under month,
   * named by the v1 compact labels) and return the three deterministic ids.
   * Ids are content-addressed from the date (@notees/domain dates.ts), so a
   * re-run creates nothing — the client-level existence check is op-log
   * hygiene, not correctness; even a raced create is an applier no-op.
   */
  async ensureDateChain(
    isoDate: string,
  ): Promise<{ year: string; month: string; day: string }> {
    const parts = parseIsoDate(isoDate);
    const ids = chainNodeIds(isoDate);
    if (this.getNodeRaw(ids.year) === undefined) {
      await this.createObject({
        id: ids.year,
        nodeType: "page",
        parentId: null,
        name: dateNodeLabel(parts, "year"),
        classIds: [SYSTEM_CLASS_UUIDS.year],
      });
    }
    if (this.getNodeRaw(ids.month) === undefined) {
      await this.createObject({
        id: ids.month,
        nodeType: "page",
        parentId: ids.year,
        name: dateNodeLabel(parts, "month"),
        classIds: [SYSTEM_CLASS_UUIDS.month],
      });
    }
    if (this.getNodeRaw(ids.day) === undefined) {
      await this.createObject({
        id: ids.day,
        nodeType: "page",
        parentId: ids.month,
        name: dateNodeLabel(parts, "day"),
        classIds: [SYSTEM_CLASS_UUIDS.day],
      });
    }
    return ids;
  }

  /** Create/refresh the chain and return the node id at the schema's precision. */
  private async dateRefFor(isoDate: string, precision: DatePrecision): Promise<string> {
    const ids = await this.ensureDateChain(isoDate);
    return precision === "year" ? ids.year : precision === "month" ? ids.month : ids.day;
  }

  /**
   * Set a date property value: ensure the chain, then link the date node at
   * the schema's precision ({ "nodeId": … } — the shape the edge index
   * projects, so the year node backlinks everything dated that year).
   * Editing an existing value overwrites the same slot's ref.
   */
  async setDateProperty(
    objectId: string,
    propertySchemaId: string,
    isoDate: string,
    idx = 0,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const ref = await this.dateRefFor(isoDate, this.datePrecisionOf(propertySchemaId));
    await this.setProperty(objectId, propertySchemaId, { nodeId: ref }, idx, metadata);
  }

  /**
   * Set a date_range value ({ start, end } of date refs, either side open /
   * clearable). Precision applies to both ends. A null end keeps whatever the
   * other side holds — an open range.
   */
  async setDateRangeProperty(
    objectId: string,
    propertySchemaId: string,
    start: string | null,
    end: string | null,
    idx = 0,
  ): Promise<void> {
    const precision = this.datePrecisionOf(propertySchemaId);
    const value: { start: { nodeId: string } | null; end: { nodeId: string } | null } = {
      start: null,
      end: null,
    };
    if (start !== null) value.start = { nodeId: await this.dateRefFor(start, precision) };
    if (end !== null) value.end = { nodeId: await this.dateRefFor(end, precision) };
    await this.setProperty(objectId, propertySchemaId, value, idx);
  }

  /**
   * Create an annotation on an asset (the composed write behind the chips'
   * annotations form): the highlight-classed object named by the quote
   * excerpt, the highlight_asset link, the provenance text, and the optional
   * note child block. Applied locally, push kicked off.
   */
  createAnnotation(input: CreateAnnotationInput): Promise<string> {
    return createAnnotation(this, input);
  }

  // --- assets (REST upload + op-log link) -------------------------------------

  private requireRest(): { serverUrl: string; apiKey: string } {
    if (this.restServerUrl === null || this.restApiKey === null) {
      throw new Error(
        "WorkspaceClient: asset upload/download requires serverUrl + apiKey (use createHttp)",
      );
    }
    return { serverUrl: this.restServerUrl, apiKey: this.restApiKey };
  }

  /**
   * Upload file bytes to the server's CAS asset store (POST /api/v1/assets).
   * Returns the server-issued asset metadata; the caller links it into the
   * graph (asset node + property.set) — this method does NOT touch the store.
   */
  async uploadAsset(file: Blob, filename: string): Promise<AssetUploadResult> {
    const { serverUrl, apiKey } = this.requireRest();
    return postAssetUpload(serverUrl, apiKey, this.workspaceId, file, filename);
  }

  /**
   * Record an uploaded asset on a node (asset.attach op, the same envelope
   * the server submits when the multipart carries an objectId). Enqueued
   * client-side so the derived node_asset row — and with it the attachment
   * chip's name/download read — is local immediately (local-first), then
   * pushed with the rest of the outbox.
   */
  async attachAsset(objectId: string, asset: AssetUploadResult): Promise<void> {
    const engine = this.requireEngine();
    engine.enqueue(
      this.buildEnvelope(
        "asset.attach",
        {
          objectId,
          assetId: asset.assetId,
          hash: asset.hash,
          mimeType: asset.mimeType,
          size: asset.size,
          originalName: asset.originalName,
        },
        [objectId, asset.assetId],
      ),
    );
    this.notify();
    this.kickPush();
  }

  /**
   * Download an asset's bytes (GET /api/v1/assets/:id, workspace key) and open
   * them in a new tab as a blob URL — the key stays out of any URL.
   */
  async downloadAsset(assetId: string): Promise<void> {
    const { serverUrl, apiKey } = this.requireRest();
    const blob = await fetchAssetBlob(serverUrl, apiKey, assetId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
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
