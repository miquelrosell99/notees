/**
 * Object API (single-user surface, /api): nodes, classes, properties,
 * search, backlinks. Every write IS an envelope through the same pipeline as
 * /batch (the server stamps id/HLC/timestamp/actor from the API key) — one
 * write path, per the hard invariant.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import {
  classCreatePayload,
  classPropertySetPayload,
  classPropertyUnsetPayload,
  classUnassignPayload,
  colorValueSchema,
  objectCreatePayload,
  objectRestorePayload,
  objectUpdatePayload,
  propertySchemaCreatePayload,
  propertySchemaDeletePayload,
  propertySchemaUpdatePayload,
  propertySetPayload,
  propertyUnsetPayload,
  tagUnassignPayload,
} from "@notees/protocol";
import { deriveDisplayName, fullTitleOf, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { parseQueryAst, runAggregate, runQuery } from "@notees/query";
import { visiblePropertyValueRows, type NodeRow, type Store, planMerge, MergeGuardError } from "@notees/store";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { adsTokenFor } from "./routes-prefs.js";
import { resolvePdfSource, resolveSourceMetadata } from "./resolve-source.js";
import { requireUser } from "./routes-auth.js";

/**
 * Query-string booleans: only the strings "true"/"false" coerce (a bare
 * z.coerce.boolean() would turn the string "false" into true).
 */
const booleanQueryParam = z
  .union([z.literal("true"), z.literal("false")])
  .transform((value) => value === "true");

const listQuerySchema = z
  .object({
    /** Class identity bit filter (Revision 12 embedding model). */
    isClass: booleanQueryParam.optional(),
    /**
     * Embedding-flag filter: true selects the embedded body rows (parented
     * non-class nodes with the flag set — the Block role), false the
     * standalone rows (non-class roots plus standalone children — the Page
     * role).
     */
    isEmbedded: booleanQueryParam.optional(),
    class: z.string().uuid().optional(),
    /** Direct-children filter: parent_id equality. */
    parent: z.string().uuid().optional(),
    /** Trash listing: true selects inactive rows (trashed), false/omitted the
     * default active rows. Position-order reads use GET /objects/:id/children;
     * this filter is for scans and bulk audits. */
    trashed: booleanQueryParam.optional(),
    q: z.string().max(512).optional(),
    /**
     * Property filter `?property=<schemaId>:<value>` — exact match on the
     * JSON-encoded scalar stored in property_value (a string value matches
     * its JSON form, e.g. kuhn1962 ↔ "kuhn1962"). The value part is
     * everything after the FIRST colon (URLs contain colons).
     */
    property: z
      .string()
      .regex(/^[^:]+:.*$/s)
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().optional(),
  })
  .strict();

