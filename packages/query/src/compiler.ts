/**
 * QueryAST -> SQLite compiler over the derived schema.
 *
 * Port of the `frontend/src/core/query/compileToSqlite.ts` CONCEPTS,
 * adapted to the current store (packages/store):
 *  - the Revision-11 booleans (`node.is_class`, `node.present_as_main`)
 *    replace node_type; `is_active = 1` excludes deleted nodes on every
 *    query (the store's read helpers do the same);
 *  - the reference index is `edge` (never authored) — the linkedTo
 *    condition/scope mirror `Store.backlinksWithRollup` (direct +
 *    containment roll-up, distance in subtree levels);
 *  - class conditions probe `class_hierarchy` (applier-maintained transitive
 *    closure INCLUDING the self-row), so descendant classes match;
 *  - property conditions read through the effective-values read model
 *    (effective.ts): tombstone-suppressed authored rows UNION
 *    bindings-derived defaults (first-class-applied-wins), so a filter sees
 *    the same values the property panel shows. Pass `includeDefaults: false`
 *    to test authored rows only;
 *  - the derived search plaintext lives ONLY in the FTS index (name +
 *    content tokens), so `contains` LIKE-probes search_index through the
 *    docid map — the same text `fts` MATCHes.
 *
 * Everything is parameterized with positional `?` placeholders; user values
 * never reach the SQL string. The compiler assumes a single-workspace store
 * (no workspace filter), matching the store's read helpers.
 *
 * Compiler boundaries (fail loud, cleanly extensible):
 *  - `aggregation` compiles: the filtered-node set becomes a `filtered` CTE,
 *    dimensions GROUP BY it, measures aggregate over it (see compileAggregate).
 *    Execution goes through runAggregate — runQuery rejects aggregation ASTs;
 *  - scopes/conditions outside the AST subset (style marks, parent/child
 *    paths, regex, flags) are not part of the model.
 */

import type {
  Aggregation,
  AggregationDimension,
  AggregationMeasure,
  Condition,
  Group,
  Not,
  PropertyOp,
  QueryAst,
  SortSpec,
} from "./ast.js";
import {
  resolveTimestampPlaceholder,
  resolveValuePlaceholder,
  type PlaceholderContext,
} from "./placeholders.js";

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

/** An aggregate compilation additionally carries the deterministic column order. */
export interface CompiledAggregate {
  sql: string;
  params: unknown[];
  /** Column labels, in result order: dimensions (declared order), then measures. */
  columns: string[];
}

/**
 * The placeholder clock: `{today}`-style tokens in
 * createdAfter/createdBefore timestamps and comparison-bound property values
 * resolve against this instant. Defaults to the current time on each
 * compile, so a saved view re-evaluates on the day it runs. (The once-
 * reserved `currentNodeId` option was dead — the strict AST carries explicit
 * ids, "this page" is baked at write time — and is removed.)
 */
export type CompileOptions = PlaceholderContext;

/**
 * Prefix-AND FTS match expression (port of the store's buildMatchQuery —
 * kept here so the query package stays standalone, dependency-free). Each
 * maximal run of letters/digits OUTSIDE double quotes becomes a bare prefix
 * token (`term*`); each double-quoted segment becomes an exact FTS phrase
 * (valid MATCH syntax on FTS4 and FTS5 alike). Splitting at every
 * non-alphanumeric boundary mirrors the unicode61 tokenizer ("11607-1" →
 * `11607* AND 1*`). Null when nothing searchable remains.
 */
export function buildMatchExpression(query: string): string | null {
  const splitTerms = (text: string): string[] =>
    text
      .trim()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
  const clauses: string[] = [];
  const unquoted: string[] = [];
  const pattern = /"([^"]*)"/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    unquoted.push(query.slice(last, match.index));
    last = match.index + match[0].length;
    const terms = splitTerms(match[1]!);
    if (terms.length > 0) clauses.push(`"${terms.join(" ")}"`);
  }
  unquoted.push(query.slice(last));
  for (const term of splitTerms(unquoted.join(" "))) clauses.push(`${term}*`);
  if (clauses.length === 0) return null;
  return clauses.join(" AND ");
}

