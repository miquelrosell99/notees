import type {
  AggregationDimension,
  AggregationMeasure,
  AggregationNode,
  ChildCondition,
  ChildPathCondition,
  ClassCondition,
  ConditionNode,
  ContentCondition,
  ExtendsCondition,
  GroupNode,
  NotNode,
  PageCondition,
  ParentCondition,
  ParentPathCondition,
  PropertyCondition,
  QueryAST,
  ReferenceCondition,
  ReferencePathCondition,
  ScopeNode,
  StyleCondition,
  TagCondition,
} from '../../types/queryAST';
import { toFtsMatchExpression } from './search';

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

const STYLE_TO_AST_TYPE: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'underline',
  strikethrough: 'strikethrough',
  broken_link: 'broken_link',
};

const BUILTIN_PROPERTY_COLUMNS = new Set([
  'id',
  'parent_id',
  'created_at',
  'updated_at',
  'kind',
  'name',
  'create_date',
  'write_date',
]);

function resolvePlaceholder(value: string, currentNodeUuid?: string): string | null {
  if (!value || value.trim() === '') return null;
  if (value === '{current_node_uuid}') {
    return currentNodeUuid ?? null;
  }
  if (value.includes('{') || value.includes('}')) return null;
  return value;
}

function validUuids(values: string[] | undefined, currentNodeUuid?: string): string[] {
  if (!values) return [];
  return values
    .map((v) => resolvePlaceholder(v, currentNodeUuid))
    .filter((v): v is string => v !== null);
}

function placeholders(count: number): string {
  return Array(count).fill('?').join(', ');
}

/**
 * Compile a QueryAST to SQLite SQL using positional `?` placeholders.
 *
 * Supported subset (see `agents/plans/phase3-queryast-sqlite.md`):
 * - Scopes: `entire_workspace`, `pages`, `current_page`, `specific_pages`, `linked_refs`.
 * - Conditions: class (with inheritance via `class_hierarchy`), extends, property
 *   (builtin columns and custom `property_value` JSON), content text search, style
 *   mark search, reference / reference_path, parent / parent_path, child / child_path,
 *   page, and selected flags.
 * - Aggregations: count and numeric aggregates grouped by builtin dimensions or by
 *   custom property UUIDs.
 *
 * Out of scope (documented by returning `undefined` clauses or ignoring operators):
 * - `regex` content operator (SQLite REGEXP requires a custom extension).
 * - `is_private` / `is_favorite` / `active` flags.
 * - Builtin numeric measures such as `sequence` or `id` (the derived schema has no
 *   such columns).
 */
export function compileToSqlite(
  ast: QueryAST,
  workspaceId: string,
  currentNodeUuid?: string
): CompiledSql {
  const compiler = new Compiler('n', workspaceId, currentNodeUuid);
  if (ast.aggregation) {
    return compiler.compileAggregate(ast);
  }
  return compiler.compile(ast);
}

class Compiler {
  private params: unknown[] = [];
  private alias: string;
  private workspaceId: string;
  private currentNodeUuid: string | undefined;

  constructor(alias: string, workspaceId: string, currentNodeUuid?: string) {
    this.alias = alias;
    this.workspaceId = workspaceId;
    this.currentNodeUuid = currentNodeUuid;
  }

  private pushParam(value: unknown): string {
    this.params.push(value);
    return '?';
  }

  compile(ast: QueryAST): CompiledSql {
    // Narrow select: callers only read `id` (queryNodes) or wrap the SQL in a
    // COUNT subquery filtered on `active` (countQueryResults). Selecting the
    // wide row would force SQLite to materialize every scanned node's full
    // content JSON. No DISTINCT: the outer query has no JOINs — every scope
    // and condition clause is a WHERE-term subquery — so each node row can
    // appear at most once.
    return this.compileSelect(ast, `${this.alias}.id, ${this.alias}.active`);
  }

  private compileSelect(ast: QueryAST, columns: string): CompiledSql {
    const where: string[] = [`${this.alias}.workspace_id = ${this.pushParam(this.workspaceId)}`];

    const scopeSql = this.generateScopeSql(ast.scope);
    if (scopeSql) where.push(scopeSql);

    const groupSql = this.generateGroupSql(ast.root_group);
    if (groupSql) where.push(`(${groupSql})`);

    const sql = `SELECT ${columns}\nFROM node ${this.alias}\nWHERE ${where.join(
      ' AND '
    )}\nORDER BY ${this.alias}.id`;
    return { sql, params: this.params };
  }

