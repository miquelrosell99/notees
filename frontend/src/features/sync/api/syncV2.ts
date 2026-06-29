/**
 * v2 sync API client.
 */

import api from '@/api/client';
import type { Operation } from '@/runtime';

export type VersionVector = Record<string, number>;
export type BaseVector = Record<string, VersionVector>;

export interface OperationIntentV2 {
  type: string;
  client_id: string;
  seq: number;
  node_uuid: string;
  parent_uuid?: string | null;
  after_uuid?: string | null;
  content_ast?: unknown[] | null;
  name?: string | null;
  class_uuid?: string | null;
  tag_uuid?: string | null;
  class_uuids?: string[] | null;
  tag_uuids?: string[] | null;
  is_deleted?: boolean | null;
  is_page?: boolean;
  is_task?: boolean;
  is_daily?: boolean;
  is_monthly?: boolean;
  is_yearly?: boolean;
  properties?: Record<string, unknown> | null;
  property_uuid?: string | null;
  property_value?: unknown;
}

export interface SyncBatchRequestV2 {
  ops: OperationIntentV2[];
  base_vector: BaseVector;
  workspace_uuid?: string | null;
}

export interface SyncBatchResponseV2 {
  applied: boolean;
  new_vectors: BaseVector;
}

export interface SyncConflictResponseV2 {
  stale_nodes: string[];
  server_vectors: BaseVector;
  conflict_type: 'text_edit' | 'tree_conflict' | 'permission_denied' | 'node_deleted';
}

export async function syncBatchV2(
  request: SyncBatchRequestV2,
): Promise<SyncBatchResponseV2> {
  const response = await api.post<SyncBatchResponseV2>('/sync/batch', request, {
    headers: { 'X-Notees-Sync-Protocol': 'v2' },
  });
  return response.data;
}

export function operationToIntentV2(op: Operation, clientId: string, seq: number): OperationIntentV2 | null {
  const base: OperationIntentV2 = {
    type: op.type,
    client_id: clientId,
    seq,
    node_uuid: op.blockId,
  };

  switch (op.type) {
    case 'update_content': {
      const payload = op.payload as { contentAST?: unknown[] };
      return { ...base, content_ast: payload.contentAST ?? null };
    }
    case 'update_node': {
      const payload = op.payload as { updates?: Record<string, unknown> };
      return { ...base, properties: payload.updates ?? null };
    }
    case 'create': {
      const payload = op.payload as {
        parentId?: string | null;
        afterBlockId?: string | null;
        contentAST?: unknown[];
        classIds?: string[];
        tagIds?: string[];
      };
      return {
        ...base,
        type: 'create',
        parent_uuid: payload.parentId ?? null,
        after_uuid: payload.afterBlockId ?? null,
        content_ast: payload.contentAST ?? null,
        class_uuids: payload.classIds ?? null,
        tag_uuids: payload.tagIds ?? null,
      };
    }
    case 'move':
    case 'move_node': {
      const payload = op.payload as { parentId?: string | null; afterBlockId?: string | null };
      return {
        ...base,
        type: 'move',
        parent_uuid: payload.parentId ?? null,
        after_uuid: payload.afterBlockId ?? null,
      };
    }
    case 'set_classes': {
      const payload = op.payload as { classIds?: string[] };
      return {
        ...base,
        type: 'update_node',
        properties: { class_uuids: payload.classIds ?? [] },
      };
    }
    case 'set_tags': {
      const payload = op.payload as { tagIds?: string[] };
      return {
        ...base,
        type: 'update_node',
        properties: { tag_uuids: payload.tagIds ?? [] },
      };
    }
    case 'delete':
      return { ...base, type: 'delete', is_deleted: true };
    case 'add_class': {
      const payload = op.payload as { classId?: string };
      return { ...base, type: 'add_class', class_uuid: payload.classId };
    }
    case 'remove_class': {
      const payload = op.payload as { classId?: string };
      return { ...base, type: 'remove_class', class_uuid: payload.classId };
    }
    case 'add_tag': {
      const payload = op.payload as { tagId?: string };
      return { ...base, type: 'add_tag', tag_uuid: payload.tagId };
    }
    case 'remove_tag': {
      const payload = op.payload as { tagId?: string };
      return { ...base, type: 'remove_tag', tag_uuid: payload.tagId };
    }
    default:
      return null;
  }
}
