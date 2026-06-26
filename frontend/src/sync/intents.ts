/**
 * intents.ts — adapters from the public MutationIntent vocabulary to Operation values.
 *
 * This is the canonical place where editor/user intents are expanded into the
 * low-level Operation values consumed by OperationRuntime. Structural intents
 * (split, merge, indent, outdent, move-up/down, reorder, toggle collapsed) need
 * runtime context to compute target parents/ordering, so they are handled here
 * alongside the simple intent mappings.
 */

import type { MutationIntent, GraphNode } from '@/runtime/types';
import type { Operation, CreatePayload, UpdateContentPayload } from '@/runtime';
import type { OperationRuntime } from '@/runtime';
import { generateUUID } from '@/utils/uuid';
import {
  splitContentASTAtOffset,
  mergeContentASTs,
} from '@/runtime/astUtils';

// ─── Public API ───────────────────────────────────────────────────

/**
 * Convert any MutationIntent into one or more Operations.
 */
export function intentToOperations(
  intent: MutationIntent,
  runtime: OperationRuntime,
): Operation[] {
  switch (intent.type) {
    case 'update_content': {
      const dependsOn = findPendingCreateOperationId(runtime, intent.blockId);
      return [contentOperation(intent.blockId, intent.contentAST, dependsOn ? [dependsOn] : [])];
    }

    case 'create_block':
      return [createOperation(intent.blockId, intent)];

    case 'delete_block':
      return [deleteOperation(intent.blockId)];

    case 'move_block':
      return [moveOperation(intent.blockId, intent.newParentId, intent.afterBlockId)];

    case 'set_collapsed':
      return [collapsedOperation(intent.blockId, intent.collapsed)];

    case 'set_node_type':
      // Node type changes are currently folded into class assignments.
      return [];

    case 'add_class':
      return [addClassOperation(intent.blockId, intent.classId)];

    case 'remove_class':
      return [removeClassOperation(intent.blockId, intent.classId)];

    case 'add_tag':
      return [addTagOperation(intent.blockId, intent.tagId)];

    case 'remove_tag':
      return [removeTagOperation(intent.blockId, intent.tagId)];

    case 'update_node':
      return [updateNodeOperation(intent.blockId, intent.updates)];

    case 'move_node':
      return [moveNodeOperation(intent.blockId, intent.parentId, intent.afterBlockId)];

    case 'batch':
      return intent.intents.flatMap((sub) => intentToOperations(sub, runtime));

    case 'split_block':
      return splitBlockOperations(intent, runtime);

    case 'merge_blocks':
      return mergeBlocksOperations(intent, runtime);

    case 'indent_block':
      return indentBlockOperations(intent, runtime);

    case 'outdent_block':
      return outdentBlockOperations(intent, runtime);

    case 'move_up':
      return moveUpOperations(intent, runtime);

    case 'move_down':
      return moveDownOperations(intent, runtime);

    case 'reorder_blocks':
      return reorderBlocksOperations(intent, runtime);

    case 'toggle_collapsed': {
      const node = runtime.getNode(intent.blockId);
      if (!node) return [];
      return [collapsedOperation(intent.blockId, !node.collapsed)];
    }
  }
}

/**
 * Expand an intent to operations and apply them to the runtime.
 * Returns the generated operations so callers can persist or inspect them.
 */
export function applyIntent(runtime: OperationRuntime, intent: MutationIntent): Operation[] {
  const operations = intentToOperations(intent, runtime);
  for (const operation of operations) {
    runtime.applyOperation(operation);
  }
  return operations;
}

// ─── Helpers ──────────────────────────────────────────────────────

function findPendingCreateOperationId(runtime: OperationRuntime, blockId: string): string | undefined {
  return runtime
    .getOperationsForBlock(blockId)
    .find((op) => op.type === 'create' && (op.state === 'pending' || op.state === 'in_flight'))?.id;
}