  compileAggregate(ast: QueryAST): CompiledSql {
    // The aggregation SELECT references fn.kind / created_at / updated_at /
    // class_ids, so the CTE keeps the wide row (DISTINCT is still redundant —
    // see compile()).
    const base = this.compileSelect(ast, `${this.alias}.*`);
    const baseCte = base.sql.replace(/\nORDER BY [^\n]+$/, '');

    const aggCompiler = new AggregationCompiler();
    const groupResult = aggCompiler.compile(ast.aggregation!);

    const sql = `WITH filtered_nodes AS (\n${baseCte}\n)\n${groupResult.sql}`;
    return { sql, params: [...base.params, ...groupResult.params] };
  }

  compileGroupWithAlias(alias: string, group: GroupNode): { sql: string; params: unknown[] } {
    const compiler = new Compiler(alias, this.workspaceId, this.currentNodeUuid);
    const sql = compiler.generateGroupSql(group);
    return { sql: sql ?? '1=1', params: compiler.params };
  }

  generateGroupSql(group: GroupNode): string | undefined {
    if (!group.children || group.children.length === 0) return undefined;

    const clauses: string[] = [];
    for (const child of group.children) {
      if (child.type === 'group') {
        const nested = this.generateGroupSql(child);
        if (nested) clauses.push(`(${nested})`);
      } else if (child.type === 'not') {
        const negated = this.generateNotSql(child);
        if (negated) clauses.push(negated);
      } else {
        const cond = this.generateConditionSql(child);
        if (cond) clauses.push(cond);
      }
    }

    if (clauses.length === 0) return undefined;
    const op = group.logic === 'OR' ? ' OR ' : ' AND ';
    return clauses.join(op);
  }

  private generateNotSql(node: NotNode): string | undefined {
    const child = node.child;
    let inner: string | undefined;
    if (child.type === 'group') {
      inner = this.generateGroupSql(child);
    } else if (child.type === 'not') {
      inner = this.generateNotSql(child);
    } else {
      inner = this.generateConditionSql(child);
    }
    if (!inner) return undefined;
    return `NOT (${inner})`;
  }

  generateConditionSql(condition: ConditionNode): string | undefined {
    switch (condition.condition_type) {
      case 'class':
        return this.generateClassCondition(condition);
      case 'extends':
        return this.generateExtendsCondition(condition);
      case 'property':
        return this.generatePropertyCondition(condition);
      case 'content':
        return this.generateContentCondition(condition);
      case 'style':
        return this.generateStyleCondition(condition);
      case 'reference':
        return this.generateReferenceCondition(condition);
      case 'reference_path':
        return this.generateReferencePathCondition(condition);
      case 'parent':
        return this.generateParentCondition(condition);
      case 'parent_path':
        return this.generateParentPathCondition(condition);
      case 'child':
        return this.generateChildCondition(condition);
      case 'child_path':
        return this.generateChildPathCondition(condition);
      case 'page':
        return this.generatePageCondition(condition);
      case 'tag':
        return this.generateTagCondition(condition);
      default:
        return undefined;
    }
  }

