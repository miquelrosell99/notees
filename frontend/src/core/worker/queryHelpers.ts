/**
 * Worker-side query helpers for operations that need raw SQL against the
 * worker-owned WorkspaceStore.
 *
 * These helpers are invoked through `IWorkspaceStoreClient.query` and are
 * implemented in both the real Web Worker and the jsdom inline fallback so
 * tests keep sharing the same synchronous store.
 */

import type { WorkspaceStore } from '../store';
import type { Node, ClassExtends, InheritedProperty, ExtendedByClass } from '@/types/api';
import type { NodeView } from '@/types/nodeView';
import type { QueryAST } from '@/types/queryAST';
import { queryAll, queryOne } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { createEmptyQueryAST } from '@/types/queryAST';
import { substituteRuntimeParams } from '../query/substituteRuntimeParams';
import { compileToSqlite } from '../query/compileToSqlite';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Node projection ────────────────────────────────────────────────────────

export function getNodeByUuid(store: WorkspaceStore, nodeUuid: string): Node | null {
  return projectNode(store, nodeUuid) ?? null;
}

export function getNodeKindMap(store: WorkspaceStore): Map<string, 'page' | 'block' | 'class'> {
  const rows = queryAll<{ id: string; kind: string }>(
    store.getDb(),
    'SELECT id, kind FROM node WHERE active = 1'
  );
  const map = new Map<string, 'page' | 'block' | 'class'>();
  for (const row of rows) {
    if (row.kind === 'page' || row.kind === 'block' || row.kind === 'class') {
      map.set(row.id, row.kind);
    }
  }
  return map;
}

// ─── NodeView queries ───────────────────────────────────────────────────────

