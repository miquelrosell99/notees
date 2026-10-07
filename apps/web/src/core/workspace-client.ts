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
  DEFAULT_CLASS_ICON,
  defaultIconFor,
  deriveDisplayName,
  parseIsoDate,
  rendersWithDocumentChrome,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type DatePrecision,
} from "@notees/domain";
import {
  Clock,
  newEnvelope,
  type ContentAst,
  type Envelope,
  type WorkspaceFeature,
} from "@notees/protocol";
import { parseQueryAst, runAggregate, runQuery, type QueryAst } from "@notees/query";
import {
  Store,
  graphTopology as computeGraphTopology,
  visiblePropertyValueRows,
  type GraphOptions,
  type GraphTopology,
  type NodeRow,
} from "@notees/store";
import {
  HttpTransport,
  OfflineTransport,
  SyncEngine,
  isListingAffectingEnvelope,
  summarizeEnvelopes,
  type BatchChangeInfo,
  type SyncConflict,
  type SyncStatus,
  type Transport,
} from "@notees/sync";

import { sqljsBackend } from "@notees/store/sqljs";

// PG10 alias name-equivalents (aliasProperty type-only imports back — no
// runtime cycle).
import { aliasValuesOf } from "../ui/components/aliasProperty.js";

import {
  UndoJournal,
  type UndoCaptureSource,
  type UndoHistoryEntry,
  type UndoRecordMode,
  type UndoUiState,
} from "./undo-journal.js";

/** Sensible default depth cap for getBlockTree (cycle protection). */
const DEFAULT_TREE_DEPTH = 64;

/** Bare-uuid test for the legacy carrier value shape (archived data). */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default actor for the single-user client (overridable per client). */
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

/**
 * A semantic conflict the engine reported (see @notees/sync detectConflicts),
 * with the wall-clock time it was observed. Newest-last, bounded history for
 * the sync details modal — conflicts are otherwise transient
 * (emitted, never stored).
 */
export interface ConflictHistoryEntry extends SyncConflict {
  at: number;
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

/** Conflict-history retention for the sync details modal. */
const CONFLICT_LOG_CAP = 100;

/**
 * Change notification payload — what a `notify()` actually changed,
 * so the main-thread read cache refetches only impacted keys instead of the
 * whole cache. Semantics for subscribers:
 *
 *  - `structural === true` OR both fields absent → the change set is unknown
 *    or listing-scale: invalidate EVERY cached read.
 *  - otherwise → a content-only edit of `affectedNodeIds` (already
 *    ancestor-expanded): invalidate reads scoped to those ids plus
 *    content-global reads (search/reference listings embed titles and link
 *    marks from anywhere).
 *
 * `revision` is a per-session monotonic counter — informational (diagnostics,
 * tests); coalesced notifications carry the merged max.
 */
export interface ChangeNotification {
  revision: number;
  affectedNodeIds?: string[];
  structural?: boolean;
}

/**
 * Payload beyond this many expanded ids falls back to `structural: true`:
 * the invalidation message must stay small, and at this scale refetching
 * everything is cheaper than resolving scopes anyway.
 */
const CHANGE_AFFECT_CAP = 256;

export interface ClientNode {
  id: string;
  workspaceId: string;
  /** Class identity bit — the ONLY identity marker (classes are always roots). */
  isClass: boolean;
  /** Render bit for parented non-class nodes: true = the parent's
   * main-children zone + document chrome when zoomed; false = the inline
   * body + block chrome. Unread for parentless nodes and classes. */
  presentAsMain: boolean;
  parentId: string | null;
  classIds: string[];
  tagIds: string[];
  name: string | null;
  contentAst: ContentAst;
  icon: string | null;
  color: string | null;
  /** Wire node fields (the icon/color precedent, store schema v16): the
   * page cover/banner asset refs and the main page a node alias points at.
   * Null when unset; mapped by object.update. */
  coverAssetId: string | null;
  bannerAssetId: string | null;
  aliasedNodeId: string | null;
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
 * or whose compilation the query engine does not support. The query block view
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
  /** Revision-11 render-state booleans (the server's /query summary shape). */
  isClass: boolean;
  presentAsMain: boolean;
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
 * One page of the cursor-paginated ranked search: the resolved
 * nodes plus the opaque cursor for the next page (null = exhausted).
 */
export interface SearchPageResult {
  nodes: ClientNode[];
  nextCursor: string | null;
}

/**
 * Match-context snippet, mirrored from @notees/store's
 * SearchSnippet: the whitespace-normalized excerpt plus char-offset match
 * spans into it.
 */
export interface SearchSnippetData {
  text: string;
  matches: Array<{ start: number; length: number }>;
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
  /** Per-CLASS: the binding's required flag — a property may be
   *  mandatory for one class, optional for another. */
  required: boolean | null;
  defaultValue: string | null;
  /** SCHEMA.md "Dates": schema-row date behavior (null = day / not qualified). */
  datePrecision: DatePrecision | null;
  dateQualified: boolean | null;
  /** SCHEMA.md "Number formats": display-only formatting (null = unformatted). */
  numberPad?: number | null;
  numberDecimals?: number | null;
  numberRounding?: "round" | "floor" | "ceil" | "truncate" | null;
  /** The soft-unbind flag (false = the binding stops contributing). */
  active: boolean;
}

/**
 * Map one `class_property ⋈ property_schema` row to a ClassBinding — shared
 * by the extends-aware getClassBindings read and the own-rows-only
 * getRegistryBindings read. Title-is-content: the schema ROW is the naming
 * authority (renames and user edits ride it); only a missing row falls back
 * to a synthesized label at the call site.
 */
function mapClassBindingRow(row: Record<string, unknown>): ClassBinding {
  const decodeDefault = (raw: string | null): string | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      return raw;
    }
  };
  const parsePrecision = (raw: unknown): DatePrecision | null =>
    raw === "year" || raw === "month" || raw === "day" ? raw : null;
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
    defaultValue: decodeDefault((row.default_value as string | null) ?? null),
    datePrecision: parsePrecision(row.date_precision),
    dateQualified:
      row.date_qualified === null || row.date_qualified === undefined
        ? null
        : row.date_qualified === 1,
    numberPad: row.number_pad === null || row.number_pad === undefined ? null : Number(row.number_pad),
    numberDecimals:
      row.number_decimals === null || row.number_decimals === undefined ? null : Number(row.number_decimals),
    numberRounding:
      row.number_rounding === null || row.number_rounding === undefined
        ? null
        : (row.number_rounding as "round" | "floor" | "ceil" | "truncate"),
    active: row.binding_active === 0 ? false : true,
  };
}

/** Where a select/multi_select (or boolean) value renders on a block row. */
export type PropertyDisplay = "panel" | "bullet" | "inline";

/** Editable fields of a class.property.set write (all optional — patch). */
export interface SetClassPropertyInput {
  sequence?: number;
  required?: boolean | null;
  defaultValue?: unknown;
  active?: boolean;
}

/** A select/multi_select option (color + icon, both optional). */
export interface ClientPropertyOption {
  id: string;
  label: string;
  /** Preset token or `#RRGGBB` hex; absent/null = uncolored. */
  color?: string | null;
  /** MDI icon name (camelCase @mdi/js convention); absent/null = no icon. */
  icon?: string | null;
}

/**
 * One entry of the GET /api/operations relay-log feed, trimmed to
 * what the property-history modal renders — the envelope's coordination fields
 * plus its payload.
 */
export interface OperationFeedEntry {
  seq: number;
  opType: string;
  payload: Record<string, unknown>;
  actorId: string;
  deviceId: string;
  timestamp: string;
  hlc: { physical: number; logical: number };
}

/** Editable fields of a propertySchema.update write (all optional — patch). */
export interface UpdatePropertySchemaInput {
  name?: string;
  options?: ClientPropertyOption[];
  datePrecision?: DatePrecision;
  dateQualified?: boolean;
  /** SCHEMA.md "Number formats": absent keeps, null clears (display only). */
  numberPad?: number | null;
  numberDecimals?: number | null;
  numberRounding?: "round" | "floor" | "ceil" | "truncate" | null;
  /** The render contracts (PROPERTY-level): absent keeps, null clears. */
  display?: PropertyDisplay | null;
  readonly?: boolean | null;
  hideWhenEmpty?: boolean | null;
}

/** A property schema row as listed by the bindings picker's candidate set. */
export interface ClientPropertySchema {
  id: string;
  name: string;
  type: string;
  multi: boolean;
  scope: string;
  options: ClientPropertyOption[] | null;
  targetClassFilter: string[] | null;
  /** SCHEMA.md "Dates": finest granularity a date value may claim (null = day). */
  datePrecision: DatePrecision | null;
  /** SCHEMA.md "Dates": node-typed values may carry date qualifiers. */
  dateQualified: boolean | null;
  /** SCHEMA.md "Number formats": display-only formatting (null = unformatted). */
  numberPad?: number | null;
  numberDecimals?: number | null;
  numberRounding?: "round" | "floor" | "ceil" | "truncate" | null;
  /** The render contracts (PROPERTY-level; null = panel / unset). */
  display?: PropertyDisplay | null;
  readonly?: boolean | null;
  hideWhenEmpty?: boolean | null;
}

export interface CreatePropertySchemaInput {
  /**
   * Defaults to a fresh UUIDv7. Pass the reserved system id to author a
   * designed schema idempotently (the task family); the
   * propertySchema.create op has always accepted a caller-chosen id.
   */
  id?: string;
  name: string;
  type: string;
  multi?: boolean;
  scope?: string;
  options?: ClientPropertyOption[];
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
  /** The value's stable element id — the address multi-value removes target. */
  elementId: string;
  schema: {
    id: string;
    name: string;
    type: string;
    multi: boolean;
    datePrecision: DatePrecision | null;
    dateQualified: boolean | null;
    numberPad?: number | null;
    numberDecimals?: number | null;
    numberRounding?: "round" | "floor" | "ceil" | "truncate" | null;
    /** The render contracts (PROPERTY-level; null = panel / unset). */
    display?: PropertyDisplay | null;
    readonly?: boolean | null;
    hideWhenEmpty?: boolean | null;
  } | null;
  value: unknown;
  /** Authored qualifiers (date-node refs or legacy ISO strings). */
  metadata: Record<string, unknown> | null;
  source: "authored" | "default";
  boundBy: string | null;
  /** Per-CLASS: the winning binding's required flag. */
  required: boolean | null;
  /** PROPERTY-level: the schema's render contracts — the same for
   *  every carrier, class-bound or not. */
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
  sequence: number | null;
  display: PropertyDisplay | null;
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
   * subtree (source-side containment roll-up); "alias" = the edge
   * targets an alias page of the node (issue #7 node-alias roll-up —
   * SCHEMA.md "Node aliases"). Unlinked references are always "direct".
   */
  kind: "direct" | "containment" | "alias";
  /**
   * Linked references only: the edge's verb — a propertySchemaId
   * when the referencing edge is a property value over a bound verb schema
   * (the designed targeted path; typed-link marks stay targetless per the
   * deferred-resolution ruling). The surfaces resolve it to the schema
   * name. Null for mentions and unlinked references.
   */
  verb: string | null;
}