function splitBlockOperations(
  intent: Extract<MutationIntent, { type: 'split_block' }>,
  runtime: OperationRuntime,
): Operation[] {
  const node = runtime.getNode(intent.blockId);
  if (!node) return [];

  const { before, after } = splitContentASTAtOffset(node.contentAST, intent.atOffset);
  const children = runtime.getChildren(intent.blockId);
  const hasChildren = children.length > 0;

  let newParentId: string | null;
  let afterBlockId: string | null;

  if (hasChildren && !intent.forceSibling) {
    newParentId = intent.blockId;
    afterBlockId = null;
  } else {
    newParentId = node.parentId;
    const siblings = newParentId ? runtime.getChildren(newParentId) : [];
    const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);
    afterBlockId = myIndex >= 0 ? siblings[myIndex]?.blockId ?? null : null;
  }

  return [
    contentOperation(intent.blockId, before),
    createOperation(intent.newBlockId, {
      parentId: newParentId,
      afterBlockId,
      contentAST: after,
      nodeType: 'block',
    }),
  ];
}

function mergeBlocksOperations(
  intent: Extract<MutationIntent, { type: 'merge_blocks' }>,
  runtime: OperationRuntime,
): Operation[] {
  const source = runtime.getNode(intent.sourceBlockId);
  const target = runtime.getNode(intent.targetBlockId);
  if (!source || !target) return [];

  const mergedAST = mergeContentASTs(target.contentAST, source.contentAST);
  const ops: Operation[] = [contentOperation(intent.targetBlockId, mergedAST)];

  const targetChildren = runtime.getChildren(intent.targetBlockId);
  const sourceChildren = runtime.getChildren(intent.sourceBlockId);
  let lastAfter = targetChildren[targetChildren.length - 1]?.blockId ?? null;
  for (const child of sourceChildren) {
    ops.push(moveOperation(child.blockId, intent.targetBlockId, lastAfter));
    lastAfter = child.blockId;
  }

  ops.push(deleteOperation(intent.sourceBlockId));
  return ops;
}

function indentBlockOperations(
  intent: Extract<MutationIntent, { type: 'indent_block' }>,
  runtime: OperationRuntime,
): Operation[] {
  const node = runtime.getNode(intent.blockId);
  if (!node?.parentId) return [];

  const siblings = runtime.getChildren(node.parentId);
  const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);
  if (myIndex <= 0) return [];

  const newParentId = siblings[myIndex - 1].blockId;
  const newParentChildren = runtime.getChildren(newParentId);
  const afterBlockId = newParentChildren[newParentChildren.length - 1]?.blockId ?? null;

  return [moveOperation(intent.blockId, newParentId, afterBlockId)];
}

function outdentBlockOperations(
  intent: Extract<MutationIntent, { type: 'outdent_block' }>,
  runtime: OperationRuntime,
): Operation[] {
  const node = runtime.getNode(intent.blockId);
  if (!node?.parentId) return [];

  const parent = runtime.getNode(node.parentId);
  if (!parent?.parentId) return [];

  const grandparentId = parent.parentId;
  const ops: Operation[] = [];

  ops.push(moveOperation(intent.blockId, grandparentId, parent.blockId));

  const siblings = runtime.getChildren(node.parentId);
  const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);
  const subsequentSiblings = siblings.filter((_, i) => i > myIndex);

  const existingChildren = runtime.getChildren(intent.blockId);
  let lastAfter = existingChildren[existingChildren.length - 1]?.blockId ?? null;
  for (const sibling of subsequentSiblings) {
    ops.push(moveOperation(sibling.blockId, intent.blockId, lastAfter));
    lastAfter = sibling.blockId;
  }

  return ops;
}

function moveUpOperations(
  intent: Extract<MutationIntent, { type: 'move_up' }>,
  runtime: OperationRuntime,
): Operation[] {
  const node = runtime.getNode(intent.blockId);
  if (!node?.parentId) return [];

  const parent = runtime.getNode(node.parentId);
  if (!parent) return [];

  const siblings = runtime.getChildren(node.parentId);
  const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);

  if (myIndex > 0) {
    const beforePrev = myIndex > 1 ? siblings[myIndex - 2] : null;
    return [moveOperation(intent.blockId, node.parentId, beforePrev?.blockId ?? null)];
  } else if (myIndex === 0 && parent.parentId) {
    const grandparentChildren = runtime.getChildren(parent.parentId);
    const parentIndex = grandparentChildren.findIndex((s) => s.blockId === node.parentId);
    if (parentIndex > 0) {
      const prevParentId = grandparentChildren[parentIndex - 1].blockId;
      const prevParentChildren = runtime.getChildren(prevParentId);
      const afterBlockId = prevParentChildren[prevParentChildren.length - 1]?.blockId ?? null;
      return [moveOperation(intent.blockId, prevParentId, afterBlockId)];
    }
  }
  return [];
}

