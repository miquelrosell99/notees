/**
 * ProjectionReconciler — Diffs projected node lists and reconciles inline editors.
 *
 * The projection layer diffs current visible nodes vs previous state by blockId,
 * performing minimal insert/remove/reorder operations. Selection and caret
 * position are preserved across reconciliations.
 */

import type { ProjectedNode, ProjectionDiffOp } from './types';

// ─── Diff engine ──────────────────────────────────────────────────

/**
 * Compute minimal diff operations to transform `prev` into `next`.
 * Uses blockId as the stable key.
 */
export function diffProjections(
  prev: ProjectedNode[],
  next: ProjectedNode[],
): ProjectionDiffOp[] {
  const ops: ProjectionDiffOp[] = [];

  const prevMap = new Map(prev.map(n => [n.blockId, n]));
  const nextMap = new Map(next.map(n => [n.blockId, n]));
  const nextIds = next.map(n => n.blockId);
  const prevIds = prev.map(n => n.blockId);

  // 1. Find removals (in prev but not in next)
  for (const id of prevIds) {
    if (!nextMap.has(id)) {
      ops.push({ type: 'remove', blockId: id });
    }
  }

  // 2. Find insertions (in next but not in prev)
  for (let i = 0; i < nextIds.length; i++) {
    if (!prevMap.has(nextIds[i])) {
      ops.push({ type: 'insert', node: next[i], atIndex: i });
    }
  }

  // 3. Find updates (same blockId, changed properties)
  for (const [id, nextNode] of nextMap) {
    const prevNode = prevMap.get(id);
    if (!prevNode) continue;

    const changes: Partial<ProjectedNode> = {};
    let hasChanges = false;

    if (prevNode.depth !== nextNode.depth) {
      changes.depth = nextNode.depth;
      hasChanges = true;
    }
    if (prevNode.collapsed !== nextNode.collapsed) {
      changes.collapsed = nextNode.collapsed;
      hasChanges = true;
    }
    if (prevNode.visible !== nextNode.visible) {
      changes.visible = nextNode.visible;
      hasChanges = true;
    }
    if (JSON.stringify(prevNode.contentAST) !== JSON.stringify(nextNode.contentAST)) {
      changes.contentAST = nextNode.contentAST;
      hasChanges = true;
    }
    if (prevNode.hasChildren !== nextNode.hasChildren) {
      changes.hasChildren = nextNode.hasChildren;
      hasChanges = true;
    }
    if (prevNode.icon !== nextNode.icon) {
      changes.icon = nextNode.icon;
      hasChanges = true;
    }
    if (prevNode.color !== nextNode.color) {
      changes.color = nextNode.color;
      hasChanges = true;
    }
    if (prevNode.name !== nextNode.name) {
      changes.name = nextNode.name;
      hasChanges = true;
    }

    if (hasChanges) {
      ops.push({ type: 'update', blockId: id, changes });
    }
  }

  // 4. Find moves (same blockId but different position)
  // Filter to only nodes present in both
  const survivingPrev = prevIds.filter(id => nextMap.has(id));
  const survivingNext = nextIds.filter(id => prevMap.has(id));

  if (survivingPrev.length === survivingNext.length && survivingPrev.length > 0) {
    // Check if order changed using LIS (longest increasing subsequence)
    // Nodes not in LIS need to be moved
    const prevIndexMap = new Map(survivingPrev.map((id, i) => [id, i]));
    const nextIndexInPrev = survivingNext.map(id => prevIndexMap.get(id)!);

    const lis = longestIncreasingSubsequence(nextIndexInPrev);
    const lisSet = new Set(lis);

    for (let i = 0; i < survivingNext.length; i++) {
      if (!lisSet.has(i)) {
        ops.push({ type: 'move', blockId: survivingNext[i], toIndex: i });
      }
    }
  }

  return ops;
}

/**
 * Longest Increasing Subsequence indices.
 * Used for minimal move detection.
 */
function longestIncreasingSubsequence(arr: number[]): number[] {
  if (arr.length === 0) return [];

  const n = arr.length;
  const dp = new Array(n).fill(1);
  const parent = new Array(n).fill(-1);

  let maxLen = 1;
  let maxIdx = 0;

  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (arr[j] < arr[i] && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        parent[i] = j;
      }
    }
    if (dp[i] > maxLen) {
      maxLen = dp[i];
      maxIdx = i;
    }
  }

  // Reconstruct
  const result: number[] = [];
  let idx = maxIdx;
  while (idx !== -1) {
    result.push(idx);
    idx = parent[idx];
  }
  return result.reverse();
}

// ─── Reconciler class ─────────────────────────────────────────────

/**
 * Manages a projection state and provides reconciliation diffs
 * when the projection updates.
 */
export class ProjectionReconciler {
  private currentProjection: ProjectedNode[] = [];
  private projectionId: string;

  constructor(projectionId: string) {
    this.projectionId = projectionId;
  }

  getProjectionId(): string {
    return this.projectionId;
  }

  getCurrentProjection(): ProjectedNode[] {
    return this.currentProjection;
  }

  /**
   * Update with new projected nodes and return the diff operations.
   */
  reconcile(newProjection: ProjectedNode[]): ProjectionDiffOp[] {
    // Only include visible nodes for diffing
    const prevVisible = this.currentProjection.filter(n => n.visible);
    const nextVisible = newProjection.filter(n => n.visible);

    const ops = diffProjections(prevVisible, nextVisible);

    // Store full projection (including hidden nodes for collapse/expand)
    this.currentProjection = newProjection;

    return ops;
  }

  /**
   * Get the visible portion of the current projection.
   */
  getVisibleNodes(): ProjectedNode[] {
    return this.currentProjection.filter(n => n.visible);
  }

  /**
   * Find a node in the current projection by blockId.
   */
  findNode(blockId: string): ProjectedNode | undefined {
    return this.currentProjection.find(n => n.blockId === blockId);
  }

  /**
   * Reset the reconciler state.
   */
  reset(): void {
    this.currentProjection = [];
  }
}