export interface CreateObjectInput {
  /** Defaults to a fresh UUIDv7. */
  id?: string;
  /**
   * Render bit (Revision 11): true = the parent's main-children zone +
   * document chrome when zoomed; false/absent = the inline body (a parented
   * child defaults to inline; a parentless node defaults to main — the
   * applier decides when the field is omitted). Classes are declared by
   * class.create, never by this bit.
   */
  presentAsMain?: boolean;
  /** Omit for a workspace-root page; null is accepted explicitly. */
  parentId?: string | null;
  /**
   * Title-is-content: `name` is NOT a stored field — it becomes the node's
   * initial text content (a single text token) when `contentAst` is not
   * given. A page's title IS its content.
   */
  name?: string;
  contentAst?: ContentAst;
  classIds?: string[];
  tagIds?: string[];
  /**
   * Initial sibling placement in the parent's fractional child order
   * (object.create / object.move payload): place next to that current
   * sibling; omit both to append at the end.
   */
  afterId?: string;
  beforeId?: string;
}

export interface UpdateObjectInput {
  /**
   * Render-bit toggle (Revision 11): promotion/demotion — flipping false →
   * true stringifies the content server-side (the bit never un-flattens).
   */
  presentAsMain?: boolean;
  contentAst?: ContentAst;
  icon?: string;
  /** Preset token or #RRGGBB hex; null clears the color. */
  color?: string | null;
  /**
   * The wire node fields (the icon/color precedent — SCHEMA.md "Node
   * structure"): the page cover/banner asset refs and the main page a node
   * alias points at. Presence writes; null clears; absence preserves.
   */
  coverAssetId?: string | null;
  bannerAssetId?: string | null;
  aliasedNodeId?: string | null;
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

/** POST /api/assets response shape (the fields the client consumes). */
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
 * provenance property (…000000000019) records origin (+ page context),
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
    presentAsMain: true,
    name: quote.slice(0, ANNOTATION_NAME_MAX),
    classIds: [SYSTEM_CLASS_UUIDS.highlight],
  });
  await writes.setProperty(id, SYSTEM_PROPERTY_UUIDS.highlightAsset, { nodeId: input.assetId }, 0);
  // The model has no seeded locator property (the …0018 locator was
  // withdrawn, never reused), so
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
   * Server REST access (POST /api/assets upload + download). createHttp
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
 * POST /api/assets (multipart, CAS upload). The web client's upload path:
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
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/assets`, {
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
 * GET /api/assets/:id (auth; Range-capable). Fetched with the API key
 * header (a bare window.open cannot set headers), then opened as a blob URL
 * so the chip click lands in a new tab without leaking the key into a URL.
 */
export async function fetchAssetBlob(
  serverUrl: string,
  apiKey: string,
  assetId: string,
  workspaceId?: string,
): Promise<Blob> {
  const response = await fetch(
    `${serverUrl.replace(/\/$/, "")}/api/assets/${encodeURIComponent(assetId)}`,
    {
      // The workspace header is load-bearing: asset bytes live under the
      // workspace's own directory server-side, so without it the route
      // resolves the default workspace and 404s every non-default fetch
      // (2026-10-04: covers rendered "No image bytes" in worker AND
      // in-process modes for exactly this reason).
      headers: {
        "X-API-Key": apiKey,
        ...(workspaceId !== undefined ? { "X-Workspace-Id": workspaceId } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`asset download failed: HTTP ${response.status}`);
  }
  return response.blob();
}

/** Blob → data URL (image thumbnails/covers); null on read failure. */
export function readBlobAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// --- per-user UI prefs (favorites/recents — server-side UI state) ----
//
// Owner ruling 2026-10-04: favorites/recents are UI preferences,
// so they live in the sync server's per-user prefs store, NOT the operation
// log ("device state is never an op" stands). The client speaks REST
// (getPrefs/patchPrefs below) with a device-local cache (`notees.favorites` /
// `notees.recents`, the pre-existing keys) as the honest offline fallback:
// reads return the cached copy, writes update it immediately and sync when a
// server answers.

export interface UserPrefs {
  /** Ordered starred node ids. */
  favorites: string[];
  /** Most-recent-first node ids. */
  recents: string[];
}

/** "server" — the prefs store answered; "local" — the device cache did. */
export type UserPrefsSource = "server" | "local";

/** Merge patch: each present list replaces its column wholesale. */
export interface PrefsPatch {
  favorites?: string[];
  recents?: string[];
}

/** The server's recents cap (favorites cap 500 — a UI never gets near it). */
export const MAX_SYNCED_RECENTS = 50;

/** Device-local cache keys — shared with the sidebar/palette legacy readers. */
const PREFS_LOCAL_KEYS = { favorites: "notees.favorites", recents: "notees.recents" } as const;

/**
 * Memory backing for realms without localStorage (the store worker): the
 * fallback cache survives the session, honestly not across worker restarts.
 */
const prefsMemoryCache = new Map<string, string[]>();

/** Read one device-local prefs list (`notees.favorites` / `notees.recents`). */
export function readDevicePrefList(key: keyof typeof PREFS_LOCAL_KEYS): string[] {
  // localStorage existing means it is authoritative — an absent key IS an
  // empty list. The memory backing serves only realms without localStorage
  // (the store worker), never as a shadow of an empty store.
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(PREFS_LOCAL_KEYS[key]);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      // Fall through to the memory copy.
    }
  }
  return prefsMemoryCache.get(key) ?? [];
}

/** Write one device-local prefs list (localStorage + memory backing). */
export function writeDevicePrefList(key: keyof typeof PREFS_LOCAL_KEYS, list: string[]): void {
  prefsMemoryCache.set(key, list);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PREFS_LOCAL_KEYS[key], JSON.stringify(list));
    }
  } catch {
    // Storage unavailable; the memory copy keeps the session consistent.
  }
}

/** Server body → UserPrefs; a malformed answer is a loud error, never half-read. */
function normalizeUserPrefs(body: unknown): UserPrefs {
  const value = body as { favorites?: unknown; recents?: unknown };
  const asIds = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
  return { favorites: asIds(value?.favorites), recents: asIds(value?.recents) };
}

/** Star toggle: add/remove an id, preserving the existing order. */
export function mergeFavoriteToggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/** Recents open: most-recent-first, deduped, capped at MAX_SYNCED_RECENTS. */
export function mergeRecentOpen(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, MAX_SYNCED_RECENTS);
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
    isClass: row.is_class === 1,
    presentAsMain: row.present_as_main === 1,
    parentId: row.parent_id,
    classIds,
    tagIds,
    name: row.name,
    contentAst: parseContentAst(row.content),
    icon: row.icon,
    color: row.color,
    coverAssetId: row.cover_asset_id ?? null,
    bannerAssetId: row.banner_asset_id ?? null,
    aliasedNodeId: row.aliased_node_id ?? null,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Per-row identity stamp for the `mapNode` cache, hashing exactly
 * the raw columns `mapNode` consumes. Metadata stamps are UNSOUND here:
 * membership recomputes touch `class_ids`/`tag_ids` without bumping
 * `hlc`/`updated_at` (appliers.ts recomputeClassIds/recomputeTagIds), so the
 * stamp must cover the values themselves. Two FNV-1a-style 32-bit runs with
 * different constants give a ~64-bit space (per-row-version collision
 * ~2^-64); a matching pair means every mapped column is byte-identical.
 * Returns the pair instead of a combined Number — 2^64 exceeds the safe
 * integer range.
 */
function nodeRowStamp(row: NodeRow): { h1: number; h2: number } {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000197;
  const mix = (value: string | number | null): void => {
    const text = value === null ? "\x00" : String(value);
    for (let i = 0; i < text.length; i++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
      h2 = Math.imul(h2 ^ (text.charCodeAt(i) + 0x9e37), 0x85ebca6b);
    }
    // Column-boundary + length folding (naive concat would alias ab|c / a|bc).
    h1 = Math.imul(h1 ^ (text.length + 0x1f), 0x01000193);
    h2 = Math.imul(h2 ^ (text.length + 0x1e), 0x85ebca6b);
  };
  mix(row.id);
  mix(row.workspace_id);
  mix(row.is_class);
  mix(row.present_as_main);
  mix(row.parent_id);
  mix(row.class_ids);
  mix(row.tag_ids);
  mix(row.name);
  mix(row.content);
  mix(row.icon);
  mix(row.color);
  mix(row.cover_asset_id);
  mix(row.banner_asset_id);
  mix(row.aliased_node_id);
  mix(row.is_active);
  mix(row.created_at);
  mix(row.updated_at);
  return { h1: h1 >>> 0, h2: h2 >>> 0 };
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
  private readonly listeners = new Set<(change: ChangeNotification) => void>();
  /** Server REST access (asset upload/download); null without serverUrl/apiKey. */
  private readonly restServerUrl: string | null;
  private readonly restApiKey: string | null;

  private workspaceId: string = DEFAULT_WORKSPACE_ID;
  private engine: SyncEngine | null = null;
  /** Combined teardown for the wired realtime channel + status subscription. */
  private realtimeStop: (() => void) | null = null;
  private closed = false;
  /**
   * Revision-keyed memo for the render-path list reads
   * (listClasses/listPages/roots). Dozens of components call these per
   * render; uncached, each call re-ran the full-table query + row mapping on
   * the main thread (the profiled 75%-of-capture jank). `notify()` is the
   * single funnel for every store mutation and refresh, so it clears this
   * map: one query per change burst, and no re-query at all for renders that
   * race no change (e.g. the 2s status poll). Returned arrays are SHARED
   * across callers until the next notify — callers must treat them as
   * read-only.
   */
  private readonly listReadCache = new Map<string, unknown>();
  /**
   * Per-row `mapNode` identity cache: unchanged rows reuse their
   * `ClientNode` across store revisions, so a version bump (one keystroke's
   * op) doesn't re-parse/re-allocate every node in the workspace (the
   * profiled allocation churn — 254 minor GCs in a 35s capture). Keyed by
   * row id, self-invalidating via the column-value stamp (no notify
   * coupling); membership recomputes that skip hlc/updated_at are still
   * caught through the class_ids/tag_ids columns in the stamp.
   */
  private readonly nodeMapCache = new Map<string, { h1: number; h2: number; node: ClientNode }>();

  private mapNodeCached(row: NodeRow): ClientNode {
    const { h1, h2 } = nodeRowStamp(row);
    const hit = this.nodeMapCache.get(row.id);
    if (hit !== undefined && hit.h1 === h1 && hit.h2 === h2) return hit.node;
    const node = mapNode(row);
    this.nodeMapCache.set(row.id, { h1, h2, node });
    return node;
  }
  /**
   * The session-local op-inverse undo journal (in-memory, per
   * client = per tab; never cross-tab, never durable). Records every write
   * this client applies through its outbox path, with the pre-op snapshot
   * captured at apply time; undo/redo compose existing ops through the same
   * write path (see undo-journal.ts for the inversion matrix).
   */
  private readonly undoJournal: UndoJournal;
  /** Semantic conflict history for the sync details modal. */
  private readonly conflictLog: ConflictHistoryEntry[] = [];

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
    this.undoJournal = new UndoJournal({ capture: this.buildUndoCaptureSource() });
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

  /**
   * The graph-view topology projection: one derived read over the
   * local store — classes + present-as-main nodes only, every edge rolled up
   * to that node set, plus the semantic co-occurrence family. Pure read, no
   * caching here: the graph view debounces its own reloads on subscribe.
   */
  graphTopology(options?: GraphOptions): GraphTopology {
    return computeGraphTopology(this.store, this.workspaceId, options);
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
    // A (re)bootstrap starts a fresh session journal: the durable unpushed
    // backlog replays below through the raw engine path on purpose (those
    // envelopes already had their session — re-journaling replays would mint
    // phantom undo entries).
    this.undoJournal.clear();
    this.engine = new SyncEngine(this.store, this.transport, this.clock, {
      workspaceId,
      callbacks: {
        onConflict: (conflicts) => {
          // Record before forwarding: the modal reads the log over RPC, and
          // conflicts are otherwise transient (emitted once, never stored).
          for (const conflict of conflicts) {
            this.conflictLog.push({ ...conflict, at: Date.now() });
          }
          if (this.conflictLog.length > CONFLICT_LOG_CAP) {
            this.conflictLog.splice(0, this.conflictLog.length - CONFLICT_LOG_CAP);
          }
          this.userOnConflict?.(conflicts);
        },
        onError: (error) => this.userOnSyncError?.(error),
        onPush: (_total, info) => this.notifyFromInfo(info),
        onPull: (_total, info) => this.notifyFromInfo(info),
        // Realtime (WS) frames applied to the store refresh the UI exactly
        // like a pull does.
        onRemoteBatch: (_applied, info) => this.notifyFromInfo(info),
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
    // Bootstrap notifies unconditionally (the engine callbacks above also
    // fired): sync failures reject before the onPull callback runs, and the
    // initial UI seed must refresh either way.
    this.notify();
  }

  /**
   * One push+pull sync cycle against the relay. The engine's onPush/onPull/
   * status callbacks notify with change-info; no wrapper notify here (a
   * no-op cycle must not invalidate the read cache).
   */
  async sync(): Promise<void> {
    await this.requireEngine().sync();
  }

  // --- read API (local store only) -------------------------------------------

  /** The node mapped to the client view, or undefined when missing/inactive. */
  getNode(id: string): ClientNode | undefined {
    const row = this.store.getNode(id);
    if (!row || row.is_active !== 1) return undefined;
    return this.mapNodeCached(row);
  }

  /** A single node, regardless of active state (backlink sources may be trashed). */
  getNodeRaw(id: string): ClientNode | undefined {
    const row = this.store.getNode(id);
    return row ? this.mapNodeCached(row) : undefined;
  }

  /** Display name for mentions/chips (SCHEMA.md name derivation); null when unknown. */
  getDisplayName(id: string): string | null {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) return null;
    return deriveDisplayName(node) || null;
  }

  /**
   * A document-chrome node (Revision 11): non-class and parentless or
   * present-as-main — the Page View's read; anything else (a class, an
   * inline block) is not a page here.
   */
  getPage(id: string): ClientNode | undefined {
    const node = this.getNode(id);
    return node !== undefined && rendersWithDocumentChrome(node) ? node : undefined;
  }

  /** All document-chrome nodes (parentless or main children), deterministic order. */
  listPages(): ClientNode[] {
    return this.cachedListRead("listPages", () => {
      const rows = this.store.database
        .prepare(
          `SELECT * FROM node
         WHERE workspace_id = ? AND is_class = 0 AND (parent_id IS NULL OR present_as_main = 1) AND is_active = 1
         ORDER BY COALESCE(name, id), id`,
        )
        .all(this.workspaceId) as NodeRow[];
      return rows.map((row) => this.mapNodeCached(row));
    });
  }

  /**
   * Top-level pages only (parentless non-class, active) — the shell's
   * workspace-level page lists and the export enumerator. Same display order
   * as listPages; unlike listPages, main children (subpages in a parent's
   * Pages zone) are NOT included.
   */
  roots(): ClientNode[] {
    return this.cachedListRead("roots", () =>
      this.store.roots(this.workspaceId).map((row) => this.mapNodeCached(row)),
    );
  }

  /** All active classes in the workspace, deterministic order (# capture). */
  listClasses(): ClientNode[] {
    return this.cachedListRead("listClasses", () => {
      const rows = this.store.database
        .prepare(
          `SELECT * FROM node
         WHERE workspace_id = ? AND is_class = 1 AND is_active = 1
         ORDER BY COALESCE(name, id), id`,
        )
        .all(this.workspaceId) as NodeRow[];
      return rows.map((row) => this.mapNodeCached(row));
    });
  }

  /**
   * The class id → icon lookup behind the UI icon maps: a narrow
   * `SELECT id, icon` — no content blob, no sort — revision-cached like the
   * list reads. Both web clients satisfy this; icon-map call sites should
   * prefer it over `classIconMap(client.listClasses())`.
   */
  classIcons(): ReadonlyMap<string, string | null> {
    return this.cachedListRead("classIcons", () => {
      const rows = this.store.database
        .prepare(
          `SELECT id, icon FROM node
         WHERE workspace_id = ? AND is_class = 1 AND is_active = 1`,
        )
        .all(this.workspaceId) as Array<{ id: string; icon: string | null }>;
      return new Map(rows.map((row) => [row.id, row.icon]));
    });
  }

  /**
   * The class id → EFFECTIVE icon lookup (#1 follow-up): each class's own
   * icon, else the first icon found walking its `class_extends` chain (the
   * `classIconInChain` semantics — a daily page whose icon arrives through
   * a class parent now renders it in ROWS too, not just group-by headers).
   * Computed once per revision over the narrow id+icon read + the extends
   * table. Display-time only: the stored icons stay as authored.
   */
  effectiveClassIcons(): ReadonlyMap<string, string | null> {
    return this.cachedListRead("effectiveClassIcons", () => {
      const own = this.classIcons();
      const rows = this.store.database
        .prepare(
          "SELECT class_id, parent_class_id FROM class_extends ORDER BY class_id, parent_class_id",
        )
        .all() as Array<{ class_id: string; parent_class_id: string }>;
      const parentsOf = new Map<string, string[]>();
      for (const row of rows) {
        const list = parentsOf.get(row.class_id);
        if (list === undefined) parentsOf.set(row.class_id, [row.parent_class_id]);
        else list.push(row.parent_class_id);
      }
      const resolved = new Map<string, string | null>();
      const resolve = (id: string, seen: ReadonlySet<string>): string | null => {
        if (resolved.has(id)) return resolved.get(id)!;
        if (seen.has(id)) return null;
        const icon = own.get(id);
        if (icon !== null && icon !== undefined && icon !== "") {
          resolved.set(id, icon);
          return icon;
        }
        const next = new Set(seen).add(id);
        for (const parent of parentsOf.get(id) ?? []) {
          const parentIcon = resolve(parent, next);
          if (parentIcon !== null) {
            resolved.set(id, parentIcon);
            return parentIcon;
          }
        }
        resolved.set(id, null);
        return null;
      };
      for (const id of own.keys()) resolve(id, new Set());
      return resolved;
    });
  }

  /** Compute-once-per-revision list read (see `listReadCache`). */
  private cachedListRead<T>(key: string, compute: () => T): T {
    if (this.listReadCache.has(key)) return this.listReadCache.get(key) as T;
    const value = compute();
    this.listReadCache.set(key, value);
    return value;
  }

  /** Direct extends parents of a class (m2m), deterministic order. */
  getClassParents(classId: string): string[] {
    return this.store.classParentIds(classId);
  }

  /** Classes extending this one (transitive), as nodes — the "Extended by" read. */
  getClassChildren(classId: string): ClientNode[] {
    return this.store
      .classChildIds(classId)
      .map((id) => this.getNode(id) ?? this.getNodeRaw(id))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /** Nodes with present OR-set membership in the class, display order. */
  getClassMembers(classId: string): ClientNode[] {
    return this.store.classMembers(classId).map((row) => this.mapNodeCached(row));
  }

  /** The classed-nodes section badge — the same membership projection as a COUNT. */
  getClassMemberCount(classId: string): number {
    return this.store.classMembersCount(classId);
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
    if (node === undefined || !node.isClass) {
      return [];
    }
    // Extends-aware (owner fix): a class's bindings include its ancestors'
    // — book extends source, so source's bound properties are book's class
    // properties too. Own rows first, then
    // ancestors' by sequence; the first binding for a schema wins.
    // class_hierarchy rows are (class_id, ancestor_id): the ancestor set of
    // `classId` is `SELECT ancestor_id … WHERE class_id = classId` (the
    // transpose — `class_id … WHERE ancestor_id` — selected the DESCENDANTS,
    // leaking children's rows into the parent read).
    const rows = this.store.database
      .prepare(
        `SELECT cp.property_schema_id, cp.sequence, cp.required, cp.default_value,
                cp.active AS binding_active, ps.name, ps.type, ps.multi, ps.target_class_filter, ps.active,
                ps.date_precision, ps.date_qualified, ps.number_pad, ps.number_decimals, ps.number_rounding
         FROM class_property cp
         LEFT JOIN property_schema ps ON ps.id = cp.property_schema_id
         WHERE cp.class_id IN (SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?)
         ORDER BY (cp.class_id = ?) DESC, cp.sequence, cp.property_schema_id`,
      )
      .all(classId, classId) as Array<Record<string, unknown>>;
    const seenSchemas = new Set<string>();
    const dedupedRows = rows.filter((row) => {
      const id = String(row.property_schema_id);
      if (seenSchemas.has(id)) return false;
      seenSchemas.add(id);
      return true;
    });
    const bindings: ClassBinding[] = dedupedRows.map((row) => mapClassBindingRow(row));
    const bound = new Set(bindings.map((b) => b.propertySchemaId));
    // Seed-spec fallback: a system class whose binding rows were never
    // authored still exposes its spec's schemas (read-synthesized — the
    // PG14 seed-spec lookup). Keyed on the RESERVED SYSTEM ID, not the
    // title, so the lookup survives display-wording renames (the system-
    // names pass) and ad-hoc test fixtures alike. The synthesized label
    // comes from the property_schema ROW when one exists (the row is the
    // naming authority — renames and user edits ride it); only a missing
    // row falls back to the manifest's display name.
    const systemClassName = (
      Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>
    ).find(([, id]) => id === classId)?.[0];
    const schemaNameStmt = this.store.database.prepare(
      "SELECT name FROM property_schema WHERE id = ?",
    );
    let fallbackSeq = bindings.length;
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      // bindTo-less specs (the global alias schema) are never class-bound —
      // skip them explicitly (undefined === systemClassName would otherwise
      // "match" for non-system classes).
      if (spec === undefined || spec.bindTo === undefined || spec.bindTo !== systemClassName) {
        continue;
      }
      const id = SYSTEM_PROPERTY_UUIDS[name as keyof typeof SYSTEM_PROPERTY_UUIDS];
      if (bound.has(id)) continue;
      const stored = schemaNameStmt.get(id) as { name: string } | undefined;
      bindings.push({
        propertySchemaId: id,
        name:
          stored?.name ??
          SYSTEM_PROPERTY_DISPLAY_NAMES[name as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES],
        type: spec.type,
        multi: spec.multi ?? false,
        targetClassFilter: spec.targetClassFilter ?? null,
        sequence: fallbackSeq++,
        required: null,
        defaultValue: spec.defaultValue ?? null,
        datePrecision: null,
        dateQualified: null,
        active: true,
      });
    }
    return bindings.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
  }

  /**
   * The class's OWN registry rows (class_property ⋈ property_schema) —
   * no extends inheritance, no seed-spec fallback synthesis. This is the
   * honest existence read for write-path self-heals (deploySystemClass's
   * binding step): getClassBindings read-synthesizes the designed system
   * seeds for system classes, so a workspace whose registry rows were never
   * authored still LOOKS bound through that read while the registry-only
   * effective-properties read (store effective.ts) sees nothing. Reads that
   * deliberately rely on the fallback (the meetingFamily present gates, the
   * calendar chip eligibility walk, the ClassView) keep using
   * getClassBindings.
   */
  getRegistryBindings(classId: string): ClassBinding[] {
    const node = this.getNode(classId);
    if (node === undefined || !node.isClass) {
      return [];
    }
    const rows = this.store.database
      .prepare(
        `SELECT cp.property_schema_id, cp.sequence, cp.required, cp.default_value,
                cp.active AS binding_active, ps.name, ps.type, ps.multi, ps.target_class_filter, ps.active,
                ps.date_precision, ps.date_qualified, ps.number_pad, ps.number_decimals, ps.number_rounding
         FROM class_property cp
         LEFT JOIN property_schema ps ON ps.id = cp.property_schema_id
         WHERE cp.class_id = ?
         ORDER BY cp.sequence, cp.property_schema_id`,
      )
      .all(classId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapClassBindingRow(row));
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
   * Nodes carrying an authored value for the property schema (the
   * PropertyView's references population). Pure read over the local
   * store; derived defaults never materialize, so unvalued bindings never
   * list.
   */
  getPropertyReferences(schemaId: string): ClientNode[] {
    return this.store.propertyValueCarriers(schemaId).map((entry) => mapNode(entry.node));
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
   * An image asset's bytes as a data URL (card covers / thumbnails). Null
   * for non-image assets and when the REST surface is unconfigured —
   * callers render the no-image card in that case.
   */
  async getAssetDataUrl(assetNodeId: string): Promise<string | null> {
    const info = this.getAssetInfo(assetNodeId);
    if (info === undefined || !info.mimeType.startsWith("image/")) return null;
    if (this.restServerUrl === null || this.restApiKey === null) return null;
    try {
      const blob = await fetchAssetBlob(this.restServerUrl, this.restApiKey, info.assetId, this.workspaceId);
      return await readBlobAsDataUrl(blob);
    } catch {
      return null;
    }
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
        `SELECT id, name, type, multi, scope, options, target_class_filter, date_precision, date_qualified,
                display, readonly, hide_when_empty
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
      let options: ClientPropertyOption[] | null = null;
      try {
        const parsed: unknown = JSON.parse((row.options as string | null) ?? "null");
        if (Array.isArray(parsed)) {
          options = parsed
            .filter(
              (v): v is Record<string, unknown> =>
                typeof v === "object" && v !== null && "id" in v && "label" in v,
            )
            .map((v) => ({
              id: String(v.id),
              label: String(v.label),
              // Option colors ride the color grammar; absent/null = none.
              ...("color" in v && (typeof v.color === "string" || v.color === null)
                ? { color: v.color as string | null }
                : {}),
              // Option icons ride as an MDI name; absent/null = none.
              ...("icon" in v && (typeof v.icon === "string" || v.icon === null)
                ? { icon: v.icon as string | null }
                : {}),
            }));
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
        numberPad: row.number_pad === null || row.number_pad === undefined ? null : Number(row.number_pad),
        numberDecimals:
          row.number_decimals === null || row.number_decimals === undefined ? null : Number(row.number_decimals),
        numberRounding:
          row.number_rounding === null || row.number_rounding === undefined
            ? null
            : (row.number_rounding as "round" | "floor" | "ceil" | "truncate"),
        // The render contracts (PROPERTY-level; null = panel / unset).
        display: row.display === "bullet" || row.display === "inline" ? row.display : null,
        readonly: row.readonly === null || row.readonly === undefined ? null : row.readonly === 1,
        hideWhenEmpty:
          row.hide_when_empty === null || row.hide_when_empty === undefined
            ? null
            : row.hide_when_empty === 1,
      };
    });
  }

  /**
   * Children of a node in child-order, recursive to `depth` levels (the
   * inline body only: main children render in their own section — the Pages
   * zone — so the tree is filtered to is_class = 0 AND present_as_main = 0,
   * the inline-block predicate; class children (spec I4) ride here as
   * ordinary body blocks).
   */
  /**
   * Block-subtree rooted at `id`, capped at `depth` levels (cycle protection).
   * `depth` normalizes null → default: the worker RPC boundary turns an
   * omitted optional into JSON null, and `null <= 0` is true — without the
   * normalization the worker path silently renders every page with zero
   * block rows.
   *
   * The node-backed-property exclusion is computed PER SUBTREE ROOT —
   * a nested block's own carriers are excluded from ITS body, and an
   * excluded carrier's whole subtree is pruned with it (children of an
   * excluded row are never visited).
   */
  getBlockTree(pageId: string, depth?: number | null): BlockTreeNode[] {
    // The deferred follow-up: `useOutlinerValue` calls this on every
    // view render, so it rides the revision cache like the list reads (the
    // worker client already cachedReads it; now the in-process path matches).
    return this.cachedListRead(`getBlockTree:${pageId}:${depth ?? "*"}`, () => {
      const cap = depth ?? DEFAULT_TREE_DEPTH;
      const build = (id: string, remaining: number): BlockTreeNode[] => {
        if (remaining <= 0) return [];
        // Node-backed property values live as children of the owner but render
        // inside the property cell — exclude them here or they appear twice.
        // Two shapes: node-typed references ({"nodeId"}) and text properties,
        // whose scalar value may be the carrier block's uuid (legacy shape).
        const propertyRefIds = this.propertyCarrierIdsOf(id);
        return this.store
          .children(id)
          .filter(
            (row) =>
              row.is_class === 0 &&
              row.present_as_main === 0 &&
              row.is_active === 1 &&
              !propertyRefIds.has(row.id),
          )
          .map((row) => ({
            node: this.mapNodeCached(row),
            children: build(row.id, remaining - 1),
          }));
      };
      return build(pageId, cap);
    });
  }

  /**
   * The node ids referenced by `nodeId`'s property values (canonical
   * `{nodeId}` refs and legacy bare-uuid text values) — the carrier set the
   * body render excludes. Scoped to ONE node: each subtree root filters its
   * own carriers.
   */
  private propertyCarrierIdsOf(nodeId: string): Set<string> {
    const propertyRefIds = new Set<string>();
    for (const row of visiblePropertyValueRows(this.store.database, nodeId)) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "nodeId" in parsed &&
          typeof (parsed as { nodeId: unknown }).nodeId === "string"
        ) {
          propertyRefIds.add((parsed as { nodeId: string }).nodeId);
        } else if (typeof parsed === "string" && UUID_LIKE.test(parsed)) {
          propertyRefIds.add(parsed);
        }
      } catch {
        // Scalar value — not a node reference.
      }
    }
    return propertyRefIds;
  }

  /** FTS prefix-AND search over active nodes (ranked; limit defaults to 50). */
  search(query: string, limit?: number): ClientNode[] {
    return this.store
      .search(query, limit)
      .map((hit) => this.getNode(hit.nodeId))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /**
   * Cursor-paginated ranked search: the async counterpart of the
   * cached sync `search` for load-more surfaces. `cursor` is the opaque
   * `nextCursor` of the previous page (null/absent = first page); the result
   * carries the next cursor (null = exhausted).
   */
  searchPage(
    query: string,
    opts?: { limit?: number; cursor?: string | null } | null,
  ): Promise<SearchPageResult> {
    const page = this.store.searchPage(query, { limit: opts?.limit, cursor: opts?.cursor ?? null });
    return Promise.resolve({
      nodes: page.hits
        .map((hit) => this.getNode(hit.nodeId))
        .filter((node): node is ClientNode => node !== undefined),
      nextCursor: page.nextCursor,
    });
  }

  /**
   * Match-context snippet around the densest query-term cluster in one node's
   * indexed plaintext — the results panels' excerpt. Null when
   * the node is unknown or carries no match. Sync like the other cached reads.
   */
  getSearchSnippet(
    nodeId: string,
    query: string,
    opts?: { maxTokens?: number; ellipsis?: string } | null,
  ): SearchSnippetData | null {
    return this.store.getSearchSnippet(nodeId, query, opts ?? undefined);
  }

  /**
   * Name→id resolution: the local twin of GET /api/resolve —
   * case-insensitive EXACT display-name match over the ranked FTS candidates
   * (blocks included). An exact case-insensitive ALIAS VALUE is a
   * name-equivalent — the candidate pool already folds alias text into the
   * FTS row (text-scalar indexing), so resolution follows search semantics.
   * An alias page's own title resolves to the ALIAS page (links keep the
   * alias uuid — navigation redirects to the terminal; the server /resolve
   * answers the terminal for API consumers). Null when no active node
   * carries the name or alias.
   */
  resolveNodeByName(name: string): string | null {
    const wanted = name.toLowerCase();
    for (const hit of this.store.search(name, 100)) {
      const node = this.getNode(hit.nodeId);
      if (node === undefined) continue;
      if ((deriveDisplayName(node) || "").toLowerCase() === wanted) return node.id;
      if (this.nameEquivalentsOf(node.id).some((alias) => alias.toLowerCase() === wanted)) {
        return node.id;
      }
    }
    return null;
  }

  /**
   * Live-query bridge for `query` content tokens: validate the token's
   * serialized AST with @notees/query's fail-loud parser (unknown condition
   * types / versions throw InvalidQueryAstError — the view renders an
   * "invalid query" placeholder) and execute it against the local store. The
   * Store satisfies the query package's structural QueryStore interface, so
   * no mapping layer is needed. Rows come back as node summaries (id, name,
   * isClass/presentAsMain, parentId, createdAt) — enough for the result
   * list, the simple table, and the containing-node walk. ASTs carrying an
   * aggregation run through runAggregateAst instead.
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
      rows: result.rows.map((row) => {
        const node = this.getNode(String(row.id));
        return {
          id: String(row.id),
          // Title-is-content: the summary name derives from the node's
          // content (the retired name column is always null).
          name: node !== undefined ? deriveDisplayName(node) || null : null,
          isClass: row.is_class === 1,
          presentAsMain: row.present_as_main === 1,
          parentId: (row.parent_id as string | null) ?? null,
          createdAt: (row.created_at as string | null) ?? null,
        };
      }),
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
      .map((row) => this.mapNodeCached(row));
  }

  /**
   * Class effectiveColor: the class's own color, else the nearest ancestor
   * in the extends chain with a color (walked via class_extends edges).
   */
  effectiveClassColor(classId: string): string | null {
    const seen = new Set<string>();
    const queue = [classId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.getNode(current) ?? this.getNodeRaw(current);
      if (node !== undefined && node.color !== null && node.color !== "") {
        return node.color;
      }
      const parents = this.store.database
        .prepare("SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id")
        .all(current) as Array<{ parent_class_id: string }>;
      for (const parent of parents) queue.push(parent.parent_class_id);
    }
    return null;
  }

  /** Raw class-icon walk: the class's own icon, else the nearest ancestor
   * in the extends chain with an icon (same walk as effectiveClassColor).
   * No display-time default — the shared building block of the two
   * effective-icon resolvers below. */
  private classIconInChain(classId: string): string | null {
    const seen = new Set<string>();
    const queue = [classId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.getNode(current) ?? this.getNodeRaw(current);
      if (node !== undefined && node.icon !== null && node.icon !== "") {
        return node.icon;
      }
      const parents = this.store.database
        .prepare("SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id")
        .all(current) as Array<{ parent_class_id: string }>;
      for (const parent of parents) queue.push(parent.parent_class_id);
    }
    return null;
  }

  /** Class effectiveIcon: the raw chain walk, else the display-time default
   * DEFAULT_CLASS_ICON. The default is read-side only — the stored icon stays
   * empty until the user picks one. Never null. */
  effectiveClassIcon(classId: string): string {
    return this.classIconInChain(classId) ?? DEFAULT_CLASS_ICON;
  }

  /** Node effectiveIcon: the node's own icon, else the first assigned class's
   * chain icon (class order, mirroring effectiveNodeColor). The class default
   * does NOT leak into a node — an iconless classed page renders the page
   * default, not the class glyph. The final fallback is the render-state
   * display default (class → class glyph, document chrome → page glyph,
   * inline block → null, whose chrome is the bullet dot). */
  effectiveNodeIcon(
    node: Pick<ClientNode, "icon" | "classIds" | "isClass" | "presentAsMain" | "parentId">,
  ): string | null {
    if (node.icon !== null && node.icon !== undefined && node.icon !== "") return node.icon;
    for (const classId of node.classIds) {
      const icon = this.classIconInChain(classId);
      if (icon !== null) return icon;
    }
    return defaultIconFor(node);
  }

  /**
   * Node effectiveColor: the node's own color, else the first assigned
   * class's effectiveColor (class order). Drives link underlines and the
   * node-view accent border.
   */
  effectiveNodeColor(node: Pick<ClientNode, "color" | "classIds">): string | null {
    if (node.color !== null && node.color !== undefined && node.color !== "") return node.color;
    for (const classId of node.classIds) {
      const color = this.effectiveClassColor(classId);
      if (color !== null) return color;
    }
    return null;
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
   * node PLUS source-side containment roll-up (query-time traversal) —
   * outward links from inside the node's subtree (a block inside France
   * linking Paris references France by containment). Ordered direct first,
   * then containment by subtree depth. Each entry carries the breadcrumb of
   * its containing page (the actual linking block's chain) and a `kind`.
   * The section badge reads getBacklinkCount (direct only) — unchanged, so a
   * containment-heavy page shows a longer list than its badge number.
   * The node-alias roll-up unions in edges whose target is any page whose
   * alias-terminal is this node (the store's recursive read over
   * `aliased_node_id`; chains included) as `kind: "alias"` rows after the
   * direct and containment sets — the alias page's own view is unchanged
   * (it lists only its own edges; SCHEMA.md "Node aliases").
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
        verb: row.verb === null || row.verb === undefined ? null : String(row.verb),
      });
    }
    // Node-alias roll-up: an edge targeting an alias page of this node
    // references this node by alias — union the alias pages' DIRECT backlink
    // sets in (query-time over the derived edge index; no derived-schema
    // change — the alias enumeration rides the store's recursive read).
    // Sources already claimed by the direct/containment sets stay single-row
    // (one reference per source).
    for (const aliasId of this.aliasPageIdsOf(id)) {
      for (const edge of this.getBacklinks(aliasId)) {
        const sourceId = edge.sourceId;
        if (seen.has(sourceId)) continue;
        const source = this.getNode(sourceId);
        if (!source) continue;
        const entry = this.referenceEntry(source);
        if (entry === null) continue;
        // Same own-subtree exclusion as the direct set, relative to BOTH
        // this node and the alias: a link from inside this node's subtree to
        // its alias, or from inside the alias's subtree to the alias itself,
        // is content, not a reference.
        if (entry.containingPageId === id || entry.source.id === id) continue;
        if (entry.containingPageId === aliasId || entry.source.id === aliasId) continue;
        seen.add(sourceId);
        entries.push({ ...entry, kind: "alias", verb: edge.verb });
      }
    }
    return entries;
  }

  /**
   * References (the page's References tab): the distinct document-chrome
   * pages this node's subtree points AT — the outgoing mirror of
   * getLinkedReferences. A mention authored in a block under the node (or a
   * node-typed property value on it) whose target renders with document
   * chrome and is top-level or one of the node's own child pages; the store
   * filter keeps classes, inline blocks, deeper-nested pages and trashed
   * nodes out. One row per target, direct first (the store contract).
   */
  getReferences(id: string): ClientNode[] {
    const targets: ClientNode[] = [];
    for (const row of this.store.referencesWithRollup(id) as Array<Record<string, unknown>>) {
      const target = this.getNode(String(row.target_id));
      if (!target) continue;
      targets.push(target);
    }
    return targets;
  }

  /**
   * Eager References-tab count for the section-visibility rule (hide the
   * tab at 0). Unlike the linked-references badge — direct-only
   * node_stats, so that LIST can honestly outrun its number — this count
   * reads the same roll-up the list renders, one row per target, so the
   * badge and the rows cannot diverge. Cost: one subtree query per mount,
   * the accepted price (the unlinked-reference count pays a full FTS pass).
   */
  getReferenceCount(id: string): number {
    return (this.store.referencesWithRollup(id) as Array<Record<string, unknown>>).length;
  }

  /**
   * Unlinked references (document-chrome nodes only — inline blocks never
   * get this section): literal-text FTS matches of the node's display name
   * across the workspace, excluding the node itself and every node that
   * already links to it (the linked-references set).
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

  /** Source ids matching the node's name, minus itself and linked sources. */
  private unlinkedReferenceIds(id: string): string[] {
    const node = this.getNode(id);
    if (!node || !rendersWithDocumentChrome(node)) return [];
    // A source linking the node OR any of its alias pages is already linked
    // (the linked-references set rolls alias-targeted edges in — see
    // getLinkedReferences), so the unlinked list excludes both families.
    const linkedSources = new Set(this.getBacklinks(id).map((edge) => edge.sourceId));
    for (const aliasId of this.aliasPageIdsOf(id)) {
      for (const edge of this.getBacklinks(aliasId)) linkedSources.add(edge.sourceId);
    }
    // Name-equivalents: the display name AND every text alias value AND
    // every alias-page title each get a literal-text FTS pass (aliases are
    // names for search).
    const names = [deriveDisplayName(node), ...this.nameEquivalentsOf(id)].filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      for (const hit of this.store.search(name)) {
        if (hit.nodeId === id || linkedSources.has(hit.nodeId) || seen.has(hit.nodeId)) continue;
        seen.add(hit.nodeId);
        ids.push(hit.nodeId);
      }
    }
    return ids;
  }

  /**
   * Alias pages of `id`: every live document-chrome node whose alias-terminal
   * is this node (the store's recursive reverse-walk over `aliased_node_id` —
   * chains included). The page restriction is the client convention
   * (SCHEMA.md "Node aliases"): non-page carriers don't act as aliases, so
   * they filter out here.
   */
  private aliasPageIdsOf(id: string): string[] {
    const ids: string[] = [];
    for (const aliasId of this.store.aliasNodesOf(id)) {
      const alias = this.getNode(aliasId);
      if (alias === undefined || !rendersWithDocumentChrome(alias)) continue;
      ids.push(aliasId);
    }
    return ids;
  }

  /**
   * Every node whose alias-terminal is `id` (the aliases listing behind the
   * title-row affordance): live ids from the store's recursive read, mapped
   * to nodes. The main page itself never lists.
   */
  aliasNodesOf(id: string): ClientNode[] {
    const nodes: ClientNode[] = [];
    for (const aliasId of this.store.aliasNodesOf(id)) {
      const alias = this.getNode(aliasId);
      if (alias === undefined || !rendersWithDocumentChrome(alias)) continue;
      nodes.push(alias);
    }
    return nodes;
  }

  /**
   * The terminal of a node-alias chain (SCHEMA.md "Node aliases"): the id
   * unchanged when the node is not an alias / the chain is cyclic; otherwise
   * the final main node. The navigation seam — the App open funnels resolve
   * every open through this read, so mentions, links, palette rows,
   * breadcrumbs and graph clicks all land on the terminal.
   */
  resolveAlias(id: string): string {
    return this.store.resolveAlias(id);
  }

  /**
   * The node's name-equivalents: every text alias value plus the title of
   * every alias page of the node — an alias page's title names its main page
   * for search (resolve + unlinked references).
   */
  private nameEquivalentsOf(id: string): string[] {
    const names = aliasValuesOf(this, id);
    for (const aliasId of this.aliasPageIdsOf(id)) {
      const alias = this.getNode(aliasId);
      if (alias === undefined) continue;
      const title = deriveDisplayName(alias);
      if (title !== null && title.trim() !== "") names.push(title);
    }
    return names;
  }

  /**
   * Direct main children (Revision 11: is_class = 0 AND present_as_main = 1
   * — the parent's main-children zone, the Pages section's rows; inline
   * body blocks and classes never appear here).
   */
  getChildPages(id: string): ClientNode[] {
    return this.store
      .children(id)
      .filter((row) => row.is_class === 0 && row.present_as_main === 1 && row.is_active === 1)
      .map((row) => this.mapNodeCached(row));
  }

  /**
   * Materialized backlink count (node_stats) — the linked-references badge.
   * DIRECT edges only (targeting the node itself): containment roll-up rows
   * and issue #7 node-alias roll-up rows lengthen the linked-references LIST
   * without moving this number — the same accepted badge-vs-list divergence
   * the containment roll-up documented (see getLinkedReferences).
   */
  getBacklinkCount(id: string): number {
    const row = this.store.database
      .prepare("SELECT backlink_count AS n FROM node_stats WHERE node_id = ?")
      .get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Feature-toggle read — absent row means enabled (default on). */
  isFeatureEnabled(feature: WorkspaceFeature): boolean {
    return this.store.isFeatureEnabled(this.workspaceId, feature);
  }

  /** Toggled feature rows only (untoggled features are absent, not listed). */
  listFeatureRows(): Array<{ feature: string; enabled: boolean }> {
    return this.store.listFeatureRows(this.workspaceId);
  }

  /** Active instance count across the feature's managed classes (the F3 disable confirmation). */
  getFeatureInstanceCount(feature: WorkspaceFeature): number {
    return this.store.featureInstanceCount(this.workspaceId, feature);
  }

  /** Write a feature toggle (workspace.feature.set, LWW by HLC). */
  async setFeatureEnabled(feature: WorkspaceFeature, enabled: boolean): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "workspace.feature.set",
        { feature, enabled },
        [],
      ),
    );
  }

  /** Direct main-child count (cheap child-order read) — the child-pages badge. */
  getChildPageCount(id: string): number {
    const row = this.store.database
      .prepare(
        `SELECT COUNT(*) AS n FROM node_child_order o
         JOIN node n ON n.id = o.child_id
         WHERE o.parent_id = ? AND n.is_class = 0 AND n.present_as_main = 1 AND n.is_active = 1`,
      )
      .get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Breadcrumb row for a reference: the source plus its containing main
   * node — the nearest ancestor matching the document-chrome predicate
   * (non-class, parentless or present-as-main; the source itself when it
   * already matches).
   */
  private referenceEntry(source: ClientNode): ReferenceEntry {
    let current = source;
    for (
      let guard = 0;
      !rendersWithDocumentChrome(current) && current.parentId !== null && guard < 64;
      guard += 1
    ) {
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
      // Unlinked references match literal text, not an edge — no verb.
      verb: null,
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

  /**
   * The single local-write seam: every envelope this client authors
   * funnels through here. The inverse intent is captured BEFORE the apply
   * (the pre-op snapshot), the envelope then applies + enters the outbox
   * exactly like any write, and only a successful apply is journaled — a
   * throwing apply never reaches the outbox, so it never reaches the journal.
   * `mode` journals the application to the opposite stack while undo/redo
   * runs (the standard model: undoing is itself journaled, on the redo side);
   * `verbOverride` relabels those entries with the original gesture's verb
   * ("Redo delete", not "Redo restore").
   */
  private enqueueLocal(
    envelope: Envelope,
    mode: UndoRecordMode = "normal",
    verbOverride?: string,
  ): void {
    const prepared = this.undoJournal.prepare(envelope);
    const summary = this.requireEngine().enqueue(envelope);
    this.undoJournal.commit(prepared, mode, verbOverride);
    this.notify({
      affectedNodeIds: summary.affectedNodeIds,
      structural: isListingAffectingEnvelope(envelope),
    });
    this.kickPush();
  }

  // --- undo journal -------------------------------------------------------------

  /** The pre-apply read seam behind the journal — pure store reads (see undo-journal.ts). */
  private buildUndoCaptureSource(): UndoCaptureSource {
    const db = () => this.store.database;
    const parseJson = (raw: string | null | undefined): unknown => {
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const stringList = (raw: string | null | undefined): string[] => {
      const parsed = parseJson(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    };
    const nullableBool = (raw: unknown): boolean | null =>
      raw === null || raw === undefined ? null : raw === 1 || raw === true;
    return {
      nodeSnapshot: (id) => {
        const row = this.store.getNode(id);
        if (row === undefined) return null;
        return {
          presentAsMain: row.present_as_main === 1,
          icon: row.icon,
          color: row.color,
          contentAst: parseContentAst(row.content),
          classIds: stringList(row.class_ids),
          tagIds: stringList(row.tag_ids),
          active: row.is_active === 1,
        };
      },
      nodePlacement: (id) => {
        const row = this.store.getNode(id);
        if (row === undefined) return null;
        if (row.parent_id === null) {
          return { parentId: null, afterId: null, beforeId: null };
        }
        const siblings = db()
          .prepare(
            "SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position",
          )
          .all(row.parent_id) as Array<{ child_id: string }>;
        const ids = siblings.map((sibling) => sibling.child_id);
        const index = ids.indexOf(id);
        return {
          parentId: row.parent_id,
          afterId: index > 0 ? ids[index - 1]! : null,
          beforeId: index >= 0 && index < ids.length - 1 ? ids[index + 1]! : null,
        };
      },
      classDescription: (classId) => {
        const row = db()
          .prepare("SELECT description FROM class WHERE id = ?")
          .get(classId) as { description: string | null } | undefined;
        return row?.description ?? null;
      },
      propertyValue: (objectId, propertySchemaId, elementId, idx) => {
        const rowId = elementId ?? `${objectId}:${propertySchemaId}:${idx}`;
        const row = db()
          .prepare(
            "SELECT id, idx, value, metadata FROM property_value WHERE id = ?",
          )
          .get(rowId) as
          | { id: string; idx: number; value: string; metadata: string | null }
          | undefined;
        if (row === undefined) return null;
        const metadata = parseJson(row.metadata);
        return {
          elementId: row.id,
          idx: row.idx,
          value: parseJson(row.value),
          metadata:
            typeof metadata === "object" && metadata !== null
              ? (metadata as Record<string, unknown>)
              : null,
        };
      },
      classBinding: (classId, propertySchemaId) => {
        const row = db()
          .prepare(
            `SELECT sequence, required, default_value, active
             FROM class_property WHERE class_id = ? AND property_schema_id = ?`,
          )
          .get(classId, propertySchemaId) as
          | {
              sequence: number;
              required: number | null;
              default_value: string | null;
              active: number;
            }
          | undefined;
        if (row === undefined) return null;
        return {
          sequence: row.sequence,
          required: nullableBool(row.required),
          defaultValue: row.default_value === null ? undefined : parseJson(row.default_value),
          active: row.active !== 0,
        };
      },
      classParents: (classId) =>
        (
          db()
            .prepare(
              "SELECT parent_class_id FROM class_extends WHERE class_id = ? ORDER BY parent_class_id",
            )
            .all(classId) as Array<{ parent_class_id: string }>
        ).map((row) => row.parent_class_id),
      schemaSnapshot: (propertySchemaId) => {
        const row = db()
          .prepare(
            `SELECT name, type, multi, scope, options, target_class_filter, date_precision, date_qualified,
                    display, readonly, hide_when_empty
             FROM property_schema WHERE id = ?`,
          )
          .get(propertySchemaId) as
          | {
              name: string;
              type: string;
              multi: number;
              scope: string;
              options: string;
              target_class_filter: string | null;
              date_precision: string | null;
              date_qualified: number | null;
              display: string | null;
              readonly: number | null;
              hide_when_empty: number | null;
            }
          | undefined;
        if (row === undefined) return null;
        const filter = parseJson(row.target_class_filter);
        return {
          name: row.name,
          type: row.type,
          multi: row.multi === 1,
          scope: row.scope,
          options: parseJson(row.options),
          targetClassFilter: Array.isArray(filter)
            ? filter.filter((v): v is string => typeof v === "string")
            : null,
          datePrecision: row.date_precision,
          dateQualified: nullableBool(row.date_qualified),
          display: row.display === "bullet" || row.display === "inline" ? row.display : null,
          readonly: nullableBool(row.readonly),
          hideWhenEmpty: nullableBool(row.hide_when_empty),
        };
      },
      assetSnapshot: (objectId, assetId) => {
        const row = db()
          .prepare(
            `SELECT asset_id, hash, mime_type, size, original_name FROM node_asset
             WHERE node_id = ? AND asset_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
          )
          .get(objectId, assetId) as
          | {
              asset_id: string;
              hash: string;
              mime_type: string;
              size: number;
              original_name: string;
            }
          | undefined;
        if (row === undefined) return null;
        return {
          assetId: row.asset_id,
          hash: row.hash,
          mimeType: row.mime_type,
          size: row.size,
          originalName: row.original_name,
        };
      },
      collectionMembership: (collectionId, objectId) => {
        const row = db()
          .prepare(
            "SELECT present FROM collection_member WHERE collection_id = ? AND object_id = ?",
          )
          .get(collectionId, objectId) as { present: number } | undefined;
        return row !== undefined && row.present === 1;
      },
      featureEnabled: (feature) => {
        const row = db()
          .prepare(
            "SELECT enabled FROM workspace_feature WHERE workspace_id = ? AND feature = ?",
          )
          .get(this.workspaceId, feature) as { enabled: number } | undefined;
        // Absent row = enabled (the empty-table default).
        return row === undefined || row.enabled === 1;
      },
    };
  }

  /**
   * The session journal state for chrome (keymap gating, palette
   * rows): availability plus the "Undo <verb>" / "Redo <verb>" labels. Async
   * to match the WorkerClient proxy (the union type is what App consumes).
   */
  async undoState(): Promise<UndoUiState> {
    return this.engine === null
      ? { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
      : this.undoJournal.state();
  }

  /**
   * The browsable history behind the jump-to menu: the undo stack
   * oldest-first with labels + timestamps + affected node ids. Empty when
   * the journal is (new session, new workspace).
   */
  async undoHistory(): Promise<UndoHistoryEntry[]> {
    return this.engine === null ? [] : this.undoJournal.history();
  }

  /**
   * Undo the most recent journaled local write: the captured inverses are
   * composed into fresh envelopes and applied through the normal write path,
   * journaled on the redo side (batched into ONE redo entry per gesture, and
   * relabeled with the original verb so the chrome reads "Redo delete").
   * Returns false when the journal is empty; a failed apply restores the
   * entry (unspent) and rethrows — undo never half-consumes a journal entry
   * silently (the inverses that did apply stay journaled on the redo side).
   */
  async undo(): Promise<boolean> {
    const entry = this.undoJournal.takeUndo();
    if (entry === null) return false;
    try {
      this.undoJournal.batch(() => {
        for (const spec of entry.inverseSpecs) {
          this.enqueueLocal(
            this.buildEnvelope(spec.opType, spec.payload, spec.affected),
            "undo",
            entry.verb,
          );
        }
      });
    } catch (error) {
      this.undoJournal.restoreUndo(entry);
      throw error;
    }
    return true;
  }

  /**
   * Redo the most recently undone entry: the redo entry's inverseSpecs are
   * the original gesture's ops (captured when the undo applied), so redo —
   * the mirror of undo — applies the popped entry's inverseSpecs through the
   * normal write path, journaled on the undo side under the same verb.
   */
  async redo(): Promise<boolean> {
    const entry = this.undoJournal.takeRedo();
    if (entry === null) return false;
    try {
      this.undoJournal.batch(() => {
        for (const spec of entry.inverseSpecs) {
          this.enqueueLocal(
            this.buildEnvelope(spec.opType, spec.payload, spec.affected),
            "redo",
            entry.verb,
          );
        }
      });
    } catch (error) {
      this.undoJournal.restoreRedo(entry);
      throw error;
    }
    return true;
  }

  /** Test/dev seam: how many entries the session journal currently holds. */
  undoDepth(): { undo: number; redo: number } {
    return { undo: this.undoJournal.undoDepth(), redo: this.undoJournal.redoDepth() };
  }

  /** Create an object; returns its id. Applied locally, push kicked off. */
  async createObject(partial: CreateObjectInput): Promise<string> {
    const id = partial.id ?? uuidv7();
    const payload: Record<string, unknown> = { objectId: id };
    if (partial.presentAsMain !== undefined) payload.presentAsMain = partial.presentAsMain;
    if (partial.classIds !== undefined) payload.classIds = partial.classIds;
    if (partial.tagIds !== undefined) payload.tagIds = partial.tagIds;
    // Title-is-content: the protocol has no object `name`. The `name`
    // convenience becomes the node's initial text content (a single text
    // token), so callers can keep naming pages at creation.
    const initialText = partial.name !== undefined && partial.contentAst === undefined
      ? [{ type: "text", text: partial.name }]
      : undefined;
    if (initialText !== undefined) payload.contentAst = initialText;
    if (partial.contentAst !== undefined) payload.contentAst = partial.contentAst;
    if (partial.parentId !== undefined) payload.parentId = partial.parentId;
    if (partial.afterId !== undefined) payload.afterId = partial.afterId;
    if (partial.beforeId !== undefined) payload.beforeId = partial.beforeId;
    this.enqueueLocal(this.buildEnvelope("object.create", payload, [id]));
    return id;
  }

  /** Update object fields (object.update; at least one field required). */
  async updateObject(id: string, fields: UpdateObjectInput): Promise<void> {
    const payload: Record<string, unknown> = { objectId: id };
    if (fields.presentAsMain !== undefined) payload.presentAsMain = fields.presentAsMain;
    if (fields.contentAst !== undefined) payload.contentAst = fields.contentAst;
    if (fields.icon !== undefined) payload.icon = fields.icon;
    if (fields.color !== undefined) payload.color = fields.color;
    if (fields.coverAssetId !== undefined) payload.coverAssetId = fields.coverAssetId;
    if (fields.bannerAssetId !== undefined) payload.bannerAssetId = fields.bannerAssetId;
    if (fields.aliasedNodeId !== undefined) payload.aliasedNodeId = fields.aliasedNodeId;
    this.enqueueLocal(this.buildEnvelope("object.update", payload, [id]));
  }

  /** Trash (default) or permanently delete an object and its subtree. */
  async deleteObject(id: string, opts: DeleteObjectOptions = {}): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "object.delete",
        { objectId: id, permanent: opts.permanent ?? false },
        [id],
      ),
    );
  }

  /**
   * Reparent a node (outliner indent/outdent gesture) — issues `object.move`.
   * `parentId` null means workspace root — legal for any non-class node (a
   * parentless node simply renders with document chrome; only a class under
   * a parent violates the store's placement CHECK). Pass `afterId` to land
   * the node immediately after that sibling in the parent's child order
   * (Enter placement); omit it to append at the end (Tab indent). Applied
   * locally, push kicked off.
   */
  async moveObject(
    id: string,
    parentId: string | null,
    afterId?: string,
    beforeId?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = { objectId: id, parentId };
    if (afterId !== undefined) payload.afterId = afterId;
    if (beforeId !== undefined) payload.beforeId = beforeId;
    this.enqueueLocal(this.buildEnvelope("object.move", payload, [id]));
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
  /**
   * User-defined class ORDER (class.reorder, display-only LWW): writes the
   * full ordered member list; the applier keeps ordered members first and
   * appends any unlisted members sorted by id.
   */
  async reorderClasses(id: string, classIds: string[]): Promise<void> {
    this.enqueueLocal(this.buildEnvelope("class.reorder", { objectId: id, classIds }, [id]));
  }

  async unassignClass(id: string, classId: string): Promise<void> {
    const node = this.getNode(id) ?? this.getNodeRaw(id);
    if (!node) throw new Error(`unassignClass: node ${id} not found`);
    if (!node.classIds.includes(classId)) return;
    // Owner rule: authored values that merely MIRROR the departing
    // class's binding defaults carry no user data — the user never put
    // anything in that property. Sweep them (unset envelopes, explicit ops —
    // every client converges) before the membership remove. The provenance
    // flag (owner directive — value metadata, wire-neutral) makes
    // the call EXACT where present:
    //   metadata.provenance === "system" → the system materialized it —
    //     sweep even when it differs from the default;
    //   metadata.provenance === "user"   → the user explicitly wrote it —
    //     NEVER sweep, even when it equals the default;
    //   absent (legacy data)             → the original mirror heuristic.
    const bindings = this.getClassBindings(classId);
    if (bindings.length > 0) {
      const authored = this.getEffectiveProperties(id).filter((row) => row.source === "authored");
      for (const binding of bindings) {
        const defaultJson = JSON.stringify(binding.defaultValue ?? null);
        for (const row of authored) {
          if (row.propertySchemaId !== binding.propertySchemaId) continue;
          const provenance =
            typeof row.metadata?.provenance === "string" ? row.metadata.provenance : null;
          const mirrorsDefault =
            JSON.stringify(row.value) === defaultJson &&
            binding.defaultValue !== null &&
            binding.defaultValue !== undefined;
          const sweep =
            provenance === "system" ? true : provenance === "user" ? false : mirrorsDefault;
          if (!sweep) continue;
          const payload: Record<string, unknown> = {
            objectId: id,
            propertySchemaId: binding.propertySchemaId,
          };
          // PG5: unset by element id when the row carries a writer-minted
          // UUID element; the deterministic composite (node:schema:idx) is
          // not uuid-shaped — those rows unset by idx.
          if (
            typeof row.elementId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.elementId)
          ) {
            payload.elementId = row.elementId;
          } else {
            payload.idx = row.idx;
          }
          this.enqueueLocal(this.buildEnvelope("property.unset", payload, [id]));
        }
      }
    }
    this.enqueueLocal(this.buildEnvelope("class.unassign", { objectId: id, classId }, [id]));
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
    this.enqueueLocal(this.buildEnvelope("tag.unassign", { objectId: id, tagId }, [id]));
  }

  /**
   * Create a class (class.create: node row + class registry row — the
   * registry row is what keeps the extends closure rebuild authoritative).
   * The store seeds the hierarchy self-row at create time, so no setExtends
   * is needed for a class that never extends anything.
   * Returns the new class id. Applied locally, push kicked off.
   */
  async createClass(
    name: string,
    opts?: { icon?: string; color?: string; id?: string },
  ): Promise<string> {
    // Caller-chosen id (the object.create pattern): system authoring
    // (ensureTaskFamily) creates the task class at its reserved seed id.
    const id = opts?.id ?? uuidv7();
    // Title-is-content: the class's name becomes its (text-only) content.
    const payload: Record<string, unknown> = {
      classId: id,
      contentAst: [{ type: "text", text: name }],
    };
    if (opts?.icon !== undefined) payload.icon = opts.icon;
    if (opts?.color !== undefined) payload.color = opts.color;
    this.enqueueLocal(this.buildEnvelope("class.create", payload, [id]));
    return id;
  }

  /**
   * Replace a class's full extends parent set (class.setExtends — m2m,
   * replace semantics; an empty array detaches all parents). The store keeps
   * the transitive closure in sync and fails loud on cycles (CycleError),
   * which callers surface as a transient message.
   */
  async setClassExtends(classId: string, parentClassIds: string[]): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "class.setExtends",
        { classId, parentClassIds },
        [classId, ...parentClassIds],
      ),
    );
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
    const payload: Record<string, unknown> = { classId, propertySchemaId };
    if (fields.sequence !== undefined) payload.sequence = fields.sequence;
    if (fields.required !== undefined) payload.required = fields.required;
    if (fields.defaultValue !== undefined) payload.defaultValue = fields.defaultValue;
    if (fields.active !== undefined) payload.active = fields.active;
    this.enqueueLocal(this.buildEnvelope("class.property.set", payload, [classId]));
  }

  /** Remove a class → property-schema binding (class.property.unset). */
  async unsetClassProperty(classId: string, propertySchemaId: string): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "class.property.unset",
        { classId, propertySchemaId },
        [classId],
      ),
    );
  }

  /**
   * Create a property schema (propertySchema.create); returns the new id.
   * The bindings picker's "+ new schema" path.
   */
  async createPropertySchema(input: CreatePropertySchemaInput): Promise<string> {
    const id = input.id ?? uuidv7();
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
    this.enqueueLocal(this.buildEnvelope("propertySchema.create", payload, []));
    return id;
  }

  /**
   * Patch a property schema's metadata (propertySchema.update): name/options
   * plus the SCHEMA.md "Dates" fields (the Class View bindings editor's
   * precision/qualified controls). Omitted fields keep their values.
   */
  async updatePropertySchema(propertySchemaId: string, fields: UpdatePropertySchemaInput): Promise<void> {
    const payload: Record<string, unknown> = { propertySchemaId };
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.options !== undefined) payload.options = fields.options;
    if (fields.datePrecision !== undefined) payload.datePrecision = fields.datePrecision;
    if (fields.dateQualified !== undefined) payload.dateQualified = fields.dateQualified;
    if (fields.numberPad !== undefined) payload.numberPad = fields.numberPad;
    if (fields.numberDecimals !== undefined) payload.numberDecimals = fields.numberDecimals;
    if (fields.numberRounding !== undefined) payload.numberRounding = fields.numberRounding;
    if (fields.display !== undefined) payload.display = fields.display;
    if (fields.readonly !== undefined) payload.readonly = fields.readonly;
    if (fields.hideWhenEmpty !== undefined) payload.hideWhenEmpty = fields.hideWhenEmpty;
    this.enqueueLocal(this.buildEnvelope("propertySchema.update", payload, []));
  }

  /**
   * Soft-delete a property schema (propertySchema.delete — the conversion
   * flow's final step). Authored values under the schema survive
   * in the log; recreate-under-the-same-id reactivates (the applier upsert).
   */
  async deletePropertySchema(propertySchemaId: string): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope("propertySchema.delete", { propertySchemaId }, []),
    );
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
    const payload: Record<string, unknown> = { objectId, propertySchemaId, value, idx };
    if (metadata !== undefined) payload.metadata = metadata;
    this.enqueueLocal(this.buildEnvelope("property.set", payload, [objectId]));
  }

  /** Clear an authored property value (property.unset) — the default resurfaces. */
  async unsetProperty(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    this.enqueueLocal(
      this.buildEnvelope(
        "property.unset",
        { objectId, propertySchemaId, idx },
        [objectId],
      ),
    );
  }

  /**
   * "Promote to block" (SCHEMA.md "Node-backed text properties"): detach a
   * node-backed text property value and surface the carrier in the owner's
   * body as an ordinary child. Composed from existing ops — property.unset
   * (whose applier trashes the now-unreferenced carrier, trash + retention
   * per the spec) followed by object.restore (revives the carrier subtree as
   * a body child; a safe no-op when the unset left it alive, e.g. another
   * slot still references it). Display state only: no move op — the carrier
   * keeps its tree position and renders in the body once no value references
   * it. Fails loud when the slot holds no authored value or the value is not
   * a node-backed reference.
   */
  async promotePropertyCarrier(objectId: string, propertySchemaId: string, idx = 0): Promise<void> {
    const row = this.store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
      )
      .get(objectId, propertySchemaId, idx) as { value: string } | undefined;
    if (row === undefined) {
      throw new Error(
        `promotePropertyCarrier: no authored value at ${propertySchemaId}:${idx} on ${objectId}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = undefined;
    }
    const carrier =
      typeof parsed === "object" && parsed !== null && "nodeId" in parsed
        ? String((parsed as { nodeId: unknown }).nodeId)
        : typeof parsed === "string" && UUID_LIKE.test(parsed)
          ? parsed
          : null;
    if (carrier === null) {
      throw new Error(
        `promotePropertyCarrier: value at ${propertySchemaId}:${idx} is not a node-backed carrier reference`,
      );
    }
    // One gesture, two envelopes: journal them as a single entry (the unset
    // and the restore undo together, in reverse).
    this.undoJournal.batch(() => {
      this.enqueueLocal(
        this.buildEnvelope("property.unset", { objectId, propertySchemaId, idx }, [objectId]),
      );
      this.enqueueLocal(
        this.buildEnvelope("object.restore", { objectId: carrier }, [objectId, carrier]),
      );
    });
  }

  // --- dates (SCHEMA.md "Dates" — a date is a node, not a string) --------------

  /** The schema's date precision (default day when the row predates the field). */
  private datePrecisionOf(propertySchemaId: string): DatePrecision {
    const schema = this.listPropertySchemas().find((s) => s.id === propertySchemaId);
    return schema?.datePrecision ?? "day";
  }

  /**
   * Ensure the year/month/day node chain for an ISO date exists (journal
   * layout: year as a workspace-root page, month under year, day under month,
   * named by the compact labels) and return the three deterministic ids.
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
        presentAsMain: true,
        parentId: null,
        name: dateNodeLabel(parts, "year"),
        classIds: [SYSTEM_CLASS_UUIDS.year],
      });
    }
    if (this.getNodeRaw(ids.month) === undefined) {
      await this.createObject({
        id: ids.month,
        presentAsMain: true,
        parentId: ids.year,
        name: dateNodeLabel(parts, "month"),
        classIds: [SYSTEM_CLASS_UUIDS.month],
      });
    }
    if (this.getNodeRaw(ids.day) === undefined) {
      await this.createObject({
        id: ids.day,
        presentAsMain: true,
        parentId: ids.month,
        name: dateNodeLabel(parts, "day"),
        classIds: [SYSTEM_CLASS_UUIDS.day],
      });
    }
    // Heal the chain parentage AND labels: older writers created chain nodes
    // parentless and with ISO-dashed content ("2026-10-05"); the stored label
    // must be the compact form ("20261005" — the lookup/sort contract), so
    // an existing-but-wrong level is rewritten, idempotently — one op per
    // stray, only while it actually differs.
    const healLevel = async (
      id: string,
      parentId: string | null,
      precision: "year" | "month" | "day",
    ): Promise<void> => {
      const node = this.getNodeRaw(id);
      if (node === undefined) return;
      if ((node.parentId ?? null) !== parentId) {
        await this.moveObject(id, parentId);
      }
      const label = dateNodeLabel(parts, precision);
      const first = node.contentAst[0];
      const text =
        first !== undefined && (first as { type?: unknown }).type === "text"
          ? String((first as { text?: unknown }).text ?? "")
          : "";
      if (text !== label) {
        await this.updateObject(id, { contentAst: [{ type: "text", text: label }] });
      }
    };
    await healLevel(ids.year, null, "year");
    await healLevel(ids.month, ids.year, "month");
    await healLevel(ids.day, ids.month, "day");
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

  // --- per-user UI prefs (favorites/recents — server-side UI state) -------------

  /**
   * GET /api/me/prefs (session or API-key credential). On success the local
   * cache is refreshed so device-local readers (sidebar lists, palette
   * Recent) see the same source. Offline/unreachable (or a client without
   * REST config): the cached copy answers, tagged `source: "local"`.
   */
  async getPrefs(): Promise<UserPrefs & { source: UserPrefsSource }> {
    if (this.restServerUrl !== null && this.restApiKey !== null) {
      try {
        const response = await fetch(`${this.restServerUrl.replace(/\/$/, "")}/api/me/prefs`, {
          headers: { "X-API-Key": this.restApiKey },
        });
        if (response.ok) {
          const prefs = normalizeUserPrefs(await response.json());
          writeDevicePrefList("favorites", prefs.favorites);
          writeDevicePrefList("recents", prefs.recents);
          return { ...prefs, source: "server" };
        }
      } catch {
        // Unreachable — the cached copy below is the honest offline answer.
      }
    }
    return {
      favorites: readDevicePrefList("favorites"),
      recents: readDevicePrefList("recents"),
      source: "local",
    };
  }

  /**
   * PUT /api/me/prefs (merge patch; each present list replaces wholesale).
   * The local cache updates first — optimistic and honest offline: when the
   * server cannot be reached the write persists device-locally and the next
   * successful call syncs it. Resolves `source: "server" | "local"`.
   */
  async patchPrefs(patch: PrefsPatch): Promise<UserPrefs & { source: UserPrefsSource }> {
    const merged: UserPrefs = {
      favorites: patch.favorites ?? readDevicePrefList("favorites"),
      recents: patch.recents ?? readDevicePrefList("recents"),
    };
    if (patch.favorites !== undefined) writeDevicePrefList("favorites", patch.favorites);
    if (patch.recents !== undefined) writeDevicePrefList("recents", patch.recents);
    if (this.restServerUrl !== null && this.restApiKey !== null) {
      try {
        const response = await fetch(`${this.restServerUrl.replace(/\/$/, "")}/api/me/prefs`, {
          method: "PUT",
          headers: { "X-API-Key": this.restApiKey, "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (response.ok) {
          const prefs = normalizeUserPrefs(await response.json());
          writeDevicePrefList("favorites", prefs.favorites);
          writeDevicePrefList("recents", prefs.recents);
          return { ...prefs, source: "server" };
        }
      } catch {
        // Unreachable — the local write above already landed.
      }
    }
    return { ...merged, source: "local" };
  }

  /**
   * Upload file bytes to the server's CAS asset store (POST /api/assets).
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
    this.enqueueLocal(
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
  }

  /**
   * Download an asset's bytes (GET /api/assets/:id, workspace key) — the raw
   * read the export engine's include-assets bundle uses (distinct from
   * downloadAsset, which opens a tab, and getAssetDataUrl, images only).
   */
  async fetchAssetBytes(assetId: string): Promise<Blob> {
    const { serverUrl, apiKey } = this.requireRest();
    return fetchAssetBlob(serverUrl, apiKey, assetId, this.workspaceId);
  }

  /**
   * Download an asset's bytes (GET /api/assets/:id, workspace key) and open
   * them in a new tab as a blob URL — the key stays out of any URL.
   */
  async downloadAsset(assetId: string): Promise<void> {
    const { serverUrl, apiKey } = this.requireRest();
    const blob = await fetchAssetBlob(serverUrl, apiKey, assetId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
  }

  /**
   * Property value history feed: paginated GET /api/operations
   * (the relay-log read), filtered client-side to property.* ops
   * for one node + schema, newest-first by HLC. The feed entries are
   * envelope-v3 objects — seq, hlc, actor, timestamp, payload — everything
   * the history modal renders. Throws when the feed is unreachable (the
   * modal renders the device-local note); bounded at 30 pages (300k
   * envelopes) so a huge log cannot hang the UI.
   */
  async fetchOperationsFor(
    objectId: string,
    propertySchemaId: string,
  ): Promise<OperationFeedEntry[]> {
    const { serverUrl, apiKey } = this.requireRest();
    const matches = (op: OperationFeedEntry): boolean =>
      (op.opType === "property.set" || op.opType === "property.unset") &&
      typeof op.payload === "object" &&
      op.payload !== null &&
      op.payload.objectId === objectId &&
      op.payload.propertySchemaId === propertySchemaId;
    const entries: OperationFeedEntry[] = [];
    let afterSeq = 0;
    for (let page = 0; page < 30; page++) {
      const url = `${serverUrl.replace(/\/$/, "")}/api/operations?afterSeq=${afterSeq}&limit=10000`;
      const response = await fetch(url, {
        headers: { "X-API-Key": apiKey, "X-Workspace-Id": this.workspaceId },
      });
      if (!response.ok) {
        throw new Error(`operations feed failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        operations: OperationFeedEntry[];
        nextAfterSeq: number;
        hasMore: boolean;
      };
      for (const op of body.operations) {
        if (matches(op)) entries.push(op);
      }
      if (!body.hasMore) break;
      afterSeq = body.nextAfterSeq;
    }
    entries.sort(
      (a, b) =>
        b.hlc.physical - a.hlc.physical ||
        b.hlc.logical - a.hlc.logical ||
        (a.seq < b.seq ? 1 : -1),
    );
    return entries;
  }

  /**
   * Push pending outbox ops now. Writes only kick a best-effort push; await
   * this when delivery must be deterministic (tests, "save & close"). The
   * engine's onPush/onPull callbacks notify with change-info — no wrapper
   * notify (an empty outbox changes nothing).
   */
  async push(): Promise<void> {
    await this.requireEngine().push();
  }

  /** Pull now: snapshot shortcut when newer, then seq catch-up. */
  async pull(): Promise<void> {
    await this.requireEngine().pull();
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
    // Engine status transitions reach subscribers, but a status flip is not
    // data churn: notify with an explicitly empty change set so the read
    // cache invalidates nothing (the footer re-reads status on the same
    // notification).
    const stopStatus = engine.subscribeStatus(() =>
      this.notify({ affectedNodeIds: [], structural: false }),
    );
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

  /** Recent semantic conflicts (newest last, bounded at CONFLICT_LOG_CAP). */
  conflictHistory(): ConflictHistoryEntry[] {
    return [...this.conflictLog];
  }

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
   * next pull re-fetches anything the batch covered. The notification carries
   * the batch's own change-info (the engine's onRemoteBatch callback fires
   * from inside onRemoteBatch only when no pull defers it — this wrapper
   * notify also covers the deferred and zero-applied paths).
   */
  applyRemoteBatch(envelopes: Envelope[], seqs?: Record<string, number> | null): void {
    this.requireEngine().onRemoteBatch(envelopes, seqs ?? {});
    const info = summarizeEnvelopes(envelopes);
    // Remote envelopes may carry incomplete affected metadata; when we can
    // infer nothing, fall back to the scope-unknown notification (full
    // invalidation) rather than silently refreshing nothing.
    if (info.affectedNodeIds.length === 0 && !info.structural) this.notify();
    else this.notifyFromInfo(info);
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

  /** Per-session monotonic counter; see ChangeNotification. */
  private revision = 0;

  subscribe(listener: (change: ChangeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The single notify funnel. Callers pass what they know:
   *
   *  - no argument — the change set is unknown (bootstrap, status/realtime
   *    wiring, manual sync wrappers): subscribers must treat everything as
   *    stale.
   *  - `{ affectedNodeIds, structural }` — one applied batch (local write,
   *    push/pull/remote summary): content-only edits stay scoped; a
   *    listing-affecting batch (or an oversized affected set) collapses to
   *    `structural: true`.
   *
   * Content scopes are ancestor-expanded here (a page-tree read of P
   * contains node X iff P is an ancestor of X), bounded by CHANGE_AFFECT_CAP.
   */
  private notify(change?: { affectedNodeIds?: string[]; structural?: boolean }): void {
    if (this.closed) return;
    this.listReadCache.clear();
    this.revision += 1;
    let payload: ChangeNotification = { revision: this.revision };
    if (change !== undefined && change.structural === true) {
      payload = { revision: this.revision, structural: true };
    } else if (change !== undefined) {
      const affected = this.expandAffectedAncestors(change.affectedNodeIds ?? []);
      if (affected.length > CHANGE_AFFECT_CAP) {
        payload = { revision: this.revision, structural: true };
      } else {
        // Explicit empty scope ("nothing is stale") — a bare {revision}
        // payload means scope-unknown and would invalidate everything.
        payload = { revision: this.revision, affectedNodeIds: affected, structural: false };
      }
    }
    for (const listener of this.listeners) listener(payload);
  }

  /**
   * Union of the given ids with their ancestor chains (parent pointers up to
   * the workspace root). Content edits invalidate a node and its ancestors;
   * descendants of the edited node are untouched by definition.
   */
  private expandAffectedAncestors(ids: string[]): string[] {
    const out = new Set<string>();
    for (const id of ids) {
      if (out.has(id)) continue;
      out.add(id);
      let current = this.store.getNode(id)?.parent_id ?? null;
      let hops = 0;
      while (current !== null && !out.has(current) && hops < 64) {
        out.add(current);
        hops += 1;
        current = this.store.getNode(current)?.parent_id ?? null;
      }
    }
    return [...out];
  }

  private notifyFromInfo(info: BatchChangeInfo | undefined): void {
    this.notify(
      info === undefined
        ? undefined
        : { affectedNodeIds: info.affectedNodeIds, structural: info.structural },
    );
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