interface NodeViewRow {
  id: string;
  node_id: string;
  name: string;
  view_type: string;
  order_index: number;
  is_default: number;
  active: number;
  shown_properties: string;
  group_by: string | null;
  view_mode: string | null;
  sort_entries: string;
  settings: string;
  query_ast: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function rowToNodeView(row: NodeViewRow): NodeView {
  return {
    uuid: row.id,
    node_uuid: row.node_id,
    name: row.name,
    view_type: row.view_type,
    order_index: row.order_index,
    is_default: row.is_default !== 0,
    active: row.active !== 0,
    shown_properties: parseJson<Array<{ uuid: string; sequence: number }>>(row.shown_properties, []),
    group_by: parseJson<NodeView['group_by']>(row.group_by, null),
    view_mode: row.view_mode as NodeView['view_mode'],
    sort_entries: parseJson<NodeView['sort_entries']>(row.sort_entries, []),
    settings: parseJson<NodeView['settings']>(row.settings, {}),
    query_ast: parseJson<QueryAST | undefined>(row.query_ast, undefined),
    create_date: row.created_at ?? new Date().toISOString(),
    write_date: row.updated_at ?? new Date().toISOString(),
  };
}

export function getNodeViews(
  store: WorkspaceStore,
  nodeUuid: string,
  options?: { viewType?: string; includeQueryAST?: boolean }
): NodeView[] {
  const { viewType, includeQueryAST = true } = options ?? {};
  const sql = viewType
    ? `SELECT * FROM node_view WHERE node_id = ? AND view_type = ? AND active = 1 ORDER BY order_index`
    : `SELECT * FROM node_view WHERE node_id = ? AND active = 1 ORDER BY order_index`;
  const params = viewType ? [nodeUuid, viewType] : [nodeUuid];
  const rows = queryAll<NodeViewRow>(store.getDb(), sql, params);

  const views = rows.map(rowToNodeView);
  if (!includeQueryAST) {
    return views.map((v) => ({ ...v, query_ast: undefined }));
  }
  return views;
}

export function getNodeViewsByType(store: WorkspaceStore, nodeUuid: string): Record<string, NodeView[]> {
  const rows = queryAll<NodeViewRow>(
    store.getDb(),
    `SELECT * FROM node_view WHERE node_id = ? AND active = 1 ORDER BY order_index`,
    [nodeUuid]
  );

  const grouped: Record<string, NodeView[]> = {};
  for (const row of rows) {
    const view = rowToNodeView(row);
    if (!grouped[view.view_type]) {
      grouped[view.view_type] = [];
    }
    grouped[view.view_type].push(view);
  }
  for (const viewType of Object.keys(grouped)) {
    grouped[viewType].sort((a, b) => a.order_index - b.order_index);
  }
  return grouped;
}

export function getNodeView(store: WorkspaceStore, viewUuid: string): NodeView | undefined {
  const row = queryOne<NodeViewRow>(store.getDb(), `SELECT * FROM node_view WHERE id = ?`, [viewUuid]);
  return row ? rowToNodeView(row) : undefined;
}

export function getDefaultNodeView(
  store: WorkspaceStore,
  nodeUuid: string,
  viewType: string
): NodeView | undefined {
  const row = queryOne<NodeViewRow>(
    store.getDb(),
    `SELECT * FROM node_view WHERE node_id = ? AND view_type = ? AND is_default = 1 AND active = 1`,
    [nodeUuid, viewType]
  );
  return row ? rowToNodeView(row) : undefined;
}

export function countQueryResults(
  store: WorkspaceStore,
  workspaceId: string,
  request: { query_ast?: QueryAST; runtime_params?: Record<string, unknown> }
): number {
  if (!request.query_ast) return 0;
  const ast = substituteRuntimeParams(request.query_ast, request.runtime_params ?? {});
  const compiled = compileToSqlite(ast, workspaceId);
  const row = queryOne<{ count: number }>(
    store.getDb(),
    `SELECT COUNT(*) AS count FROM (${compiled.sql})`,
    compiled.params as (string | number | null | Uint8Array)[]
  );
  return row?.count ?? 0;
}

export function readViewAst(store: WorkspaceStore, viewUuid: string): QueryAST {
  const row = queryOne<{ query_ast: string | null }>(
    store.getDb(),
    'SELECT query_ast FROM node_view WHERE id = ?',
    [viewUuid]
  );
  if (!row?.query_ast) return createEmptyQueryAST();
  try {
    return JSON.parse(row.query_ast) as QueryAST;
  } catch {
    return createEmptyQueryAST();
  }
}

// ─── Class / property queries ───────────────────────────────────────────────

function classNameByUuid(classes: Node[], uuid: string): string {
  return classes.find((c) => c.uuid === uuid)?.name ?? uuid;
}

export function getClassExtends(store: WorkspaceStore, classId: string, classes: Node[]): ClassExtends[] {
  const rows = queryAll<{ ancestor_id: string }>(
    store.getDb(),
    'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ? ORDER BY ancestor_id',
    [classId, classId]
  );
  return rows.map((row, index) => ({
    class_node_uuid: classId,
    class_node_name: classNameByUuid(classes, classId),
    extends_class_node_uuid: row.ancestor_id,
    extends_class_node_name: classNameByUuid(classes, row.ancestor_id),
    sequence: index,
  }));
}

export function getClassExtendsAncestors(store: WorkspaceStore, classId: string): string[] {
  const rows = queryAll<{ ancestor_id: string }>(
    store.getDb(),
    'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ? ORDER BY ancestor_id',
    [classId, classId]
  );
  return rows.map((row) => row.ancestor_id);
}

export function getInheritedProperties(
  store: WorkspaceStore,
  classId: string,
  classes: Node[]
): InheritedProperty[] {
  const db = store.getDb();
  const directIds = new Set(
    queryAll<{ property_schema_id: string }>(
      db,
      'SELECT property_schema_id FROM class_property_edge WHERE class_id = ?',
      [classId]
    ).map((r) => r.property_schema_id)
  );
  const rows = queryAll<{
    ancestor_id: string;
    property_schema_id: string;
    property_name: string;
    property_type: string;
    sequence: number;
    default_value: string | null;
    hidden: number;
  }>(
    db,
    `SELECT
       h.ancestor_id,
       e.property_schema_id,
       s.name AS property_name,
       s.type AS property_type,
       e.sequence,
       e.default_value,
       e.hidden
     FROM class_hierarchy h
     JOIN class_property_edge e ON e.class_id = h.ancestor_id
     JOIN property_schema s ON s.id = e.property_schema_id
     WHERE h.class_id = ? AND h.ancestor_id != ? AND s.active = 1
     ORDER BY e.sequence`,
    [classId, classId]
  );

  const seen = new Set<string>();
  return rows
    .filter((row) => !directIds.has(row.property_schema_id))
    .filter((row) => {
      if (seen.has(row.property_schema_id)) return false;
      seen.add(row.property_schema_id);
      return true;
    })
    .map((row) => ({
      property_uuid: row.property_schema_id,
      property_name: row.property_name,
      property_type: row.property_type as InheritedProperty['property_type'],
      from_class_uuid: row.ancestor_id,
      from_class_name: classNameByUuid(classes, row.ancestor_id),
      sequence: row.sequence,
      default_value: (() => {
        try {
          return JSON.parse(row.default_value ?? 'null') as unknown;
        } catch {
          return null;
        }
      })(),
      hidden: row.hidden !== 0,
      is_overridden: false,
    }));
}

export function getExtendedByClasses(store: WorkspaceStore, classId: string, classes: Node[]): ExtendedByClass[] {
  const rows = queryAll<{ class_id: string }>(
    store.getDb(),
    'SELECT class_id FROM class_hierarchy WHERE ancestor_id = ? AND class_id != ?',
    [classId, classId]
  );
  return rows.map((row) => ({
    nodeUuid: row.class_id,
    uuid: row.class_id,
    name: classNameByUuid(classes, row.class_id),
    icon: classes.find((c) => c.uuid === row.class_id)?.icon ?? null,
  }));
}

export interface PropertySuggestion {
  property_uuid: string;
  name: string;
  icon: string | null;
  type: string;
  usage_count: number;
  already_assigned: boolean;
}

export function getPropertySuggestions(
  store: WorkspaceStore,
  contextNodeUuid: string | undefined
): PropertySuggestion[] {
  const db = store.getDb();

  // Count how many nodes have a value for each property schema.
  const usageRows = queryAll<{ property_schema_id: string; usage_count: number }>(
    db,
    `SELECT property_schema_id, COUNT(DISTINCT node_id) AS usage_count
     FROM property_value
     GROUP BY property_schema_id`
  );
  const usageMap = new Map(usageRows.map((r) => [r.property_schema_id, r.usage_count]));

  // Optionally determine which properties the context node already has.
  const nodePropertyIds = new Set<string>();
  if (contextNodeUuid) {
    const nodeRows = queryAll<{ property_schema_id: string }>(
      db,
      'SELECT DISTINCT property_schema_id FROM property_value WHERE node_id = ?',
      [contextNodeUuid]
    );
    for (const row of nodeRows) {
      nodePropertyIds.add(row.property_schema_id);
    }
  }

  const schemaRows = queryAll<{ id: string; name: string; icon: string | null; type: string }>(
    db,
    `SELECT id, name, icon, type
     FROM property_schema
     WHERE workspace_id = ? AND active = 1`,
    [store.getWorkspaceId()]
  );

  return schemaRows
    .map((schema) => ({
      property_uuid: schema.id,
      name: schema.name,
      icon: schema.icon,
      type: schema.type,
      usage_count: usageMap.get(schema.id) ?? 0,
      already_assigned: contextNodeUuid ? nodePropertyIds.has(schema.id) : false,
    }))
    .sort((a, b) => b.usage_count - a.usage_count);
}

function parseClassName(contentJson: string): string {
  try {
    const content = JSON.parse(contentJson) as unknown[];
    return content.map((c) => (c as { text?: string }).text ?? '').join('').trim();
  } catch {
    return '';
  }
}

export function getNodesWithProperty(store: WorkspaceStore, propertyUuid: string): Node[] {
  const rows = queryAll<{
    node_id: string;
    value: string;
    kind: string;
    parent_id: string | null;
    class_ids: string;
    content: string;
    created_at: string | null;
    updated_at: string | null;
  }>(
    store.getDb(),
    `SELECT
       n.id AS node_id,
       v.value,
       n.kind,
       n.parent_id,
       n.class_ids,
       n.content,
       n.created_at,
       n.updated_at
     FROM property_value v
     JOIN node n ON n.id = v.node_id
     WHERE v.property_schema_id = ? AND n.active = 1`,
    [propertyUuid]
  );

  return rows.map((row) => {
    const name = parseClassName(row.content);
    const classIds = (() => {
      try {
        return JSON.parse(row.class_ids) as string[];
      } catch {
        return [];
      }
    })();
    const isClass = classIds.includes('class') || row.kind === 'class';
    const pageUuid = row.parent_id ?? row.node_id;
    return {
      uuid: row.node_id,
      name,
      icon: null,
      color: null,
      parent_uuid: row.parent_id,
      page_uuid: pageUuid,
      is_page: row.kind === 'page' || row.parent_id === null,
      is_class: isClass,
      sequence: 0,
      active: true,
      create_date: row.created_at ?? new Date().toISOString(),
      write_date: row.updated_at ?? new Date().toISOString(),
      classes_uuid: classIds,
    } as unknown as Node;
  });
}

export interface ValidateClassExtendsResult {
  valid: boolean;
  error?: string;
  cycle_path?: string[];
}

export function validateClassExtends(
  store: WorkspaceStore,
  classId: string,
  extendsIds: string[]
): ValidateClassExtendsResult {
  for (const candidateId of extendsIds) {
    if (candidateId === classId) {
      return { valid: false, error: 'Circular inheritance', cycle_path: [classId, candidateId] };
    }
    const visited: string[] = [];
    const stack = [candidateId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === classId) {
        return { valid: false, error: 'Circular inheritance', cycle_path: [...visited, classId] };
      }
      if (visited.includes(current)) continue;
      visited.push(current);
      const parents = queryAll<{ ancestor_id: string }>(
        store.getDb(),
        'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ?',
        [current, current]
      );
      for (const parent of parents) {
        stack.push(parent.ancestor_id);
      }
    }
  }