const SORT_COLUMNS: Record<SortSpec["field"], { column: string; nullable: boolean }> = {
  // Title-is-content: the title is the node's content text (the name column
  // is retired). Concatenate the text-run tokens for ordering; NULL/empty
  // titles fall to the id tiebreak the runner appends.
  name: {
    column:
      "(SELECT group_concat(json_extract(j.value, '$.text'), ' ') FROM json_each(n.content) j " +
      "WHERE json_extract(j.value, '$.type') = 'text')",
    nullable: true,
  },
  createdAt: { column: "n.created_at", nullable: true },
  isClass: { column: "n.is_class", nullable: false },
  presentAsMain: { column: "n.present_as_main", nullable: false },
};

/**
 * Deterministic aggregate column labels: dimensions in declared order, then
 * measures in declared order. Generated names (never user text) keep compile-
 * time column identity without store lookups; collisions (e.g. two identical
 * measures) get a positional `#n` suffix.
 */
function aggregationColumns(aggregation: Aggregation): string[] {
  const names = aggregation.dimensions.map((dimension) =>
    dimension.kind === "class" || dimension.kind === "property"
      ? `${dimension.kind}:${dimension.id}`
      : dimension.kind,
  );
  names.push(
    ...aggregation.measures.map((measure) => {
      switch (measure.function) {
        case "count":
          return "count";
        case "countDistinct":
          return "countDistinct";
        default:
          return `${measure.function}:${measure.id}`;
      }
    }),
  );
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    let index = 2;
    while (used.has(`${name}#${index}`)) index += 1;
    const suffixed = `${name}#${index}`;
    used.add(suffixed);
    return suffixed;
  });
}

export function compile(ast: QueryAst, options: CompileOptions = {}): CompiledQuery {
  return new Compiler(options).compile(ast);
}

export function compileAggregate(ast: QueryAst, options: CompileOptions = {}): CompiledAggregate {
  return new Compiler(options).compileAggregate(ast);
}

class Compiler {
  private readonly params: unknown[] = [];

  constructor(private readonly options: CompileOptions) {}

  private push(value: unknown): string {
    this.params.push(value);
    return "?";
  }

  compile(ast: QueryAst): CompiledQuery {
    if (ast.aggregation !== undefined) {
      const aggregate = this.aggregationSql(ast, ast.aggregation);
      return { sql: aggregate.sql, params: this.params };
    }

    const { from, where, hasDistance } = this.filteredFromWhere(ast);

    const columns = hasDistance ? "n.*, sc.distance AS distance" : "n.*";
    const sql =
      `SELECT ${columns}\nFROM ${from}\nWHERE ${where.join(" AND ")}\n` +
      `ORDER BY ${this.orderSql(ast.sort)}`;
    return { sql, params: this.params };
  }

  /**
   * Aggregation compilation: the same filtered-node set as the plain query
   * (scope joins + conditions) becomes a `filtered` CTE; the outer query
   * groups it by the dimensions and aggregates the measures. Zero dimensions
   * = one grand-total row (no GROUP BY). Column order is deterministic:
   * dimensions in declared order, then measures; labels are `isClass` /
   * `presentAsMain` / `class:<id>` / `property:<id>` / `count` /
   * `countDistinct` / `<fn>:<id>` (collisions suffixed `#2`, `#3`, …).
   * `sort` does not apply to aggregates — the grid is ordered by its
   * dimension expressions.
   */
  compileAggregate(ast: QueryAst): CompiledAggregate {
    if (ast.aggregation === undefined) {
      throw new Error("query compile: compileAggregate requires an AST with an aggregation");
    }
    const aggregate = this.aggregationSql(ast, ast.aggregation);
    return { sql: aggregate.sql, params: this.params, columns: aggregate.columns };
  }

  private aggregationSql(
    ast: QueryAst,
    aggregation: Aggregation,
  ): { sql: string; columns: string[] } {
    const { from, where } = this.filteredFromWhere(ast);
    const dimExprs = aggregation.dimensions.map((dimension) => this.dimensionSql(dimension));
    const measureExprs = aggregation.measures.map((measure) => this.measureSql(measure));
    const columns = aggregationColumns(aggregation);
    // GROUP BY/ORDER BY reference the output aliases: repeating the
    // expressions would repeat their `?` placeholders (one param push per
    // generation), and SQLite resolves result-column names in both clauses.
    const dimAliases = columns.slice(0, dimExprs.length).map((column) => `"${column}"`);
    const selectList = [...dimExprs, ...measureExprs].map(
      (expr, index) => `${expr} AS "${columns[index]}"`,
    );
    let sql =
      "WITH filtered AS (\n" +
      "SELECT n.id, n.is_class, n.present_as_main, n.class_ids\n" +
      `FROM ${from}\n` +
      `WHERE ${where.join(" AND ")}\n` +
      ")\n" +
      `SELECT ${selectList.join(", ")}\nFROM filtered f\n`;
    if (dimExprs.length > 0) {
      sql += `GROUP BY ${dimAliases.join(", ")}\n`;
      sql += `ORDER BY ${dimAliases.join(", ")} ASC`;
    }
    return { sql, columns };
  }

