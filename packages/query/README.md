# @notees/query

Notees v2 query engine: the versioned **QueryAST** model + a parameterized
SQLite compiler over the v2 derived store (`@notees/store`). Port of the v1
concepts (`frontend/src/core/query/compileToSqlite.ts`,
`app/domain/entities/query_ast.py`), adapted to the v2 schema.

The package is **standalone** (runtime dependency: zod only). Execution
helpers take a structural store interface, so there is no import cycle:
`@notees/protocol` references the AST schema via `z.lazy` (loose union,
forward-compatible) and `@notees/query` never imports the protocol.

## API (what the web slice calls)

```ts
import { compile, runQuery, countQuery, matches, parseQueryAst } from "@notees/query";

const { sql, params } = compile(ast, { currentNodeId? });   // { sql, params }
const { ids, rows } = runQuery(store, ast, opts?);          // ids + full n.* rows
const total = countQuery(store, ast, opts?);
const hit = matches(store, nodeId, ast, opts?);
const ast = parseQueryAst(token.queryAst);                  // fail-loud validation
```

`currentNodeId` is reserved for future current-node-relative scopes; the v1
AST carries explicit ids. The compiler assumes a single-workspace store (no
workspace filter), matching the store's read helpers. Every query filters
`n.is_active = 1`.

## AST (version 1, strict — unknown condition types fail loud)

```ts
QueryAst  { version: 1, scope, root: Group, sort?, aggregation? }
Scope     entire_workspace | pages | subtree(pageId) | linkedTo(nodeId)
Group     { logic: and | or, children: (Condition | Group | Not)[] }
Not       { child: Condition | Group }
```

Conditions (M1 subset, cleanly extensible by versioned addition):

| Condition | Semantics |
|---|---|
| `class {classId}` | Members of the class **or any class extending it** (`class_hierarchy`, which includes the self-row). |
| `nodeType {nodeType}` | `node.node_type = page \| block \| class`. |
| `content {op, value}` | `contains`: LIKE substring over the derived search plaintext (name + content tokens — the only derived plaintext in v2; it lives in the FTS index). `fts`: prefix-AND `MATCH` over `search_index`. |
| `property {schemaId, op, value?, includeDefaults?}` | See below. `eq`, `neq`, `contains`, `exists`, `gt`, `gte`, `lt`, `lte`. |
| `linkedTo {nodeId}` | `backlinksWithRollup` membership: a direct edge to the node, **or** an edge sourced strictly inside its subtree and targeting outside it (containment roll-up). |
| `createdAfter / createdBefore {timestamp}` | Inclusive bounds on `node.created_at` (ISO-8601, lexicographic). |

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
  match when any effective row matches; `neq` is the v1 `not_equals` port —
  "has at least one effective value different from v" — so unset nodes do not
  match (pair with `exists` if they should). `gt`/`gte`/`lt`/`lte` are the v1
  GREATER_THAN/LESS_THAN family: JSON numbers compare numerically, everything
  else (ISO-8601 dates) lexicographically.

## Text query DSL (`parseQueryLanguage`)

The user-facing search grammar — port of v1 `query_language.py`, compiled by
the same AST pipeline so CLI/API/UI share one language:

```
class:Name            class membership (by NAME; "!=" negates)
type:page|block|class nodeType ("!=" negates)
text:term             content contains (substring; bare words do the same)
linked:Name           backlinksWithRollup to the named node ("!=" negates)
prop:name<op>val      property condition (no value → exists)
<schema>:<op>val      shorthand: bare property-schema field (year:>2010)
"quoted phrase"       content contains the phrase
AND OR NOT ( )        boolean composition (juxtaposition = AND)
```

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

The `linkedTo` **condition** uses the same CTE with a single-column
projection (`n.id IN (SELECT id FROM (...))`). `pages` is a plain
`node_type = 'page'` filter; `entire_workspace` adds nothing.

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
                      | { kind: "nodeType" }>
measures:   Array<{ function: "count" | "countDistinct", kind?: "node" }
                      | { function: "sum" | "avg" | "min" | "max", kind: "property", id }>
```

SQL shape: the same filtered-node set becomes a `filtered` CTE, the outer
query groups it (zero dimensions = one grand-total row, no GROUP BY):

```sql
WITH filtered AS (
  SELECT n.id, n.node_type, n.class_ids FROM node n WHERE n.is_active = 1 AND (...)
)
SELECT f.node_type AS "nodeType", COUNT(*) AS "count"
FROM filtered f
GROUP BY "nodeType"
ORDER BY "nodeType" ASC
```

- Columns are deterministic: dimensions in declared order, then measures;
  labels `nodeType` / `class:<id>` / `property:<id>` / `count` /
  `countDistinct` / `<fn>:<id>` (collisions suffixed `#2`, …). GROUP BY /
  ORDER BY reference the output aliases (SQLite resolves result-column
  names) so parameterized expressions appear exactly once.
- Property dimensions/measures read the effective value at idx 0 through the
  same read model as the property conditions (authored UNION winning-binding
  default; three schema-id params per property reference).
- `sort` does not apply to aggregates; `runQuery` rejects aggregation ASTs —
  execution goes through `runAggregate(store, ast) → { columns, rows }`.

## Deferred (fail loud today, cleanly extensible)

- v1 condition types outside the M1 model: style marks, parent/parent_path,
  child/child_path, page, tag, flag, reference_path, extends (covered by
  `class` via the hierarchy closure), regex (needs a SQLite extension),
  in/not_in.
- DSL sugar not yet mapped: `collection:` scope, `author:` (relation-based),
  `asset:`/`citekey:` fields (citekey is reachable today as
  `prop:citekey:…`).
- `content contains` passes `%`/`_` through to LIKE (v1 parity; wildcard
  escaping is a later concern).

## Protocol wiring

The AST model lives in `packages/protocol/src/query-ast.ts` (protocol is the
wire-adjacent home; this package's `src/ast.ts` re-exports it unchanged, so
`import { … } from "@notees/query"` keeps working).
`packages/protocol/src/content-mark.ts` types the `query` content token's
`queryAst` as `z.union([z.lazy(() => queryAstSchema), z.record(z.unknown())])`:
known v1 ASTs parse into the typed model; newer/foreign AST versions apply as
plain records (the AST evolves by version; the content grammar must not
reject them).
