/**
 * circleLayout.ts
 *
 * Positions all nodes evenly on a single circle centred on the canvas.
 * Used by useNodePhysics when mode === 'circle'.
 *
 * Pure function — no React hooks. Mutates `targetX`, `targetY`, `_treeRadius`
 * (and snaps `x`/`y` for nodes that haven't been placed yet).
 */

import type { GraphNode } from './viewTypes';

/**
 * Distributes nodes around one ring.
 *
 * @param nodes        Visible nodes to position (order determines angular placement).
 * @param centerX      Canvas centre X in world space.
 * @param centerY      Canvas centre Y in world space.
 * @param nodeSpacing  Arc-length spacing between adjacent node edges (pixels).
 *                     Derived from the largest glare radius: `maxGlareRadius * 2 + 8`.
 */
export function applyCircleLayout(
  nodes: GraphNode[],
  centerX: number,
  centerY: number,
  nodeSpacing: number,
): void {
  if (nodes.length === 0) return;

  const preferredRadius = Math.min(centerX, centerY) * 0.8;
  const minRadiusForCount = (nodes.length * nodeSpacing) / (2 * Math.PI);
  const radius = Math.max(preferredRadius, minRadiusForCount);

  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    node.targetX = centerX + radius * Math.cos(angle);
    node.targetY = centerY + radius * Math.sin(angle);
    (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
    // Snap position for brand-new nodes that haven't been placed yet.
    if (node.x == null && node.y == null) {
      node.x = node.targetX;
      node.y = node.targetY;
    }
  });
}
