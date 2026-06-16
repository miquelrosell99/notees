/**
 * mutationMap — maps Operation values to TanStack Query mutations and cache updates.
 *
 * This module knows how to turn a runtime operation into:
 * - API request parameters (NodeCreate / NodeUpdate / delete id)
 * - Targeted cache writes after the mutation succeeds
 *
 * It does not contain React hooks; SyncManager wires the actual useMutation calls.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { Node, NodeCreate, NodeUpdate } from '@/types/api';
import * as nodesApi from '@/api/nodes';
import type {
  Operation,
  CreatePayload,
  MovePayload,
  UpdateContentPayload,
  SetCollapsedPayload,
  SetClassesPayload,
} from '@/runtime';
import { writeCreate, writeUpdate, writeDelete, writeMove } from './cacheWriter';
import { getOperationRuntime } from '@/runtime';

export interface SyncApi {
  createNode: (data: NodeCreate) => Promise<Node>;
  updateNode: (id: number, data: NodeUpdate) => Promise<Node>;
  deleteNode: (id: number) => Promise<void>;
}

export const defaultSyncApi: SyncApi = {
  createNode: nodesApi.createNode,
  updateNode: nodesApi.updateNode,
  deleteNode: nodesApi.deleteNode,
};

function serializeContentAST(contentAST: UpdateContentPayload['contentAST']): string {
  return JSON.stringify(contentAST);
}

function apiNodeFromOperation(operation: Operation): Node {
  // SyncManager must pass the projected node from OperationRuntime for cache updates.
  // This function is only a fallback if the caller does not supply one.
  return {
    id: operation.serverId ?? -1,
    uuid: operation.blockId,
    name: serializeContentAST((operation.payload as UpdateContentPayload).contentAST ?? []),
    icon: null,
    color: null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: false,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
  };
}

/**
 * Build the API request for an operation.
 *
 * When an operation was created before its block had a server-side id (e.g. a
 * content update on a block that is still being created), the current server id
 * is resolved from the runtime at dispatch time.
 */
export function operationToApiRequest(operation: Operation):
  | { type: 'create'; data: NodeCreate }
  | { type: 'update'; id: number; data: NodeUpdate }
  | { type: 'delete'; id: number }
  | { type: 'unsupported' } {
  const runtimeServerId =
    operation.serverId ?? getOperationRuntime().getNode(operation.blockId)?.serverId;

  switch (operation.type) {
    case 'create': {
      const payload = operation.payload as CreatePayload;
      return {
        type: 'create',
        data: {
          name: serializeContentAST(payload.contentAST),
          parent_id: payload.parentId ? parseInt(payload.parentId, 10) : null,
          sequence: 0, // computed server-side from parent/after
          uuid: operation.blockId,
        },
      };
    }
    case 'update_content': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return {
        type: 'update',
        id: runtimeServerId,
        data: { name: serializeContentAST((operation.payload as UpdateContentPayload).contentAST) },
      };
    }
    case 'move': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      const payload = operation.payload as MovePayload;
      return {
        type: 'update',
        id: runtimeServerId,
        data: {
          parent_id: payload.parentId ? parseInt(payload.parentId, 10) : null,
          sequence: 0, // computed server-side from parent/after
        },
      };
    }
    case 'set_collapsed': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      const collapsedPayload = operation.payload as SetCollapsedPayload;
      return {
        type: 'update',
        id: runtimeServerId,
        data: { collapsed: collapsedPayload.collapsed },
      };
    }
    case 'set_classes': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      const classesPayload = operation.payload as SetClassesPayload;
      return {
        type: 'update',
        id: runtimeServerId,
        data: { classes: classesPayload.classIds.map((id) => parseInt(id, 10)) },
      };
    }
    case 'set_tags': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return {
        type: 'update',
        id: runtimeServerId,
        data: {}, // Tags use a separate endpoint; treat as unsupported for now.
      };
    }
    case 'delete': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return { type: 'delete', id: runtimeServerId };
    }
    default:
      return { type: 'unsupported' };
  }
}

/**
 * Execute the API request for an operation.
 */
export async function executeOperation(
  operation: Operation,
  api: SyncApi = defaultSyncApi,
): Promise<Node | null> {
  const request = operationToApiRequest(operation);

  switch (request.type) {
    case 'create':
      return api.createNode(request.data);
    case 'update':
      return api.updateNode(request.id, request.data);
    case 'delete':
      await api.deleteNode(request.id);
      return null;
    case 'unsupported':
      throw new Error(`Unsupported operation: ${operation.type}`);
  }
}

/**
 * Apply the cache update that corresponds to a successful operation.
 * `result` is the API response node (null for deletes).
 */
export function applyCacheUpdate(
  queryClient: QueryClient,
  operation: Operation,
  result: Node | null,
): void {
  const node = result ?? apiNodeFromOperation(operation);

  switch (operation.type) {
    case 'create': {
      const payload = operation.payload as CreatePayload;
      const parentId = payload.parentId ? parseInt(payload.parentId, 10) : null;
      if (parentId != null && node.id > 0) {
        writeCreate(queryClient, parentId, node);
      }
      break;
    }
    case 'update_content':
      if (node.id > 0) writeUpdate(queryClient, node.id, { name: node.name });
      break;
    case 'move':
      if (node.id > 0) writeMove(queryClient, node.id, node.parent_id, node.sequence, node);
      break;
    case 'set_collapsed':
      if (node.id > 0) writeUpdate(queryClient, node.id, { collapsed: node.collapsed });
      break;
    case 'set_classes':
      if (node.id > 0) writeUpdate(queryClient, node.id, { classes: node.classes });
      break;
    case 'delete':
      if (operation.serverId != null) writeDelete(queryClient, operation.serverId);
      break;
  }
}