  // --- aggregation ----------------------------------------------------------------

  private dimensionSql(dimension: AggregationDimension): string {
    switch (dimension.kind) {
      case "isClass":
        return "f.is_class";
      case "presentAsMain":
        return "f.present_as_main";
      case "class": {
        // Same membership probe as the class condition: class_hierarchy
        // carries the extends closure (self-row included). The key is the
        // boolean membership (1/0) — a node is or is not in the class.
        const classId = this.push(dimension.id);
        return (
          "CASE WHEN EXISTS (\n  SELECT 1 FROM json_each(f.class_ids)\n" +
          `  WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id = ${classId})\n` +
          ") THEN 1 ELSE 0 END"
        );
      }
      case "property":
        return this.effectiveValueSql(dimension.id);
    }
  }

  private measureSql(measure: AggregationMeasure): string {
    switch (measure.function) {
      case "count":
        return "COUNT(*)";
      case "countDistinct":
        return "COUNT(DISTINCT f.id)";
      case "sum":
      case "avg":
      case "min":
      case "max":
        // json_extract yields the JSON number for numeric values; text values
        // aggregate as SQLite's numeric coercion dictates (non-numeric text
        // sums error out — bind numeric schemas to sum/avg, as the builder does).
        return `${measure.function.toUpperCase()}(${this.effectiveValueSql(measure.id)})`;
    }
  }

  /**
   * The property_value suppression predicate shared by every authored read
   * (the PG5 visible set in SQL): no winning SLOT tombstone (legacy
   * positional path — full (hlc, actor) tuple) and no strictly-newer
   * ELEMENT tombstone (the row id IS the element id; add-wins ties).
   */
  private static visibleValuePredicate(alias: string): string {
    return (
      "NOT EXISTS (\n" +
      `  SELECT 1 FROM property_value_tombstone t\n` +
      `  WHERE t.node_id = ${alias}.node_id AND t.property_schema_id = ${alias}.property_schema_id\n` +
      `    AND t.idx = ${alias}.idx\n` +
      `    AND (t.hlc_physical, t.hlc_logical, COALESCE(t.actor_id, '')) >=\n` +
      `        (${alias}.hlc_physical, ${alias}.hlc_logical, COALESCE(${alias}.actor_id, ''))\n` +
      ")\n" +
      "AND NOT EXISTS (\n" +
      `  SELECT 1 FROM property_value_element_tombstone et\n` +
      `  WHERE et.element_id = ${alias}.id\n` +
      `    AND (et.hlc_physical, et.hlc_logical) >\n` +
      `        (${alias}.hlc_physical, ${alias}.hlc_logical)\n` +
      ")"
    );
  }

  /**
   * The effective/authored value at idx 0 of a property for the filtered node
   * (alias `f`) — the same read model as the property conditions: authored
   * idx-0 rows (visible-set suppressed) UNION the winning ACTIVE binding's
   * default when no authored row at idx 0 shadows it
   * (first-class-applied-wins; PC4 inactive bindings never derive), surfaced
   * as json_extract(value, '$'). Params per call: three schema ids (authored
   * filter, binding filter, derived-shadow check), mirroring propertySql's
   * parameter pattern.
   */
  private effectiveValueSql(schemaId: string): string {
    const authored = this.push(schemaId);
    const binding = this.push(schemaId);
    const shadow = this.push(schemaId);
    const tombstone = Compiler.visibleValuePredicate("pv");
    return (
      "(SELECT json_extract(ev.value, '$') FROM (\n" +
      `  SELECT pv.node_id, pv.value FROM property_value pv\n` +
      `  WHERE pv.property_schema_id = ${authored} AND pv.node_id = f.id AND pv.idx = 0 AND ${tombstone}\n` +
      "  UNION ALL\n" +
      "  SELECT wb.node_id, wb.default_value FROM (\n" +
      "    SELECT cms.node_id, cp.default_value,\n" +
      "           ROW_NUMBER() OVER (\n" +
      "             PARTITION BY cms.node_id\n" +
      "             ORDER BY cms.hlc_physical, cms.hlc_logical, cms.class_id\n" +
      "           ) AS rn\n" +
      "    FROM class_member_set cms\n" +
      "    JOIN class_property cp ON cp.class_id = cms.class_id\n" +
      `    WHERE cms.present = 1 AND cp.property_schema_id = ${binding} AND cp.active = 1\n` +
      "      AND cp.default_value IS NOT NULL\n" +
      "  ) wb\n" +
      "  WHERE wb.rn = 1 AND wb.node_id = f.id\n" +
      "    AND NOT EXISTS (\n" +
      "      SELECT 1 FROM property_value pv\n" +
      `      WHERE pv.node_id = wb.node_id AND pv.property_schema_id = ${shadow}\n` +
      `        AND pv.idx = 0 AND ${tombstone}\n` +
      "    )\n" +
      ") ev LIMIT 1)"
    );
  }

