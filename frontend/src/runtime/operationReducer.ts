/**
 * Pure reducer: apply an Operation to a graph of CoreNodes.
 *
 * This module has no React, TanStack Query, or API imports.
 */

import type {
  Operation,
  CoreNode,
  CreatePayload,
  MovePayload,
  UpdateContentPayload,
  SetCollapsedPayload,
  SetClassesPayload,
  SetTagsPayload,
} from './operation';

const MIN_ORDER_GAP = 1e-9;
const ORDER_STEP = 1024;

function cloneMap(nodes: ReadonlyMap<string, CoreNode>): Map<string, CoreNode> {
  return new Map(nodes);
}

function cloneNode(node: CoreNode): CoreNode {
  return { ...node };
}

function getSiblings(nodes: ReadonlyMap<string, CoreNode>, parentId: string | null): CoreNode[] {
  const result: CoreNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId === parentId && !node.isDeleted) {
      result.push(node);
    }
  }
  return result.sort((a, b) => a.orderIndex - b.orderIndex);
}

function computeOrderIndex(
  nodes: Map<string, CoreNode>,
  parentId: string | null,
  afterBlockId: string | null,
): number {
  const siblings = getSiblings(nodes, parentId);

  if (siblings.length === 0) {
    return 0;
  }

  if (afterBlockId === null) {
    return siblings[0].orderIndex - ORDER_STEP;
  }

  const afterIndex = siblings.findIndex((s) => s.blockId === afterBlockId);
  if (afterIndex === -1) {
    return siblings[siblings.length - 1].orderIndex + ORDER_STEP;
  }

  const after = siblings[afterIndex];
  const before = siblings[afterIndex + 1];

  if (!before) {
    return after.orderIndex + ORDER_STEP;
  }

  const gap = before.orderIndex - after.orderIndex;
  if (gap < MIN_ORDER_GAP) {
    return renormalizeAndCompute(nodes, parentId, afterBlockId);
  }

  return after.orderIndex + gap / 2;
}

function renormalizeAndCompute(
  nodes: Map<string, CoreNode>,
  parentId: string | null,
  afterBlockId: string | null,
): number {
  const siblings = getSiblings(nodes, parentId);
  let index = 0;
  for (const sibling of siblings) {
    const mutable = cloneNode(sibling);
    mutable.orderIndex = index * ORDER_STEP;
    nodes.set(sibling.blockId, mutable);
    index += 1;
  }
  return computeOrderIndex(nodes, parentId, afterBlockId);
}

function applyCreate(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const payload = operation.payload as CreatePayload;
  const orderIndex = computeOrderIndex(nodes, payload.parentId, payload.afterBlockId);

  const newNode: CoreNode = {
    blockId: operation.blockId,
    serverId: operation.serverId,
    parentId: payload.parentId,
    orderIndex,
    nodeType: payload.nodeType ?? 'block',
    contentAST: payload.contentAST,
    collapsed: false,
    isDeleted: false,
    isPage: payload.nodeType === 'page',
    name: payload.name,
    icon: payload.icon ?? null,
    color: payload.color ?? null,
    classIds: payload.classIds ?? [],
    tagIds: payload.tagIds ?? [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    version: 0,
  };

  nodes.set(operation.blockId, newNode);
  return nodes;
}

function applyMove(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const node = nodes.get(operation.blockId);
  if (!node) {
    return nodes;
  }

  const payload = operation.payload as MovePayload;
  const orderIndex = computeOrderIndex(nodes, payload.parentId, payload.afterBlockId);

  const updated = cloneNode(node);
  updated.parentId = payload.parentId;
  updated.orderIndex = orderIndex;
  updated.updatedAt = new Date(now).toISOString();

  nodes.set(operation.blockId, updated);
  return nodes;
}

function applyUpdateContent(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const node = nodes.get(operation.blockId);
  if (!node) {
    return nodes;
  }

  const payload = operation.payload as UpdateContentPayload;
  const updated = cloneNode(node);
  updated.contentAST = payload.contentAST;
  updated.updatedAt = new Date(now).toISOString();

  nodes.set(operation.blockId, updated);
  return nodes;
}

function applyDelete(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const node = nodes.get(operation.blockId);
  if (!node) {
    return nodes;
  }

  const updated = cloneNode(node);
  updated.isDeleted = true;
  updated.updatedAt = new Date(now).toISOString();

  nodes.set(operation.blockId, updated);
  return nodes;
}

function applySetCollapsed(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const node = nodes.get(operation.blockId);
  if (!node) {
    return nodes;
  }

  const payload = operation.payload as SetCollapsedPayload;
  const updated = cloneNode(node);
  updated.collapsed = payload.collapsed;
  updated.updatedAt = new Date(now).toISOString();

  nodes.set(operation.blockId, updated);
  return nodes;
}

function applySetClasses(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const node = nodes.get(operation.blockId);
  if (!node) {
    return nodes;
  }

  const payload = operation.payload as SetClassesPayload;
  const updated = cloneNode(node);
  updated.classIds = [...payload.classIds];
  updated.updatedAt = new Date(now).toISOString();

  nodes.set(operation.blockId, updated);
  return nodes;
}

function applySetTags(nodes: Map<string, CoreNode>, operation: Operation, now: number): Map<string, CoreNode> {
  const node = nodes.get(operation.blockId);
  if (!node) {
    return nodes;
  }

  const payload = operation.payload as SetTagsPayload;
  const updated = cloneNode(node);
  updated.tagIds = [...payload.tagIds];
  updated.updatedAt = new Date(now).toISOString();

  nodes.set(operation.blockId, updated);
  return nodes;
}

/**
 * Apply a single operation to an immutable graph and return a new graph.
 * The input graph is never mutated.
 */
export function applyOperation(
  nodes: ReadonlyMap<string, CoreNode>,
  operation: Operation,
  now = Date.now(),
): Map<string, CoreNode> {
  const mutable = cloneMap(nodes);

  switch (operation.type) {
    case 'create':
      return applyCreate(mutable, operation, now);
    case 'move':
      return applyMove(mutable, operation, now);
    case 'update_content':
      return applyUpdateContent(mutable, operation, now);
    case 'delete':
      return applyDelete(mutable, operation, now);
    case 'set_collapsed':
      return applySetCollapsed(mutable, operation, now);
    case 'set_classes':
      return applySetClasses(mutable, operation, now);
    case 'set_tags':
      return applySetTags(mutable, operation, now);
    default:
      return mutable;
  }
}

/**
 * Apply a sequence of operations in order.
 */
export function applyOperations(
  nodes: ReadonlyMap<string, CoreNode>,
  operations: readonly Operation[],
  now = Date.now(),
): Map<string, CoreNode> {
  let result: Map<string, CoreNode> = cloneMap(nodes);
  for (const operation of operations) {
    result = applyOperation(result, operation, now);
  }
  return result;
}
