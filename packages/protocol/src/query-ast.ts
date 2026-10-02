/**
 * QueryAST v1 — the canonical, serializable query model for Notees v2
 * (port of v1 `app/domain/entities/query_ast.py` concepts, adapted to the v2
 * derived schema: the Revision-11 booleans (`is_class`, `present_as_main`)
 * replace node_type/kind, edge replaces node_link as the
 * reference index, class_hierarchy carries the transitive extends closure).
 *
 * Lives in @notees/protocol because it is wire-adjacent: the content
 * grammar's `query` token embeds it (content-mark.ts), and protocol must
 * not depend on any workspace package. @notees/query re-exports this module
 * unchanged (`packages/query/src/ast.ts`), so existing
 * `import { … } from "@notees/query"` paths keep working.
 *
 * Design laws (carried over from v1):
 *  - the AST is the source of truth — UI and SQL are projections of it;
 *  - the AST is versioned (`version: 1`) and evolves by versioned extension —
 *    unknown condition types or newer versions FAIL LOUD at parse time
 *    (`queryAstSchema` is strict; the protocol content token wraps it in a
 *    loose union so foreign blocks still apply — see content-mark);
 *  - scopes and conditions carry explicit ids; there are no editor-relative
 *    placeholders in v1 (the compiler accepts `currentNodeId` for future
 *    current-node-relative scopes, reserved).
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

// --- conditions ------------------------------------------------------------------

/**
 * eq/neq/contains/exists are the v1 subset; gt/gte/lt/lte are the v1
 * GREATER_THAN / LESS_THAN family. Comparison runs over the effective/authored
 * scalar through json_extract(value, '$'): numeric JSON values compare
 * numerically, everything else (ISO-8601 dates in particular) lexicographically.
 */
export type PropertyOp = "eq" | "neq" | "contains" | "exists" | "gt" | "gte" | "lt" | "lte";
export type ContentOp = "contains" | "fts";

export type Condition =
  | { type: "class"; classId: string }
  | { type: "isClass"; isClass: boolean }
  | { type: "presentAsMain"; presentAsMain: boolean }
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
  /** node.created_at >= timestamp (ISO-8601, inclusive, lexicographic). */
  | { type: "createdAfter"; timestamp: string }
  /** node.created_at <= timestamp (ISO-8601, inclusive, lexicographic). */
  | { type: "createdBefore"; timestamp: string };

export const conditionSchema = z.discriminatedUnion("type", [
  /** Hierarchy-aware: members of the class OR of any class extending it. */
  z.object({ type: z.literal("class"), classId: uuid }).strict(),
  /** Class identity bit: match class nodes (true) or non-class nodes (false). */
  z.object({ type: z.literal("isClass"), isClass: z.boolean() }).strict(),
  /** Render bit (parented nodes): match the parent's main-children zone
   * (true) or the inline body (false). */
  z.object({ type: z.literal("presentAsMain"), presentAsMain: z.boolean() }).strict(),
  /**
   * contains: LIKE substring over the derived search plaintext (the same text
   * the FTS index holds: name + content tokens, case-insensitive for ASCII).
   * fts: prefix-AND FTS MATCH over search_index.
   */
  z.object({
    type: z.literal("content"),
    op: z.enum(["contains", "fts"]),
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
  z.object({ type: z.literal("createdAfter"), timestamp: z.string().min(1) }).strict(),
  z.object({ type: z.literal("createdBefore"), timestamp: z.string().min(1) }).strict(),
]) satisfies z.ZodType<Condition>;

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

// --- sort ---------------------------------------------------------------------------

export type SortField = "name" | "createdAt" | "isClass" | "presentAsMain";
export type SortDir = "asc" | "desc";
export type SortSpec = { field: SortField; dir: SortDir };

export const sortSpecSchema = z
  .object({
    field: z.enum(["name", "createdAt", "isClass", "presentAsMain"]),
    dir: z.enum(["asc", "desc"]),
  })
  .strict();

// --- aggregation ---------------------------------------------------------------------

export type AggregationDimension =
  | { kind: "class"; id: string }
  | { kind: "property"; id: string }
  | { kind: "isClass" }
  | { kind: "presentAsMain" };

export const aggregationDimensionSchema = z.discriminatedUnion("kind", [
  /** Group by membership in the class (hierarchy-aware, like the class condition). */
  z.object({ kind: z.literal("class"), id: uuid }).strict(),
  /** Group by the effective/authored value at idx 0 of the bound property. */
  z.object({ kind: z.literal("property"), id: uuid }).strict(),
  /** Group by node.is_class (label: "Is class"). */
  z.object({ kind: z.literal("isClass") }).strict(),
  /** Group by node.present_as_main (label: "Presents as main"). */
  z.object({ kind: z.literal("presentAsMain") }).strict(),
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
