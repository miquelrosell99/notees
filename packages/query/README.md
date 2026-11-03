# @notees/query

Notees query engine: the versioned **QueryAST** model + a parameterized
SQLite compiler over the derived store (`@notees/store`). Port of the
concepts (`frontend/src/core/query/compileToSqlite.ts`,
`app/domain/entities/query_ast.py`), adapted to the current schema.

The package is **standalone** (runtime dependency: zod only). Execution
helpers take a structural store interface, so there is no import cycle:
`@notees/protocol` references the AST schema via `z.lazy` (loose union,
forward-compatible) and `@notees/query` never imports the protocol.

## API (what the web slice calls)

```ts
import { compile, runQuery, countQuery, matches, parseQueryAst } from "@notees/query";

const { sql, params } = compile(ast, { now?, selfNodeId? }); // { sql, params }
const { ids, rows } = runQuery(store, ast, opts?);          // ids + full n.* rows
const total = countQuery(store, ast, opts?);
const hit = matches(store, nodeId, ast, opts?);
const ast = parseQueryAst(token.queryAst);                  // fail-loud validation
```

`selfNodeId` is the hosting page for the `self` member target mode — each
family's single-anchor in-ids form with the host id supplied at compile time
(the run site passes the page the query block/view sits on). A self target
compiling WITHOUT it throws — there is no honest reading of "self" without a
host. `now` overrides the placeholder clock (tests pin it). The compiler
assumes a single-workspace store (no
workspace filter), matching the store's read helpers. Every query filters
`n.is_active = 1`.

## AST (version 2, strict — unknown condition types/families/ops/target modes fail loud)

```ts
QueryAst  { version: 2, scope, root: Group, sort?, aggregation? }
Scope     entire_workspace | pages | subtree(pageId) | linkedTo(nodeId)
Group     { logic: and | or, children: (Condition | Group | Not)[] }
Not       { child: Condition | Group }
```

Conditions — six types (v2 folds the v1 64-variant flat union into
parameterized axes; comparator and target mode are orthogonal on the wire):