  private generateScopeSql(scope: ScopeNode): string | undefined {
    const scopeType = scope.scope_type;

    if (scopeType === 'entire_workspace') {
      return undefined;
    }

    if (scopeType === 'pages') {
      return `${this.alias}.kind = 'page'`;
    }

    if (scopeType === 'current_page') {
      if (!this.currentNodeUuid) return undefined;
      const includeDescendants = scope.include_descendants ?? true;
      if (!includeDescendants) {
        return `${this.alias}.id = ${this.pushParam(this.currentNodeUuid)}`;
      }
      const param = this.pushParam(this.currentNodeUuid);
      return `${this.alias}.id IN (WITH RECURSIVE page_subtree(id) AS (SELECT ${param} AS id UNION ALL SELECT node.id FROM node JOIN page_subtree ON node.parent_id = page_subtree.id) SELECT id FROM page_subtree)`;
    }

    if (scopeType === 'specific_pages') {
      const extended = scope as ScopeNode & { page_uuids?: string[] };
      const uuids = validUuids(extended.page_uuids, this.currentNodeUuid);
      if (uuids.length === 0) return undefined;
      const includeDescendants = scope.include_descendants ?? false;
      if (!includeDescendants) {
        const list = placeholders(uuids.length);
        uuids.forEach((u: string) => this.pushParam(u));
        return `${this.alias}.id IN (${list})`;
      }
      const list = placeholders(uuids.length);
      uuids.forEach((u: string) => this.pushParam(u));
      return `${this.alias}.id IN (WITH RECURSIVE page_subtree(id) AS (SELECT id FROM node WHERE id IN (${list}) AND kind = 'page' UNION ALL SELECT node.id FROM node JOIN page_subtree ON node.parent_id = page_subtree.id) SELECT id FROM page_subtree)`;
    }

    if (scopeType === 'linked_refs') {
      if (!this.currentNodeUuid) return undefined;
      return `EXISTS (SELECT 1 FROM node_link nl WHERE nl.source_id = ${this.alias}.id AND nl.target_id = ${this.pushParam(
        this.currentNodeUuid
      )})`;
    }

    return undefined;
  }

  private pageIdSubquery(nodeAlias: string): string {
    return `(WITH RECURSIVE page_ancestors(id, kind, parent_id) AS (
      SELECT ${nodeAlias}.id, ${nodeAlias}.kind, ${nodeAlias}.parent_id
      UNION ALL
      SELECT n.id, n.kind, n.parent_id FROM node n JOIN page_ancestors pa ON n.id = pa.parent_id
    ) SELECT id FROM page_ancestors WHERE kind = 'page' LIMIT 1)`;
  }

  private nameTextExpr(nodeAlias: string): string {
    // The extracted text leaves are precomputed at write time into the derived
    // text_content column (see derived/textContent.ts); reading the column
    // avoids a per-row json_tree parse of the full content JSON.
    return `${nodeAlias}.text_content`;
  }

  private generateClassCondition(condition: ClassCondition): string | undefined {
    const uuids = validUuids(
      condition.class_uuids && condition.class_uuids.length > 0
        ? condition.class_uuids
        : condition.class_uuid
          ? [condition.class_uuid]
          : [],
      this.currentNodeUuid
    );
    if (uuids.length === 0) return undefined;

    const list = placeholders(uuids.length);
    uuids.forEach((u: string) => this.pushParam(u));

    const membership = `EXISTS (SELECT 1 FROM json_each(${this.alias}.class_ids) WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id IN (${list})))`;

    const op = condition.operator ?? 'contains';
    switch (op) {
      case 'defined':
        return `${this.alias}.class_ids IS NOT NULL AND json_array_length(${this.alias}.class_ids) > 0`;
      case 'not_defined':
        return `${this.alias}.class_ids IS NULL OR json_array_length(${this.alias}.class_ids) = 0`;
      case 'does_not_contain':
      case 'is_not':
        return `NOT ${membership}`;
      case 'contains':
      case 'is':
      default:
        return membership;
    }
  }

  private generateExtendsCondition(condition: ExtendsCondition): string | undefined {
    const uuid = resolvePlaceholder(condition.extends_class_uuid, this.currentNodeUuid);
    if (!uuid) return undefined;
    this.pushParam(uuid);
    return `EXISTS (SELECT 1 FROM json_each(${this.alias}.class_ids) WHERE value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id = ? AND class_id != ancestor_id))`;
  }

