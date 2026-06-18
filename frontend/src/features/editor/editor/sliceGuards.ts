/**
 * sliceGuards — Structural guard functions for slice-based block views.
 *
 * These guard functions enforce page-boundary and projection-root
 * constraints for BlockListView. They are passed to BlockEditor
 * as canIndent / canOutdent / canMerge / canDelete callbacks.
 */

import type { GraphNode } from '@/runtime/types';
import { getOperationRuntime } from '@/runtime';
import { getNode, getChildren } from '@/runtime/graphHelpers';
import type { OperationRuntime } from '@/runtime';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Walk up the hierarchy to find the nearest page ancestor.
 * Returns the page's blockId, or null if none found.
 */
function findPageAncestor(runtime: OperationRuntime, node: GraphNode): string | null {
  let current: GraphNode | undefined = node;
  while (current) {
    if (current.isPage || current.nodeType === 'page') return current.blockId;
    if (!current.parentId) return null;
    current = getNode(runtime, current.parentId);
  }
  return null;
}

// ─── Guard Factories ──────────────────────────────────────────────

/**
 * Create structural guard functions for a slice view.
 *
 * @param projectionRootIds - Set of blockIds that are projection roots (locked)
 */
export function createSliceGuards(projectionRootIds: Set<string>) {
  const runtime = getOperationRuntime();

  /**
   * Guard: can a block be indented?
   * - Projection roots cannot be indented.
   * - A block cannot indent under a page sibling (cross-page operation).
   */
  function canIndent(blockId: string): boolean {
    if (projectionRootIds.has(blockId)) return false;

    const node = getNode(runtime, blockId);
    if (!node?.parentId) return false;

    // Find previous sibling — that would become the new parent
    const siblings = getChildren(runtime, node.parentId);
    const myIndex = siblings.findIndex(s => s.blockId === blockId);
    if (myIndex <= 0) return false; // Can't indent first child (runtime will also reject)

    const prevSibling = siblings[myIndex - 1];
    // Can't indent under a page (cross-page operation)
    if (prevSibling.isPage || prevSibling.nodeType === 'page') return false;

    return true;
  }

  /**
   * Guard: can a block be outdented?
   * - Projection roots cannot be outdented.
   * - A block whose parent is a page cannot be outdented (page boundary).
   */
  function canOutdent(blockId: string): boolean {
    if (projectionRootIds.has(blockId)) return false;

    const node = getNode(runtime, blockId);
    if (!node?.parentId) return false;

    const parent = getNode(runtime, node.parentId);
    if (!parent?.parentId) return false;
    // Can't outdent out of a page (page boundary)
    if (parent.isPage || parent.nodeType === 'page') return false;

    return true;
  }

  /**
   * Guard: can a block be merged with another?
   * - Projection roots cannot be merged (neither source nor target).
   */
  function canMerge(sourceBlockId: string, targetBlockId: string): boolean {
    if (projectionRootIds.has(sourceBlockId)) return false;
    if (projectionRootIds.has(targetBlockId)) return false;
    return true;
  }

  /**
   * Guard: can a block be deleted?
   * - Projection roots cannot be deleted.
   */
  function canDelete(blockId: string): boolean {
    if (projectionRootIds.has(blockId)) return false;
    return true;
  }

  /**
   * Guard: can a block be moved (drag & drop) to a new parent?
   * - Projection roots cannot be moved.
   * - Moving across page boundaries is not allowed.
   */
  function canMove(blockId: string, newParentId: string): boolean {
    if (projectionRootIds.has(blockId)) return false;

    const block = getNode(runtime, blockId);
    const newParent = getNode(runtime, newParentId);
    if (!block || !newParent) return false;

    // Check cross-page: find page ancestor of both block and new parent
    const blockPage = findPageAncestor(runtime, block);
    const newParentPage = findPageAncestor(runtime, newParent);

    // If both are within a page, they must be in the same page
    if (blockPage && newParentPage && blockPage !== newParentPage) return false;

    return true;
  }

  return { canIndent, canOutdent, canMerge, canDelete, canMove };
}