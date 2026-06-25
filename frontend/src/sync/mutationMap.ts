/**
 * mutationMap — maps Operation values to TanStack Query mutations and cache updates.
 *
 * This module knows how to turn a runtime operation into:
 * - API request parameters (NodeCreate / NodeUpdate / delete uuid)
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

export interface SyncApi {
  createNode: (data: NodeCreate) => Promise<Node>;
  updateNode: (uuid: string, data: NodeUpdate) => Promise<Node>;
  deleteNode: (uuid: string) => Promise<void>;
  addClass: (nodeUuid: string, classUuid: string) => Promise<Node>;
  removeClass: (nodeUuid: string, classUuid: string) => Promise<Node>;
  addTag: (nodeUuid: string, tagUuid: string) => Promise<Node>;
  removeTag: (nodeUuid: string, tagUuid: string) => Promise<Node>;
  moveNode: (nodeUuid: string, parentUuid: string | null, position?: number) => Promise<Node>;
}

export const defaultSyncApi: SyncApi = {
  createNode: nodesApi.createNode,
  updateNode: nodesApi.updateNode,
  deleteNode: nodesApi.deleteNode,
  addClass: nodesApi.addClass,
  removeClass: nodesApi.removeClass,
  addTag: async (nodeUuid: string, tagUuid: string) => {
    await nodesApi.addTagLink(nodeUuid, tagUuid);
    return buildTagNodeFromRuntime(nodeUuid);
  },
  removeTag: async (nodeUuid: string, tagUuid: string) => {
    await nodesApi.removeTagLink(nodeUuid, tagUuid);
    return buildTagNodeFromRuntime(nodeUuid);
  },
  moveNode: nodesApi.moveNode,
};

export function buildTagNodeFromRuntime(uuid: string): Node {
  const runtime = getOperationRuntime();
  const coreNode = runtime.snapshot().projectedNodes.values();
  for (const node of coreNode) {
    if (node.blockId === uuid) {
      return {
        id: node.serverId ?? -1,
        uuid,
        name: node.name ?? '',
        icon: node.icon ?? null,
        color: node.color ?? null,
        parent_id: null,
        parent_uuid: null,
        page_id: null,
        page_uuid: null,
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
  throw new Error(`Node ${uuid} not found in runtime for tag update`);
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
    parent_uuid: null,
    page_id: null,
    page_uuid: null,
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
 * Operations are keyed by the runtime block UUID (blockId). When an operation
 * was created before its block had a server-side id, the uuid is still known
 * from the runtime and is used for the API call.
 */
export function operationToApiRequest(operation: Operation):
  | { type: 'create'; data: NodeCreate }
  | { type: 'update'; uuid: string; data: NodeUpdate }
  | { type: 'delete'; uuid: string }
  | { type: 'add_class'; uuid: string; classUuid: string }
  | { type: 'remove_class'; uuid: string; classUuid: string }
  | { type: 'add_tag'; uuid: string; tagUuid: string }
  | { type: 'remove_tag'; uuid: string; tagUuid: string }
  | { type: 'move_node'; uuid: string; parentUuid: string | null; position: number }
  | { type: 'unsupported' } {
  const runtime = getOperationRuntime();
  const nodeUuid = operation.blockId;

  switch (operation.type) {
    case 'create': {
      const payload = operation.payload as CreatePayload;
      return {
        type: 'create',
        data: {
          name: serializeContentAST(payload.contentAST),
          parent_uuid: payload.parentId ? runtime.getNode(payload.parentId)?.blockId ?? null : null,
          sequence: 0, // computed server-side from parent/after
          uuid: operation.blockId,
        },
      };
    }
    case 'update_content': {
      return {
        type: 'update',
        uuid: nodeUuid,
        data: { name: serializeContentAST((operation.payload as UpdateContentPayload).contentAST) },
      };
    }
    case 'move': {
      const payload = operation.payload as MovePayload;
      return {
        type: 'update',
        uuid: nodeUuid,
        data: {
          parent_uuid: payload.parentId ? runtime.getNode(payload.parentId)?.blockId ?? null : null,
          sequence: 0, // computed server-side from parent/after
        },
      };
    }
    case 'set_collapsed': {
      const collapsedPayload = operation.payload as SetCollapsedPayload;
      return {
        type: 'update',
        uuid: nodeUuid,
        data: { collapsed: collapsedPayload.collapsed },
      };
    }
    case 'set_classes': {
      const classesPayload = operation.payload as SetClassesPayload;
      return {
        type: 'update',
        uuid: nodeUuid,
        data: { class_uuids: classesPayload.classIds },
      };
    }
    case 'set_tags': {
      return {
        type: 'update',
        uuid: nodeUuid,
        data: {}, // Tags use a separate endpoint; treat as unsupported for now.
      };
    }
    case 'add_class': {
      return {
        type: 'add_class',
        uuid: nodeUuid,
        classUuid: (operation.payload as AddClassPayload).classId,
      };
    }
    case 'remove_class': {
      return {
        type: 'remove_class',
        uuid: nodeUuid,
        classUuid: (operation.payload as RemoveClassPayload).classId,
      };
    }
    case 'add_tag': {
      return {
        type: 'add_tag',
        uuid: nodeUuid,
        tagUuid: (operation.payload as AddTagPayload).tagId,
      };
    }
    case 'remove_tag': {
      return {
        type: 'remove_tag',
        uuid: nodeUuid,
        tagUuid: (operation.payload as RemoveTagPayload).tagId,
      };
    }
    case 'update_node': {
      const updatePayload = operation.payload as UpdateNodePayload;
      const data: NodeUpdate = {};
      if (updatePayload.updates.name !== undefined) data.name = updatePayload.updates.name ?? null;
      if (updatePayload.updates.icon !== undefined) data.icon = updatePayload.updates.icon;
      if (updatePayload.updates.color !== undefined) data.color = updatePayload.updates.color;
      if (updatePayload.updates.isPage !== undefined) data.is_page = updatePayload.updates.isPage;
      if (updatePayload.updates.collapsed !== undefined) data.collapsed = updatePayload.updates.collapsed;
      return { type: 'update', uuid: nodeUuid, data };
    }
    case 'move_node': {
      const movePayload = operation.payload as MoveNodePayload;
      const parentUuid = movePayload.parentId ? runtime.getNode(movePayload.parentId)?.blockId ?? null : null;
      const siblings = movePayload.parentId ? runtime.getChildren(movePayload.parentId) : [];
      const afterIndex = movePayload.afterBlockId
        ? siblings.findIndex((s) => s.blockId === movePayload.afterBlockId)
        : -1;
      const position = afterIndex >= 0 ? afterIndex + 1 : 0;
      return {
        type: 'move_node',
        uuid: nodeUuid,
        parentUuid,
        position,
      };
    }
    case 'delete': {
      return { type: 'delete', uuid: nodeUuid };
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
      return api.updateNode(request.uuid, request.data);
    case 'delete':
      await api.deleteNode(request.uuid);
      return null;
    case 'add_class':
      return api.addClass(request.uuid, request.classUuid);
    case 'remove_class':
      return api.removeClass(request.uuid, request.classUuid);
    case 'add_tag':
      return api.addTag(request.uuid, request.tagUuid);
    case 'remove_tag':
      return api.removeTag(request.uuid, request.tagUuid);
    case 'move_node':
      return api.moveNode(request.uuid, request.parentUuid, request.position);
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
