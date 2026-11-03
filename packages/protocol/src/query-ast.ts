/**
 * QueryAST v2 — the canonical, serializable query model for Notees.
 *
 * Lives in @notees/protocol because it is wire-adjacent: the content
 * grammar's `query` token embeds it (content-mark.ts), and protocol must
 * not depend on any workspace package. @notees/query re-exports this module
 * unchanged (`packages/query/src/ast.ts`), so existing
 * `import { … } from "@notees/query"` paths keep working.
 *
 * v2 replaces the v1 flat union of 64 condition types with SIX types.
 * The v1 type names smeared three independent axes across the type system —
 * `descendantOf` / `descendantOfAny` / `descendantOfQuery` /
 * `descendantOfSelf` / `descendantSet` are one logical condition wearing
 * five hats. v2 makes the axes explicit and orthogonal:
 *
 *  - `member` conditions carry `family` (what reference is tested), `op`
 *    (the comparator: in / not-in / exists / not-exists / exact), and a
 *    `target` that names its mode (`ids` manual / `query` nested / `self`
 *    hosting page). Negative comparators are wire-level ops; free-form
 *    negation additionally sugars through the `not` group wrapper.
 *  - `content` folds v1's `contentSet` (op `exists`).
 *  - `property` folds v1's `propertyBetween` / `propertyWithin`.
 *  - `date` folds the ten v1 `created*` / `updated*` types behind an
 *    explicit `field` axis.
 *  - `nodeField` folds v1's `isClass` / `isEmbedded` (they ride op `eq`
 *    with value `"true"` / `"false"`); `coverAsset` / `bannerAsset` /
 *    `aliasedNode` keep their ops unchanged.
 *
 * Design laws (carried over):
 *  - the AST is the source of truth — UI and SQL are projections of it;
 *  - the AST is versioned (`version: 2`) and evolves by versioned extension —
 *    unknown condition types, families, ops, target modes, or versions FAIL
 *    LOUD at parse time (every schema is `.strict()`; the protocol content
 *    token wraps it in a loose union so foreign blocks still apply — see
 *    content-mark);
 *  - there is NO v1 parse path: `version: 1` is rejected outright and v1
 *    data converges by a one-time in-place log rewrite
 *    (`scripts/migrate-query-ast-v2.mts`, Path-B precedent
 *    `migrate-is-embedded.mts`), never by dual-parse;
 *  - scopes and conditions carry explicit ids; there are no editor-relative
 *    ID placeholders ("this page" is baked at write time by the
 *    builder) — EXCEPT the `self` target mode: the target names the query's
 *    HOSTING PAGE, which is not knowable at write time (the same AST must
 *    mean "this page" wherever it runs). It resolves at COMPILE time
 *    against `@notees/query` CompileOptions.selfNodeId — the run site
 *    supplies the hosting page's id, and a compile without it FAILS LOUD.
 *    The static / dynamic (nested-group) target modes stay explicit-id.
 *    `{today}`-style DATE placeholders ({today}/{this_week}/{this_month}/
 *    {this_year}) are ordinary strings in timestamp/value positions and
 *    resolve at compile time against the run clock (@notees/query
 *    CompileOptions.now) — see placeholders.ts.
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

// --- target reference ---------------------------------------------------------------
// The target mode axis: `ids` manual / `query` nested / `self` hosting page.
// Recursive (a query target nests a full group tree) — zod needs explicit
// output annotations to type the cycle.

/**
 * The target reference — the mode axis of every `member` membership op.
 * `ids` is a manual pick (class family → class ids, tags → tag ids, every
 * other family → node ids); `query` defines the target set dynamically
 * through a nested group (a saved view re-resolves on every run, never
 * baked uuids); `self` names the HOSTING PAGE, resolved at compile time
 * against CompileOptions.selfNodeId.
 */
export type TargetRef =
  | { mode: "ids"; ids: string[] }
  | { mode: "query"; root: Group }
  | { mode: "self" };

