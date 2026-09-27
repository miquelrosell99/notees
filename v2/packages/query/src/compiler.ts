/**
 * QueryAST -> SQLite compiler over the v2 derived schema.
 *
 * Port of the v1 `frontend/src/core/query/compileToSqlite.ts` CONCEPTS,
 * adapted to the v2 store (packages/store):
 *  - `node.node_type` replaces v1 `kind`; `is_active = 1` excludes deleted
 *    nodes on every query (the store's read helpers do the same);
 *  - the v2 reference index is `edge` (never authored) — the linkedTo
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
 * M1 boundaries (fail loud, cleanly extensible):
 *  - `aggregation` is defined in the AST schema but compilation is not
 *    implemented — compiling an AST with `aggregation` throws;
 *  - scopes/conditions outside the v1 AST subset (style marks, parent/child
 *    paths, regex, flags) are not part of the v2 M1 model.
 */

import type { Condition, Group, Not, QueryAst, SortSpec } from "./ast.js";

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

export interface CompileOptions {
  /**
   * Reserved for future current-node-relative scopes/placeholders (v1's
   * current_page / {current_node_uuid}); the M1 AST carries explicit ids, so
   * this is accepted but unused.
   */
  currentNodeId?: string | undefined;
}

/**
 * Prefix-AND FTS match expression (port of the store's buildMatchQuery —
 * kept here so the query package stays standalone, dependency-free). Each
 * whitespace term becomes a bare prefix token (`term*`), all terms ANDed;
 * non-alphanumerics are dropped per term (unicode61 discards them anyway and
 * bare tokens must not carry FTS query syntax). Null when nothing searchable
 * remains.
 */