const propertyWriteBodySchema = z
  .object({
    propertySchemaId: z.string().uuid(),
    value: z.unknown(),
    idx: z.number().int().nonnegative().default(0),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const propertyDeleteQuerySchema = z
  .object({
    idx: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();

/** propertySchema.update body: the patch fields only (the id is the route param). */
const propertySchemaUpdateBodySchema = propertySchemaUpdatePayload
  .omit({ propertySchemaId: true })
  .refine((body) => Object.keys(body).length > 0, { message: "at least one field to update" });

/** class.property.set body: the patch fields + propertySchemaId (class id is the route param). */
const classPropertySetBodySchema = classPropertySetPayload
  .omit({ classId: true })
  .refine((body) => Object.keys(body).length > 1, { message: "at least one binding field to set" });

/** object merge body: the merge destination (SCHEMA.md "Node merge"). */
const mergeBodySchema = z.object({ targetId: z.string().uuid() }).strict();

const createBodySchema = z
  .object({
    /**
     * Revision 12 embedding model. `isClass: true` declares a class node — the
     * write becomes a class.create envelope (classes are always roots, so
     * parentId / classIds / isEmbedded must not accompany it). Otherwise
     * the write is object.create and `isEmbedded` sets the embedding flag
     * (applier default: false/standalone when parentless, true/embedded
     * when parented).
     */
    isClass: z.boolean().optional(),
    isEmbedded: z.boolean().optional(),
    /** Title-is-content: becomes the node's initial text content. */
    name: z.string().max(1024).optional(),
    contentAst: z.array(z.unknown()).optional(),
    classIds: z.array(z.string().uuid()).default([]),
    parentId: z.string().uuid().nullable().optional(),
    /** Caller-chosen id (deterministic content-addressed ids — the date
     * chain roots; the op payload has always accepted one). Defaults to a
     * fresh UUIDv7. A taken id fails loud with 409. */
    id: z.string().uuid().optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    /** Embedding-flag toggle: promotion/demotion between the standalone
     * Page role (isEmbedded: false) and the embedded Block role
     * (isEmbedded: true) under the parent. */
    isEmbedded: z.boolean().optional(),
    icon: z.string().max(64).optional(),
    /** Preset token or #RRGGBB hex; null clears (SCHEMA.md color grammar). */
    color: colorValueSchema.nullish(),
    contentAst: z.array(z.unknown()).optional(),
    /**
     * The wire node fields (SCHEMA.md "Node structure" — the icon/color
     * precedent): presence writes, null clears, exactly like the
     * `object.update` payload they forward into.
     */
    coverAssetId: z.string().uuid().nullable().optional(),
    bannerAssetId: z.string().uuid().nullable().optional(),
    aliasedNodeId: z.string().uuid().nullable().optional(),
    /**
     * optimistic-concurrency guard, HTTP-layer only (never
     * enters the op payload): the node's `hlc` as last seen by the caller.
     * The node row's (hlc_physical, hlc_logical) is the one natural
     * per-node revision (bumped by object.update/object.move); a stale
     * value fails 409 conflict. Other mutations have no natural revision
     * and deliberately offer no base check — see the OpenAPI
     * x-revision-checks extension.
     */
    baseRevision: z
      .object({
        physical: z.number().int().nonnegative(),
        logical: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "at least one field to update" });

const searchQuerySchema = z
  .object({
    q: z.string().min(1).max(512),
    isClass: booleanQueryParam.optional(),
    isEmbedded: booleanQueryParam.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    /**
     * Offset cursor from a previous response's `nextCursor` —
     * opaque to callers; anything not a decimal offset fails 422.
     */
    cursor: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

const resolveQuerySchema = z
  .object({
    /** The node's display name (title-is-content: the derived content title). */
    name: z.string().min(1).max(512),
  })
  .strict();

const deleteQuerySchema = z
  .object({
    permanent: z.coerce.boolean().default(false),
    confirm: z.string().optional(),
  })
  .strict();

const queryBodySchema = z
  .object({
    /** The versioned QueryAST (validated fail-loud by parseQueryAst). */
    ast: z.unknown(),
  })
  .strict();

export /**
 * Plan-07 ruling (controller-carried): a workspace with a workspace_key row
 * is encrypted — the server serves it NO content reads (they are client-side
 * over the local derived store). Keyless workspaces keep the reads for
 * CLI/legacy compat. Same gate as the seed shim (context.ts ensureSeeded).
 */
function assertContentReadsAllowed(ctx: ServerContext, workspaceId: string): void {
  if (ctx.auth.getWorkspaceKey(workspaceId) !== undefined) {
    throw new AppError(404, "not_found", "workspace is encrypted — content reads are client-side");
  }
}

export function workspaceFor(ctx: ServerContext, request: FastifyRequest): string {
  const header = request.headers["x-workspace-id"];
  if (typeof header === "string" && z.string().uuid().safeParse(header).success) {
    return header;
  }
  return ctx.defaultWorkspace;
}

interface ApiObject {
  id: string;
  workspaceId: string;
  /** Class identity bit (Revision 12): true = class node (always a root). */
  isClass: boolean;
  /** Embedding flag for parented non-class nodes: true = embedded in the
   * parent's body (the Block role); false = a standalone structural element
   * (the Page role — the parent's main-children zone + document chrome when
   * zoomed). Unread for parentless nodes and classes. */
  isEmbedded: boolean;
  parentId: string | null;
  classIds: string[];
  /** Tag membership (SCHEMA.md "Tags"): page ids assigned as tags to this
   * node — the derived OR-Set projection (recomputeTagIds, sorted by id). */
  tagIds: string[];
  name: string | null;
  icon: string | null;
  color: string | null;
  /** Wire node fields (SCHEMA.md "Node structure", store schema v16): the
   * asset nodes behind the page cover/banner chrome and the main page a
   * node alias points at. null = unset (a present-null PATCH clears). */
  coverAssetId: string | null;
  bannerAssetId: string | null;
  aliasedNodeId: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  hlc: { physical: number; logical: number };
}

function nodeToApi(row: NodeRow, resolveMentionName?: (targetNodeId: string) => string | null): ApiObject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    isClass: row.is_class === 1,
    isEmbedded: row.is_embedded === 1,
    parentId: row.parent_id,
    classIds: JSON.parse(row.class_ids) as string[],
    tagIds: JSON.parse(row.tag_ids) as string[],
    // Title-is-content: the API name derives from the node's content (the
    // retired name column is always null). The API is the machine surface —
    // the full title, no DISPLAY_NAME_MAX budget (the dense-chrome cap is a
    // UI concern; web/GTK/Flutter apply it where they render chrome).
    // A bare mention resolves its TARGET's current title (the no-stored-link-
    // text ruling — the wire carries no captured link text); the caller
    // threads a store-backed resolver so the machine name reads complete.
    name:
      fullTitleOf({
        id: row.id,
        isClass: row.is_class,
        isEmbedded: row.is_embedded,
        contentAst: JSON.parse(row.content) as NonNullable<Parameters<typeof fullTitleOf>[0]["contentAst"]>,
        classIds: JSON.parse(row.class_ids) as string[],
      }, undefined, resolveMentionName) || null,
    icon: row.icon,
    color: row.color,
    coverAssetId: row.cover_asset_id,
    bannerAssetId: row.banner_asset_id,
    aliasedNodeId: row.aliased_node_id,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
  };
}

/**
 * The store-backed mention resolver for the machine API (the web client's
 * `WorkspaceClientReads.getDisplayName` seam mirrored server-side): a bare
 * mention's label is its target's CURRENT title, derived from the derived
 * node rows — recursive with a path guard so a mention cycle folds to
 * nothing at the loop point instead of hanging. Passed to `nodeToApi` (and
 * anywhere a flattened name leaves this process).
 */
function mentionNameResolverOf(store: Store): (targetNodeId: string) => string | null {
  const stmt = store.database.prepare("SELECT id, content, class_ids FROM node WHERE id = ?");
  const resolve = (id: string, path: Set<string>): string | null => {
    if (path.has(id)) return null;
    const row = stmt.get(id) as { id: string; content: string | null; class_ids: string | null } | undefined;
    if (row === undefined) return null;
    path.add(id);
    const name = fullTitleOf(
      {
        id: row.id,
        contentAst: row.content === null ? [] : (JSON.parse(row.content) as NonNullable<Parameters<typeof fullTitleOf>[0]["contentAst"]>),
        classIds: row.class_ids === null ? [] : (JSON.parse(row.class_ids) as string[]),
      },
      undefined,
      (targetId) => resolve(targetId, path),
    );
    path.delete(id);
    return name === "" ? null : name;
  };
  return (id) => resolve(id, new Set());
}

function requireNode(store: Store, id: string): NodeRow {
  const row = store.getNode(id);
  if (row === undefined) {
    throw new AppError(404, "not_found", `object ${id} does not exist`);
  }
  return row;
}

function requireClass(store: Store, id: string): void {
  const row = store.database.prepare("SELECT 1 FROM class WHERE id = ? AND active = 1").get(id);
  if (row === undefined) {
    throw new AppError(404, "not_found", `class ${id} does not exist`);
  }
}

interface SchemaRow {
  id: string;
  name: string;
  type: string;
  multi: number;
  /** The schema's icon; null = none. */
  icon: string | null;
  /** The SOLE locality authority: null = global. */
  scopeClassIds: string | null;
  /** Value validation rules; null = none. */
  validationRules: string | null;
  options: string;
  targetClassFilter: string | null;
  datePrecision: string | null;
  dateQualified: number | null;
  /** Render contracts (PROPERTY-level; NULL = panel / unset). `readonly`
   *  retired 2026-10-21 — derived from the system list, not stored. */
  display: string | null;
  hideWhenEmpty: number | null;
  /** The GLOBAL default; null = none. */
  defaultValue: string | null;
}

function readSchemaRow(store: Store, id: string): SchemaRow | undefined {
  return store.database
    .prepare(
      `SELECT id, name, type, multi, icon, scope_class_ids AS scopeClassIds, validation_rules AS validationRules,
              options, target_class_filter AS targetClassFilter,
              date_precision AS datePrecision, date_qualified AS dateQualified,
              number_pad AS numberPad, number_decimals AS numberDecimals, number_rounding AS numberRounding,
              display, hide_when_empty AS hideWhenEmpty,
              default_value AS defaultValue
       FROM property_schema WHERE id = ? AND active = 1`,
    )
    .get(id) as SchemaRow | undefined;
}

/** The API property-schema view (multi decoded, JSON columns parsed). */
function schemaView(row: SchemaRow): Record<string, unknown> {
  return {
    ...row,
    multi: row.multi === 1,
    options: JSON.parse(row.options) as unknown,
    scopeClassIds: row.scopeClassIds !== null ? (JSON.parse(row.scopeClassIds) as unknown) : null,
    validationRules: row.validationRules !== null ? (JSON.parse(row.validationRules) as unknown) : null,
    targetClassFilter: row.targetClassFilter !== null ? (JSON.parse(row.targetClassFilter) as unknown) : null,
    datePrecision: row.datePrecision === "year" || row.datePrecision === "month" || row.datePrecision === "day" ? row.datePrecision : null,
    display: row.display === "bullet" || row.display === "inline" ? row.display : null,
    hideWhenEmpty: row.hideWhenEmpty === null ? null : row.hideWhenEmpty === 1,
    dateQualified: row.dateQualified === null ? null : row.dateQualified === 1,
    defaultValue: row.defaultValue !== null ? (JSON.parse(row.defaultValue) as unknown) : null,
  };
}

function requireSchema(store: Store, id: string): SchemaRow {
  const row = readSchemaRow(store, id);
  if (row === undefined) {
    throw new AppError(404, "not_found", `property schema ${id} does not exist`);
  }
  return row;
}

/**
 * Class title read model (title-is-content): the display name derives from
 * the class NODE's content — the node is the authority. The registry `name`
 * is a write-side denormalized cache (applyClassCreate/applyClassUpdate
 * maintain it) that pre-title-is-content rows never backfilled, so reads
 * treat it as a fallback only, never the source of truth.
 */
function classNameFromNode(nodeContent: string | null, nodeClassIds: string | null, cachedName: string): string {
  if (nodeContent !== null) {
    const derived = deriveDisplayName({
      id: "",
      isClass: 1,
      isEmbedded: 0,
      contentAst: JSON.parse(nodeContent) as NonNullable<Parameters<typeof deriveDisplayName>[0]["contentAst"]>,
      classIds: JSON.parse(nodeClassIds ?? "[]") as string[],
    });
    if (derived) return derived;
  }
  return cachedName;
}

/**
 * The full object projection behind GET /objects/:id (and the children
 * read): base row + resolved classes + resolved tags + authored property
 * rows. The workspace-zip export (routes-auth) builds its ExportNodes from
 * this so exported frontmatter carries properties.
 */
export function fullObject(store: Store, row: NodeRow) {
  const resolveMentionName = mentionNameResolverOf(store);
  const base = nodeToApi(row, resolveMentionName);
  const classes = base.classIds
    .map((classId) => {
      const classRow = store.database
        .prepare(
          `SELECT c.id, c.name, c.icon, c.color, n.content AS nodeContent, n.class_ids AS nodeClassIds
           FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
           WHERE c.id = ? AND c.active = 1`,
        )
        .get(classId) as
        | { id: string; name: string; icon: string | null; color: string | null; nodeContent: string | null; nodeClassIds: string | null }
        | undefined;
      if (classRow === undefined) return null;
      return { id: classRow.id, name: classNameFromNode(classRow.nodeContent, classRow.nodeClassIds, classRow.name), icon: classRow.icon, color: classRow.color };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // Resolved tags (SCHEMA.md "Tags": tags ARE pages, never classes — the
  // name derives from the tag NODE's content like the API name, not the
  // class registry join). Missing/inactive tag pages drop out silently,
  // mirroring the classes filter above.
  const tags = base.tagIds
    .map((tagId) => {
      const tagRow = store.database
        .prepare("SELECT id, content, class_ids, color FROM node WHERE id = ? AND is_active = 1")
        .get(tagId) as
        | { id: string; content: string | null; class_ids: string | null; color: string | null }
        | undefined;
      if (tagRow === undefined) return null;
      const name = fullTitleOf(
        {
          id: tagRow.id,
          isClass: 0,
          isEmbedded: 0,
          contentAst: JSON.parse(tagRow.content ?? "[]") as NonNullable<Parameters<typeof fullTitleOf>[0]["contentAst"]>,
          classIds: JSON.parse(tagRow.class_ids ?? "[]") as string[],
        },
        undefined,
        resolveMentionName,
      );
      return { id: tagRow.id, name: name || null, color: tagRow.color };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // Authored rows ride the visible-set derivation (tombstoned elements
  // never surface), each carrying its stable element id.
  const properties = visiblePropertyValueRows(store.database, row.id)
    .map((property) => {
      const schema = store.database
        .prepare("SELECT id, name, type FROM property_schema WHERE id = ?")
        .get(property.property_schema_id) as
        | { id: string; name: string; type: string }
        | undefined;
      if (schema === undefined) return null;
      return { property, schema };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort(
      (a, b) =>
        a.schema.name.localeCompare(b.schema.name) ||
        a.property.idx - b.property.idx ||
        (a.property.id < b.property.id ? -1 : 1),
    )
    .map(({ property, schema }) => ({
      schemaId: schema.id,
      schemaName: schema.name,
      schemaType: schema.type,
      elementId: property.id,
      idx: property.idx,
      value: JSON.parse(property.value) as unknown,
      ...(property.metadata !== null ? { metadata: JSON.parse(property.metadata) as unknown } : {}),
    }));
  const contentAst = JSON.parse(row.content) as unknown;
  return { ...base, contentAst, classes, tags, properties };
}

export function registerObjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/property-schemas", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const rows = store.database
      .prepare(
        `SELECT id, name, type, multi, icon, scope_class_ids AS scopeClassIds, validation_rules AS validationRules,
                options, target_class_filter AS targetClassFilter,
                date_precision AS datePrecision, date_qualified AS dateQualified,
              number_pad AS numberPad, number_decimals AS numberDecimals, number_rounding AS numberRounding,
              default_value AS defaultValue
         FROM property_schema WHERE active = 1 ORDER BY name, id`,
      )
      .all() as SchemaRow[];
    return { propertySchemas: rows.map(schemaView) };
  });

  app.get("/property-schemas/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    return { propertySchema: schemaView(requireSchema(store, id)) };
  });

  app.post("/property-schemas", async (request, reply) => {
    const parsed = propertySchemaCreatePayload.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid propertySchema.create payload");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    await ctx.submit({
      workspaceId,
      opType: "propertySchema.create",
      payload: parsed.data as Record<string, unknown>,
      client: "api",
    });
    const store = ctx.workspaces.storeFor(workspaceId);
    reply.code(201);
    return { propertySchema: schemaView(requireSchema(store, parsed.data.propertySchemaId)) };
  });

  /**
   * propertySchema.update: rename / options / date behavior
   * patch. The stored row is the route's 404 gate — the applier's UPDATE is
   * intentionally quiet on unknown ids, the API is not.
   */
  app.patch("/property-schemas/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = propertySchemaUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid propertySchema.update body");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireSchema(store, id);
    const checked = propertySchemaUpdatePayload.safeParse({ propertySchemaId: id, ...parsed.data });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid propertySchema.update payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "propertySchema.update",
      payload: checked.data as Record<string, unknown>,
      client: "api",
    });
    return { propertySchema: schemaView(requireSchema(store, id)) };
  });

  /**
   * propertySchema.delete: soft-delete (active = 0). Authored
   * values on nodes survive; the schema drops out of every read. Delete of a
   * missing/inactive schema fails loud with 404 (same contract as object
   * delete).
   */
  app.delete("/property-schemas/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireSchema(store, id);
    const checked = propertySchemaDeletePayload.safeParse({ propertySchemaId: id });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid propertySchema.delete payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "propertySchema.delete",
      payload: checked.data as Record<string, unknown>,
      client: "api",
    });
    return { id, deleted: true };
  });

  /**
   * class.property.set: the binding upsert (the active soft-unbind + pinned
   * tier-flag patch —
   * omitted fields keep their values; the
   * binding carries ONLY the per-class mechanics; `required` retired
   * outright, `defaultValue` moved to the property schema, `sequence`
   * retired outright — class panels render in pin tiers, alphabetical by
   * property name within each tier —
   * so the strict payload rejects all three keys).
   */
  app.post("/classes/:id/properties", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = classPropertySetBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid class.property.set body");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireClass(store, id);
    const propertySchemaId = parsed.data.propertySchemaId;
    requireSchema(store, propertySchemaId);
    const checked = classPropertySetPayload.safeParse({ classId: id, ...parsed.data });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid class.property.set payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "class.property.set",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    const row = store.database
      .prepare(
        `SELECT property_schema_id, active, pinned
         FROM class_property WHERE class_id = ? AND property_schema_id = ?`,
      )
      .get(id, propertySchemaId) as
      | { property_schema_id: string; active: number; pinned: number }
      | undefined;
    return {
      classId: id,
      propertySchemaId,
      binding:
        row === undefined
          ? null
          : {
              propertySchemaId: row.property_schema_id,
              active: row.active === 1,
              pinned: row.pinned === 1,
            },
    };
  });

  /** class.property.unset: remove the binding row (authored values survive). */
  app.delete("/classes/:id/properties/:propertySchemaId", async (request) => {
    const { id, propertySchemaId } = request.params as { id: string; propertySchemaId: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireClass(store, id);
    requireSchema(store, propertySchemaId);
    const checked = classPropertyUnsetPayload.safeParse({ classId: id, propertySchemaId });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid class.property.unset payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "class.property.unset",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    return { classId: id, propertySchemaId, unbound: true };
  });

  app.get("/resolve", async (request) => {
    const query = request.query as Record<string, unknown>;
    const metadataParam = (key: "doi" | "isbn" | "arxiv" | "pmid" | "ads"): string | undefined =>
      typeof query[key] === "string" && (query[key] as string).length > 0
        ? (query[key] as string)
        : undefined;
    const doi = metadataParam("doi");
    const isbn = metadataParam("isbn");
    const arxiv = metadataParam("arxiv");
    const pmid = metadataParam("pmid");
    const ads = metadataParam("ads");
    if (doi !== undefined || isbn !== undefined || arxiv !== undefined || pmid !== undefined || ads !== undefined) {
      const workspaceId = workspaceFor(ctx, request);
      await ctx.ensureSeeded(workspaceId);
      // Plan-07: the prefs blob is opaque — the ADS credential comes from
      // the explicit header (wrapped prefs) or the unwrapped blob (keyless).
      const adsApiToken = ads !== undefined ? adsTokenFor(ctx, request) : undefined;
      return resolveSourceMetadata(ctx, workspaceId, { doi, isbn, arxiv, pmid, ads }, { adsApiToken });
    }
    const parsed = resolveQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid resolve query");
    }
    const { name } = parsed.data;
    const workspaceId = workspaceFor(ctx, request);
    assertContentReadsAllowed(ctx, workspaceId);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const wanted = name.toLowerCase();
    for (const hit of store.search(name, 100)) {
      const row = store.getNode(hit.nodeId);
      if (row === undefined || row.is_active !== 1) continue;
      const api = nodeToApi(row, mentionNameResolverOf(store));
      const aliases = store.scalarPropertyValues(hit.nodeId, SYSTEM_PROPERTY_UUIDS.alias);
      const matchesName = (api.name ?? "").toLowerCase() === wanted;
      const matchesAlias = aliases.some((alias) => alias.toLowerCase() === wanted);
      if (matchesName || matchesAlias) {
        // A name hit on an ALIAS page answers the MAIN page: the store
        // chain-walker collapses the alias chain to its terminal,
        // cycle-safe with a depth cap (the web client's navigation seam
        // resolves with the same walker).
        const resolvedId = store.resolveAlias(hit.nodeId);
        const resolved = nodeToApi(store.getNode(resolvedId)!, mentionNameResolverOf(store));
        return {
          name: resolved.name,
          id: resolved.id,
          isClass: resolved.isClass,
          isEmbedded: resolved.isEmbedded,
          parentId: resolved.parentId,
        };
      }
    }
    throw new AppError(404, "not_found", `no node named "${name}"`);
  });

  /**
   * THE OWNER'S PDF FLOW (slices 3–6 task 4): hand the server a PDF — either
   * as a multipart upload (the CAS asset route's intake idiom) or as `?url=`
   * for a server-side fetch — and get the source-metadata record for the DOI
   * printed in it. The scan, the SSRF guard, and the error taxonomy live in
   * resolve-source.ts (resolvePdfSource); the 25MB cap applies to both intake
   * paths. A `?url=` answer also carries `pdf: { url }` — the task-6 web
   * client's attach intent: the create flow uploads THAT pdf to CAS. When
   * both an upload and `?url=` arrive, `?url=` wins (documented); neither →
   * 422. No DOI in the bytes → 422 no_identifier_found; the usual resolver
   * gate/codes apply to the metadata leg (403/404/502).
   */
  app.post("/resolve/pdf", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const query = request.query as Record<string, unknown>;
    const url =
      typeof query["url"] === "string" && (query["url"] as string).length > 0
        ? (query["url"] as string)
        : undefined;
    let bytes: Buffer | undefined;
    if (url === undefined) {
      // request.file() itself throws 406 for a non-multipart body; the
      // route's contract is the pinned 422 for "no intake at all".
      if (!request.isMultipart()) {
        throw new AppError(
          422,
          "validation_failed",
          "multipart body must include a file part, or pass ?url=",
        );
      }
      const file = await request.file();
      if (file === undefined) {
        throw new AppError(
          422,
          "validation_failed",
          "multipart body must include a file part, or pass ?url=",
        );
      }
      try {
        bytes = await file.toBuffer();
      } catch {
        throw new AppError(422, "validation_failed", "upload exceeded the multipart size limit");
      }
    }
    return resolvePdfSource(ctx, workspaceId, { bytes, url });
  });

  /**
   * QueryAST execution endpoint: the caller compiles its text DSL (or builds
   * an AST directly) client-side and posts it; the server runs it against the
   * workspace's derived store with @notees/query. Plain ASTs return the
   * deterministic ids plus node summaries; ASTs carrying an `aggregation`
   * return the grouped grid (columns + rows). Unparseable ASTs and
   * unsupported compilations are 422s (fail loud, never half-executed).
   */
  app.get("/classes", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    assertContentReadsAllowed(ctx, workspaceId);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const classes = store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                n.content AS nodeContent, n.class_ids AS nodeClassIds,
                (SELECT json_group_array(parent_class_id) FROM (
                   SELECT parent_class_id FROM class_extends e
                   WHERE e.class_id = c.id ORDER BY parent_class_id)) AS parentClassIds,
                (SELECT COUNT(*) FROM class_member_set m WHERE m.class_id = c.id AND m.present = 1) AS memberCount
         FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
         WHERE c.active = 1`,
      )
      .all() as { id: string; name: string; icon: string | null; color: string | null; description: string | null; nodeContent: string | null; nodeClassIds: string | null; parentClassIds: string | null; memberCount: number }[];
    const listed = classes.map((row) => ({
      id: row.id,
      name: classNameFromNode(row.nodeContent, row.nodeClassIds, row.name),
      icon: row.icon,
      color: row.color,
      description: row.description,
      parentClassIds: JSON.parse(row.parentClassIds ?? "[]") as string[],
      memberCount: row.memberCount,
    }));
    // Title-is-content: ordering keys on the DERIVED title (the registry
    // cache is a fallback, not the authority).
    listed.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
    return { classes: listed };
  });

  app.get("/classes/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    assertContentReadsAllowed(ctx, workspaceId);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const classRow = store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                n.content AS nodeContent, n.class_ids AS nodeClassIds,
                (SELECT json_group_array(parent_class_id) FROM (
                   SELECT parent_class_id FROM class_extends e
                   WHERE e.class_id = c.id ORDER BY parent_class_id)) AS parentClassIds
         FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
         WHERE c.id = ? AND c.active = 1`,
      )
      .get(id) as
      | { id: string; name: string; icon: string | null; color: string | null; description: string | null; nodeContent: string | null; nodeClassIds: string | null; parentClassIds: string | null }
      | undefined;
    if (classRow === undefined) {
      throw new AppError(404, "not_found", `class ${id} does not exist`);
    }
    const members = (
      store.database
        .prepare(
          `SELECT n.id, n.is_class AS isClass, n.is_embedded AS isEmbedded, n.content, n.class_ids
           FROM class_member_set m JOIN node n ON n.id = m.node_id
           WHERE m.class_id = ? AND m.present = 1 AND n.is_active = 1 ORDER BY n.id`,
        )
        .all(id) as Array<{ id: string; isClass: number; isEmbedded: number; content: string; class_ids: string }>
    ).map((row) => ({
      id: row.id,
      name: fullTitleOf({
        id: row.id,
        isClass: row.isClass,
        isEmbedded: row.isEmbedded,
        contentAst: JSON.parse(row.content) as NonNullable<Parameters<typeof fullTitleOf>[0]["contentAst"]>,
        classIds: JSON.parse(row.class_ids) as string[],
      }) || null,
      isClass: row.isClass === 1,
      isEmbedded: row.isEmbedded === 1,
    }));
    return {
      class: {
        id: classRow.id,
        name: classNameFromNode(classRow.nodeContent, classRow.nodeClassIds, classRow.name),
        icon: classRow.icon,
        color: classRow.color,
        description: classRow.description,
        parentClassIds: JSON.parse(classRow.parentClassIds ?? "[]") as string[],
      },
      members,
    };
  });

  app.get("/properties/:id/values", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    assertContentReadsAllowed(ctx, workspaceId);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const nameById = new Map(
      (
        store.database
          .prepare("SELECT id, name FROM node")
          .all() as Array<{ id: string; name: string | null }>
      ).map((row) => [row.id, row.name]),
    );
    // The values read rides the visible-set derivation.
    const values = visiblePropertyValueRows(store.database)
      .filter((row) => row.property_schema_id === id)
      .sort(
        (a, b) =>
          a.node_id.localeCompare(b.node_id) ||
          a.idx - b.idx ||
          (a.id < b.id ? -1 : 1),
      )
      .map((row) => ({
        objectId: row.node_id,
        objectName: nameById.get(row.node_id) ?? null,
        elementId: row.id,
        idx: row.idx,
        value: JSON.parse(row.value) as unknown,
      }));
    return { propertySchemaId: id, values };
  });
}
