import type { Database } from 'sql.js';
import type { Node } from '@/types/api';
import { queryAll, queryOne } from '../db/sqlite';
import type { NodeRow, WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';

const MAX_NAME_LENGTH = 200;
const MAX_CHILDREN_DEPTH = 2;

/**
 * Derive a display name from node content.
 *
 * - If content is a valid AST document, stringify it to plain text. Node links
 *   render as a placeholder ("…") because this helper has no store access to
 *   resolve them; callers that need resolved link text (e.g. buildBreadcrumbs)
 *   should compute their own display_name from the content AST.
 * - Some legacy/crdt content stores bare inline text nodes at document level
 *   (e.g. [{"type":"text","text":"..."}]); fall back to the first text leaf.
 * - Otherwise fall back to the raw content string, truncated to 200 chars.
 */
export function deriveName(content: string): string {
  if (!content) {
    return 'Untitled';
  }

  const ast = parseAST(content);
  if (ast.length > 0) {
    const text = stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY, maxLength: MAX_NAME_LENGTH });
    if (text.trim()) {
      return text.trim();
    }
    // CRDT text updates may store bare inline text nodes at document level.
    const firstText = findFirstText(ast);
    if (firstText) {
      return firstText.slice(0, MAX_NAME_LENGTH);
    }
  }

  const raw = content.slice(0, MAX_NAME_LENGTH).trim();
  return raw || 'Untitled';
}