export function buildMatchExpression(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}*`).join(" AND ");
}

const SORT_COLUMNS: Record<SortSpec["field"], { column: string; nullable: boolean }> = {
  name: { column: "n.name", nullable: true },
  createdAt: { column: "n.created_at", nullable: true },
  nodeType: { column: "n.node_type", nullable: false },
};

export function compile(ast: QueryAst, options: CompileOptions = {}): CompiledQuery {
  return new Compiler(options).compile(ast);
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
      throw new Error(
        "query compile: AST carries an aggregation, but aggregation compilation " +
          "is not implemented in M1 (schema-defined, execution deferred)",
      );
    }

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
      where.push("n.node_type = 'page'");
    }
    const group = this.groupSql(ast.root);
    if (group !== undefined) {
      where.push(`(${group})`);
    }

    const columns = hasDistance ? "n.*, sc.distance AS distance" : "n.*";
    const sql =
      `SELECT ${columns}\nFROM ${from}\nWHERE ${where.join(" AND ")}\n` +
      `ORDER BY ${this.orderSql(ast.sort)}`;
    return { sql, params: this.params };
  }

  // --- scope -----------------------------------------------------------------

  /** Anchor + descendants, one row per node, distance = levels below the anchor. */
  private subtreeSql(anchorId: string): string {
    const anchor = this.push(anchorId);
    return (
      "WITH RECURSIVE sub(id, distance) AS (\n" +
      `  SELECT id, 0 FROM node WHERE id = ${anchor}\n` +
      "  UNION ALL\n" +
      "  SELECT n.id, sub.distance + 1 FROM sub JOIN node n ON n.parent_id = sub.id\n" +
      ") SELECT id, distance FROM sub"
    );
  }

  /**
   * backlinksWithRollup membership (Store.backlinksWithRollup shape): direct
   * edges targeting the anchor (distance 0), UNION containment edges — source
   * strictly inside the anchor's subtree linking OUT of it (distance = source
   * depth). One row per source node, MIN(distance) collapses duplicates.
   */
  private linkedToSql(nodeId: string): string {
    const anchor = this.push(nodeId);
    const target = this.push(nodeId);
    return (
      "WITH RECURSIVE sub(id, distance) AS (\n" +
      `  SELECT id, 0 FROM node WHERE id = ${anchor}\n` +
      "  UNION ALL\n" +
      "  SELECT n.id, sub.distance + 1 FROM sub JOIN node n ON n.parent_id = sub.id\n" +
      "), hits AS (\n" +
      `  SELECT e.source_id AS id, 0 AS distance FROM edge e WHERE e.target_id = ${target}\n` +
      "  UNION ALL\n" +
      "  SELECT e.source_id, sub.distance FROM edge e\n" +
      "  JOIN sub ON sub.id = e.source_id\n" +
      "  WHERE sub.distance > 0 AND e.target_id NOT IN (SELECT id FROM sub)\n" +
      ") SELECT id, MIN(distance) AS distance FROM hits GROUP BY id"
    );
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
      case "nodeType":
        return `n.node_type = ${this.push(condition.nodeType)}`;
      case "content":
        return this.contentSql(condition);
      case "property":
        return this.propertySql(condition);
      case "linkedTo":
        // Condition form: membership only (single-column projection; the
        // scope form joins the same CTE for its distance column).
        return `n.id IN (SELECT id FROM (${this.linkedToSql(condition.nodeId)}))`;
      case "createdAfter":
        return `n.created_at >= ${this.push(condition.timestamp)}`;
      case "createdBefore":
        return `n.created_at <= ${this.push(condition.timestamp)}`;
      default:
        throw new Error(
          `query compile: unknown condition type ${(condition as { type: string }).type}`,
        );
    }
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
    // LIKE is ASCII case-insensitive (SQLite default), matching v1's
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
   * matches); neq is the v1 not_equals port — "has at least one effective
   * value different from v" — so nodes with NO effective value do not match
   * (pair with `exists` if unset nodes should count). Values compare through
   * json_extract(value, '$').
   */
  private propertySql(condition: Extract<Condition, { type: "property" }>): string {
    if (
      (condition.op === "eq" || condition.op === "contains") &&
      (condition.value === undefined || condition.value === null)
    ) {
      throw new Error(`query compile: property op '${condition.op}' requires a non-null value`);
    }
    const includeDefaults = condition.includeDefaults ?? true;

    const schemaId = this.push(condition.schemaId);
    let ctes =
      `WITH authored AS (\n` +
      `  SELECT pv.node_id AS node_id, pv.value AS value\n` +
      `  FROM property_value pv\n` +
      `  WHERE pv.property_schema_id = ${schemaId}\n` +
      `    AND NOT EXISTS (\n` +
      `      SELECT 1 FROM property_value_tombstone t\n` +
      `      WHERE t.node_id = pv.node_id AND t.property_schema_id = pv.property_schema_id\n` +
      `        AND t.idx = pv.idx\n` +
      `        AND (t.hlc_physical, t.hlc_logical, COALESCE(t.actor_id, '')) >=\n` +
      `            (pv.hlc_physical, pv.hlc_logical, COALESCE(pv.actor_id, ''))\n` +
      `    )\n` +
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
        `    WHERE cms.present = 1 AND cp.property_schema_id = ${bindingSchemaId}\n` +
        `      AND cp.default_value IS NOT NULL\n` +
        `  ) wb\n` +
        `  WHERE wb.rn = 1\n` +
        `    AND NOT EXISTS (\n` +
        `      SELECT 1 FROM property_value pv\n` +
        `      WHERE pv.node_id = wb.node_id AND pv.property_schema_id = ${authoredSchemaId}\n` +
        `        AND pv.idx = 0\n` +
        `        AND NOT EXISTS (\n` +
        `          SELECT 1 FROM property_value_tombstone t\n` +
        `          WHERE t.node_id = pv.node_id AND t.property_schema_id = pv.property_schema_id\n` +
        `            AND t.idx = pv.idx\n` +
        `            AND (t.hlc_physical, t.hlc_logical, COALESCE(t.actor_id, '')) >=\n` +
        `                (pv.hlc_physical, pv.hlc_logical, COALESCE(pv.actor_id, ''))\n` +
        `        )\n` +
        `    )\n` +
        `)`;
      unions += "\nUNION ALL\nSELECT node_id, value FROM derived";
    }

    let predicate = "";
    if (condition.op === "eq") {
      predicate = `WHERE json_extract(value, '$') = ${this.push(condition.value)}`;
    } else if (condition.op === "neq") {
      predicate = `WHERE json_extract(value, '$') != ${this.push(condition.value)}`;
    } else if (condition.op === "contains") {
      predicate = `WHERE CAST(json_extract(value, '$') AS TEXT) LIKE '%' || ${this.push(condition.value)} || '%'`;
    }

    const membership = `n.id IN (\n  ${ctes},\n  effective AS (\n  ${unions}\n  )\n  SELECT node_id FROM effective\n  ${predicate}\n)`;
    return membership;
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
