/**
 * QueryAST v1 — the canonical, serializable query model for Notees
 * (port of `app/domain/entities/query_ast.py` concepts, adapted to the
 * derived schema: the Revision-12 booleans (`is_class`, `is_embedded`)
 * replace node_type/kind, edge replaces node_link as the
 * reference index, class_hierarchy carries the transitive extends closure).
 *
 * Lives in @notees/protocol because it is wire-adjacent: the content
 * grammar's `query` token embeds it (content-mark.ts), and protocol must
 * not depend on any workspace package. @notees/query re-exports this module
 * unchanged (`packages/query/src/ast.ts`), so existing
 * `import { … } from "@notees/query"` paths keep working.
 *
 * Design laws (carried over):
 *  - the AST is the source of truth — UI and SQL are projections of it;
 *  - the AST is versioned (`version: 1`) and evolves by versioned extension —
 *    unknown condition types or newer versions FAIL LOUD at parse time
 *    (`queryAstSchema` is strict; the protocol content token wraps it in a
 *    loose union so foreign blocks still apply — see content-mark);
 *  - scopes and conditions carry explicit ids; there are no editor-relative
 *    ID placeholders ("this page" is baked at write time by the
 *    builder). `{today}`-style DATE placeholders ({today}/{this_week}/
 *    {this_month}/{this_year}) are ordinary strings in timestamp/value
 *    positions and resolve at compile time against the run clock
 *    (@notees/query CompileOptions.now) — see placeholders.ts.
 */

import { z } from "zod";

const uuid = z.string().uuid();

// --- scope ---------------------------------------------------------------------

export type Scope =
  | { type: "entire_workspace" }
  | { type: "pages" }
  | { type: "subtree"; pageId: string }
  | { type: "linkedTo"; nodeId: string };

export const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entire_workspace") }).strict(),
  z.object({ type: z.literal("pages") }).strict(),
  /** The page plus every node under it (recursive parent_id walk). */
  z.object({ type: z.literal("subtree"), pageId: uuid }).strict(),
  /** Roll-up membership: backlinksWithRollup semantics (direct + containment). */
  z.object({ type: z.literal("linkedTo"), nodeId: uuid }).strict(),
]);

// --- group / not -------------------------------------------------------------------
// Recursive: zod needs explicit output annotations to type the cycle.

export type Group = { type: "group"; logic: "and" | "or"; children: Child[] };
export type Not = { type: "not"; child: Condition | Group };
export type Child = Condition | Group | Not;

export const groupSchema: z.ZodType<Group> = z.lazy(() =>
  z
    .object({
      type: z.literal("group"),
      logic: z.enum(["and", "or"]),
      children: z.array(childSchema),
    })
    .strict(),
);

export const notSchema: z.ZodType<Not> = z.lazy(() =>
  z
    .object({
      type: z.literal("not"),
      child: z.union([conditionSchema, groupSchema]),
    })
    .strict(),
);

export const childSchema: z.ZodType<Child> = z.lazy(() =>
  z.union([conditionSchema, groupSchema, notSchema]),
);


// --- conditions ------------------------------------------------------------------

/**
 * eq/neq/contains/exists are the original subset; gt/gte/lt/lte are the
 * GREATER_THAN / LESS_THAN family. Comparison runs over the effective/authored
 * scalar through json_extract(value, '$'): numeric JSON values compare
 * numerically, everything else (ISO-8601 dates in particular) lexicographically.
 */
export type PropertyOp = "eq" | "neq" | "contains" | "exists" | "gt" | "gte" | "lt" | "lte";
export type ContentOp = "contains" | "fts" | "eq" | "neq" | "starts" | "ends";
/**
 * The date-comparison family (Odoo's date operators, owner 2026-10-16):
 * eq/neq are DAY-granular equality (the whole local day matches), gt/gte/lt/lte
 * compare against the resolved instant. `between`/`within` ride their own
 * condition shapes.
 */
