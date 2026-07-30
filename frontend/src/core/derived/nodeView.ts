import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryOne } from '../db/sqlite';
import type { ChangeNotification } from './index';

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function jsonOrDefault(value: unknown, defaultValue: unknown): string {
  if (value === undefined || value === null) return JSON.stringify(defaultValue);
  return JSON.stringify(value);
}

function applyNodeViewCreate(db: Database, op: Operation): ChangeNotification[] {
  const payload = op.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const nodeId = payload.nodeId as string;
  db.run(
    `INSERT OR REPLACE INTO node_view (
       id, workspace_id, node_id, name, view_type, order_index, is_default,
       active, shown_properties, group_by, view_mode, sort_entries,
       settings, query_ast, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.viewId as string,
      op.envelope.workspaceId,
      nodeId,
      payload.name as string,
      payload.viewType as string,
      (payload.orderIndex as number | undefined) ?? 0,
      payload.isDefault ? 1 : 0,
      1,
      jsonOrDefault(payload.shownProperties, []),
      jsonOrNull(payload.groupBy),
      (payload.viewMode as string | null | undefined) ?? null,
      jsonOrDefault(payload.sortEntries, []),
      jsonOrDefault(payload.settings, {}),
      jsonOrNull(payload.queryAst),
      now,
      now,
    ]
  );
  return [{ scope: 'node', nodeId }];
}

function applyNodeViewUpdate(db: Database, op: Operation): ChangeNotification[] {
  const payload = op.payload as Record<string, unknown>;
  const viewId = payload.viewId as string;
  const now = new Date().toISOString();

  const columns: string[] = [];
  const values: (string | number | null)[] = [];

  const addColumn = (name: string, value: string | number | null): void => {
    columns.push(`${name} = ?`);
    values.push(value);
  };

  if ('name' in payload) addColumn('name', payload.name as string);
  if ('orderIndex' in payload) addColumn('order_index', payload.orderIndex as number | null);
  if ('isDefault' in payload) addColumn('is_default', payload.isDefault ? 1 : 0);
  if ('shownProperties' in payload) addColumn('shown_properties', jsonOrDefault(payload.shownProperties, []));
  if ('groupBy' in payload) addColumn('group_by', jsonOrNull(payload.groupBy));
  if ('viewMode' in payload) addColumn('view_mode', (payload.viewMode as string | null | undefined) ?? null);
  if ('sortEntries' in payload) addColumn('sort_entries', jsonOrDefault(payload.sortEntries, []));
  if ('settings' in payload) addColumn('settings', jsonOrDefault(payload.settings, {}));
  if ('queryAst' in payload) addColumn('query_ast', jsonOrNull(payload.queryAst));

  if (columns.length === 0) return [];

  addColumn('updated_at', now);
  values.push(viewId);

  db.run(`UPDATE node_view SET ${columns.join(', ')} WHERE id = ?`, values);

  const row = queryOne<{ node_id: string }>(db, 'SELECT node_id FROM node_view WHERE id = ?', [viewId]);
  return row ? [{ scope: 'node', nodeId: row.node_id }] : [];
}

function applyNodeViewDelete(db: Database, op: Operation): ChangeNotification[] {
  const payload = op.payload as Record<string, unknown>;
  const viewId = payload.viewId as string;
  const row = queryOne<{ node_id: string }>(db, 'SELECT node_id FROM node_view WHERE id = ?', [viewId]);
  db.run('DELETE FROM node_view WHERE id = ?', [viewId]);
  return row ? [{ scope: 'node', nodeId: row.node_id }] : [];
}

function applyNodeViewReorder(db: Database, op: Operation): ChangeNotification[] {
  const payload = op.payload as Record<string, unknown>;
  const nodeId = payload.nodeId as string;
  const viewType = payload.viewType as string;
  const orderedIds = (payload.orderedViewIds as string[] | undefined) ?? [];
  for (let i = 0; i < orderedIds.length; i++) {
    db.run(
      'UPDATE node_view SET order_index = ? WHERE node_id = ? AND view_type = ? AND id = ?',
      [i, nodeId, viewType, orderedIds[i]]
    );
  }
  return [{ scope: 'node', nodeId }];
}

export function deleteNodeViewsForNode(db: Database, nodeId: string): void {
  db.run('DELETE FROM node_view WHERE node_id = ?', [nodeId]);
}

export function applyNodeViewOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType } = op.envelope;
  if (opType === 'nodeView.create') {
    return applyNodeViewCreate(db, op);
  }
  if (opType === 'nodeView.update') {
    return applyNodeViewUpdate(db, op);
  }
  if (opType === 'nodeView.delete') {
    return applyNodeViewDelete(db, op);
  }
  if (opType === 'nodeView.reorder') {
    return applyNodeViewReorder(db, op);
  }
  return [];
}