  return { valid: true };
}

// ─── Raw UUID link repair ───────────────────────────────────────────────────

export interface RawUuidLinkCandidate {
  id: string;
  content: unknown[];
}

export function getNodesWithRawUuidLinks(store: WorkspaceStore): RawUuidLinkCandidate[] {
  const rows = queryAll<{ id: string; content: string }>(
    store.getDb(),
    'SELECT id, content FROM node WHERE content LIKE "%[[%" ESCAPE "\\"'
  );
  return rows.map((row) => ({
    id: row.id,
    content: JSON.parse(row.content) as unknown[],
  }));
}

// ─── Existing helpers ───────────────────────────────────────────────────────

export function getTrashedNodes(
  store: WorkspaceStore,
  projectionDepth?: number
): Node[] {
  const rows = queryAll<{ id: string }>(
    store.getDb(),
    'SELECT id FROM node WHERE active = 0 ORDER BY updated_at DESC'
  );
  return rows
    .map((row) => projectNode(store, row.id, projectionDepth))
    .filter((n): n is Node => n !== undefined);
}

export function getArchivedPages(store: WorkspaceStore): Node[] {
  const rows = queryAll<{ id: string }>(
    store.getDb(),
    "SELECT id FROM node WHERE kind = 'page' AND active = 0 ORDER BY updated_at DESC"
  );
  return rows
    .map((row) => projectNode(store, row.id))
    .filter((n): n is Node => n !== undefined);
}

export function getPageAliases(
  store: WorkspaceStore,
  canonicalNodeId: string
): Node[] {
  const rows = queryAll<{ alias_node_id: string }>(
    store.getDb(),
    'SELECT alias_node_id FROM node_alias WHERE canonical_node_id = ?',
    [canonicalNodeId]
  );
  return rows
    .map((row) => projectNode(store, row.alias_node_id))
    .filter(
      (n): n is Node => n !== undefined && n.uuid !== canonicalNodeId
    );
}

export function getCommentNodes(
  store: WorkspaceStore,
  nodeUuid: string
): Node[] {
  const childIds = store.getChildren(nodeUuid);
  return childIds
    .map((childId) => projectNode(store, childId))
    .filter(
      (n): n is Node =>
        n !== undefined &&
        n.active !== false &&
        !!n.classes_uuid?.includes(SYSTEM_CLASS_UUIDS.comment)
    );
}
