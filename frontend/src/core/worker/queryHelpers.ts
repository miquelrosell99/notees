/**
 * Worker-side query helpers for operations that need raw SQL against the
 * worker-owned WorkspaceStore.
 *
 * These helpers are invoked through `IWorkspaceStoreClient.query` and are
 * implemented in both the real Web Worker and the jsdom inline fallback so
 * tests keep sharing the same synchronous store.
 */

import type { WorkspaceStore } from '../store';
import type {
  Node,
  ClassExtends,
  InheritedProperty,
  ExtendedByClass,
  BreadcrumbItemResponse,
  Backlink,
  LinkType,
  LinkedReference,
  LinkedReferencesResponse,
  BreadcrumbSegment,
  PropertyBacklink,
  TextLink,
} from '@/types/api';

import type { NodeView } from '@/types/nodeView';
import type { QueryAST } from '@/types/queryAST';
import { queryAll, queryOne } from '../db/sqlite';
import { projectNode, projectNodes } from '../adapters/nodeProjection';
import { parseAST, parseLinkId, unwrapCrdtContentAst } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, TASK_CLOSED_STATUSES } from '@/constants/systemProperties';
import { createEmptyQueryAST } from '@/types/queryAST';
import { substituteRuntimeParams } from '../query/substituteRuntimeParams';
import { compileToSqlite } from '../query/compileToSqlite';
import { expandClassFilterUuidsFromDb, nodeMatchesExpandedClassFilter } from '../query/classFilter';
import { queryNodes } from '../query/queryNodes';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { executeGraphQuery } from '../graphQueries/queryRegistry';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import { isDayUuid, isMonthUuid, isYearUuid, yearMonthToMonthUuid, yearToYearUuid } from '@/utils/dateUuid';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function runGraphQuery(store: WorkspaceStore, name: string, input: unknown): unknown {
  return executeGraphQuery(store, name, input);
}

// ─── Node projection ────────────────────────────────────────────────────────

export function getNodeByUuid(store: WorkspaceStore, nodeUuid: string): Node | null {
  return projectNode(store, nodeUuid) ?? null;
}