function moveDownOperations(
  intent: Extract<MutationIntent, { type: 'move_down' }>,
  runtime: OperationRuntime,
): Operation[] {
  const node = runtime.getNode(intent.blockId);
  if (!node?.parentId) return [];

  const parent = runtime.getNode(node.parentId);
  if (!parent) return [];

  const siblings = runtime.getChildren(node.parentId);
  const myIndex = siblings.findIndex((s) => s.blockId === intent.blockId);

  if (myIndex < siblings.length - 1) {
    const nextSibling = siblings[myIndex + 1];
    return [moveOperation(intent.blockId, node.parentId, nextSibling.blockId)];
  } else if (myIndex === siblings.length - 1 && parent.parentId) {
    const grandparentChildren = runtime.getChildren(parent.parentId);
    const parentIndex = grandparentChildren.findIndex((s) => s.blockId === node.parentId);
    if (parentIndex < grandparentChildren.length - 1) {
      const nextParentId = grandparentChildren[parentIndex + 1].blockId;
      return [moveOperation(intent.blockId, nextParentId, null)];
    }
  }
  return [];
}

function reorderBlocksOperations(
  intent: Extract<MutationIntent, { type: 'reorder_blocks' }>,
  runtime: OperationRuntime,
): Operation[] {
  const ops: Operation[] = [];
  let lastAfter: string | null = null;
  for (const blockId of intent.orderedBlockIds) {
    const node = runtime.getNode(blockId);
    if (!node) continue;
    ops.push(moveOperation(blockId, intent.parentId, lastAfter));
    lastAfter = blockId;
  }
  return ops;
}

// ─── Operation factories ──────────────────────────────────────────

export function contentOperation(
  blockId: string,
  contentAST: UpdateContentPayload['contentAST'],
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'update_content',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { contentAST },
  };
}

export function createOperation(
  blockId: string,
  payload: Omit<CreatePayload, 'parentId' | 'afterBlockId'> & { parentId: string | null; afterBlockId: string | null },
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'create',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: {
      parentId: payload.parentId,
      afterBlockId: payload.afterBlockId,
      contentAST: payload.contentAST,
      nodeType: payload.nodeType,
      name: payload.name,
      icon: payload.icon,
      color: payload.color,
      classIds: payload.classIds,
      tagIds: payload.tagIds,
    },
  };
}

export function moveOperation(
  blockId: string,
  parentId: string | null,
  afterBlockId: string | null,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'move',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { parentId, afterBlockId },
  };
}

export function deleteOperation(
  blockId: string,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'delete',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: {},
  };
}

export function collapsedOperation(
  blockId: string,
  collapsed: boolean,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'set_collapsed',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { collapsed },
  };
}

export function addClassOperation(
  blockId: string,
  classId: string,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'add_class',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { classId },
  };
}

export function removeClassOperation(
  blockId: string,
  classId: string,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'remove_class',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { classId },
  };
}

export function addTagOperation(
  blockId: string,
  tagId: string,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'add_tag',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { tagId },
  };
}

export function removeTagOperation(
  blockId: string,
  tagId: string,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'remove_tag',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { tagId },
  };
}

export function updateNodeOperation(
  blockId: string,
  updates: Partial<GraphNode>,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'update_node',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { updates },
  };
}

export function moveNodeOperation(
  blockId: string,
  parentId: string | null,
  afterBlockId: string | null,
  dependsOn: readonly string[] = [],
): Operation {
  return {
    id: generateUUID(),
    type: 'move_node',
    blockId,
    state: 'pending',
    dependsOn,
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: { parentId, afterBlockId },
  };
}