  private generatePropertyCondition(condition: PropertyCondition): string | undefined {
    const propName = condition.property_name;
    const op = condition.operator;

    if (BUILTIN_PROPERTY_COLUMNS.has(propName)) {
      return this.generateBuiltinPropertyCondition(condition);
    }

    const propUuid = condition.property_uuid;
    if (!propUuid) return undefined;
    this.pushParam(propUuid);

    // Decorrelated IN subqueries instead of per-row correlated EXISTS: the
    // subquery is materialized once (backed by idx_property_value_schema) and
    // each node row is a cheap ephemeral-index probe. node_id is NOT NULL, so
    // NOT IN is equivalent to NOT EXISTS here.
    if (op === 'is_empty') {
      return `${this.alias}.id NOT IN (SELECT node_id FROM property_value WHERE property_schema_id = ?)`;
    }
    if (op === 'is_not_empty') {
      return `${this.alias}.id IN (SELECT node_id FROM property_value WHERE property_schema_id = ?)`;
    }

    if (op === 'in' || op === 'not_in') {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      if (values.length === 0) return undefined;
      const list = placeholders(values.length);
      values.forEach((v: unknown) => this.pushParam(v));
      const inClause = `${this.alias}.id IN (SELECT node_id FROM property_value WHERE property_schema_id = ? AND json_extract(property_value.value, '$') IN (${list}))`;
      return op === 'not_in' ? `NOT (${inClause})` : inClause;
    }

    if (condition.value === undefined || condition.value === null) return undefined;
    this.pushParam(condition.value);

    const valueExpr = `json_extract(property_value.value, '$')`;
    const isNumeric = condition.property_type === 'number';
    return `${this.alias}.id IN (SELECT node_id FROM property_value WHERE property_schema_id = ? AND ${this.valueComparison(valueExpr, op, isNumeric)})`;
  }

  private generateBuiltinPropertyCondition(condition: PropertyCondition): string | undefined {
    const propName = condition.property_name;
    const op = condition.operator;

    let column: string;
    if (propName === 'name') {
      column = this.nameTextExpr(this.alias);
    } else if (propName === 'create_date') {
      column = `date(${this.alias}.created_at)`;
    } else if (propName === 'write_date') {
      column = `date(${this.alias}.updated_at)`;
    } else {
      column = `${this.alias}.${propName}`;
    }

    if (op === 'is_empty') {
      return `${column} IS NULL`;
    }
    if (op === 'is_not_empty') {
      return `${column} IS NOT NULL`;
    }

    if (op === 'in' || op === 'not_in') {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      if (values.length === 0) return undefined;
      const list = placeholders(values.length);
      values.forEach((v: unknown) => this.pushParam(v));
      const expr = `${column} IN (${list})`;
      return op === 'not_in' ? `NOT (${expr})` : expr;
    }

    if (condition.value === undefined || condition.value === null) return undefined;
    this.pushParam(condition.value);
    return this.valueComparison(column, op, false);
  }

  private valueComparison(expr: string, op: string, isNumeric: boolean): string | undefined {
    switch (op) {
      case 'equals':
        return `${expr} = ?`;
      case 'not_equals':
        return `${expr} != ?`;
      case 'contains':
        return `CAST(${expr} AS TEXT) LIKE '%' || ? || '%'`;
      case 'starts_with':
        return `CAST(${expr} AS TEXT) LIKE ? || '%'`;
      case 'ends_with':
        return `CAST(${expr} AS TEXT) LIKE '%' || ?`;
      case 'greater_than':
        return isNumeric ? `CAST(${expr} AS REAL) > ?` : `${expr} > ?`;
      case 'less_than':
        return isNumeric ? `CAST(${expr} AS REAL) < ?` : `${expr} < ?`;
      case 'gte':
        return isNumeric ? `CAST(${expr} AS REAL) >= ?` : `${expr} >= ?`;
      case 'lte':
        return isNumeric ? `CAST(${expr} AS REAL) <= ?` : `${expr} <= ?`;
      default:
        return undefined;
    }
  }

  private generateContentCondition(condition: ContentCondition): string | undefined {
    if (!condition.value) return undefined;
    const textExpr = this.nameTextExpr(this.alias);
    const op = condition.operator ?? 'contains';

    if (op === 'regex') {
      // SQLite REGEXP requires a custom extension; not available in sql.js.
      return undefined;
    }

    if (op === 'fts') {
      const matchExpr = toFtsMatchExpression(String(condition.value));
      if (!matchExpr) return undefined;
      const param = this.pushParam(matchExpr);
      return `EXISTS (SELECT 1 FROM search_index si WHERE si.node_id = ${this.alias}.id AND si.content MATCH ${param})`;
    }

    this.pushParam(condition.value);
    const caseInsensitive = !condition.case_sensitive;

    switch (op) {
      case 'contains':
        return caseInsensitive
          ? `LOWER(${textExpr}) LIKE '%' || LOWER(?) || '%'`
          : `${textExpr} LIKE '%' || ? || '%'`;
      case 'starts_with':
        return caseInsensitive
          ? `LOWER(${textExpr}) LIKE LOWER(?) || '%'`
          : `${textExpr} LIKE ? || '%'`;
      case 'ends_with':
        return caseInsensitive
          ? `LOWER(${textExpr}) LIKE '%' || LOWER(?)`
          : `${textExpr} LIKE '%' || ?`;
      case 'equals':
        return caseInsensitive ? `LOWER(${textExpr}) = LOWER(?)` : `${textExpr} = ?`;
      default:
        return undefined;
    }
  }