export function getProjectedNodes(
  store: WorkspaceStore,
  nodeUuids: string[],
  depth?: number
): Node[] {
  return projectNodes(store, nodeUuids, depth);
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

export function getChildrenBatch(store: WorkspaceStore, parentIds: string[]): Record<string, string[]> {
  return store.getChildrenBatch(parentIds);
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
  // The compiled SQL has no active filter; queryNodes excludes archived/trashed
  // rows post-projection (isActiveMatch), so the COUNT must exclude them too or
  // collapsed header badges would disagree with the expanded result set.
  const row = queryOne<{ count: number }>(
    store.getDb(),
    `SELECT COUNT(*) AS count FROM (${compiled.sql}) WHERE active = 1`,
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

// ─── Breadcrumbs ────────────────────────────────────────────────────────────

const MAX_RESOLVED_BREADCRUMB_NAME_LENGTH = 200;

/**
 * Resolve a node's content AST to plain text, expanding node links recursively.
 *
 * Links that cannot be resolved (deleted target, missing store entry) fall back
 * to the AST label or a placeholder. Recursive/cyclic links are rendered as "…"
 * by stringifyAST's built-in cycle detection.
 */
function resolveBreadcrumbNameText(store: WorkspaceStore, content: string | null | undefined): string {
  if (!content) return '';
  const ast = unwrapCrdtContentAst(parseAST(content));
  const text = stringifyAST(ast, {
    mode: StringifyMode.TEXT_ONLY,
    maxLength: MAX_RESOLVED_BREADCRUMB_NAME_LENGTH,
    resolveNodeLink: (linkId) => {
      const { nodeUuid } = parseLinkId(linkId);
      if (!nodeUuid) return null;
      const target = projectNode(store, nodeUuid);
      if (!target) return null;
      return {
        targetAST: unwrapCrdtContentAst(parseAST(target.content)),
        label: null,
        targetId: nodeUuid,
      };
    },
  });
  return text.trim();
}

export function buildBreadcrumbs(store: WorkspaceStore, nodeUuid: string): BreadcrumbItemResponse[] {
  const breadcrumbs: BreadcrumbItemResponse[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = nodeUuid;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = projectNode(store, currentId);
    if (!node) break;

    currentId = node.parent_uuid;
    if (!currentId) break;

    const parent = projectNode(store, currentId);
    if (!parent) break;

    breadcrumbs.push({
      uuid: parent.uuid,
      name: parent.name,
      display_name: resolveBreadcrumbNameText(store, parent.content) || parent.display_name || parent.name,
      icon: parent.icon ?? null,
      is_page: parent.is_page,
      parent_locked: parent.parent_locked ?? false,
    });
  }

  // Ancestors were collected from immediate parent up to root; the UI expects
  // root-to-leaf order (e.g., year → month → day for date pages).
  return breadcrumbs.reverse();
}

/**
 * Ensure existing daily/monthly/yearly journal pages form the correct
 * year → month → day hierarchy.
 *
 * This is a one-off idempotent cleanup run at workspace startup. It fixes
 * journal pages created before the hierarchy was enforced, and is cheap because
 * there are at most a few hundred date nodes per workspace.
 */
export function repairDatePageHierarchy(store: WorkspaceStore): void {
  const db = store.getDb();
  const rows = queryAll<{ id: string; class_ids: string }>(
    db,
    `SELECT id, class_ids FROM node
     WHERE EXISTS (
       SELECT 1 FROM json_each(class_ids)
       WHERE value IN (?, ?, ?)
     )`,
    [SYSTEM_CLASS_UUIDS.day, SYSTEM_CLASS_UUIDS.month, SYSTEM_CLASS_UUIDS.year]
  );

  for (const row of rows) {
    const classIds = parseJson<string[]>(row.class_ids, []);
    const nodeId = row.id;
    let expectedParentId: string | null = null;

    if (classIds.includes(SYSTEM_CLASS_UUIDS.day) && isDayUuid(nodeId)) {
      const datePart = nodeId.slice('00000000-0000-0000-00dd-'.length, '00000000-0000-0000-00dd-'.length + 8);
      const year = datePart.slice(0, 4);
      const month = datePart.slice(4, 6);
      expectedParentId = yearMonthToMonthUuid(parseInt(year, 10), parseInt(month, 10));
    } else if (classIds.includes(SYSTEM_CLASS_UUIDS.month) && isMonthUuid(nodeId)) {
      const yearPart = nodeId.slice('00000000-0000-0000-00aa-'.length, '00000000-0000-0000-00aa-'.length + 4);
      expectedParentId = yearToYearUuid(parseInt(yearPart, 10));
    } else if (classIds.includes(SYSTEM_CLASS_UUIDS.year) && isYearUuid(nodeId)) {
      expectedParentId = null;
    } else {
      continue;
    }

    const currentRow = queryOne<{ parent_id: string | null }>(
      db,
      'SELECT parent_id FROM node WHERE id = ?',
      [nodeId]
    );
    const currentParentId = currentRow?.parent_id ?? null;

    if (currentParentId !== expectedParentId) {
      store.moveNode(nodeId, expectedParentId);
    }
  }
}

/**
 * Rebuild the class_hierarchy closure table from the class table.
 *
 * Idempotent startup repair, run alongside repairDatePageHierarchy. The
 * closure is fully derivable from class.extends_class_ids, so this heals
 * clients that applied class ops with an older applier — without forcing a
 * full operation-log replay via CURRENT_DERIVED_STATE_VERSION. Ancestors are
 * resolved by walking extends_class_ids directly (not the half-built closure)
 * and the walk is cycle-safe. Cheap: workspaces have few classes.
 */
export function repairClassHierarchy(store: WorkspaceStore): void {
  const db = store.getDb();
  const classes = queryAll<{ id: string; extends_class_ids: string | null }>(
    db,
    'SELECT id, extends_class_ids FROM class'
  );
  if (classes.length === 0) return;

  const extendsById = new Map<string, string[]>(
    classes.map((c) => [c.id, parseJson<string[]>(c.extends_class_ids ?? '', [])])
  );

  const ancestorsOf = (classId: string): string[] => {
    const ancestors = new Set<string>();
    const stack = [...(extendsById.get(classId) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === classId || ancestors.has(current)) continue;
      ancestors.add(current);
      stack.push(...(extendsById.get(current) ?? []));
    }
    return [...ancestors].sort();
  };

  db.run('DELETE FROM class_hierarchy');
  for (const c of classes) {
    db.run('INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', [c.id, c.id]);
    for (const ancestorId of ancestorsOf(c.id)) {
      db.run('INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)', [c.id, ancestorId]);
    }
  }
}

// ─── Backlinks ──────────────────────────────────────────────────────────────

export function buildBacklinks(store: WorkspaceStore, nodeUuid: string): Backlink[] {
  const sourceIds = store.getBacklinks(nodeUuid);
  const backlinks: Backlink[] = [];

  for (const sourceId of sourceIds) {
    const sourceNode = projectNode(store, sourceId);
    if (!sourceNode) continue;

    const sourcePage = sourceNode.is_page ? sourceNode : findSourcePage(store, sourceId);
    const linkType: LinkType = sourceNode.is_page ? 'page' : 'block';

    backlinks.push({
      source_node_uuid: sourceNode.uuid,
      source_node_name: sourceNode.name,
      source_page_uuid: sourcePage?.uuid ?? null,
      source_page_name: sourcePage?.name ?? null,
      link_type: linkType,
      position: 0,
    });
  }

  return backlinks;
}

// ─── Linked references ──────────────────────────────────────────────────────

function findSourcePage(store: WorkspaceStore, sourceNodeId: string): Node | undefined {
  const sourceNode = projectNode(store, sourceNodeId);
  if (!sourceNode) return undefined;
  if (sourceNode.is_page) return sourceNode;

  const visited = new Set<string>();
  let currentId: string | null | undefined = sourceNode.parent_uuid;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = projectNode(store, currentId);
    if (!parent) break;
    if (parent.is_page) return parent;
    currentId = parent.parent_uuid;
  }
  return undefined;
}

function buildBreadcrumbPath(store: WorkspaceStore, sourceNodeId: string): BreadcrumbSegment[] {
  const path: BreadcrumbSegment[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = sourceNodeId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = projectNode(store, currentId);
    if (!node) break;
    const parentId = node.parent_uuid;
    if (!parentId) break;
    const parent = projectNode(store, parentId);
    if (!parent) break;
    path.unshift({
      node_uuid: parent.uuid,
      name: nodeNameToText(parent.name) || parent.uuid,
      is_property: false,
    });
    currentId = parentId;
  }

  return path;
}

function buildSyntheticRef(store: WorkspaceStore, sourceNodeId: string): LinkedReference {
  const sourceNode = projectNode(store, sourceNodeId)!;
  const sourcePage = findSourcePage(store, sourceNodeId);
  const breadcrumbPath = buildBreadcrumbPath(store, sourceNodeId);

  return {
    source_node: sourceNode as Node,
    source_page: (sourcePage as Node | undefined) ?? null,
    link_type: 'text',
    context: nodeNameToText(sourceNode.name) || '',
    breadcrumb_path: breadcrumbPath,
  };
}

export function buildLinkedReferences(
  store: WorkspaceStore,
  nodeUuid: string,
  params?: { limit?: number; offset?: number }
): LinkedReferencesResponse {
  const baseAst = createEmptyQueryAST();
  const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid });
  const matches = queryNodes(store, {
    ast,
    runtimeParams: { current_node_uuid: nodeUuid, current_node_id: nodeUuid },
    projectionDepth: 0,
  });

  const refs = matches.map((sourceNode) => buildSyntheticRef(store, sourceNode.uuid));

  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? refs.length;
  const paginated = refs.slice(offset, offset + limit);

  return { linked_references: paginated, total_count: refs.length };
}