export type DateOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
/** The relative periods ("is within today / this week / this month / this year"). */
export type DatePeriod = "today" | "this_week" | "this_month" | "this_year";
/**
 * The node wire-field predicates (coverAsset/bannerAsset/aliasedNode — the
 * node-table columns the fields project to): eq/neq against a node id,
 * exists for the set/unset bit. Range/substring ops don't fit uuid
 * references; the wire fields are nullable, so `not exists` reads unset.
 */
export type NodeFieldOp = "eq" | "neq" | "exists";

export type Condition =
  | { type: "class"; classId: string }
  | { type: "isClass"; isClass: boolean }
  | { type: "isEmbedded"; isEmbedded: boolean }
  | { type: "content"; op: ContentOp; value: string }
  | {
      type: "property";
      schemaId: string;
      op: PropertyOp;
      value?: unknown;
      /**
       * Read through the effective-values read model (authored rows plus
       * class-binding defaults derived at query time, first-class-applied-wins)
       * — the same view the property panel shows. Default true; pass false to
       * test authored property_value rows only.
       */
      includeDefaults?: boolean | undefined;
    }
  /** backlinksWithRollup semantics: direct edge to nodeId, or containment roll-up. */
  | { type: "linkedTo"; nodeId: string }
  /**
   * EXACT class-set equality (the Odoo "=" register): the node's class set is
   * exactly {classId} — nothing else rides it. (The plain `class` condition
   * is closure MEMBERSHIP: the class among others.) Negation (is-not) is the
   * not-wrap.
   */
  | { type: "classExact"; classId: string }
  /**
   * ANY-of class membership (Odoo "one of"): at least one of the picked
   * classes rides the node's class set — closure-aware per id, like `class`.
   * The not-wrap reads "not one of".
   */
  | { type: "classAny"; classIds: string[] }
  /** The class set is non-empty (Odoo "is defined"/"is set"); the not-wrap reads "is not set". */
  | { type: "classSet" }
  /**
   * The CONTAINING PAGE (the nearest self-or-ancestor rendering with document
   * chrome — a class, a parentless node, or an is_embedded=0 node under a
   * page-role parent) IS ONE OF the picked nodes (v1's Page block, static
   * mode). The not-wrap reads "page is not any of …".
   */
  | { type: "pageOf"; nodeIds: string[] }
  /** DYNAMIC Page: the containing page is one of the nodes matching the nested group. */
  | { type: "pageOfQuery"; root: Group }
  /** The row lives inside a page at all (the Page "is set" — a page's own page is itself). */
  | { type: "pageSet" }
  /**
   * The PARENT PATH carries one of the picked nodes (v1's Parent path block,
   * static mode): some STRICT ancestor (parent, grandparent, …) is in the set
   * — self excluded. The not-wrap reads "parent path includes none of …".
   */
  | { type: "ancestorIn"; nodeIds: string[] }
  /** DYNAMIC Parent path: some strict ancestor matches the nested group. */
  | { type: "ancestorInQuery"; root: Group }
  /**
   * The ROOT ancestor (the workspace-root child at the top of the parent
   * chain — the row itself when parentless) IS ONE OF the picked nodes (v1's
   * root walk, static mode). The not-wrap reads "root is not any of …".
   */
  | { type: "rootIn"; nodeIds: string[] }
  /** DYNAMIC Root: the workspace-root ancestor matches the nested group. */
  | { type: "rootInQuery"; root: Group }
  /**
   * Ancestor-chain membership: the node's parents tree (parent,
   * grandparent, …, the node itself EXCLUDED) contains nodeId — the row
   * sits anywhere inside the chosen node's tree. Compiled as subtree
   * membership minus the anchor row.
   */
  | { type: "descendantOf"; nodeId: string }
  /**
   * DYNAMIC links-to: the row's backlinksWithRollup target set is ANY node
   * matching the nested group ("links to a person node with age > 50") —
   * the v1 dynamic reference blocks as a durable wire form (a saved view
   * re-resolves the nested query on every run, never baked uuids).
   */
  | { type: "linkedToQuery"; root: Group }
  /** DYNAMIC parent: the ancestor chain contains ANY node matching the group. */
  | { type: "descendantOfQuery"; root: Group }
  /** node.created_at >= timestamp (ISO-8601, inclusive, lexicographic). */
  | { type: "createdAfter"; timestamp: string }
  /** node.created_at <= timestamp (ISO-8601, inclusive, lexicographic). */
  | { type: "createdBefore"; timestamp: string }
  /** node.updated_at >= timestamp (the "edit date" facet of created). */
  | { type: "updatedAfter"; timestamp: string }
  /** node.updated_at <= timestamp. */
  | { type: "updatedBefore"; timestamp: string }
  /** The title/content plaintext is non-empty (the content "is set"). */
  | { type: "contentSet" }
  /** Tag membership: the OR-set tag_ids carries tagId (a tag is any page). */
  | { type: "tag"; tagId: string }
  /** ANY-of tag membership (Odoo "one of" over tags). */
  | { type: "tagAny"; tagIds: string[] }
  /** At least one tag rides the node. */
  | { type: "tagSet" }
  /** backlinksWithRollup membership of ANY picked node (the links "one of"). */
  | { type: "linkedToAny"; nodeIds: string[] }
  /** At least one inbound link (a direct edge targets the node). */
  | { type: "linkSet" }
  /** Subtree membership of ANY picked node (the parent "one of"), anchors excluded. */
  | { type: "descendantOfAny"; nodeIds: string[] }
  /** The node has a parent at all (parent_id IS NOT NULL). */
  | { type: "parentSet" }
  /** Date comparison (Odoo's =/!=/>/>=/</<=) over created_at. */
  | { type: "createdCmp"; op: DateOp; timestamp: string }
  /** Date comparison over updated_at. */
  | { type: "updatedCmp"; op: DateOp; timestamp: string }
  /** Inclusive created-at range (from day-start to to day-end). */
  | { type: "createdBetween"; from: string; to: string }
  /** Inclusive updated-at range. */
  | { type: "updatedBetween"; from: string; to: string }
  /** created_at inside a relative period (today / this week / this month / this year). */
  | { type: "createdWithin"; period: DatePeriod }
  /** updated_at inside a relative period. */
  | { type: "updatedWithin"; period: DatePeriod }
  /** The effective property value sits inside the inclusive [from, to] range. */
  | { type: "propertyBetween"; schemaId: string; from?: unknown; to?: unknown }
  /** The effective date-valued property sits inside the relative period. */
  | { type: "propertyWithin"; schemaId: string; period: DatePeriod }
  /** node.cover_asset_id comparison — the page cover's asset node (the wire field). */
  | { type: "coverAsset"; op: NodeFieldOp; value?: string | undefined }
  /** node.banner_asset_id comparison — the page banner's asset node (the wire field). */
  | { type: "bannerAsset"; op: NodeFieldOp; value?: string | undefined }
  /** node.aliased_node_id comparison — the main page a node alias points at. */
  | { type: "aliasedNode"; op: NodeFieldOp; value?: string | undefined };