  // --- filtered set (shared by the plain query and the aggregation) ---------------

  private filteredFromWhere(ast: QueryAst): { from: string; where: string[]; hasDistance: boolean } {
    let from = "node n";
    let hasDistance = false;
    switch (ast.scope.type) {
      case "entire_workspace":
        break;
      case "pages":
        // Filtered in WHERE below; no scope join, no distance column.
        break;
      case "subtree":
        from += `\nJOIN (${this.subtreeSql(ast.scope.pageId)}) sc ON sc.id = n.id`;
        hasDistance = true;
        break;
      case "linkedTo":
        from += `\nJOIN (${this.linkedToSql(ast.scope.nodeId)}) sc ON sc.id = n.id`;
        hasDistance = true;
        break;
    }

    const where: string[] = ["n.is_active = 1"];
    if (ast.scope.type === "pages") {
      // Document-chrome predicate (Revision 11): non-class nodes that are
      // parentless (workspace documents) or present as main (a parent's
      // main-children zone). Inline blocks and classes are out.
      where.push("n.is_class = 0 AND (n.parent_id IS NULL OR n.present_as_main = 1)");
    }
    const group = this.groupSql(ast.root);
    if (group !== undefined) {
      where.push(`(${group})`);
    }
    return { from, where, hasDistance };
  }

  // --- scope -----------------------------------------------------------------

  /** Anchor-set seed for a single node (distance 0). */
  private anchorNodeSql(nodeId: string): string {
    return `SELECT id, 0 AS distance FROM node WHERE id = ${this.push(nodeId)}`;
  }

  /** Anchor-set seed for a nested group: the matching ACTIVE nodes (distance 0). */
  private groupAnchorsSql(root: Group): string {
    const group = this.groupSql(root);
    return (
      "SELECT n.id, 0 AS distance FROM node n WHERE n.is_active = 1" +
      (group !== undefined ? ` AND (${group})` : "")
    );
  }

  /** Anchor SET + descendants, one row per node, distance = levels below. */
  private subtreeSetSql(anchorsSql: string): string {
    return (
      "WITH RECURSIVE sub(id, distance) AS (\n" +
      `${anchorsSql}\n` +
      "  UNION ALL\n" +
      "  SELECT n.id, sub.distance + 1 FROM sub JOIN node n ON n.parent_id = sub.id\n" +
      ") SELECT id, distance FROM sub"
    );
  }

  /** Anchor + descendants — the single-anchor convenience over subtreeSetSql. */
  private subtreeSql(anchorId: string): string {
    return this.subtreeSetSql(this.anchorNodeSql(anchorId));
  }

  /**
   * backlinksWithRollup membership (Store.backlinksWithRollup shape): direct
   * edges targeting the anchor (distance 0), UNION containment edges — source
   * strictly inside the anchor's subtree linking OUT of it (distance = source
   * depth). One row per source node, MIN(distance) collapses duplicates.
   */
  /**
   * backlinksWithRollup membership over a TARGET SET (the dynamic form the
   * v1 reference blocks had): targets = the anchor rows themselves; sub =
   * targets ∪ their subtrees; hits = direct edges to ANY target, UNION
   * sources inside any subtree linking OUTSIDE the whole sub union. The
   * single-anchor form reduces to the original linkedTo semantics exactly
   * (direct edges to the anchor only; containment roll-up outward).
   */
  private linkedToSetSql(targetsSql: string): string {
    return (
      "WITH RECURSIVE anchors AS (" + targetsSql + "),\n" +
      "sub(id, distance) AS (\n" +
      "  SELECT id, 0 AS distance FROM anchors\n" +
      "  UNION ALL\n" +
      "  SELECT n.id, sub.distance + 1 FROM sub JOIN node n ON n.parent_id = sub.id\n" +
      "), hits AS (\n" +
      "  SELECT e.source_id AS id, 0 AS distance FROM edge e\n" +
      "  WHERE e.target_id IN (SELECT id FROM anchors)\n" +
      "  UNION ALL\n" +
      "  SELECT e.source_id, sub.distance FROM edge e\n" +
      "  JOIN sub ON sub.id = e.source_id\n" +
      "  WHERE sub.distance > 0 AND e.target_id NOT IN (SELECT id FROM sub)\n" +
      ") SELECT id, MIN(distance) AS distance FROM hits GROUP BY id"
    );
  }

