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
  AddClassPayload,
  RemoveClassPayload,
  AddTagPayload,
  RemoveTagPayload,
  UpdateNodePayload,
  MoveNodePayload,
} from '@/runtime';
import { writeCreate, writeUpdate, writeDelete, writeMove } from './cacheWriter';
import { getOperationRuntime } from '@/runtime';
import { resolveParentServerId } from '@/runtime/serverIdMap';

export interface SyncApi {
  createNode: (data: NodeCreate) => Promise<Node>;
  updateNode: (id: number, data: NodeUpdate) => Promise<Node>;
  deleteNode: (id: number) => Promise<void>;
  addClass: (id: number, classId: number) => Promise<Node>;
  removeClass: (id: number, classId: number) => Promise<Node>;
  addTag: (id: number, tagId: number) => Promise<Node>;
  removeTag: (id: number, tagId: number) => Promise<Node>;
  moveNode: (id: number, parentId: number | null, position?: number) => Promise<Node>;
}

export const defaultSyncApi: SyncApi = {
  createNode: nodesApi.createNode,
  updateNode: nodesApi.updateNode,
  deleteNode: nodesApi.deleteNode,
  addClass: nodesApi.addClass,
  removeClass: nodesApi.removeClass,
  addTag: async (id: number, tagId: number) => {
    await nodesApi.addTagLink(id, tagId);
    return buildTagNodeFromRuntime(id);
  },
  removeTag: async (id: number, tagId: number) => {
    await nodesApi.removeTagLink(id, tagId);
    return buildTagNodeFromRuntime(id);
  },
  moveNode: nodesApi.moveNode,
};

export function buildTagNodeFromRuntime(id: number): Node {
  const runtime = getOperationRuntime();
  const coreNode = runtime.snapshot().projectedNodes.values();
  for (const node of coreNode) {
    if (node.serverId === id) {
      return {
        id,
        uuid: node.blockId,
        name: node.name ?? '',
        icon: node.icon ?? null,
        color: node.color ?? null,
        parent_id: null,
        page_id: null,
        sequence: node.orderIndex,
        collapsed: node.collapsed,
        active: !node.isDeleted,
        is_page: node.isPage,
        create_date: node.createdAt,
        write_date: node.updatedAt,
        tags: node.tagIds.map((t) => parseInt(t, 10)),
      };
    }
  }
  throw new Error(`Node ${id} not found in runtime for tag update`);
}

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
  | { type: 'add_class'; id: number; classId: number }
  | { type: 'remove_class'; id: number; classId: number }
  | { type: 'add_tag'; id: number; tagId: number }
  | { type: 'remove_tag'; id: number; tagId: number }
  | { type: 'move_node'; id: number; parentId: number; position: number }
  | { type: 'unsupported' } {
  const runtime = getOperationRuntime();
  const runtimeServerId =
    operation.serverId ?? runtime.getNode(operation.blockId)?.serverId;

  switch (operation.type) {
    case 'create': {
      const payload = operation.payload as CreatePayload;
      return {
        type: 'create',
        data: {
          name: serializeContentAST(payload.contentAST),
          parent_id: payload.parentId ? resolveParentServerId(runtime, payload.parentId) : null,
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
          parent_id: payload.parentId ? resolveParentServerId(runtime, payload.parentId) : null,
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
    case 'add_class': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return {
        type: 'add_class',
        id: runtimeServerId,
        classId: parseInt((operation.payload as AddClassPayload).classId, 10),
      };
    }
    case 'remove_class': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return {
        type: 'remove_class',
        id: runtimeServerId,
        classId: parseInt((operation.payload as RemoveClassPayload).classId, 10),
      };
    }
    case 'add_tag': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return {
        type: 'add_tag',
        id: runtimeServerId,
        tagId: parseInt((operation.payload as AddTagPayload).tagId, 10),
      };
    }
    case 'remove_tag': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      return {
        type: 'remove_tag',
        id: runtimeServerId,
        tagId: parseInt((operation.payload as RemoveTagPayload).tagId, 10),
      };
    }
    case 'update_node': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      const updatePayload = operation.payload as UpdateNodePayload;
      const data: NodeUpdate = {};
      if (updatePayload.updates.name !== undefined) data.name = updatePayload.updates.name ?? null;
      if (updatePayload.updates.icon !== undefined) data.icon = updatePayload.updates.icon;
      if (updatePayload.updates.color !== undefined) data.color = updatePayload.updates.color;
      if (updatePayload.updates.isPage !== undefined) data.is_page = updatePayload.updates.isPage;
      if (updatePayload.updates.collapsed !== undefined) data.collapsed = updatePayload.updates.collapsed;
      return { type: 'update', id: runtimeServerId, data };
    }
    case 'move_node': {
      if (runtimeServerId == null) return { type: 'unsupported' };
      const movePayload = operation.payload as MoveNodePayload;
      const parentId = movePayload.parentId ? resolveParentServerId(runtime, movePayload.parentId) : null;
      const siblings = movePayload.parentId ? runtime.getChildren(movePayload.parentId) : [];
      const afterIndex = movePayload.afterBlockId
        ? siblings.findIndex((s) => s.blockId === movePayload.afterBlockId)
        : -1;
      const position = afterIndex >= 0 ? afterIndex + 1 : 0;
      return {
        type: 'move_node',
        id: runtimeServerId,
        parentId: parentId ?? 0,
        position,
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
    case 'add_class':
      return api.addClass(request.id, request.classId);
    case 'remove_class':
      return api.removeClass(request.id, request.classId);
    case 'add_tag':
      return api.addTag(request.id, request.tagId);
    case 'remove_tag':
      return api.removeTag(request.id, request.tagId);
    case 'move_node':
      return api.moveNode(request.id, request.parentId, request.position);
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
      // Use the server-returned parent_id rather than parsing the runtime
      // payload parent UUID, which could be mistaken for a numeric id.
      if (node.parent_id != null && node.id > 0) {
        writeCreate(queryClient, node.parent_id, node);
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
    case 'add_class':
    case 'remove_class':
      if (node.id > 0) {
        writeUpdate(queryClient, node.id, {
          classes: node.classes,
          color: node.color,
          icon: node.icon,
          is_page: node.is_page,
        });
      }
      break;
    case 'add_tag':
    case 'remove_tag':
      if (node.id > 0) writeUpdate(queryClient, node.id, { tags: node.tags });
      break;
    case 'update_node':
      if (node.id > 0) {
        writeUpdate(queryClient, node.id, {
          name: node.name,
          icon: node.icon,
          color: node.color,
          is_private: node.is_private,
        });
      }
      break;
    case 'move_node':
      if (node.id > 0) writeMove(queryClient, node.id, node.parent_id, node.sequence, node);
      break;
    case 'delete':
      if (operation.serverId != null) writeDelete(queryClient, operation.serverId);
      break;
  }
}