function findFirstText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstText(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text.length > 0) {
      return obj.text;
    }
    for (const child of Object.values(obj)) {
      const found = findFirstText(child);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function getNodeFromDb(db: Database, nodeId: string): NodeRow | undefined {
  const row = queryOne<{
    id: string;
    workspaceId: string;
    kind: 'page' | 'block';
    parentId: string | null;
    classIds: string;
    content: string;
    active: number;
    createdAt: string | null;
    updatedAt: string | null;
    createdBy: string | null;
    updatedBy: string | null;
  }>(
    db,
    `SELECT
       id,
       workspace_id AS workspaceId,
       kind,
       parent_id AS parentId,
       class_ids AS classIds,
       content,
       active,
       created_at AS createdAt,
       updated_at AS updatedAt,
       created_by AS createdBy,
       updated_by AS updatedBy
     FROM node
     WHERE id = ?`,
    [nodeId]
  );
  if (!row) return undefined;
  return {
    ...row,
    active: row.active !== 0,
    classIds: JSON.parse(row.classIds) as string[],
  };
}

function getChildrenFromDb(db: Database, parentId: string): string[] {
  const rows = queryAll<{ child_id: string }>(
    db,
    'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
    [parentId]
  );
  return rows.map((r) => r.child_id);
}

/**
 * Walk up the parent chain to find the containing page UUID.
 * NOTE(D2): This uses node.kind === 'page'. Once class-based page tagging is
 * fully wired, resolve the page class UUID and check class_ids too.
 */
function resolvePageUuid(db: Database, nodeId: string): string | null {
  const visited = new Set<string>();
  let current: string | null = nodeId;

  while (current && !visited.has(current)) {
    visited.add(current);
    const node = getNodeFromDb(db, current);
    if (!node) break;
    if (node.kind === 'page') {
      return node.id;
    }
    current = node.parentId;
  }

  return null;
}

/**
 * Resolve the sequence (position) of a child within its parent.
 * NOTE(D2): node_child_order.position is an HLC-sortable string; map it to a
 * stable numeric sequence when the ordering scheme is finalized.
 */
function resolveSequence(db: Database, nodeId: string, parentId: string | null): number {
  if (!parentId) return 0;
  const row = queryAll<{ position: string }>(
    db,
    'SELECT position FROM node_child_order WHERE parent_id = ? AND child_id = ?',
    [parentId, nodeId]
  )[0];
  if (!row) return 0;
  const parsed = parseInt(row.position, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Build a legacy Node-shaped object from the SQLite derived tables.
 *
 * Children are projected recursively up to MAX_CHILDREN_DEPTH to avoid
 * returning huge trees for the prototype slice.
 *
 * This variant takes a raw Database so it can be used from the async worker
 * client as well as the synchronous WorkspaceStore. Note that transferring a
 * sql.js Database from a Web Worker is not possible, so callers running in a
 * real worker must route projection through a worker-side method instead.
 */
export function projectNodeFromDb(
  db: Database,
  _workspaceId: string,
  nodeId: string,
  depth = MAX_CHILDREN_DEPTH
): Node | undefined {
  const node = getNodeFromDb(db, nodeId);
  if (!node) return undefined;

  const now = new Date().toISOString();
  const name = deriveName(node.content);
  const classIds = node.classIds ?? [];
  const isPage = node.kind === 'page';
  // NOTE(D2): When the page system class UUID is known, also check
  // classIds.includes(pageClassUuid) here.
  const isClass = false;
  const isDaily = classIds.includes(SYSTEM_CLASS_UUIDS.day);
  const isMonthly = classIds.includes(SYSTEM_CLASS_UUIDS.month);
  const isYearly = classIds.includes(SYSTEM_CLASS_UUIDS.year);
  const pageUuid = resolvePageUuid(db, nodeId);
  const childIds = getChildrenFromDb(db, nodeId);

  const children =
    depth > 0
      ? childIds
          .slice(0, 100)
          .map((childId) => projectNodeFromDb(db, _workspaceId, childId, depth - 1))
          .filter((n): n is Node => n !== undefined)
      : undefined;

  const propertyRows = queryAll<{ property_schema_id: string; value: string }>(
    db,
    'SELECT property_schema_id, value FROM property_value WHERE node_id = ?',
    [nodeId]
  );
  const propertiesUuid: Record<string, unknown> = {};
  for (const row of propertyRows) {
    try {
      propertiesUuid[row.property_schema_id] = JSON.parse(row.value);
    } catch {
      propertiesUuid[row.property_schema_id] = row.value;
    }
  }

  const aliasRow = queryOne<{ canonical_node_id: string }>(
    db,
    'SELECT canonical_node_id FROM node_alias WHERE alias_node_id = ?',
    [nodeId]
  );
  const aliasedUuid = aliasRow?.canonical_node_id ?? null;

  const aliasRows = queryAll<{ alias_node_id: string }>(
    db,
    'SELECT alias_node_id FROM node_alias WHERE canonical_node_id = ?',
    [nodeId]
  );
  const aliasesUuid = aliasRows.map((row) => row.alias_node_id);

  return {
    uuid: node.id,
    name,
    content: node.content,
    display_name: name,
    icon: null,
    color: null,
    parent_uuid: node.parentId,
    page_uuid: pageUuid,
    sequence: resolveSequence(db, nodeId, node.parentId),
    active: node.active,
    is_page: isPage,
    is_class: isClass,
    is_daily: isDaily,
    is_monthly: isMonthly,
    is_yearly: isYearly,
    create_date: node.createdAt ?? now,
    write_date: node.updatedAt ?? now,
    open_date: null,
    tags_uuid: [],
    classes_uuid: classIds,
    classes_path_uuid: [],
    properties_uuid: propertiesUuid,
    children,
    has_children: childIds.length > 0,
    backlinks: [],
    linked_references: [],
    backlink_count: 0,
    comment_count: 0,
    aliases_uuid: aliasesUuid,
    aliased_uuid: aliasedUuid,
    extends_uuid: [],
    is_private: false,
    parent_locked: false,
  };
}

/**
 * Synchronous convenience wrapper that projects from a WorkspaceStore.
 */
export function projectNode(store: WorkspaceStore, nodeId: string, depth = MAX_CHILDREN_DEPTH): Node | undefined {
  return projectNodeFromDb(store.getDb(), store.getWorkspaceId(), nodeId, depth);
}

/**
 * Async projection helper for the worker-backed store client.
 * Projection runs inside the worker; the client only receives the serialisable
 * Node result.
 */
export async function projectNodeFromClient(
  client: IWorkspaceStoreClient,
  nodeId: string,
  depth = MAX_CHILDREN_DEPTH
): Promise<Node | undefined> {
  return client.query<Node | undefined>('projectNode', [nodeId, depth]);
}