// ─── Property backlinks ─────────────────────────────────────────────────────

export function buildPropertyBacklinks(store: WorkspaceStore, nodeUuid: string): PropertyBacklink[] {
  const db = store.getDb();

  const rows = queryAll<{ node_id: string; property_schema_id: string }>(
    db,
    `SELECT DISTINCT pv.node_id, pv.property_schema_id
     FROM property_value pv
     JOIN node n ON n.id = pv.node_id
     WHERE json_extract(pv.value, '$') = ?`,
    [nodeUuid]
  );

  const backlinks: PropertyBacklink[] = [];

  for (const row of rows) {
    const sourcePage = findSourcePage(store, row.node_id);
    if (!sourcePage) continue;

    const propertySchema = projectNode(store, row.property_schema_id);

    backlinks.push({
      source_page: sourcePage,
      property_uuid: row.property_schema_id,
      property_name: propertySchema?.name ?? row.property_schema_id,
    });
  }

  return backlinks;
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export function buildTasks(store: WorkspaceStore, includeComplete = false): Node[] {
  const db = store.getDb();

  const rows = queryAll<{ id: string }>(
    db,
    `SELECT n.id
     FROM node n
     WHERE EXISTS (
       SELECT 1 FROM json_each(n.class_ids)
       WHERE value = ?
     )
     ORDER BY n.id`,
    [SYSTEM_CLASS_UUIDS.task]
  );

  const tasks: Node[] = [];

  for (const row of rows) {
    const node = projectNode(store, row.id);
    if (!node) continue;

    if (!includeComplete) {
      const status = node.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.task_status];
      if (typeof status === 'string' && TASK_CLOSED_STATUSES.has(status)) {
        continue;
      }
    }

    tasks.push(node);
  }

  return tasks;
}