export const targetRefSchema: z.ZodType<TargetRef> = z.lazy(() =>
  z.union([
    z.object({ mode: z.literal("ids"), ids: z.array(uuid).min(1) }).strict(),
    z.object({ mode: z.literal("query"), root: groupSchema }).strict(),
    z.object({ mode: z.literal("self") }).strict(),
  ]),
);

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
 * The node-target families — what reference of the node the `member`
 * condition tests. The family ↔ semantics table (compiler contract,
 * unchanged SQL; normative copy in packages/query/README.md):
 *
 * | family        | predicate over the target set           | emptiness (`exists`)      |
 * |---------------|-----------------------------------------|---------------------------|
 * | class         | extends-closure membership              | has any class             |
 * | tags          | tag edge membership                     | has any tag               |
 * | links         | backlinksWithRollup (direct + roll-up)  | has any link              |
 * | referencePath | self-or-ancestor reference roll-up      | —                         |
 * | parent        | direct parent ∈ set                     | has a parent              |
 * | child         | direct child ∈ set                      | has any child             |
 * | childPath     | strict subtree membership               | has any descendant        |
 * | page          | containing page ∈ set                   | lives inside a page       |
 * | parentPath    | ancestor chain ∩ set                    | has a parent (parentSet)  |
 * | root          | workspace-root ancestor ∈ set           | — (vacuous)               |
 */
export type MemberFamily =
  | "class"
  | "tags"
  | "links"
  | "referencePath"
  | "parent"
  | "child"
  | "childPath"
  | "page"
  | "parentPath"
  | "root";

export const memberFamilySchema = z.enum([
  "class",
  "tags",
  "links",
  "referencePath",
  "parent",
  "child",
  "childPath",
  "page",
  "parentPath",
  "root",
]);

/**
 * The node-target condition — ONE type replaces the v1 family's 45
 * variants. The three sub-shapes:
 *  - `in` / `not-in`: membership over the target set (target REQUIRED);
 *  - `exists` / `not-exists`: the family's reference emptiness test
 *    (NO target — a target on these is a wire error);
 *  - `exact`: class family ONLY — exact single-class equality (v1's
 *    classExact); the target is a single class id.
 */
export type MemberCondition =
  | { type: "member"; family: MemberFamily; op: "in" | "not-in"; target: TargetRef }
  | { type: "member"; family: MemberFamily; op: "exists" | "not-exists" }
  | { type: "member"; family: "class"; op: "exact"; target: { mode: "ids"; ids: [string] } };