  private generateStyleCondition(condition: StyleCondition): string | undefined {
    const astType = STYLE_TO_AST_TYPE[condition.style_type];
    if (!astType) return undefined;

    const hasContent = `${this.alias}.content IS NOT NULL AND json_array_length(${this.alias}.content) > 0`;
    this.pushParam(astType);
    const hasMark = `EXISTS (SELECT 1 FROM json_tree(${this.alias}.content) WHERE key = 'type' AND value = ? AND path LIKE '%.marks[%]')`;

    const op = condition.operator ?? 'contains';
    switch (op) {
      case 'contains':
        return `(${hasContent} AND ${hasMark})`;
      case 'does_not_contain':
        return `NOT (${hasContent} AND ${hasMark})`;
      case 'is':
        return hasMark;
      case 'is_not':
        return `NOT ${hasMark}`;
      default:
        return undefined;
    }
  }

  private generateReferenceCondition(condition: ReferenceCondition): string | undefined {
    const op = condition.operator ?? 'references';

    if (op === 'has_no_references') {
      return `NOT EXISTS (SELECT 1 FROM node_link nl WHERE nl.source_id = ${this.alias}.id)`;
    }
    if (op === 'has_references') {
      return `EXISTS (SELECT 1 FROM node_link nl WHERE nl.source_id = ${this.alias}.id)`;
    }

    const uuids = validUuids(
      condition.target_uuids && condition.target_uuids.length > 0
        ? condition.target_uuids
        : [condition.target_uuid],
      this.currentNodeUuid
    );
    if (uuids.length === 0) return undefined;

    const list = placeholders(uuids.length);
    uuids.forEach((u: string) => this.pushParam(u));
    const references = `EXISTS (SELECT 1 FROM node_link nl WHERE nl.source_id = ${this.alias}.id AND nl.target_id IN (${list}))`;

    if (op === 'does_not_reference') return `NOT ${references}`;
    return references;
  }

  private generateReferencePathCondition(condition: ReferencePathCondition): string | undefined {
    const uuids = validUuids(condition.target_uuids, this.currentNodeUuid);
    if (uuids.length === 0) return undefined;

    const targetSubquery = `SELECT id FROM node WHERE id IN (${placeholders(uuids.length)})`;
    uuids.forEach((u: string) => this.pushParam(u));

    return this.referencePathSql(targetSubquery);
  }

  private referencePathSql(targetSubquery: string): string {
    const workspaceParam = this.pushParam(this.workspaceId);
    const ancestorCte = `WITH RECURSIVE ancestors AS (SELECT id, parent_id, 0 AS depth FROM node WHERE id = ${this.alias}.id UNION ALL SELECT n.id, n.parent_id, a.depth + 1 FROM node n JOIN ancestors a ON n.id = a.parent_id)`;

    const viaNodeLink = `EXISTS (${ancestorCte} SELECT 1 FROM ancestors a JOIN node_link nl ON nl.source_id = a.id WHERE nl.target_id IN (${targetSubquery}) AND nl.workspace_id = ${workspaceParam})`;
    const viaProperty = `EXISTS (${ancestorCte} SELECT 1 FROM ancestors a JOIN property_value pv ON pv.node_id = a.id WHERE json_extract(pv.value, '$') IN (${targetSubquery}))`;
    const viaAncestor = `EXISTS (${ancestorCte} SELECT 1 FROM ancestors WHERE id IN (${targetSubquery}) AND depth > 0)`;

    return `(${viaNodeLink} OR ${viaProperty} OR ${viaAncestor})`;
  }

