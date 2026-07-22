/**
 * Build task-shaped Node results from the core SQLite derived store.
 */

import type { Node } from '@/types/api';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, TASK_CLOSED_STATUSES } from '@/constants/systemProperties';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';

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

export async function buildTasksFromClient(
  client: IWorkspaceStoreClient,
  includeComplete = false
): Promise<Node[]> {
  return client.query<Node[]>('buildTasks', [includeComplete]);
}