export const memberConditionSchema = z.union([
  z
    .object({
      type: z.literal("member"),
      family: memberFamilySchema,
      op: z.enum(["in", "not-in"]),
      target: targetRefSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("member"),
      family: memberFamilySchema,
      op: z.enum(["exists", "not-exists"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("member"),
      family: z.literal("class"),
      op: z.literal("exact"),
      target: z.object({ mode: z.literal("ids"), ids: z.tuple([uuid]) }).strict(),
    })
    .strict(),
]);

/**
 * eq/neq/contains/exists are the original subset; gt/gte/lt/lte are the
 * GREATER_THAN / LESS_THAN family. Comparison runs over the effective/authored
 * scalar through json_extract(value, '$'): numeric JSON values compare
 * numerically, everything else (ISO-8601 dates in particular) lexicographically.
 */
export type PropertyOp = "eq" | "neq" | "contains" | "exists" | "gt" | "gte" | "lt" | "lte";
export type ContentOp = "contains" | "fts" | "eq" | "neq" | "starts" | "ends";
/**
 * The title-condition operators (the `name:` DSL field): `contains` is a LIKE
 * substring (ASCII case-insensitive, the content-contains convention);
 * `eq`/`neq` are exact BINARY comparisons (the `prop:` `:=` convention) —
 * an untitled row (NULL flattened text) matches neither, like the wire-field
 * predicates. `exists` reads "has a non-empty title".
 */
export type NameOp = "eq" | "neq" | "contains" | "exists";
/**
 * The base date-comparison ops (Odoo's date operators): eq/neq are
 * DAY-granular equality (the whole local day matches), gt/gte/lt/lte compare
 * against the resolved instant. v2's `date` condition rides the full set —
 * after/before/joins plus the folded `between` / `within` range/period ops.
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
  | MemberCondition
  /**
   * The plaintext condition: contains is a LIKE substring over the derived
   * search plaintext (the same text the FTS index holds: name + content
   * tokens, case-insensitive for ASCII); fts is a prefix-AND FTS MATCH over
   * search_index; eq/neq plaintext equality; starts/ends prefix/suffix LIKE —
   * the Odoo text operator set. `exists` (folded from v1's contentSet) reads
   * "the title/content plaintext is non-empty".
   */
  | { type: "content"; op: ContentOp | "exists"; value?: string | undefined }
  /**
   * Title-is-content: the node's title IS its flattened content text (the
   * sort-by-name expression) — the `name:` DSL field. `contains` is a LIKE
   * substring (ASCII case-insensitive); `eq`/`neq` are exact case-sensitive
   * comparisons; `exists` reads "the title is non-empty". An untitled row
   * (NULL flattened text) matches neither eq nor neq under SQL NULL
   * semantics — "is untitled" is the not-wrap of `exists`.
   */
  | { type: "name"; op: NameOp; value?: string | undefined }
  | {
      type: "property";
      schemaId: string;
      op: PropertyOp | "between" | "within";
      value?: unknown;
      /** Folded from v1's propertyBetween: the inclusive [from, to] range. */
      from?: unknown;
      to?: unknown;
      /** Folded from v1's propertyWithin: the relative period. */
      period?: DatePeriod | undefined;
      /**
       * Read through the effective-values read model (authored rows plus
       * class-binding defaults derived at query time, first-class-applied-wins)
       * — the same view the property panel shows. Default true; pass false to
       * test authored property_value rows only.
       */
      includeDefaults?: boolean | undefined;
    }
  /**
   * The date condition — the v1 `created*` / `updated*` ten types folded
   * behind an explicit `field` axis. eq/neq are DAY-granular equality;
   * gt/gte/lt/lte compare against the resolved instant; after/before are the
   * inclusive day-boundary ops; between is the inclusive [from, to] range;
   * within is the relative period.
   */
  | {
      type: "date";
      field: "created" | "updated";
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "after" | "before" | "between" | "within";
      timestamp?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      period?: DatePeriod | undefined;
    }
  /**
   * The node wire-field condition — v1's isClass/isEmbedded folded in: they
   * ride op `eq` with value "true" | "false" (the Revision-12 booleans as
   * wire strings). coverAsset/bannerAsset/aliasedNode keep eq/neq against a
   * node id and exists for the set/unset bit.
   */
  | {
      type: "nodeField";
      field: "coverAsset" | "bannerAsset" | "aliasedNode" | "isClass" | "isEmbedded";
      op: NodeFieldOp;
      value?: string | undefined;
    };

/**
 * The condition union. NOTE: v1's was a `z.discriminatedUnion("type")`;
 * v2 cannot be — the three `member` sub-shapes share the `type` value
 * "member" and zod rejects duplicate discriminator values, so the `member`
 * family is itself a union of the three precise sub-schemas (strict
 * objects that enforce the op/target coupling structurally: `in`/`not-in`
 * REQUIRE the target, `exists`/`not-exists` forbid it via `.strict()`,
 * `exact` pins family "class" and a single-id tuple).
 */
export const conditionSchema = z.union([
  memberConditionSchema,
  z
    .object({
      type: z.literal("content"),
      op: z.enum(["contains", "fts", "eq", "neq", "starts", "ends", "exists"]),
      value: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("name"),
      op: z.enum(["eq", "neq", "contains", "exists"]),
      value: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("property"),
      schemaId: uuid,
      op: z.enum(["eq", "neq", "contains", "exists", "gt", "gte", "lt", "lte", "between", "within"]),
      value: z.unknown().optional(),
      from: z.unknown().optional(),
      to: z.unknown().optional(),
      period: z.enum(["today", "this_week", "this_month", "this_year"]).optional(),
      includeDefaults: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("date"),
      field: z.enum(["created", "updated"]),
      op: z.enum([
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "after",
        "before",
        "between",
        "within",
      ]),
      timestamp: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      period: z.enum(["today", "this_week", "this_month", "this_year"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("nodeField"),
      field: z.enum(["coverAsset", "bannerAsset", "aliasedNode", "isClass", "isEmbedded"]),
      op: z.enum(["eq", "neq", "exists"]),
      // Not a uuid on purpose: isClass/isEmbedded ride "true"/"false".
      value: z.string().min(1).optional(),
    })
    .strict(),
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
  version: 2;
  scope: Scope;
  root: Group;
  sort?: SortSpec[] | undefined;
  aggregation?: Aggregation | undefined;
};

export const queryAstSchema = z
  .object({
    version: z.literal(2),
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