  private generateParentCondition(condition: ParentCondition): string | undefined {
    const op = condition.operator ?? 'has_parent';

    if (op === 'has_no_parent') {
      return `${this.alias}.parent_id IS NULL`;
    }
    if (op === 'has_any_parent') {
      return `${this.alias}.parent_id IS NOT NULL`;
    }

    const uuids = validUuids(
      condition.parent_uuids && condition.parent_uuids.length > 0
        ? condition.parent_uuids
        : condition.parent_uuid
          ? [condition.parent_uuid]
          : undefined,
      this.currentNodeUuid
    );

    if (uuids.length > 0) {
      const list = placeholders(uuids.length);
      uuids.forEach((u: string) => this.pushParam(u));
      const inSql = `${this.alias}.parent_id IN (${list})`;
      return op === 'not_has_parent' ? `NOT ${inSql}` : inSql;
    }

    if (!condition.nested_group) return undefined;
    const nested = this.compileGroupWithAlias('parent_n', condition.nested_group);
    const subquery = `SELECT parent_n.id FROM node parent_n WHERE parent_n.workspace_id = ${this.pushParam(
      this.workspaceId
    )} AND (${nested.sql})`;
    const inSql = `${this.alias}.parent_id IN (${subquery})`;
    const params = [...this.params, ...nested.params];
    // Replace params: workspace param was pushed above, then nested params follow.
    this.params = params;
    return op === 'not_has_parent' ? `NOT ${inSql}` : inSql;
  }

  private generateParentPathCondition(condition: ParentPathCondition): string | undefined {
    const op = condition.operator ?? 'has_ancestor';

    if (op === 'has_no_ancestor') {
      return `${this.alias}.parent_id IS NULL`;
    }
    if (op === 'has_any_ancestor') {
      return `${this.alias}.parent_id IS NOT NULL`;
    }

    const uuids = validUuids(condition.ancestor_uuids, this.currentNodeUuid);
    if (uuids.length > 0) {
      return this.ancestorExistsSql(uuids, op, condition.max_depth);
    }

    if (!condition.nested_group) return undefined;
    const nested = this.compileGroupWithAlias('anc_n', condition.nested_group);
    const workspaceParam = this.pushParam(this.workspaceId);
    const cte = `WITH RECURSIVE ancestors AS (SELECT id, parent_id, 0 AS depth FROM node WHERE id = ${this.alias}.id UNION ALL SELECT n.id, n.parent_id, a.depth + 1 FROM node n JOIN ancestors a ON n.id = a.parent_id)`;
    const exists = `EXISTS (${cte} SELECT 1 FROM ancestors JOIN node anc_n ON anc_n.id = ancestors.id WHERE anc_n.workspace_id = ${workspaceParam} AND ancestors.depth > 0 AND (${nested.sql}))`;
    this.params = [...this.params, ...nested.params];
    return op === 'not_has_ancestor' ? `NOT ${exists}` : exists;
  }

  private ancestorExistsSql(
    uuids: string[],
    op: string,
    maxDepth: number | undefined
  ): string {
    const list = placeholders(uuids.length);
    uuids.forEach((u: string) => this.pushParam(u));
    const depthSql =
      maxDepth !== undefined ? ` AND depth = ${this.pushParam(maxDepth)}` : '';
    const cte = `WITH RECURSIVE ancestors AS (SELECT id, parent_id, 0 AS depth FROM node WHERE id = ${this.alias}.id UNION ALL SELECT n.id, n.parent_id, a.depth + 1 FROM node n JOIN ancestors a ON n.id = a.parent_id)`;
    const exists = `EXISTS (${cte} SELECT 1 FROM ancestors WHERE id IN (${list}) AND depth > 0${depthSql})`;
    return op === 'not_has_ancestor' ? `NOT ${exists}` : exists;
  }

  private generateChildCondition(condition: ChildCondition): string | undefined {
    const op = condition.operator ?? 'has_child';

    if (op === 'has_no_child') {
      return `NOT EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = ${this.alias}.id)`;
    }
    if (op === 'has_any_child') {
      return `EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = ${this.alias}.id)`;
    }

    const uuids = validUuids(condition.child_uuids, this.currentNodeUuid);
    if (uuids.length > 0) {
      const list = placeholders(uuids.length);
      uuids.forEach((u: string) => this.pushParam(u));
      const exists = `EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = ${this.alias}.id AND child_n.id IN (${list}))`;
      return op === 'not_has_child' ? `NOT ${exists}` : exists;
    }

    if (!condition.nested_group) return undefined;
    const nested = this.compileGroupWithAlias('child_n', condition.nested_group);
    const workspaceParam = this.pushParam(this.workspaceId);
    const exists = `EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = ${this.alias}.id AND child_n.workspace_id = ${workspaceParam} AND (${nested.sql}))`;
    this.params = [...this.params, ...nested.params];
    return op === 'not_has_child' ? `NOT ${exists}` : exists;
  }

