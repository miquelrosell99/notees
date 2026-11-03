/**
 * QueryAST v2 -> SQLite compiler over the derived schema.
 *
 * Port of the `frontend/src/core/query/compileToSqlite.ts` CONCEPTS,
 * adapted to the current store (packages/store):
 *  - the Revision-12 booleans (`node.is_class`, `node.is_embedded`)
 *    replace node_type; `is_active = 1` excludes deleted nodes on every
 *    query (the store's read helpers do the same);
 *  - the reference index is `edge` (never authored) — the links family
 *    (backlinksWithRollup conditions/scopes) mirrors
 *    `Store.backlinksWithRollup` (direct + containment roll-up, distance in
 *    subtree levels);
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
 *  - scopes/conditions outside the AST subset (style marks, regex, flags)
 *    are not part of the model.
 */

import type {
  Aggregation,
  AggregationDimension,
  AggregationMeasure,
  Condition,
  ContentOp,
  DateOp,
  DatePeriod,
  Group,
  MemberCondition,
  MemberFamily,
  Not,
  PropertyOp,
  QueryAst,
  SortSpec,
  TargetRef,
} from "./ast.js";
import {
  placeholderEndDate,
  placeholderStartDate,
  resolveDayBounds,
  resolvePeriodBounds,
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
 * compile, so a saved view re-evaluates on the day it runs.
 */
export interface CompileOptions extends PlaceholderContext {
  /**
   * The hosting page for the `self` member target mode (`{ mode: "self" }`):
   * the page the query block sits on, supplied by the run site (never baked
   * into the AST — the same AST must mean "this page" wherever it runs). A
   * self target compiling WITHOUT this option FAILS LOUD (there is no honest
   * reading of "self" without a host). This is the deliberate
   * re-introduction of the once-reserved `currentNodeId` compile context —
   * dead while "this page" was baked at write time, alive again under the
   * explicit self target.
   */
  selfNodeId?: string | undefined;
}

/**
 * Prefix-AND FTS match expression for query-block filters (modeled on the
 * store's buildMatchQuery — kept here so the query package stays
 * standalone, dependency-free). Each maximal run of letters/digits OUTSIDE
 * double quotes becomes a bare prefix token (`term*`); each
 * double-quoted segment becomes an exact FTS phrase (valid MATCH syntax on
 * FTS4 and FTS5 alike). Splitting at every non-alphanumeric boundary
 * mirrors the unicode61 tokenizer ("11607-1" → `11607* AND 1*`). Null when
 * nothing searchable remains. INTENTIONAL divergence from the store's
 * search: a filter's contains stays conjunctive (AND) —
 * filter rows demand every term; the search surface ORs bare terms and
 * tiers whole-query matches above partials.
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

/**
 * The title (the flattened content text) for the node row aliased `alias` —
 * title-is-content: concatenating the text-run tokens of the content JSON,
 * the exact expression sort-by-name orders by. group_concat yields NULL
 * when no text run rides the content (an untitled row).
 */
function titleSql(alias: string): string {
  return (
    `(SELECT group_concat(json_extract(j.value, '$.text'), ' ') FROM json_each(${alias}.content) j ` +
    `WHERE json_extract(j.value, '$.type') = 'text')`
  );
}

const SORT_COLUMNS: Record<
  SortSpec["field"],
  { column: string; nullable: boolean; nocase?: boolean }
> = {
  // Title-is-content: the title is the node's content text (the name column
  // is retired). NULL/empty titles fall to the id tiebreak the runner
  // appends. The name sort folds case (NOCASE): "a" sorts before "B", the
  // case-insensitive A–Z the client-side comparators (localeCompare
  // sensitivity "base") already ride.
  name: { column: titleSql("n"), nullable: true, nocase: true },
  createdAt: { column: "n.created_at", nullable: true },
  isClass: { column: "n.is_class", nullable: false },
  isEmbedded: { column: "n.is_embedded", nullable: false },
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
   * `isEmbedded` / `class:<id>` / `property:<id>` / `count` /
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
      "SELECT n.id, n.is_class, n.is_embedded, n.class_ids\n" +
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
      case "isEmbedded":
        return "f.is_embedded";
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
      "    SELECT cms.node_id, ps.default_value,\n" +
      "           ROW_NUMBER() OVER (\n" +
      "             PARTITION BY cms.node_id\n" +
      "             ORDER BY cms.hlc_physical, cms.hlc_logical, cms.class_id\n" +
      "           ) AS rn\n" +
      "    FROM class_member_set cms\n" +
      "    JOIN class_property cp ON cp.class_id = cms.class_id\n" +
      "    JOIN property_schema ps ON ps.id = cp.property_schema_id\n" +
      `    WHERE cms.present = 1 AND cp.property_schema_id = ${binding} AND cp.active = 1\n` +
      "      AND ps.default_value IS NOT NULL\n" +
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
      // Document-chrome predicate (Revision 12): non-class nodes that are
      // parentless (workspace documents) or carry the standalone claim under
      // a page parent (the parent's main-children zone). Inline blocks and
      // classes are out. The parentless arm is parentlessRole-aware: a parentless node whose classes effectively carry
      // parentlessRole "block" renders Block-role and stays OUT of the pages
      // scope (the is_embedded bit is flag-unread for it, so the demote is a
      // separate conjunct over the whole parentless population).
      where.push(
        "n.is_class = 0 AND (n.parent_id IS NULL OR n.is_embedded = 0)" +
          ` AND (n.parent_id IS NOT NULL OR NOT ${this.hasParentlessBlockClassSql("n")})`,
      );
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

  /**
   * The SELF id (the `self` member target mode): CompileOptions.selfNodeId,
   * failing loud when the run site supplied no host — there is no honest
   * reading of "self" without one.
   */
  private selfIdValue(): string {
    if (this.options.selfNodeId === undefined || this.options.selfNodeId === "") {
      throw new Error(
        "query compile: a '*Self' condition requires CompileOptions.selfNodeId (the query's hosting page)",
      );
    }
    return this.options.selfNodeId;
  }

  /** The SELF id as one `?` param. */
  private selfId(): string {
    return this.push(this.selfIdValue());
  }

  /** Anchor-set seed for the SELF family: the hosting page (distance 0). */
  private selfAnchorSql(): string {
    return `SELECT id, 0 AS distance FROM node WHERE id = ${this.selfId()}`;
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

  /**
   * The v2 condition set — six types. `member` folds the v1 45-variant
   * node-target family (family × op × target-mode axes made explicit);
   * `content` folds contentSet (op exists); `property` folds
   * propertyBetween/propertyWithin (ops between/within); `date` folds the
   * ten created-/updated- types (the field axis); `nodeField` folds
   * isClass/isEmbedded (eq "true"/"false").
   */
  private conditionSql(condition: Condition): string {
    switch (condition.type) {
      case "member":
        return this.memberSql(condition);
      case "content": {
        if (condition.op === "exists") {
          // The title/content plaintext is non-empty (the content "is set").
          return (
            "EXISTS (\n  SELECT 1 FROM search_index_docid d\n" +
            "  JOIN search_index s ON s.rowid = d.docid\n" +
            "  WHERE d.node_id = n.id AND length(s.content) > 0\n)"
          );
        }
        return this.contentSql(condition);
      }
      case "name":
        return this.nameSql(condition);
      case "property": {
        if (condition.op === "between") {
          return this.propertyRangeSql(condition.schemaId, condition.from, condition.to);
        }
        if (condition.op === "within") {
          return this.propertyWithinSql(condition.schemaId, condition.period);
        }
        return this.propertySql({
          type: "property",
          schemaId: condition.schemaId,
          op: condition.op,
          value: condition.value,
          includeDefaults: condition.includeDefaults,
        });
      }
      case "date":
        return this.dateSql(condition);
      case "nodeField": {
        if (condition.field === "isClass" || condition.field === "isEmbedded") {
          // The Revision-12 booleans ride op "eq" with value "true"/"false".
          if (condition.op !== "eq") {
            throw new Error(
              `query compile: nodeField '${condition.field}' supports only op 'eq'`,
            );
          }
          if (condition.value !== "true" && condition.value !== "false") {
            throw new Error(
              `query compile: nodeField '${condition.field}' requires value "true" or "false"`,
            );
          }
          const column = condition.field === "isClass" ? "is_class" : "is_embedded";
          return `n.${column} = ${this.push(condition.value === "true" ? 1 : 0)}`;
        }
        const columns = {
          coverAsset: "cover_asset_id",
          bannerAsset: "banner_asset_id",
          aliasedNode: "aliased_node_id",
        } as const;
        return this.nodeFieldSql(condition.field, columns[condition.field], condition);
      }
      default:
        throw new Error(
          `query compile: unknown condition type ${(condition as { type: string }).type}`,
        );
    }
  }

  /**
   * The member condition — family × op × target mode. `in`/`not-in` compile
   * the family's membership predicate over the resolved target set (negated
   * for `not-in`); `exists`/`not-exists` compile the family's emptiness read
   * (negated for `not-exists`); class `exact` is the exact class-set equality.
   * Every predicate is built BEFORE the string composes, so `?` params bind
   * in evaluation order regardless of the wrapping.
   */
  private memberSql(condition: MemberCondition): string {
    switch (condition.op) {
      case "in":
      case "not-in": {
        const predicate = this.memberInSql(condition.family, condition.target);
        return condition.op === "not-in" ? `NOT (${predicate})` : predicate;
      }
      case "exists":
      case "not-exists": {
        const predicate = this.memberExistsSql(condition.family);
        return condition.op === "not-exists" ? `NOT (${predicate})` : predicate;
      }
      case "exact": {
        // EXACT class-set equality (the Odoo "=" register): exactly one class
        // rides the row AND it is the picked one — the closure deliberately
        // does NOT apply ("exactly Day, nothing else").
        const classId = this.push(condition.target.ids[0]);
        return (
          "(SELECT COUNT(*) FROM json_each(n.class_ids)) = 1\n" +
          `AND EXISTS (\n  SELECT 1 FROM json_each(n.class_ids) WHERE value = ${classId}\n)`
        );
      }
    }
  }

  /**
   * The family's `in` predicate over the target set (the v1 static/dynamic/
   * self per-family arms, unchanged SQL). The target mode selects the anchor
   * SQL: `ids` the family's manual pick, `query` the nested group's matches,
   * `self` the hosting page (CompileOptions.selfNodeId — fails loud without).
   */
  private memberInSql(family: MemberFamily, target: TargetRef): string {
    switch (family) {
      case "class": {
        if (target.mode === "ids") {
          // ANY-of membership (Odoo "one of") — closure-aware per picked id.
          // class_hierarchy includes the self-row (class, class), so direct
          // members match too; extends-transitive members match via descendants.
          const ids = target.ids.map((id) => this.push(id)).join(", ");
          return (
            "EXISTS (\n  SELECT 1 FROM json_each(n.class_ids)\n" +
            `  WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id IN (${ids}))\n)`
          );
        }
        if (target.mode === "self") {
          // The hosting page used as a class (closure-aware).
          const classId = this.selfId();
          return (
            "EXISTS (\n  SELECT 1 FROM json_each(n.class_ids)\n" +
            `  WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id = ${classId})\n)`
          );
        }
        // DYNAMIC class: closure-aware membership of ANY class matching the
        // nested group — the picked ids come from the group's matches (a
        // fresh `node n` scope). An empty nested group degrades to the
        // never-matching subquery (pruneChild drops empty dynamic roots
        // before compose).
        const group = this.groupSql(target.root);
        const targets =
          group !== undefined
            ? `SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group})`
            : "SELECT n.id FROM node n WHERE n.is_active = 0";
        return (
          "EXISTS (\n  SELECT 1 FROM json_each(n.class_ids)\n" +
          `  WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id IN (${targets}))\n)`
        );
      }
      case "tags": {
        let targets: string;
        if (target.mode === "ids") {
          targets = target.ids.map((id) => this.push(id)).join(", ");
        } else if (target.mode === "self") {
          targets = this.selfId();
        } else {
          // DYNAMIC tags: tagged with ANY tag matching the nested group — the
          // tag ids come from the group's matches (a fresh `node n` scope).
          // An empty nested group degrades to the never-matching subquery.
          const group = this.groupSql(target.root);
          targets =
            group !== undefined
              ? `SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group})`
              : "SELECT n.id FROM node n WHERE n.is_active = 0";
        }
        // Tag membership over the OR-set tag_ids (a tag is any page — no
        // hierarchy, so the probe is the literal id).
        return `EXISTS (\n  SELECT 1 FROM json_each(n.tag_ids)\n  WHERE value IN (${targets})\n)`;
      }
      case "links": {
        // backlinksWithRollup membership over the target set: `ids` an anchor
        // list, `query` the group's matches, `self` the one hosting-page
        // anchor (the single-anchor form reduces to the original
        // direct-edges + containment roll-up semantics exactly).
        const anchorSet =
          target.mode === "ids"
            ? "SELECT id, 0 AS distance FROM node WHERE id IN (" +
              target.ids.map((id) => this.push(id)).join(", ") +
              ")"
            : target.mode === "self"
              ? this.selfAnchorSql()
              : this.groupAnchorsSql(target.root);
        return `n.id IN (SELECT id FROM (${this.linkedToSetSql(anchorSet)}))`;
      }
      case "childPath": {
        if (target.mode === "ids") {
          // Subtree membership of ANY picked node, anchors excluded — the
          // anchor list reaches the NOT-IN through ONE json_each param:
          // unindexed `?` placeholders number per occurrence, so a repeated
          // list would re-bind wrong.
          const anchorIds = target.ids.map((id) => this.push(id)).join(", ");
          const anchorSet = `SELECT id, 0 AS distance FROM node WHERE id IN (${anchorIds})`;
          const subtree = this.subtreeSetSql(anchorSet);
          const exclude = this.push(JSON.stringify(target.ids));
          return (
            `n.id IN (SELECT id FROM (${subtree})) ` +
            `AND n.id NOT IN (SELECT value FROM json_each(${exclude}))`
          );
        }
        if (target.mode === "self") {
          // The row sits strictly inside the hosting page — subtree
          // membership of the self anchor, the anchor excluded. Both
          // subqueries are built before the string (params bind in text order).
          const subtree = this.subtreeSetSql(this.selfAnchorSql());
          const anchor = this.selfId();
          return `n.id IN (SELECT id FROM (${subtree})) AND n.id != ${anchor}`;
        }
        // DYNAMIC childPath: the ancestor chain contains ANY node matching
        // the nested group — subtree membership of the anchor set, anchors
        // excluded. Both subqueries are built before the string (params bind
        // in text order).
        const subtree = this.subtreeSetSql(this.groupAnchorsSql(target.root));
        const anchors = this.groupAnchorsSql(target.root);
        return (
          `n.id IN (SELECT id FROM (${subtree}))` +
          ` AND n.id NOT IN (SELECT id FROM (${anchors}))`
        );
      }
      case "parent": {
        if (target.mode === "ids") {
          // The DIRECT parent (one hop up) is one of the picked nodes (one
          // json_each param). The COALESCE maps the parentless NULL to '' so
          // the empty parent reads two-valued — matching the sync evaluator
          // (a parentless row matches the negation; the dedicated is-set/
          // is-not-set operators own the empty test).
          const ids = this.push(JSON.stringify(target.ids));
          return `COALESCE(n.parent_id, '') IN (SELECT value FROM json_each(${ids}))`;
        }
        if (target.mode === "self") {
          // The direct parent IS the hosting page (the COALESCE keeps the
          // parentless NULL two-valued, like the ids form).
          return `COALESCE(n.parent_id, '') = ${this.selfId()}`;
        }
        // DYNAMIC parent: the direct parent is one of the group's matches.
        const group = this.groupSql(target.root);
        const inner =
          group !== undefined
            ? ` AND p.id IN (SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group}))`
            : "";
        return (
          "EXISTS (\n  SELECT 1 FROM node p\n" +
          `  WHERE p.id = n.parent_id AND p.is_active = 1${inner}\n)`
        );
      }
      case "child": {
        if (target.mode === "ids") {
          // A DIRECT child is one of the picked nodes (one json_each param).
          const ids = this.push(JSON.stringify(target.ids));
          return (
            "EXISTS (\n  SELECT 1 FROM node c\n" +
            `  WHERE c.parent_id = n.id AND c.is_active = 1 AND c.id IN (SELECT value FROM json_each(${ids}))\n)`
          );
        }
        if (target.mode === "self") {
          // A direct child IS the hosting page.
          return (
            "EXISTS (\n  SELECT 1 FROM node c\n" +
            `  WHERE c.parent_id = n.id AND c.is_active = 1 AND c.id = ${this.selfId()}\n)`
          );
        }
        // DYNAMIC child: a direct child is one of the group's matches.
        const group = this.groupSql(target.root);
        const inner =
          group !== undefined
            ? ` AND c.id IN (SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group}))`
            : "";
        return (
          "EXISTS (\n  SELECT 1 FROM node c\n" +
          `  WHERE c.parent_id = n.id AND c.is_active = 1${inner}\n)`
        );
      }
      case "referencePath": {
        if (target.mode === "ids") {
          return this.referencePathSql(
            `SELECT value AS id FROM json_each(${this.push(JSON.stringify(target.ids))})`,
          );
        }
        if (target.mode === "self") {
          // The rollup target IS the hosting page.
          return this.referencePathSql(this.selfAnchorSql());
        }
        // DYNAMIC referencePath: the rollup targets are the group's matches.
        const group = this.groupSql(target.root);
        const targets =
          group !== undefined
            ? `SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group})`
            : "SELECT n.id FROM node n WHERE n.is_active = 0";
        return this.referencePathSql(targets);
      }
      case "page": {
        if (target.mode === "ids") {
          // The CONTAINING PAGE (nearest self-or-ancestor rendering with
          // document chrome) is one of the picked nodes. The page id rides
          // the correlated scalar subquery; the pick reaches it through ONE
          // json_each param.
          const ids = this.push(JSON.stringify(target.ids));
          return `EXISTS (\n  SELECT 1 FROM json_each(${ids})\n  WHERE value = ${this.containingPageIdSql()}\n)`;
        }
        if (target.mode === "self") {
          // The containing page IS the hosting page — the ids form over the
          // one-element self list.
          const ids = this.push(JSON.stringify([this.selfIdValue()]));
          return `EXISTS (\n  SELECT 1 FROM json_each(${ids})\n  WHERE value = ${this.containingPageIdSql()}\n)`;
        }
        // DYNAMIC page: the containing page is one of the group's matches.
        // The group rides a fresh `node n` scope (its conditions bind the
        // inner alias); the page id correlates to the outer row.
        const group = this.groupSql(target.root);
        const inner =
          group !== undefined
            ? ` AND page.id IN (SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group}))`
            : "";
        return (
          "EXISTS (\n  SELECT 1 FROM node page\n" +
          `  WHERE page.id = ${this.containingPageIdSql()} AND page.is_active = 1${inner}\n)`
        );
      }
      case "parentPath": {
        const anc = (where: string) =>
          "EXISTS (\n  WITH RECURSIVE anc(id, depth) AS (\n" +
          "    SELECT nd.parent_id, 0 FROM node nd WHERE nd.id = n.id\n" +
          "    UNION ALL\n" +
          "    SELECT nd.parent_id, anc.depth + 1 FROM node nd JOIN anc ON nd.id = anc.id\n" +
          "    WHERE anc.id IS NOT NULL AND anc.depth < 64\n" +
          "  )\n" +
          `  ${where}\n)`;
        if (target.mode === "ids") {
          // Some STRICT ancestor (the parent path, self excluded) is one of
          // the picked nodes (the ids ride one json_each param).
          const ids = this.push(JSON.stringify(target.ids));
          return anc(`SELECT 1 FROM anc JOIN json_each(${ids}) ON value = anc.id`);
        }
        if (target.mode === "self") {
          // A strict ancestor IS the hosting page.
          return anc(`SELECT 1 FROM anc WHERE anc.id = ${this.selfId()}`);
        }
        // DYNAMIC parentPath: some strict ancestor matches the group (the
        // group rides a fresh `node n` scope, like the page family).
        const group = this.groupSql(target.root);
        const inner =
          group !== undefined
            ? ` AND a.id IN (SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group}))`
            : "";
        return anc(
          `SELECT 1 FROM anc JOIN node a ON a.id = anc.id\n  WHERE a.is_active = 1${inner}`,
        );
      }
      case "root": {
        if (target.mode === "ids") {
          // The workspace-root ancestor (a parentless row is its own root)
          // is one of the picked nodes (one json_each param).
          const ids = this.push(JSON.stringify(target.ids));
          return `EXISTS (\n  SELECT 1 FROM json_each(${ids})\n  WHERE value = ${this.rootIdSql()}\n)`;
        }
        if (target.mode === "self") {
          // The workspace-root ancestor IS the hosting page — the ids form
          // over the one-element self list.
          const ids = this.push(JSON.stringify([this.selfIdValue()]));
          return `EXISTS (\n  SELECT 1 FROM json_each(${ids})\n  WHERE value = ${this.rootIdSql()}\n)`;
        }
        // DYNAMIC root: the workspace-root ancestor matches the group.
        const group = this.groupSql(target.root);
        const inner =
          group !== undefined
            ? ` AND root.id IN (SELECT n.id FROM node n WHERE n.is_active = 1 AND (${group}))`
            : "";
        return (
          "EXISTS (\n  SELECT 1 FROM node root\n" +
          `  WHERE root.id = ${this.rootIdSql()} AND root.is_active = 1${inner}\n)`
        );
      }
    }
  }

  /**
   * The family's emptiness (`exists`) read — the v1 `*Set` arms, unchanged
   * SQL. `referencePath` and `root` have no emptiness semantics (the design's
   * family table marks them "—"): the schema admits the shape, the compiler
   * fails loud.
   */
  private memberExistsSql(family: MemberFamily): string {
    switch (family) {
      case "class":
        // The class set is non-empty (Odoo "is set").
        return "(SELECT COUNT(*) FROM json_each(n.class_ids)) > 0";
      case "tags":
        return "(SELECT COUNT(*) FROM json_each(n.tag_ids)) > 0";
      case "links":
        // At least one inbound link — a direct edge targets the node.
        return "EXISTS (SELECT 1 FROM edge WHERE target_id = n.id)";
      case "parent":
      case "parentPath":
        // parentPath's emptiness reads "has a parent" (the parentSet bit).
        return "n.parent_id IS NOT NULL";
      case "child":
        // At least one direct child.
        return "EXISTS (SELECT 1 FROM node c WHERE c.parent_id = n.id AND c.is_active = 1)";
      case "childPath": {
        // At least one descendant (any depth below). The subtree CTE anchors
        // at the outer row (correlated anchor); any member other than the row
        // itself is a descendant.
        const subtree = this.subtreeSetSql("SELECT n.id, 0 AS distance");
        return `EXISTS (SELECT 1 FROM (${subtree}) WHERE id != n.id LIMIT 1)`;
      }
      case "page":
        // The row lives inside a page — the containing page differs from the
        // row itself (a page's own page is itself).
        return `${this.containingPageIdSql()} != n.id`;
      case "referencePath":
      case "root":
        throw new Error(
          `query compile: the '${family}' family has no emptiness (exists) semantics`,
        );
    }
  }

  /**
   * The date condition — the v1 created-/updated- ten types behind an
   * explicit `field` axis. eq/neq are DAY-granular (the whole resolved local
   * day matches); gt/gte/lt/lte compare against the resolved instant;
   * after/before are the inclusive day-boundary ops; between is the inclusive
   * [from, to] range; within is the relative period. Operands are optional on
   * the wire shape — a missing one fails loud here.
   */
  private dateSql(condition: Extract<Condition, { type: "date" }>): string {
    const column = condition.field === "created" ? "created_at" : "updated_at";
    switch (condition.op) {
      case "eq":
      case "neq":
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (condition.timestamp === undefined) {
          throw new Error(`query compile: date op '${condition.op}' requires a timestamp`);
        }
        return this.dateCmpSql(column, condition.op, condition.timestamp);
      }
      case "after": {
        if (condition.timestamp === undefined) {
          throw new Error("query compile: date op 'after' requires a timestamp");
        }
        return `n.${column} >= ${this.push(
          resolveTimestampPlaceholder(condition.timestamp, "after", this.options),
        )}`;
      }
      case "before": {
        if (condition.timestamp === undefined) {
          throw new Error("query compile: date op 'before' requires a timestamp");
        }
        return `n.${column} <= ${this.push(
          resolveTimestampPlaceholder(condition.timestamp, "before", this.options),
        )}`;
      }
      case "between": {
        if (condition.from === undefined || condition.to === undefined) {
          throw new Error("query compile: date op 'between' requires both bounds");
        }
        return this.dateBetweenSql(column, condition.from, condition.to);
      }
      case "within": {
        if (condition.period === undefined) {
          throw new Error("query compile: date op 'within' requires a period");
        }
        return this.dateWithinSql(column, condition.period);
      }
    }
  }

  /**
   * A wire-field predicate compiles straight into the node-table column
   * (store schema v16): exists = the IS NOT NULL probe; eq/neq compare the
   * reference id. SQL NULL semantics hold — an unset field matches neither
   * eq nor neq — so "is unset" reads `not exists`, not `neq`.
   */
  private nodeFieldSql(
    field: string,
    column: string,
    condition: { op: "eq" | "neq" | "exists"; value?: string | undefined },
  ): string {
    if (condition.op === "exists") {
      return `n.${column} IS NOT NULL`;
    }
    if (condition.value === undefined || condition.value === null) {
      throw new Error(`query compile: ${field} op '${condition.op}' requires a non-null value`);
    }
    return `n.${column} ${condition.op === "eq" ? "=" : "!="} ${this.push(condition.value)}`;
  }

  /**
   * The title condition (title-is-content): the predicate runs over the
   * flattened content text — the same expression sort-by-name uses. exists
   * is the non-empty probe, COALESCE'd two-valued so the not-wrap reads
   * "is untitled" (a bare `length` would go NULL for an untitled row and
   * `NOT NULL` excludes it again); contains LIKEs (ASCII case-insensitive,
   * the content-contains convention); eq/neq compare exactly (case-sensitive
   * BINARY, the prop `:=` convention) — an untitled row matches neither
   * under SQL NULL semantics, by design.
   */
  private nameSql(condition: Extract<Condition, { type: "name" }>): string {
    const title = titleSql("n");
    if (condition.op === "exists") {
      return `COALESCE(length(${title}), 0) > 0`;
    }
    if (condition.value === undefined || condition.value === null) {
      throw new Error(`query compile: name op '${condition.op}' requires a non-null value`);
    }
    const param = this.push(condition.value);
    if (condition.op === "eq" || condition.op === "neq") {
      return `${title} ${condition.op === "eq" ? "=" : "!="} ${param}`;
    }
    return `${title} LIKE '%' || ${param} || '%'`;
  }

  private contentSql(condition: {
    op: ContentOp | "exists";
    value?: string | undefined;
  }): string {
    if (condition.value === undefined || condition.value === null) {
      throw new Error(`query compile: content op '${condition.op}' requires a non-null value`);
    }
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
    // eq/neq test the plaintext for full equality; starts/ends anchor the
    // LIKE at one edge — the Odoo text operator set.
    if (condition.op === "eq" || condition.op === "neq") {
      return (
        "EXISTS (\n  SELECT 1 FROM search_index_docid d\n" +
        "  JOIN search_index s ON s.rowid = d.docid\n" +
        `  WHERE d.node_id = n.id AND s.content ${condition.op === "eq" ? "=" : "!="} ${param}\n` +
        ")"
      );
    }
    const anchor =
      condition.op === "starts"
        ? `${param} || '%'`
        : condition.op === "ends"
          ? `'%' || ${param}`
          : `'%' || ${param} || '%'`;
    return (
      "EXISTS (\n  SELECT 1 FROM search_index_docid d\n" +
      "  JOIN search_index s ON s.rowid = d.docid\n" +
      `  WHERE d.node_id = n.id AND s.content LIKE ${anchor}\n` +
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
  private propertySql(condition: {
    type: "property";
    schemaId: string;
    op: PropertyOp;
    value?: unknown;
    includeDefaults?: boolean | undefined;
  }): string {
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

    const { ctes, unions } = this.effectiveValueCtes(condition.schemaId, includeDefaults);

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
   * The effective-values CTE pair shared by every property-shaped condition
   * (property, incl. the between/within ops): tombstone-suppressed
   * authored rows UNION bindings-derived defaults (the effective.ts
   * semantics). Params push in CTE text order (schema, then the two derived
   * arms) — callers build the predicate AFTER this, so bound params always
   * follow the CTE params.
   */
  private effectiveValueCtes(
    schemaId: string,
    includeDefaults: boolean,
  ): { ctes: string; unions: string } {
    const schemaParam = this.push(schemaId);
    let ctes =
      `WITH authored AS (\n` +
      `  SELECT pv.node_id AS node_id, pv.value AS value\n` +
      `  FROM property_value pv\n` +
      `  WHERE pv.property_schema_id = ${schemaParam}\n` +
      `    AND ${Compiler.visibleValuePredicate("pv")}\n` +
      `)`;
    let unions = "SELECT node_id, value FROM authored";
    if (includeDefaults) {
      const bindingSchemaId = this.push(schemaId);
      const authoredSchemaId = this.push(schemaId);
      ctes +=
        `,\nderived AS (\n` +
        `  SELECT wb.node_id AS node_id, wb.default_value AS value\n` +
        `  FROM (\n` +
        `    SELECT cms.node_id, ps.default_value,\n` +
        `           ROW_NUMBER() OVER (\n` +
        `             PARTITION BY cms.node_id\n` +
        `             ORDER BY cms.hlc_physical, cms.hlc_logical, cms.class_id\n` +
        `           ) AS rn\n` +
        `    FROM class_member_set cms\n` +
        `    JOIN class_property cp ON cp.class_id = cms.class_id\n` +
        `    JOIN property_schema ps ON ps.id = cp.property_schema_id\n` +
        `    WHERE cms.present = 1 AND cp.property_schema_id = ${bindingSchemaId} AND cp.active = 1\n` +
        `      AND ps.default_value IS NOT NULL\n` +
        // Read-side option membership (the effective.ts rule): a select-typed
        // default whose value is no longer among the schema's options
        // (option deleted after the default was written) derives nothing.
        `      AND (ps.type NOT IN ('select', 'multi_select')\n` +
        `        OR EXISTS (\n` +
        `          SELECT 1 FROM json_each(ps.options) je\n` +
        `          WHERE json_extract(je.value, '$.id') = json_extract(ps.default_value, '$')\n` +
        `        ))\n` +
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
    return { ctes, unions };
  }

  /**
   * The class-level parentlessRole demote, flattened for
   * SQL consumers that cannot call the domain predicate: true when the row's
   * class set includes a class that EFFECTIVELY carries parentlessRole
   * "block" — its own flag OR an extends-ancestor's, via the self-inclusive
   * class_hierarchy closure (the one-way demote; there is no per-level
   * unflag). Render contract read only — no write-path enforcement (PC1).
   * `alias` is the node row's table alias in the surrounding SQL.
   */
  private hasParentlessBlockClassSql(alias: string): string {
    return (
      "EXISTS (SELECT 1 FROM class_hierarchy ch\n" +
      "  JOIN node c ON c.id = ch.ancestor_id\n" +
      `  WHERE ch.class_id IN (SELECT value FROM json_each(${alias}.class_ids))\n` +
      "    AND c.parentless_role = 'block')"
    );
  }

  /**
   * The CONTAINING PAGE id as a correlated scalar subquery (references the
   * outer row `n`): the nearest self-or-ancestor that renders with document
   * chrome — the Revision-12 page-role condition, flattened the same way the
   * "pages" scope flattens it (standalone-under-a-non-page parent is
   * write-time impossible, so the flat test is exact), plus the
   * parentlessRole demote: a parentless ancestor whose
   * classes effectively carry "block" renders Block-role, never a containing
   * page — a block-role standalone node has NO containing page (NULL). No
   * params.
   */
  private containingPageIdSql(): string {
    return (
      "(SELECT pg.id FROM node pg JOIN (\n" +
      "  WITH RECURSIVE up(id, depth) AS (\n" +
      "    SELECT n.id, 0\n" +
      "    UNION ALL\n" +
      "    SELECT nd.parent_id, up.depth + 1 FROM node nd JOIN up ON nd.id = up.id\n" +
      "    WHERE nd.parent_id IS NOT NULL AND up.depth < 64\n" +
      "  ) SELECT id, depth FROM up\n" +
      ") ch ON ch.id = pg.id\n" +
      "WHERE (pg.is_class = 1 OR pg.parent_id IS NULL OR pg.is_embedded = 0)\n" +
      `  AND (pg.parent_id IS NOT NULL OR NOT ${this.hasParentlessBlockClassSql("pg")})\n` +
      "ORDER BY ch.depth LIMIT 1)"
    );
  }

  /** The ROOT ancestor id (the workspace-root child) as a correlated scalar subquery. No params. */
  private rootIdSql(): string {
    return (
      "(SELECT pg.id FROM node pg WHERE pg.id = (\n" +
      "  WITH RECURSIVE up(id) AS (\n" +
      "    SELECT n.id\n" +
      "    UNION ALL\n" +
      "    SELECT nd.parent_id FROM node nd JOIN up ON nd.id = up.id\n" +
      "    WHERE nd.parent_id IS NOT NULL\n" +
      "  )\n" +
      "  SELECT up.id FROM up JOIN node nd ON nd.id = up.id\n" +
      "  WHERE nd.parent_id IS NULL LIMIT 1\n" +
      "))"
    );
  }

  /**
   * The referencePath family rollup over a target set (the targets query
   * yields one `id` column — a json_each wrapper for the ids pick, a fresh
   * `node n` group scope for the query mode, the self anchor for the self
   * mode). A row matches when the row OR any of its ancestors links to a
   * target, or a target is a STRICT ancestor of the row (containment is
   * folded into the link rollup). The ancestor chain CTE is seeded at the
   * row itself so the edge arm includes the row's own outbound links.
   * Params: the targets query's own.
   */
  private referencePathSql(targetsSql: string): string {
    return (
      "EXISTS (\n  WITH RECURSIVE anc(id, depth) AS (\n" +
      "    SELECT n.id, 0\n" +
      "    UNION ALL\n" +
      "    SELECT nd.parent_id, anc.depth + 1 FROM node nd JOIN anc ON nd.id = anc.id\n" +
      "    WHERE anc.id IS NOT NULL AND anc.depth < 64\n" +
      "  )\n" +
      "  SELECT 1 FROM (" + targetsSql + ") tv\n" +
      "  WHERE tv.id IN (SELECT id FROM anc WHERE id != n.id)\n" +
      "     OR EXISTS (\n       SELECT 1 FROM edge e\n" +
      "       WHERE e.target_id = tv.id AND e.source_id IN (SELECT id FROM anc)\n     )\n)"
    );
  }

  /**
   * The Odoo date comparison (the date condition's eq/neq/gt/gte/lt/lte
   * ops): eq/neq are DAY-granular (the whole resolved local day matches — the
   * timestamp resolves through the same placeholder boundary machinery as
   * after/before); gt/gte/lt/lte compare against the resolved instant
   * (gte = after, lte = before).
   */
  private dateCmpSql(column: string, op: DateOp, timestamp: string): string {
    if (op === "eq" || op === "neq") {
      const day = resolveDayBounds(timestamp, this.options);
      const start = this.push(day.from);
      const end = this.push(day.to);
      const match = `n.${column} >= ${start} AND n.${column} <= ${end}`;
      return op === "eq" ? match : `NOT (${match})`;
    }
    const direction = op === "gt" || op === "gte" ? "after" : "before";
    const sqlOp = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op as "gt" | "gte" | "lt" | "lte"];
    const bound = this.push(resolveTimestampPlaceholder(timestamp, direction, this.options));
    return `n.${column} ${sqlOp} ${bound}`;
  }

  /** The inclusive date range: from day-start to to day-end. */
  private dateBetweenSql(column: string, from: string, to: string): string {
    const fromBound = this.push(resolveTimestampPlaceholder(from, "after", this.options));
    const toBound = this.push(resolveTimestampPlaceholder(to, "before", this.options));
    return `n.${column} >= ${fromBound} AND n.${column} <= ${toBound}`;
  }

  /** The relative-period arm: the resolved period bounds against the column. */
  private dateWithinSql(column: string, period: DatePeriod): string {
    const bounds = resolvePeriodBounds(period, this.options);
    const from = this.push(bounds.from);
    const to = this.push(bounds.to);
    return `n.${column} >= ${from} AND n.${column} <= ${to}`;
  }

  /** property op between: the effective value inside the inclusive [from, to]. */
  private propertyRangeSql(schemaId: string, from: unknown, to: unknown): string {
    if (from === undefined || to === undefined) {
      throw new Error("query compile: property op 'between' requires both bounds");
    }
    const { ctes, unions } = this.effectiveValueCtes(schemaId, true);
    const fromIso =
      typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
    const toIso =
      typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null;
    const fromParam = this.push(from);
    const toParam = this.push(to);
    let predicate = `WHERE json_extract(value, '$') >= ${fromParam} AND json_extract(value, '$') <= ${toParam}`;
    if (fromIso !== null && toIso !== null) {
      // ISO bounds also speak to date-node refs; the scalar arm gates
      // non-object values (raw JSON text would sort wrong).
      const scalar = `json_type(value, '$') != 'object' AND ${predicate.slice("WHERE ".length)}`;
      predicate = `WHERE (${scalar}) OR (${this.dateRefSql(">=", fromIso)} AND ${this.dateRefSql("<=", toIso)})`;
    }
    return `n.id IN (\n  ${ctes},\n  effective AS (\n  ${unions}\n  )\n  SELECT node_id FROM effective\n  ${predicate}\n)`;
  }

  /** property op within: the effective DATE-valued property inside the period. */
  private propertyWithinSql(schemaId: string, period: DatePeriod | undefined): string {
    if (period === undefined) {
      throw new Error("query compile: property op 'within' requires a period");
    }
    const { ctes, unions } = this.effectiveValueCtes(schemaId, true);
    const token = `{${period}}`;
    const fromIso = placeholderStartDate(token, this.options);
    const toIso = placeholderEndDate(token, this.options);
    if (fromIso === null || toIso === null) {
      throw new Error(`query compile: unknown property period ${JSON.stringify(period)}`);
    }
    const fromParam = this.push(fromIso);
    const toParam = this.push(toIso);
    const scalar = `json_type(value, '$') != 'object' AND json_extract(value, '$') >= ${fromParam} AND json_extract(value, '$') <= ${toParam}`;
    const predicate = `WHERE (${scalar}) OR (${this.dateRefSql(">=", fromIso)} AND ${this.dateRefSql("<=", toIso)})`;
    return `n.id IN (\n  ${ctes},\n  effective AS (\n  ${unions}\n  )\n  SELECT node_id FROM effective\n  ${predicate}\n)`;
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
      const { column, nullable, nocase } = SORT_COLUMNS[spec.field];
      const dir = spec.dir === "desc" ? "DESC" : "ASC";
      const ordered = nocase === true ? `${column} COLLATE NOCASE ${dir}` : `${column} ${dir}`;
      // NULLs last on nullable columns (SQLite 3.30+ NULLS LAST would work,
      // but IS NULL is portable across both FTS4/FTS5-era sql.js builds).
      if (nullable) terms.push(`${column} IS NULL`, ordered);
      else terms.push(ordered);
    }
    terms.push("n.id ASC");
    return terms.join(", ");
  }
}