export const conditionSchema = z.discriminatedUnion("type", [
  /** Hierarchy-aware: members of the class OR of any class extending it. */
  z.object({ type: z.literal("class"), classId: uuid }).strict(),
  /** Class identity bit: match class nodes (true) or non-class nodes (false). */
  z.object({ type: z.literal("isClass"), isClass: z.boolean() }).strict(),
  /** Embedding flag (parented nodes): match the parent's inline body
   * (true = embedded, the Block role) or the main-children zone (false =
   * standalone, the Page role). */
  z.object({ type: z.literal("isEmbedded"), isEmbedded: z.boolean() }).strict(),
  /**
   * contains: LIKE substring over the derived search plaintext (the same text
   * the FTS index holds: name + content tokens, case-insensitive for ASCII).
   * fts: prefix-AND FTS MATCH over search_index. eq/neq: plaintext equality;
   * starts/ends: prefix/suffix LIKE — the Odoo text operator set.
   */
  z.object({
    type: z.literal("content"),
    op: z.enum(["contains", "fts", "eq", "neq", "starts", "ends"]),
    value: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("property"),
    schemaId: uuid,
    op: z.enum(["eq", "neq", "contains", "exists", "gt", "gte", "lt", "lte"]),
    value: z.unknown().optional(),
    includeDefaults: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("linkedTo"), nodeId: uuid }).strict(),
  /** EXACT class-set equality — the set is {classId}, nothing else (the Odoo "=" register). */
  z.object({ type: z.literal("classExact"), classId: uuid }).strict(),
  /** ANY-of class membership (Odoo "one of") — closure-aware per id, like `class`. */
  z.object({ type: z.literal("classAny"), classIds: z.array(uuid).min(1) }).strict(),
  /** The class set is non-empty (Odoo "is set"); the not-wrap reads "is not set". */
  z.object({ type: z.literal("classSet") }).strict(),
  /**
   * Ancestor-chain membership (the "parent is X, anywhere up the tree"
   * condition): subtree membership minus the anchor itself.
   */
  z.object({ type: z.literal("descendantOf"), nodeId: uuid }).strict(),
  /** Dynamic links-to: the target set is the nested group's matches (v1 dynamic blocks, durable form). */
  z.object({ type: z.literal("linkedToQuery"), root: groupSchema }).strict(),
  /** Dynamic parent: any ancestor matching the nested group. */
  z.object({ type: z.literal("descendantOfQuery"), root: groupSchema }).strict(),
  z.object({ type: z.literal("createdAfter"), timestamp: z.string().min(1) }).strict(),
  z.object({ type: z.literal("createdBefore"), timestamp: z.string().min(1) }).strict(),
  z.object({ type: z.literal("updatedAfter"), timestamp: z.string().min(1) }).strict(),
  z.object({ type: z.literal("updatedBefore"), timestamp: z.string().min(1) }).strict(),
  /** The v1 Page block: the containing page is one of the picked nodes / matches the group. */
  z.object({ type: z.literal("pageOf"), nodeIds: z.array(uuid).min(1) }).strict(),
  z.object({ type: z.literal("pageOfQuery"), root: groupSchema }).strict(),
  z.object({ type: z.literal("pageSet") }).strict(),
  /** The v1 Parent path block: a strict ancestor is one of the picked nodes / matches the group. */
  z.object({ type: z.literal("ancestorIn"), nodeIds: z.array(uuid).min(1) }).strict(),
  z.object({ type: z.literal("ancestorInQuery"), root: groupSchema }).strict(),
  /** The root walk: the workspace-root ancestor is one of the picked nodes / matches the group. */
  z.object({ type: z.literal("rootIn"), nodeIds: z.array(uuid).min(1) }).strict(),
  z.object({ type: z.literal("rootInQuery"), root: groupSchema }).strict(),
  /** The content "is set" bit. */
  z.object({ type: z.literal("contentSet") }).strict(),
  /** Tag shapes (the OR-set tag_ids; a tag is any page). */
  z.object({ type: z.literal("tag"), tagId: uuid }).strict(),
  z.object({ type: z.literal("tagAny"), tagIds: z.array(uuid).min(1) }).strict(),
  z.object({ type: z.literal("tagSet") }).strict(),
  /** Node-target ANY-of + set shapes (the class operator set over links/parent). */
  z.object({ type: z.literal("linkedToAny"), nodeIds: z.array(uuid).min(1) }).strict(),
  z.object({ type: z.literal("linkSet") }).strict(),
  z.object({ type: z.literal("descendantOfAny"), nodeIds: z.array(uuid).min(1) }).strict(),
  z.object({ type: z.literal("parentSet") }).strict(),
  /** The Odoo date operators: comparison, inclusive range, relative period, edited-set. */
  z.object({
    type: z.literal("createdCmp"),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    timestamp: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("updatedCmp"),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    timestamp: z.string().min(1),
  }).strict(),
  z.object({ type: z.literal("createdBetween"), from: z.string().min(1), to: z.string().min(1) }).strict(),
  z.object({ type: z.literal("updatedBetween"), from: z.string().min(1), to: z.string().min(1) }).strict(),
  z.object({ type: z.literal("createdWithin"), period: z.enum(["today", "this_week", "this_month", "this_year"]) }).strict(),
  z.object({ type: z.literal("updatedWithin"), period: z.enum(["today", "this_week", "this_month", "this_year"]) }).strict(),
  /** The property range/period shapes (numbers numerically, ISO dates lexicographically). */
  z.object({
    type: z.literal("propertyBetween"),
    schemaId: uuid,
    from: z.unknown(),
    to: z.unknown(),
  }).strict(),
  z.object({
    type: z.literal("propertyWithin"),
    schemaId: uuid,
    period: z.enum(["today", "this_week", "this_month", "this_year"]),
  }).strict(),
  /** Wire-field predicates over the node-table columns (uuid refs; eq/neq/exists). */
  z.object({
    type: z.literal("coverAsset"),
    op: z.enum(["eq", "neq", "exists"]),
    value: uuid.optional(),
  }).strict(),
  z.object({
    type: z.literal("bannerAsset"),
    op: z.enum(["eq", "neq", "exists"]),
    value: uuid.optional(),
  }).strict(),
  z.object({
    type: z.literal("aliasedNode"),
    op: z.enum(["eq", "neq", "exists"]),
    value: uuid.optional(),
  }).strict(),
]) satisfies z.ZodType<Condition>;

