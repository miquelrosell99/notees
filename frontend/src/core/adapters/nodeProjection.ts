import type { Node } from '@/types/api';
import { queryAll, queryOne } from '../db/sqlite';
import type { WorkspaceStore } from '../store';

const MAX_NAME_LENGTH = 200;
const MAX_CHILDREN_DEPTH = 2;

/**
 * Derive a display name from node content.
 *
 * - If content is parseable AST JSON, return the first non-empty text leaf.
 * - Otherwise fall back to the raw content string, truncated to 200 chars.
 */
function deriveName(content: string): string {
  if (!content) {
    return 'Untitled';
  }

  try {
    const ast = JSON.parse(content) as unknown;
    const text = findFirstText(ast);
    if (text) {
      return text.slice(0, MAX_NAME_LENGTH);
    }
  } catch {
    // Not JSON — fall through to raw content.
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

/**
 * Walk up the parent chain to find the containing page UUID.
 * TODO(D2): This uses node.kind === 'page'. Once class-based page tagging is
 * fully wired, resolve the page class UUID and check class_ids too.
 */
function resolvePageUuid(store: WorkspaceStore, nodeId: string): string | null {
  const visited = new Set<string>();
  let current: string | null = nodeId;

  while (current && !visited.has(current)) {
    visited.add(current);
    const node = store.getNode(current);
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
 * TODO(D2): node_child_order.position is an HLC-sortable string; map it to a
 * stable numeric sequence when the ordering scheme is finalized.
 */
function resolveSequence(store: WorkspaceStore, nodeId: string, parentId: string | null): number {
  if (!parentId) return 0;
  const db = store.getDb();
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
 */
export function projectNode(store: WorkspaceStore, nodeId: string, depth = MAX_CHILDREN_DEPTH): Node | undefined {
  const node = store.getNode(nodeId);
  if (!node) return undefined;

  const now = new Date().toISOString();
  const name = deriveName(node.content);
  const classIds = node.classIds ?? [];
  const isPage = node.kind === 'page';
  // TODO(D2): When the page system class UUID is known, also check
  // classIds.includes(pageClassUuid) here.
  const isClass = node.kind === 'class';
  const pageUuid = resolvePageUuid(store, nodeId);
  const childIds = store.getChildren(nodeId);

  const children =
    depth > 0
      ? childIds
          .slice(0, 100)
          .map((childId) => projectNode(store, childId, depth - 1))
          .filter((n): n is Node => n !== undefined)
      : undefined;

  const propertyRows = queryAll<{ property_schema_id: string; value: string }>(
    store.getDb(),
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
    store.getDb(),
    'SELECT canonical_node_id FROM node_alias WHERE alias_node_id = ?',
    [nodeId]
  );
  const aliasedUuid = aliasRow?.canonical_node_id ?? null;

  const aliasRows = queryAll<{ alias_node_id: string }>(
    store.getDb(),
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
    sequence: resolveSequence(store, nodeId, node.parentId),
    active: node.active,
    is_page: isPage,
    is_class: isClass,
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
