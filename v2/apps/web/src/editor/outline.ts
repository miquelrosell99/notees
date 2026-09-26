/**
 * Outline position map — the sibling/parent facts the keyboard contract
 * needs, computed once per tree render (pure, unit-testable; the editor
 * gestures read it instead of walking the DOM).
 *
 * - previousSiblingId: indent target parent (Tab) and the block a Backspace
 *   delete hands the caret to (falling back to the parent itself when the
 *   block is its parent's first child).
 * - grandParentId: outdent target parent (shift+Tab).
 *
 * `rootParentId` is the parent of the top-level rows (the page id in
 * PageView): without it the map is tree-relative and a child of a top-level
 * block has no grandparent to outdent to.
 */

import type { BlockTreeNode } from "@/core/workspace-client.js";

export interface OutlinePosition {
  parentId: string | null;
  previousSiblingId: string | null;
  grandParentId: string | null;
}

export type OutlinePositionMap = ReadonlyMap<string, OutlinePosition>;

export function buildOutlinePositions(
  roots: readonly BlockTreeNode[],
  rootParentId: string | null = null,
): Map<string, OutlinePosition> {
  const map = new Map<string, OutlinePosition>();
  const walk = (
    children: readonly BlockTreeNode[],
    parentId: string | null,
    grandParentId: string | null,
  ): void => {
    children.forEach((child, index) => {
      map.set(child.node.id, {
        parentId,
        previousSiblingId: index > 0 ? children[index - 1]!.node.id : null,
        grandParentId,
      });
      walk(child.children, child.node.id, parentId);
    });
  };
  walk(roots, rootParentId, null);
  return map;
}