// --- sort ---------------------------------------------------------------------------

export type SortField = "name" | "createdAt" | "isClass" | "isEmbedded";
export type SortDir = "asc" | "desc";
export type SortSpec = { field: SortField; dir: SortDir };

export const sortSpecSchema = z
  .object({
    field: z.enum(["name", "createdAt", "isClass", "isEmbedded"]),
    dir: z.enum(["asc", "desc"]),
  })
  .strict();

// --- aggregation ---------------------------------------------------------------------

export type AggregationDimension =
  | { kind: "class"; id: string }
  | { kind: "property"; id: string }
  | { kind: "isClass" }
  | { kind: "isEmbedded" };

export const aggregationDimensionSchema = z.discriminatedUnion("kind", [
  /** Group by membership in the class (hierarchy-aware, like the class condition). */
  z.object({ kind: z.literal("class"), id: uuid }).strict(),
  /** Group by the effective/authored value at idx 0 of the bound property. */
  z.object({ kind: z.literal("property"), id: uuid }).strict(),
  /** Group by node.is_class (label: "Is class"). */
  z.object({ kind: z.literal("isClass") }).strict(),
  /** Group by node.is_embedded (label: "Embedded"). */
  z.object({ kind: z.literal("isEmbedded") }).strict(),
]);

export type AggregationMeasure =
  | { function: "count" | "countDistinct"; kind?: "node" | undefined }
  | { function: "sum" | "avg" | "min" | "max"; kind: "property"; id: string };