// ─── Text links ───────────────────────────────────────────────────────────────

export function buildTextLinks(store: WorkspaceStore, nodeUuid: string): TextLink[] {
  const db = store.getDb();

  const rows = queryAll<{ id: string; target_id: string; label: string | null }>(
    db,
    `SELECT id, target_id, label
     FROM node_link
     WHERE source_id = ?
     ORDER BY created_at`,
    [nodeUuid]
  );

  return rows.map((row, index) => {
    const targetNode = projectNode(store, row.target_id);
    let name: string | null = targetNode?.name ?? null;

    if (!name) {
      name = row.label ?? null;
    }

    return {
      uuid: row.id,
      source_node_uuid: nodeUuid,
      target_node_uuid: row.target_id,
      position: index,
      name,
    };
  });
}

// ─── Suggestions ────────────────────────────────────────────────────────────

const SUGGESTION_LIMIT = 20;
const RECENT_MINUTES = 15;

export function buildSuggestions(store: WorkspaceStore, classFilters?: string): Node[] {
  const db = store.getDb();
  // Hierarchy-aware class filtering (Decision 9): resolve filter UUIDs through
  // the class_hierarchy closure so superclass filters match subclass instances.
  const classFilterSet = classFilters
    ? expandClassFilterUuidsFromDb(db, classFilters.split(',').filter(Boolean))
    : null;

  const recentCutoff = new Date(Date.now() - RECENT_MINUTES * 60 * 1000).toISOString();

  const recentRows = queryAll<{ id: string }>(
    db,
    `SELECT id FROM node
     WHERE kind = 'page'
       AND created_at >= ?
     ORDER BY created_at DESC`,
    [recentCutoff]
  );

  const linkedRows = queryAll<{ id: string }>(
    db,
    `SELECT id FROM (
       SELECT n.id, MAX(lc.last_clicked_at) AS last_at
       FROM node n
       JOIN link_click lc ON lc.target_id = n.id
       WHERE n.kind = 'page'
       GROUP BY n.id

       UNION ALL

       SELECT n.id, MAX(nl.created_at) AS last_at
       FROM node n
       JOIN node_link nl ON nl.target_id = n.id
       WHERE n.kind = 'page'
       GROUP BY n.id
     )
     ORDER BY last_at DESC`,
    []
  );

  const seen = new Set<string>();
  const suggestions: Node[] = [];

  const addNode = (node: Node) => {
    if (seen.has(node.uuid)) return;
    if (classFilterSet && !nodeMatchesExpandedClassFilter(node.classes_uuid, classFilterSet)) return;
    seen.add(node.uuid);
    suggestions.push(node);
  };

  for (const row of recentRows) {
    const node = projectNode(store, row.id);
    if (node) addNode(node);
  }

  for (const row of linkedRows) {
    const node = projectNode(store, row.id);
    if (node) addNode(node);
    if (suggestions.length >= SUGGESTION_LIMIT) break;
  }

  return suggestions.slice(0, SUGGESTION_LIMIT);
}
