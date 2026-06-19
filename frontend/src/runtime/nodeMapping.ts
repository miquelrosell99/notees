/**
 * Mapping between the public GraphNode type and the internal CoreNode type.
 *
 * These functions are pure and lossless for the fields that CoreNode stores.
 * Derived display fields (calloutType, taskStatus) are preserved across the
 * boundary so projections remain accurate.
 */

import type { GraphNode } from './types';
import type { CoreNode } from './operation';

export function graphNodeToCoreNode(node: GraphNode): CoreNode {
  return {
    blockId: node.blockId,
    serverId: node.serverId,
    parentId: node.parentId,
    orderIndex: node.orderIndex,
    nodeType: node.nodeType,
    contentAST: node.contentAST,
    collapsed: node.collapsed,
    isDeleted: node.isDeleted,
    isPage: node.isPage,
    name: node.name,
    icon: node.icon,
    color: node.color,
    classIds: node.classIds,
    tagIds: node.tagIds,
    isPrivate: node.isPrivate,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    version: node.version,
    hasServerChildren: node.hasServerChildren,
    calloutType: node.calloutType ?? null,
    taskStatus: node.taskStatus ?? null,
  };
}

export function coreNodeToGraphNode(node: CoreNode): GraphNode {
  return {
    blockId: node.blockId,
    serverId: node.serverId,
    parentId: node.parentId,
    orderIndex: node.orderIndex,
    nodeType: node.nodeType,
    contentAST: node.contentAST,
    collapsed: node.collapsed,
    isDeleted: node.isDeleted,
    isPage: node.isPage,
    name: node.name,
    icon: node.icon ?? null,
    color: node.color ?? null,
    classIds: node.classIds,
    tagIds: node.tagIds,
    isPrivate: node.isPrivate,
    calloutType: node.calloutType ?? null,
    taskStatus: node.taskStatus ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    version: node.version,
    hasServerChildren: node.hasServerChildren,
  };
}