export const aggregationMeasureSchema = z.union([
  z
    .object({
      function: z.enum(["count", "countDistinct"]),
      kind: z.literal("node").optional(),
    })
    .strict(),
  z
    .object({
      function: z.enum(["sum", "avg", "min", "max"]),
      kind: z.literal("property"),
      id: uuid,
    })
    .strict(),
]);

export type Aggregation = {
  dimensions: AggregationDimension[];
  measures: AggregationMeasure[];
};

export const aggregationSchema = z
  .object({
    dimensions: z.array(aggregationDimensionSchema),
    measures: z.array(aggregationMeasureSchema).min(1),
  })
  .strict();

// --- root ----------------------------------------------------------------------------

export type QueryAst = {
  version: 1;
  scope: Scope;
  root: Group;
  sort?: SortSpec[] | undefined;
  aggregation?: Aggregation | undefined;
};

export const queryAstSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    root: groupSchema,
    sort: z.array(sortSpecSchema).optional(),
    aggregation: aggregationSchema.optional(),
  })
  .strict() satisfies z.ZodType<QueryAst>;

/** Parse + validate a serialized AST. Unknown condition types / versions fail loud. */
export function parseQueryAst(input: unknown): QueryAst {
  return queryAstSchema.parse(input);
}

export function safeParseQueryAst(input: unknown): z.SafeParseReturnType<unknown, QueryAst> {
  return queryAstSchema.safeParse(input);
}