  /** Single-node backlinksWithRollup membership (the scope + static condition form). */
  private linkedToSql(nodeId: string): string {
    return this.linkedToSetSql(this.anchorNodeSql(nodeId));
  }

  // --- group / not --------------------------------------------------------------

  private groupSql(group: Group): string | undefined {
    const clauses: string[] = [];
    for (const child of group.children) {
      if (child.type === "group") {
        const nested = this.groupSql(child);
        if (nested !== undefined) clauses.push(`(${nested})`);
      } else if (child.type === "not") {
        clauses.push(this.notSql(child));
      } else {
        clauses.push(this.conditionSql(child));
      }
    }
    if (clauses.length === 0) return undefined; // empty group = no constraint
    return clauses.join(group.logic === "or" ? " OR " : " AND ");
  }

  private notSql(node: Not): string {
    const inner =
      node.child.type === "group" ? this.groupSql(node.child) : this.conditionSql(node.child);
    return `NOT (${inner ?? "1=1"})`;
  }

  // --- conditions -----------------------------------------------------------------

  private conditionSql(condition: Condition): string {
    switch (condition.type) {
      case "class": {
        // class_hierarchy includes the self-row (class, class), so direct
        // members match too; extends-transitive members match via descendants.
        const classId = this.push(condition.classId);
        return (
          "EXISTS (\n  SELECT 1 FROM json_each(n.class_ids)\n" +
          `  WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id = ${classId})\n` +
          ")"
        );
      }
      case "isClass":
        return `n.is_class = ${this.push(condition.isClass ? 1 : 0)}`;
      case "presentAsMain":
        return `n.present_as_main = ${this.push(condition.presentAsMain ? 1 : 0)}`;
      case "content":
        return this.contentSql(condition);
      case "property":
        return this.propertySql(condition);
      case "linkedTo":
        // Condition form: membership only (single-column projection; the
        // scope form joins the same CTE for its distance column).
        return `n.id IN (SELECT id FROM (${this.linkedToSql(condition.nodeId)}))`;
      case "descendantOf": {
        // Ancestor-chain membership: the row sits inside the anchor's
        // subtree (anywhere up its parents tree) — subtree membership minus
        // the anchor row itself ("has X as a parent", self excluded).
        // subtreeSql first: its placeholder must precede the anchor's
        // (params bind positionally, in evaluation order).
        const subtree = this.subtreeSql(condition.nodeId);
        const anchor = this.push(condition.nodeId);
        return `n.id IN (SELECT id FROM (${subtree})) AND n.id != ${anchor}`;
      }
      case "createdAfter":
        return `n.created_at >= ${this.push(
          resolveTimestampPlaceholder(condition.timestamp, "after", this.options),
        )}`;
      case "createdBefore":
        return `n.created_at <= ${this.push(
          resolveTimestampPlaceholder(condition.timestamp, "before", this.options),
        )}`;
      case "updatedAfter":
        return `n.updated_at >= ${this.push(
          resolveTimestampPlaceholder(condition.timestamp, "after", this.options),
        )}`;
      case "updatedBefore":
        return `n.updated_at <= ${this.push(
          resolveTimestampPlaceholder(condition.timestamp, "before", this.options),
        )}`;
      case "linkedToQuery":
        // Dynamic links-to: the target set is the nested group's matches.
        return `n.id IN (SELECT id FROM (${this.linkedToSetSql(this.groupAnchorsSql(condition.root))}))`;
      case "descendantOfQuery": {
        // Dynamic parent: the ancestor chain contains ANY node matching the
        // nested group — subtree membership of the anchor set, anchors excluded.
        // Both subqueries are built before the string (params bind in text order).
        const subtree = this.subtreeSetSql(this.groupAnchorsSql(condition.root));
        const anchors = this.groupAnchorsSql(condition.root);
        return (
          `n.id IN (SELECT id FROM (${subtree}))` +
          ` AND n.id NOT IN (SELECT id FROM (${anchors}))`
        );
      }
      case "coverAsset":
        return this.nodeFieldSql("coverAsset", "cover_asset_id", condition);
      case "bannerAsset":
        return this.nodeFieldSql("bannerAsset", "banner_asset_id", condition);
      case "aliasedNode":
        return this.nodeFieldSql("aliasedNode", "aliased_node_id", condition);
      default:
        throw new Error(
          `query compile: unknown condition type ${(condition as { type: string }).type}`,
        );
    }
  }

