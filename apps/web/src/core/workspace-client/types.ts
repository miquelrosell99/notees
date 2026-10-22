/**
 * The workspace-client's public contract: wire-facing types, option bags,
 * and the small standalone write composer (createAnnotation) — everything
 * the class family and the UI import by name, with no runtime dependency
 * on the client itself.
 */

import initSqlJs, { type SqlJsStatic } from "sql.js";

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  type DatePrecision,
} from "@notees/domain";
import type { ContentAst, ListStyle, WorkspaceFeature } from "@notees/protocol";
import type { SyncConflict, SyncStatus, Transport } from "@notees/sync";

/** Sensible default depth cap for getBlockTree (cycle protection). */
export const DEFAULT_TREE_DEPTH = 64;

/** Bare-uuid test for the legacy carrier value shape (archived data). */
export const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default actor for the single-user client (overridable per client). */
export const DEFAULT_ACTOR_ID = "01920000-0000-7000-8000-0000000000a1";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

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

export const IDLE_SNAPSHOT: SyncStatusSnapshot = {
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
export const CONFLICT_LOG_CAP = 100;

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
export const CHANGE_AFFECT_CAP = 256;

export interface ClientNode {
  id: string;
  workspaceId: string;
  /** Class identity bit — the ONLY identity marker (classes are always roots). */
  isClass: boolean;
  /** Render bit for parented non-class nodes: true = the parent's
   * main-children zone + document chrome when zoomed; false = the inline
   * body + block chrome. Unread for parentless nodes and classes. */
  isEmbedded: boolean;
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
  /** The page subtitle in the core chrome (wire node field, store schema
   * v18) — plain text, null when unset. */
  description: string | null;
  /** Per-block list style (wire node field, store schema v23): the bullet
   * dot's replacement. Null = bullet (the default); the marker NUMBER is
   * derived at render time, never stored. */
  listStyle: ListStyle | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BlockTreeNode {
  node: ClientNode;
  children: BlockTreeNode[];
}

/** The parent node's render facts for the parent-page condition (owner
 *  ruling 2026-10-15) — undefined when the node is parentless or the
 *  parent row is not at hand (the store's write-time invariant covers
 *  that case). */
export type ParentRenderFacts =
  | Pick<ClientNode, "isClass" | "parentId" | "isEmbedded">
  | undefined;

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
  isEmbedded: boolean;
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
 * to a synthesized label at the call site. The binding carries the genuinely
 * PER-CLASS mechanic ONLY — the active soft-unbind flag (owner rulings
 * 2026-10-20/21: `required` retired outright, `defaultValue` moved to the
 * schema, `sequence` retired outright — class panels render alphabetically
 * by property name).
 */
export function mapClassBindingRow(row: Record<string, unknown>): ClassBinding {
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

/**
 * The schema's value-validation rules (SCHEMA.md "Class properties",
 * owner ruling 2026-10-20 — the v1 min/max/pattern port): `min`/`max` apply
 * to `number` schemas only, `pattern` to `text`/`url`/`email` only
 * (enforced at apply time against the stored type; values validate at
 * property.set). All members optional — an empty object is not written.
 */
export interface ClientValidationRules {
  min?: number;
  max?: number;
  pattern?: string;
}

/**
 * Editable fields of a class.property.set write (all optional — patch).
 * `active` is the only field left: the binding is a presence row + the
 * soft-unbind flag (owner rulings 2026-10-20/21 — `required` retired,
 * `defaultValue` moved to the schema, `sequence` retired: class panels
 * render alphabetically by property name).
 */
export interface SetClassPropertyInput {
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

/**
 * One trashed subtree root, as the Trash hub lists it: the node row (which
 * is inactive — every normal read filters it) plus its soft-delete stamp
 * from the derived `trash` table. Permanent deletes leave no entry (their
 * rows are `is_permanent = 1` tombstones with no node row behind them).
 */
export interface TrashedEntry {
  node: ClientNode;
  deletedAt: string;
}

/**
 * One archived node, as the Archived surface lists it (owner ruling
 * 2026-10-22, the classes-gallery batch): the inactive node row PLUS the
 * guarantee that it carries NO trash row — archival is a reversible STATE
 * (object.update {active}), distinct from deletion (the trash table). The
 * stamp is the node row's `updated_at` (the archival write bumps it).
 */
export interface ArchivedEntry {
  node: ClientNode;
  archivedAt: string;
}

/** Editable fields of a propertySchema.update write (all optional — patch).
 *  The owner-2026-10-20 fields ride the keep/clear contract: absent keeps
 *  the stored value, present-null clears (SCHEMA.md "Class properties"). */
export interface UpdatePropertySchemaInput {
  name?: string;
  /** The schema's icon (nullable MDI name); null clears. */
  icon?: string | null;
  /** The locality authority: null clears back to global (empty rejected). */
  scopeClassIds?: string[] | null;
  /** Node-typed target classes; null clears the filter. */
  targetClassFilter?: string[] | null;
  /** Values single/multiple; null clears back to single. */
  multi?: boolean | null;
  /** Value-validation rules; null clears. */
  validationRules?: ClientValidationRules | null;
  options?: ClientPropertyOption[];
  datePrecision?: DatePrecision;
  dateQualified?: boolean;
  /** SCHEMA.md "Number formats": absent keeps, null clears (display only). */
  numberPad?: number | null;
  numberDecimals?: number | null;
  numberRounding?: "round" | "floor" | "ceil" | "truncate" | null;
  /** The GLOBAL default (owner ruling 2026-10-20): absent keeps, null
   *  clears (PC2-typed at apply against the schema's stored type). */
  defaultValue?: unknown;
  /** The render contracts (PROPERTY-level): absent keeps, null clears.
   *  (`readonly` retired 2026-10-21 — derived from the system list via
   *  @notees/domain isReadonlyProperty, never stored.) */
  display?: PropertyDisplay | null;
  hideWhenEmpty?: boolean | null;
}

/** A property schema row as listed by the bindings picker's candidate set. */
export interface ClientPropertySchema {
  id: string;
  name: string;
  type: string;
  multi: boolean;
  /** The schema's icon (owner 2026-10-20); null = none. */
  icon: string | null;
  /** The SOLE locality authority (owner ruling 2026-10-20): null = global,
   *  a non-empty list = local to those classes + their extensions. */
  scopeClassIds: string[] | null;
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
  /** The render contracts (PROPERTY-level; null = panel / unset).
   *  (`readonly` retired 2026-10-21 — derived from the system list, not
   *  stored.) */
  display?: PropertyDisplay | null;
  hideWhenEmpty?: boolean | null;
  /** Value-validation rules (null = none). */
  validationRules?: ClientValidationRules | null;
  /** The GLOBAL default (owner ruling 2026-10-20): parsed JSON, null = none. */
  defaultValue: unknown | null;
}

/**
 * The unified datetime write (SCHEMA.md "Datetime"): one point or a range.
 * `iso` is a calendar day ("2026-09-27"); the write path ensures the
 * year/month/day chain and links the ref at the schema's precision. `time`
 * (a well-formed "HH:MM") rides only day-precision schemas — the write fails
 * loud otherwise. A null range side writes an open side.
 */
export interface DatetimePointInput {
  iso: string;
  time?: string;
}

export type DatetimeValueInput =
  | DatetimePointInput
  | { start: DatetimePointInput | null; end: DatetimePointInput | null };

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
  /** Locality (owner ruling 2026-10-20): omit/null = global; a non-empty
   *  class-id list scopes the schema to those classes + their extensions. */
  scopeClassIds?: string[];
  icon?: string;
  options?: ClientPropertyOption[];
  targetClassFilter?: string[];
  datePrecision?: DatePrecision;
  dateQualified?: boolean;
  /** The GLOBAL default (owner ruling 2026-10-20 — one default per
   *  property; PC2-typed at apply against the create payload's type). */
  defaultValue?: unknown;
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
    /** The render contracts (PROPERTY-level; null = panel / unset).
     *  (`readonly` retired 2026-10-21 — derived from the system list.) */
    display?: PropertyDisplay | null;
    hideWhenEmpty?: boolean | null;
  } | null;
  value: unknown;
  /** Authored qualifiers (date-node refs or legacy ISO strings). */
  metadata: Record<string, unknown> | null;
  source: "authored" | "default";
  boundBy: string | null;
  /** R4 (owner ruling 2026-10-20): false on authored rows whose schema's
   *  scopeClassIds excludes the node — the row SURVIVES (never retroactive)
   *  and callers render it honestly; derived defaults never materialize for
   *  ineligible nodes, so they always read true. */
  eligible: boolean;
  /** PROPERTY-level: the schema's render contracts — the same for
   *  every carrier, class-bound or not. (Readonly-ness derives from the
   *  system property list since the owner ruling 2026-10-21.) */
  hideWhenEmpty: boolean | null;
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
  isEmbedded?: boolean;
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
  isEmbedded?: boolean;
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
  /** The page subtitle in the core chrome (store schema v18). */
  description?: string | null;
  /** Per-block list style (store schema v23): null clears back to the
   * bullet default (the color keep/clear contract). */
  listStyle?: ListStyle | null;
  /**
   * Archival bit (owner ruling 2026-10-22, the classes-gallery batch):
   * false archives the node (a reversible state — it leaves every default
   * read, no trash row), true unarchives it. Locked system classes and
   * family bases refuse the archival direction (write-time guards).
   */
  active?: boolean;
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
    isEmbedded: false,
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