  private generateChildPathCondition(condition: ChildPathCondition): string | undefined {
    const op = condition.operator ?? 'has_descendant';

    if (op === 'has_no_descendant') {
      return `NOT EXISTS (SELECT 1 FROM node child WHERE child.parent_id = ${this.alias}.id)`;
    }
    if (op === 'has_any_descendant') {
      return `EXISTS (SELECT 1 FROM node child WHERE child.parent_id = ${this.alias}.id)`;
    }

    const uuids = validUuids(condition.descendant_uuids, this.currentNodeUuid);
    if (uuids.length > 0) {
      return this.descendantExistsSql(uuids, op, condition.max_depth);
    }

    if (!condition.nested_group) return undefined;
    const nested = this.compileGroupWithAlias('desc_n', condition.nested_group);
    const workspaceParam = this.pushParam(this.workspaceId);
    const cte = `WITH RECURSIVE descendants AS (SELECT id, parent_id, 0 AS depth FROM node WHERE id = ${this.alias}.id UNION ALL SELECT n.id, n.parent_id, d.depth + 1 FROM node n JOIN descendants d ON n.parent_id = d.id)`;
    const exists = `EXISTS (${cte} SELECT 1 FROM descendants JOIN node desc_n ON desc_n.id = descendants.id WHERE desc_n.workspace_id = ${workspaceParam} AND descendants.depth > 0 AND (${nested.sql}))`;
    this.params = [...this.params, ...nested.params];
    return op === 'not_has_descendant' ? `NOT ${exists}` : exists;
  }

  private descendantExistsSql(
    uuids: string[],
    op: string,
    maxDepth: number | undefined
  ): string {
    const list = placeholders(uuids.length);
    uuids.forEach((u: string) => this.pushParam(u));
    const depthSql =
      maxDepth !== undefined ? ` AND depth = ${this.pushParam(maxDepth)}` : '';
    const cte = `WITH RECURSIVE descendants AS (SELECT id, parent_id, 0 AS depth FROM node WHERE id = ${this.alias}.id UNION ALL SELECT n.id, n.parent_id, d.depth + 1 FROM node n JOIN descendants d ON n.parent_id = d.id)`;
    const exists = `EXISTS (${cte} SELECT 1 FROM descendants WHERE id IN (${list}) AND depth > 0${depthSql})`;
    return op === 'not_has_descendant' ? `NOT ${exists}` : exists;
  }

  private generatePageCondition(condition: PageCondition): string | undefined {
    const op = condition.operator ?? 'is_page';
    const pageId = this.pageIdSubquery(this.alias);

    const uuids = validUuids(
      condition.page_uuids && condition.page_uuids.length > 0
        ? condition.page_uuids
        : condition.page_uuid
          ? [condition.page_uuid]
          : undefined,
      this.currentNodeUuid
    );

    if (uuids.length > 0) {
      const list = placeholders(uuids.length);
      uuids.forEach((u: string) => this.pushParam(u));
      const inSql = `${pageId} IN (${list})`;
      return op === 'is_not_page' ? `(${pageId} IS NULL OR NOT ${inSql})` : inSql;
    }

    if (!condition.nested_group) {
      if (op === 'has_no_page') return `${pageId} IS NULL`;
      if (op === 'has_any_page') return `${pageId} IS NOT NULL`;
      return undefined;
    }

    const nested = this.compileGroupWithAlias('page_n', condition.nested_group);
    const workspaceParam = this.pushParam(this.workspaceId);
    const subquery = `SELECT page_n.id FROM node page_n WHERE page_n.workspace_id = ${workspaceParam} AND (${nested.sql})`;
    const inSql = `${pageId} IN (${subquery})`;
    this.params = [...this.params, ...nested.params];
    return op === 'is_not_page' ? `(${pageId} IS NULL OR NOT ${inSql})` : inSql;
  }