  /**
   * A wire-field predicate compiles straight into the node-table column
   * (store schema v16): exists = the IS NOT NULL probe; eq/neq compare the
   * reference id. SQL NULL semantics hold — an unset field matches neither
   * eq nor neq — so "is unset" reads `not exists`, not `neq`.
   */
  private nodeFieldSql(
    type: "coverAsset" | "bannerAsset" | "aliasedNode",
    column: string,
    condition: { op: "eq" | "neq" | "exists"; value?: string | undefined },
  ): string {
    if (condition.op === "exists") {
      return `n.${column} IS NOT NULL`;
    }
    if (condition.value === undefined || condition.value === null) {
      throw new Error(`query compile: ${type} op '${condition.op}' requires a non-null value`);
    }
    return `n.${column} ${condition.op === "eq" ? "=" : "!="} ${this.push(condition.value)}`;
  }

  private contentSql(condition: Extract<Condition, { type: "content" }>): string {
    if (condition.op === "fts") {
      const match = buildMatchExpression(condition.value);
      if (match === null) {
        throw new Error(
          "query compile: content fts value produced no search terms " +
            JSON.stringify(condition.value),
        );
      }
      const param = this.push(match);
      return (
        "EXISTS (\n  SELECT 1 FROM search_index_docid d\n" +
        "  JOIN search_index s ON s.rowid = d.docid\n" +
        `  WHERE d.node_id = n.id AND search_index MATCH ${param}\n` +
        ")"
      );
    }
    const param = this.push(condition.value);
    // LIKE is ASCII case-insensitive (SQLite default), matching the
    // case-insensitive contains; the pattern builds around the parameter.
    return (
      "EXISTS (\n  SELECT 1 FROM search_index_docid d\n" +
      "  JOIN search_index s ON s.rowid = d.docid\n" +
      `  WHERE d.node_id = n.id AND s.content LIKE '%' || ${param} || '%'\n` +
      ")"
    );
  }