| Condition | Semantics |
|---|---|
| `member {family, op, target?}` | The node-target condition — ONE type over ten families. `op` is the comparator: `in`/`not-in` (membership over the target set; a required `target`), `exists`/`not-exists` (the family's emptiness read; NO target), or class-only `exact` (exact single-class equality — the Odoo "=" register, the closure deliberately does not apply). `not-in`/`not-exists` are wire-level negations of the same predicate; free-form negation additionally sugars through the `not` group wrapper. |
| `target` (`in`/`not-in` only) | `{ mode: "ids", ids }` a manual pick (class family → class ids, tags → tag ids, every other family → node ids) · `{ mode: "query", root }` the nested group's matches (dynamic — a saved view re-resolves on every run) · `{ mode: "self" }` the HOSTING PAGE, resolved at COMPILE time against `CompileOptions.selfNodeId` (a self target without it fails loud). |
| `content {op, value?}` | `contains`: LIKE substring over the derived search plaintext (name + content tokens — the only derived plaintext; it lives in the FTS index). `fts`: prefix-AND `MATCH` over `search_index`. `eq`/`neq`: plaintext equality; `starts`/`ends`: edge-anchored LIKE — the Odoo text set. `exists` (folded from v1's `contentSet`): the plaintext is non-empty. |
| `name {op, value?}` | The **title** (title-is-content: the flattened content text, the sort-by-name expression — title-only, unlike `content`). `contains`: LIKE substring (ASCII case-insensitive); `eq`/`neq`: exact case-sensitive comparisons (an untitled row matches neither, SQL NULL semantics — "is untitled" is the not-wrap of `exists`); `exists`: the title is non-empty, COALESCE'd two-valued. |
| `property {schemaId, op, value?, from?, to?, period?, includeDefaults?}` | See below. `eq`, `neq`, `contains`, `exists`, `gt`, `gte`, `lt`, `lte`, plus the folded range/period ops: `between {from, to}` (the inclusive range — numeric for JSON numbers, lexicographic for ISO dates, date-node refs speak too) and `within {period}` (the effective DATE-valued property inside the relative period). |
| `date {field, op, timestamp?, from?, to?, period?}` | The v1 `created*`/`updated*` ten types behind an explicit `field` axis (`created`/`updated` → `node.created_at`/`node.updated_at`). `eq`/`neq` are DAY-granular (the whole resolved local day matches); `gt`/`gte`/`lt`/`lte` compare the instant; `after`/`before` are the inclusive day-boundary ops (`created_at >= / <= timestamp`); `between {from, to}` is the inclusive range (from day-start to to day-end); `within {period}` is the relative period against the run clock. |
| `nodeField {field, op, value?}` | Wire-field predicates over the node-table columns: `coverAsset`/`bannerAsset`/`aliasedNode` — `eq`/`neq` against a node id, `exists` the set/unset probe (an unset field matches neither eq nor neq under SQL NULL semantics — "is unset" reads `not exists`). `isClass`/`isEmbedded` (folded from the v1 boolean conditions) ride op `eq` with value `"true"`/`"false"` — the Revision-12 identity/embedding bits. |

### Member families (the family ↔ semantics table — compiler contract)

| family | `in` predicate over the target set | `exists` (emptiness) |
|---|---|---|
| `class` | extends-closure membership (`class_hierarchy`, self-row included — descendant classes match) | has any class |
| `tags` | tag edge membership over the OR-set `tag_ids` (a tag is any page — no hierarchy) | has any tag |
| `links` | `backlinksWithRollup` membership: a direct edge to a target, **or** an edge sourced strictly inside a target's subtree and targeting outside it (containment roll-up). Edges are content mentions, tag memberships ("tags are links"), and node-typed property values. | has any inbound link (a direct edge targets the node) |
| `referencePath` | the self-or-ancestor link roll-up: the row OR any ancestor links to a target, or a target is a STRICT ancestor of the row (containment folded in) | — (no emptiness read: the compiler fails loud) |
| `parent` | the DIRECT parent (one hop) is in the set (the parentless NULL reads two-valued via COALESCE — the empty-parent test rides `exists`) | has a parent (`parent_id IS NOT NULL`) |
| `child` | a DIRECT child is in the set | has any direct child |
| `childPath` | strict subtree membership, anchors excluded (the row sits anywhere inside the picked node's tree) | has any descendant at any depth |
| `page` | the CONTAINING PAGE (nearest self-or-ancestor rendering with document chrome — a class, a parentless node whose classes do not effectively carry `parentlessRole "block"`, or an `is_embedded = 0` node) is in the set. A page row reads its own page (picked, it matches itself); a block-role standalone node has NO containing page — `in` never matches it. | lives inside a page (the containing page differs from the row itself) |
| `parentPath` | some STRICT ancestor (the parent path, self excluded) is in the set | has a parent (the `parent` family's bit) |
| `root` | the workspace-root ancestor (a parentless row is its own root) is in the set | — (no emptiness read: the compiler fails loud) |

`exact` is class-only: the node's class set is exactly the single picked
class — nothing else rides it. Negation ("is-not") is the `not` group
wrapper.

## Property conditions and the effective read model (DECISION)

Property conditions read through the **effective-values read model** — the
same view the property panel shows (`store/src/effective.ts`):

```
effective(node, schema) = tombstone-suppressed authored property_value
                          UNION bindings-derived default
```

- Authored rows are suppressed exactly like the panel: a tombstone with
  `>= (hlc_physical, hlc_logical, actor)` wins.
- Defaults are derived at query time, never materialized: the winning binding
  per (node, schema) is the first assigned class binding the schema
  (`class_member_set` assignment order — HLC then class id, as a
  `ROW_NUMBER() OVER` partition), and it applies only when no authored value
  exists at idx 0. A tombstoned authored value lets the default resurface.
- `includeDefaults` (default **true**) opts out: `false` tests authored rows
  only (one `property_value` probe, no bindings CTE).
- Operators are value-level over `json_extract(value, '$')`: `eq`/`contains`
  match when any effective row matches; `neq` is the `not_equals` port —
  "has at least one effective value different from v" — so unset nodes do not
  match (pair with `exists` if they should). `gt`/`gte`/`lt`/`lte` are the
  GREATER_THAN/LESS_THAN family: JSON numbers compare numerically, everything
  else (ISO-8601 dates) lexicographically.

## Text query DSL (`parseQueryLanguage`)

The user-facing search grammar — port of `query_language.py`, compiled by
the same AST pipeline so CLI/API/UI share one language:

```
class:Name            member class in ids (closure membership, by NAME; "!=" negates)
isClass:true|false    nodeField isClass eq "true"/"false" (Revision 12 bit; "!=" negates)
isEmbedded:true|false nodeField isEmbedded eq "true"/"false" (Revision 12 bit; "!=" negates)
text:term             content contains (substring; bare words do the same)
name:term             title contains (LIKE, ASCII case-insensitive); bare ":" =
                      title is non-empty (exists); ":="/"=" eq, "!=" neq —
                      exact, case-sensitive (title = the flattened content
                      text; an untitled row matches neither, so "is untitled"
                      is NOT name:)
linked:Name           member links in ids — backlinksWithRollup to the named node ("!=" negates)
coverAsset:<ref>      the cover wire node field: bare ":" = is set, "=" eq, "!=" neq
bannerAsset:<ref>     the banner wire node field (same shape)
aliasedNode:<ref>     the alias wire node field (same shape; "is unset" is NOT aliasedNode:)
prop:name<op>val      property condition (no value → exists)
<schema>:<op>val      shorthand: bare property-schema field (year:>2010);
                      any schema name resolves here (case-insensitively,
                      the resolver contract) — citekey:doe2024 and
                      authors:doe work today as property-schema conditions
"quoted phrase"       content contains the phrase
AND OR NOT ( )        boolean composition (juxtaposition = AND)
```

Wire-field values are node references: a uuid passes through, anything
else resolves by node NAME (the `linked:` resolver). Range/contains
operators don't fit uuid references — the AST admits only eq/neq/exists
(and an unset field matches neither eq nor neq under SQL NULL semantics,
so the unset probe is `NOT coverAsset:`).

Operators: `:` contains, `:=`/`=` eq, `!=` neq, `:>`/`>` gt, `:>=`/`>=` gte,
`:<`/`<` lt, `:<=`/`<=` lte. Values coerce to numbers when numeric (numeric
comparison); anything else stays text (lexicographic — ISO dates order
correctly). Class/schema/node names resolve through caller-injected
resolvers; unknown fields and unresolvable names throw `QueryLanguageError`.
`looksLikeQueryLanguage(text)` gates DSL vs plain-text search.

## SQL shapes

Scope (the only source of a `distance` column; `SELECT n.*` otherwise):

```sql
-- subtree(pageId): the page plus descendants, distance = depth below it
... JOIN (WITH RECURSIVE sub(id, distance) AS (
      SELECT id, 0 FROM node WHERE id = ?
      UNION ALL SELECT n.id, sub.distance + 1
                FROM sub JOIN node n ON n.parent_id = sub.id)
    SELECT id, distance FROM sub) sc ON sc.id = n.id

-- linkedTo(nodeId): backlinksWithRollup membership (direct + containment)
... JOIN (WITH RECURSIVE sub(id, distance) AS (...),
    hits AS (
      SELECT e.source_id AS id, 0 FROM edge e WHERE e.target_id = ?
      UNION ALL
      SELECT e.source_id, sub.distance FROM edge e
      JOIN sub ON sub.id = e.source_id
      WHERE sub.distance > 0 AND e.target_id NOT IN (SELECT id FROM sub))
    SELECT id, MIN(distance) AS distance FROM hits GROUP BY id) sc ON sc.id = n.id
```

The links family **condition** (`member {family:"links", op:"in", target}`) uses
the same CTE with a single-column projection (`n.id IN (SELECT id FROM
(...))`). `pages` filters to the document-chrome predicate — `n.is_class = 0
AND (n.parent_id IS NULL OR n.is_embedded = 0)` PLUS the parentlessRole
demote as a separate conjunct over the parentless population —
`AND (n.parent_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM class_hierarchy ch
JOIN node c ON c.id = ch.ancestor_id WHERE ch.class_id IN (SELECT value FROM
json_each(n.class_ids)) AND c.parentless_role = 'block'))`: workspace documents
plus every parent's main-children zone, classes, inline blocks, AND
block-role standalone nodes out; `entire_workspace` adds nothing.

Everything is parameterized with positional `?` — user values never reach
the SQL string (verified by tests, including an injection attempt).

`sort: [{field, dir}]` maps to `ORDER BY` (`name`/`createdAt` NULLS-last via
`IS NULL`, then `dir`), always ending in the deterministic `n.id ASC`
tiebreak. Default order: `n.id ASC`.

## Aggregation (grouped grids)

An AST may carry `aggregation: { dimensions, measures }` — dimensions GROUP
BY the filtered-node set, measures aggregate over it:

```ts
dimensions: Array<{ kind: "class", id }        // hierarchy-aware membership (1/0)
                      | { kind: "property", id } // effective/authored value at idx 0
                      | { kind: "isClass" }      // the class identity bit
                      | { kind: "isEmbedded" }>  // the embedding bit
measures:   Array<{ function: "count" | "countDistinct", kind?: "node" }
                      | { function: "sum" | "avg" | "min" | "max", kind: "property", id }>
```

SQL shape: the same filtered-node set becomes a `filtered` CTE, the outer
query groups it (zero dimensions = one grand-total row, no GROUP BY):

```sql
WITH filtered AS (
  SELECT n.id, n.is_class, n.is_embedded, n.class_ids
  FROM node n WHERE n.is_active = 1 AND (...)
)
SELECT f.is_class AS "isClass", COUNT(*) AS "count"
FROM filtered f
GROUP BY "isClass"
ORDER BY "isClass" ASC
```

- Columns are deterministic: dimensions in declared order, then measures;
  labels `isClass` / `isEmbedded` / `class:<id>` / `property:<id>` /
  `count` / `countDistinct` / `<fn>:<id>` (collisions suffixed `#2`, …).
  GROUP BY / ORDER BY reference the output aliases (SQLite resolves
  result-column names) so parameterized expressions appear exactly once.
- Property dimensions/measures read the effective value at idx 0 through the
  same read model as the property conditions (authored UNION winning-binding
  default; three schema-id params per property reference).
- `sort` does not apply to aggregates; `runQuery` rejects aggregation ASTs —
  execution goes through `runAggregate(store, ast) → { columns, rows }`.

## Deferred (fail loud today, cleanly extensible)

- Condition types outside the shipped model: style marks, regex (needs a
  SQLite extension), flags. (The relation families — parent/child/childPath,
  page, tags, links, referencePath, root — ship as `member` conditions;
  `in`/`not-in`/`exists`/`not-exists` ship as member ops.)
- DSL sugar not yet mapped: `collection:` scope, `asset:` field. Dedicated
  relation-based `author:` semantics (resolve a persona and match their
  works) remain deferred — until then `authors:doe` works as
  property-schema shorthand (the shipped schema name is "Authors").
- `content contains` passes `%`/`_` through to LIKE (parity; wildcard
  escaping is a later concern).

## Protocol wiring

The AST model lives in `packages/protocol/src/query-ast.ts` (protocol is the
wire-adjacent home; this package's `src/ast.ts` re-exports it unchanged, so
`import { … } from "@notees/query"` keeps working).
`packages/protocol/src/content-mark.ts` types the `query` content token's
`queryAst` as `z.union([z.lazy(() => queryAstSchema), z.record(z.unknown())])`:
known ASTs parse into the typed model; newer/foreign AST versions apply as
plain records (the AST evolves by version; the content grammar must not
reject them).