  private generateTagCondition(condition: TagCondition): string | undefined {
    const op = condition.operator ?? 'is';

    if (op === 'has_any_tag') {
      return `json_array_length(${this.alias}.class_ids) > 0`;
    }
    if (op === 'has_no_tag') {
      return `json_array_length(${this.alias}.class_ids) = 0`;
    }

    const uuids = validUuids(
      condition.tag_uuids && condition.tag_uuids.length > 0
        ? condition.tag_uuids
        : condition.tag_uuid
          ? [condition.tag_uuid]
          : undefined,
      this.currentNodeUuid,
    );
    if (uuids.length === 0) return undefined;

    const list = placeholders(uuids.length);
    uuids.forEach((u: string) => this.pushParam(u));
    const membership = `EXISTS (SELECT 1 FROM json_each(${this.alias}.class_ids) WHERE value IN (${list}))`;

    return op === 'is_not' ? `NOT ${membership}` : membership;
  }
}

class AggregationCompiler {
  private params: unknown[] = [];
  private joins: string[] = [];

  private pushParam(value: unknown): string {
    this.params.push(value);
    return '?';
  }

  compile(aggregation: AggregationNode): CompiledSql {
    const dimensions = aggregation.dimensions;
    if (!dimensions || dimensions.length === 0) {
      throw new Error('Aggregation has no dimensions');
    }

    const selectCols: string[] = [];
    const groupExprs: string[] = [];

    for (let i = 0; i < dimensions.length; i++) {
      const dim = dimensions[i];
      const expr = this.dimensionExpr(dim, i);
      selectCols.push(`    ${expr} AS dim_${i}`);
      groupExprs.push(expr);
    }

    const measure = aggregation.measure ?? { type: 'measure', function: 'count' as const };
    const measureExpr = this.measureExpr(measure);
    selectCols.push(`    ${measureExpr} AS value`);

    const groupBy = groupExprs.join(', ');
    const orderBy = groupExprs.length > 0 ? `${groupExprs[0]} ASC, value DESC` : 'value DESC';
    const joinsSql = this.joins.length > 0 ? `\n${this.joins.join('\n')}` : '';

    const sql = `SELECT\n${selectCols.join(',\n')}\nFROM filtered_nodes fn${joinsSql}\nGROUP BY ${groupBy}\nORDER BY ${orderBy}`;
    return { sql, params: this.params };
  }

  private dimensionExpr(dim: AggregationDimension, idx: number): string {
    if (dim.field === 'is_page') {
      return `CASE WHEN fn.kind = 'page' THEN 1 ELSE 0 END`;
    }
    if (dim.field === 'create_date') {
      return `date(fn.created_at)`;
    }
    if (dim.field === 'write_date') {
      return `date(fn.updated_at)`;
    }
    if (dim.field === 'page') {
      return `(WITH RECURSIVE page_ancestors(id, kind, parent_id) AS (
        SELECT fn.id, fn.kind, fn.parent_id
        UNION ALL
        SELECT n.id, n.kind, n.parent_id FROM node n JOIN page_ancestors pa ON n.id = pa.parent_id
      ) SELECT id FROM page_ancestors WHERE kind = 'page' LIMIT 1)`;
    }
    if (dim.field === 'class') {
      const alias = `cd_${idx}`;
      this.joins.push(`LEFT JOIN json_each(fn.class_ids) AS ${alias} ON 1=1`);
      return `${alias}.value`;
    }

    if (!dim.property_type) {
      throw new Error(`Property dimension requires property_type for ${dim.field}`);
    }
    const alias = `pd_${idx}`;
    this.joins.push(
      `LEFT JOIN property_value ${alias} ON ${alias}.node_id = fn.id AND ${alias}.property_schema_id = ${this.pushParam(
        dim.field
      )}`
    );
    return `json_extract(${alias}.value, '$')`;
  }

  private measureExpr(measure: AggregationMeasure): string {
    if (measure.function === 'count' || !measure.field) {
      return 'COUNT(*)';
    }
    if (!measure.property_type) {
      throw new Error(`Property measure requires property_type for ${measure.field}`);
    }
    const alias = 'm_0';
    this.joins.push(
      `LEFT JOIN property_value ${alias} ON ${alias}.node_id = fn.id AND ${alias}.property_schema_id = ${this.pushParam(
        measure.field
      )}`
    );
    return `${measure.function.toUpperCase()}(CAST(json_extract(${alias}.value, '$') AS REAL))`;
  }
}