  /**
   * Effective-values read (store effective.ts semantics): tombstone-suppressed
   * authored property_value rows UNION derived binding defaults for nodes with
   * no authored value at idx 0. eq/contains are value-level (any effective row
   * matches); neq is the not_equals port — "has at least one effective
   * value different from v" — so nodes with NO effective value do not match
   * (pair with `exists` if unset nodes should count). gt/gte/lt/lte are the
   * GREATER_THAN/LESS_THAN family: json_extract yields JSON numbers as
   * numeric values (numeric comparison) and everything else as text
   * (lexicographic — ISO-8601 dates order correctly); the bound value keeps
   * the type the caller gave it.
   *
   * ISO-date bound values (YYYY-MM-DD) gain a second arm for the SCHEMA.md
   * "Datetime" value shapes: datetime property values are a POINT
   * `{ "nodeId": <deterministic date-node id> }` (optionally timed) or a
   * RANGE `{ "start": slot|null, "end": slot|null }` — the id embeds the
   * date, layout frozen (packages/domain/src/dates.ts): id chars 22..23 are
   * the precision marker (dd/aa/bb — the last two of the `00dd`/`00aa`/`00bb`
   * segment), chars 25..36 the zero-padded date payload. eq/contains match
   * when the bound date falls within the value's period — for a point, the
   * referenced period CONTAINS the bound (a year-precision value answers any
   * date of that year); for a range, the bound lies within [start, end] with
   * open sides unbounded. Relational ops compare the payload, which orders
   * chronologically across precisions — a period compares at its start; for
   * a range the START payload is the comparator (a null start never matches
   * a relational op). Date-only bounds ignore `time` on values (a timed
   * point sorts with its day). Plain scalar values (e.g. binding defaults)
   * keep matching through the unchanged first arm.
   */
  private propertySql(condition: Extract<Condition, { type: "property" }>): string {
    const valueOps: readonly PropertyOp[] = ["eq", "neq", "contains", "gt", "gte", "lt", "lte"];
    // The comparison bound rides the placeholder clock: a `{today}`-style
    // token resolves to the period start as a plain YYYY-MM-DD date (the
    // hand-typed shape — the ISO-date arms below apply to it). contains is
    // a text-substring op and exists carries no value: neither resolves.
    const bound =
      typeof condition.value === "string" &&
      condition.op !== "contains" &&
      condition.op !== "exists"
        ? resolveValuePlaceholder(condition.value, this.options)
        : condition.value;
    if (valueOps.includes(condition.op) && (bound === undefined || bound === null)) {
      throw new Error(`query compile: property op '${condition.op}' requires a non-null value`);
    }
    const includeDefaults = condition.includeDefaults ?? true;

    const schemaId = this.push(condition.schemaId);
    let ctes =
      `WITH authored AS (\n` +
      `  SELECT pv.node_id AS node_id, pv.value AS value\n` +
      `  FROM property_value pv\n` +
      `  WHERE pv.property_schema_id = ${schemaId}\n` +
      `    AND ${Compiler.visibleValuePredicate("pv")}\n` +
      `)`;

    let unions = "SELECT node_id, value FROM authored";
    if (includeDefaults) {
      const bindingSchemaId = this.push(condition.schemaId);
      const authoredSchemaId = this.push(condition.schemaId);
      ctes +=
        `,\nderived AS (\n` +
        `  SELECT wb.node_id AS node_id, wb.default_value AS value\n` +
        `  FROM (\n` +
        `    SELECT cms.node_id, cp.default_value,\n` +
        `           ROW_NUMBER() OVER (\n` +
        `             PARTITION BY cms.node_id\n` +
        `             ORDER BY cms.hlc_physical, cms.hlc_logical, cms.class_id\n` +
        `           ) AS rn\n` +
        `    FROM class_member_set cms\n` +
        `    JOIN class_property cp ON cp.class_id = cms.class_id\n` +
        `    WHERE cms.present = 1 AND cp.property_schema_id = ${bindingSchemaId} AND cp.active = 1\n` +
        `      AND cp.default_value IS NOT NULL\n` +
        `  ) wb\n` +
        `  WHERE wb.rn = 1\n` +
        `    AND NOT EXISTS (\n` +
        `      SELECT 1 FROM property_value pv\n` +
        `      WHERE pv.node_id = wb.node_id AND pv.property_schema_id = ${authoredSchemaId}\n` +
        `        AND pv.idx = 0\n` +
        `        AND ${Compiler.visibleValuePredicate("pv")}\n` +
        `    )\n` +
        `)`;
      unions += "\nUNION ALL\nSELECT node_id, value FROM derived";
    }

    let predicate = "";
    const boundIso =
      typeof bound === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bound) ? bound : null;
    if (condition.op === "eq") {
      const scalar = `json_extract(value, '$') = ${this.push(bound)}`;
      predicate =
        boundIso !== null ? `WHERE ${scalar} OR ${this.dateRefSql("=", boundIso)}` : `WHERE ${scalar}`;
    } else if (condition.op === "neq") {
      if (boundIso !== null) {
        const scalar = `json_extract(value, '$') = ${this.push(bound)}`;
        predicate = `WHERE NOT (${scalar} OR ${this.dateRefSql("=", boundIso)})`;
      } else {
        predicate = `WHERE json_extract(value, '$') != ${this.push(bound)}`;
      }
    } else if (condition.op === "contains") {
      const scalar = `CAST(json_extract(value, '$') AS TEXT) LIKE '%' || ${this.push(condition.value)} || '%'`;
      predicate =
        boundIso !== null ? `WHERE ${scalar} OR ${this.dateRefSql("=", boundIso)}` : `WHERE ${scalar}`;
    } else if (condition.op !== "exists") {
      // gt/gte/lt/lte — plain comparison over the extracted scalar (numeric
      // for JSON numbers, lexicographic for text such as ISO-8601 dates).
      const sqlOp = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[condition.op];
      if (boundIso !== null) {
        // The scalar arm is gated to non-object values: a { "nodeId": … } ref
        // would otherwise compare as raw JSON text ('{' sorts after digits).
        const scalar =
          `json_type(value, '$') != 'object' AND json_extract(value, '$') ${sqlOp} ${this.push(bound)}`;
        predicate = `WHERE (${scalar}) OR ${this.dateRefSql(sqlOp, boundIso)}`;
      } else {
        predicate = `WHERE json_extract(value, '$') ${sqlOp} ${this.push(bound)}`;
      }
    }

    const membership = `n.id IN (\n  ${ctes},\n  effective AS (\n  ${unions}\n  )\n  SELECT node_id FROM effective\n  ${predicate}\n)`;
    return membership;
  }

  /**
   * Date-ref match arms over the deterministic date-node ids carried in the
   * datetime value union (see propertySql's doc): the POINT arm reads the
   * top-level `{ "nodeId": … }` (ranges have no such key, so the two arms
   * are disjoint and compose with OR); the RANGE arm reads
   * `$.start.nodeId` / `$.end.nodeId`, gated on the value actually carrying
   * a `start`/`end` key (json_type reports a JSON null side as 'null', a
   * missing key as NULL — so `{start: null, end: null}` still counts as a
   * range). `"="` matches when the bound date falls within the value's
   * period: for a range, start's period-start payload <= the bound (payload
   * orders chronologically across precisions) AND the bound's date part at
   * the end's precision width is >= end's (a month end answers any day of
   * that month); a null side is unbounded on that end. Comparison ops
   * compare the range's START payload (period-start semantics); a null
   * start never matches a relational op. Params are pushed in arm order —
   * point arm first, then the range arm (start payload bound, then the
   * end-side day/month/year bounds).
   */
  private dateRefSql(op: string, iso: string): string {
    const compact = iso.replace(/-/g, "");
    const nodeId = "json_extract(value, '$.nodeId')";
    const marker = `substr(${nodeId}, 22, 2)`;
    const startId = "json_extract(value, '$.start.nodeId')";
    const startMarker = `substr(${startId}, 22, 2)`;
    const endId = "json_extract(value, '$.end.nodeId')";
    const endMarker = `substr(${endId}, 22, 2)`;
    const rangeGate =
      "(json_type(value, '$.start') IS NOT NULL OR json_type(value, '$.end') IS NOT NULL)";
    if (op === "=") {
      const pointArm =
        `(${marker} = 'dd' AND substr(${nodeId}, 25, 8) = ${this.push(compact)} ` +
        `OR ${marker} = 'aa' AND ${this.push(compact.slice(0, 6))} = substr(${nodeId}, 25, 6) ` +
        `OR ${marker} = 'bb' AND ${this.push(compact.slice(0, 4))} = substr(${nodeId}, 25, 4))`;
      const startPayload = this.push(`${compact}0000`);
      const endDay = this.push(compact);
      const endMonth = this.push(compact.slice(0, 6));
      const endYear = this.push(compact.slice(0, 4));
      const rangeArm =
        `${rangeGate} ` +
        `AND (${startId} IS NULL OR ${startMarker} IN ('dd', 'aa', 'bb') AND substr(${startId}, 25) <= ${startPayload}) ` +
        `AND (${endId} IS NULL OR (${endMarker} = 'dd' AND substr(${endId}, 25, 8) >= ${endDay} ` +
        `OR ${endMarker} = 'aa' AND substr(${endId}, 25, 6) >= ${endMonth} ` +
        `OR ${endMarker} = 'bb' AND substr(${endId}, 25, 4) >= ${endYear}))`;
      return `(${pointArm} OR ${rangeArm})`;
    }
    const pointArm = `(${marker} IN ('dd', 'aa', 'bb') AND substr(${nodeId}, 25) ${op} ${this.push(`${compact}0000`)})`;
    const rangeArm =
      `${rangeGate} AND ${startMarker} IN ('dd', 'aa', 'bb') ` +
      `AND substr(${startId}, 25) ${op} ${this.push(`${compact}0000`)}`;
    return `(${pointArm} OR (${rangeArm}))`;
  }

  // --- sort -----------------------------------------------------------------------

  private orderSql(sort: SortSpec[] | undefined): string {
    const terms: string[] = [];
    for (const spec of sort ?? []) {
      const { column, nullable } = SORT_COLUMNS[spec.field];
      const dir = spec.dir === "desc" ? "DESC" : "ASC";
      // NULLs last on nullable columns (SQLite 3.30+ NULLS LAST would work,
      // but IS NULL is portable across both FTS4/FTS5-era sql.js builds).
      if (nullable) terms.push(`${column} IS NULL`, `${column} ${dir}`);
      else terms.push(`${column} ${dir}`);
    }
    terms.push("n.id ASC");
    return terms.join(", ");
  }
}
