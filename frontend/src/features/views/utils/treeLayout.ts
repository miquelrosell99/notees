/**
 * treeLayout.ts
 *
 * Positions nodes in concentric rings based on their parent–child depth
 * in the node hierarchy. Used by useNodePhysics when mode === 'tree'.
 *
 * Two sub-modes are supported, chosen by `constraintMode`:
 *
 *   'equidistant' — nodes at the same depth share a ring, evenly spaced.
 *   'physics'     — angular allocation is proportional to each subtree's
 *                   arc width (bottom-up pass), so children stay centred
 *                   under their parent when physics relaxes the layout.
 *
 * Pure function — no React hooks. Mutates `targetX`, `targetY`, `_treeRadius`
 * (and snaps `x`/`y` for brand-new nodes).
 */

import type { GraphNode } from '../types/viewTypes';

// ==================== Public API ====================

/**
 * Applies a tree (radial hierarchy) layout to the given node list.
 *
 * @param nodes           Visible nodes to position.
 * @param centerX         Canvas centre X in world space.
 * @param centerY         Canvas centre Y in world space.
 * @param nodeSpacing     Minimum arc-length gap between adjacent node edges.
 *                        Derived from the largest glare radius: `maxGlareRadius * 2 + 8`.
 * @param levelGap        Radial distance between consecutive depth rings.
 *                        Derived from the largest glare radius: `maxGlareRadius * 2 + 40`.
 * @param constraintMode  'equidistant' | 'physics' (default 'physics').
 */
export function applyTreeLayout(
  nodes: GraphNode[],
  centerX: number,
  centerY: number,
  nodeSpacing: number,
  levelGap: number,
  constraintMode: 'physics' | 'equidistant' = 'physics',
): void {
  if (nodes.length === 0) return;

  // ---- Step 1: build parent → children map (visible nodes only) ----
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.parentId !== null) {
      const siblings = childrenByParent.get(node.parentId) || [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
    }
  }

  // ---- Step 2: BFS depth assignment ----
  // Class nodes go first (depth 0…maxClassDepth), regular roots follow.
  const nodeDepth = new Map<string, number>();
  const visibleNodeIds = new Set(nodes.map(n => n.id));

  const classRoots   = nodes.filter(n =>  n.isClassNode && (n.parentId === null || !visibleNodeIds.has(n.parentId)));
  const regularRoots = nodes.filter(n => !n.isClassNode && (n.parentId === null || !visibleNodeIds.has(n.parentId)));
  const hasVisibleClasses = classRoots.length > 0;

  for (const node of classRoots) nodeDepth.set(node.id, 0);

  const classQueue = [...classRoots];
  let maxClassDepth = 0;
  while (classQueue.length > 0) {
    const parent = classQueue.shift()!;
    const parentDepth = nodeDepth.get(parent.id)!;
    for (const child of childrenByParent.get(parent.id) || []) {
      if (child.isClassNode) {
        const childDepth = parentDepth + 1;
        nodeDepth.set(child.id, childDepth);
        maxClassDepth = Math.max(maxClassDepth, childDepth);
        classQueue.push(child);
      }
    }
  }

  const regularRootLevel = hasVisibleClasses ? maxClassDepth + 1 : 0;
  for (const node of regularRoots) nodeDepth.set(node.id, regularRootLevel);

  // BFS from all roots to assign depths to remaining nodes.
  const queue: GraphNode[] = [...regularRoots, ...classRoots];
  for (const node of classRoots) {
    if (!regularRoots.includes(node)) queue.push(node);
  }
  // Ensure intermediate class nodes (non-root) are in the queue too.
  for (const node of nodes) {
    if (node.isClassNode && nodeDepth.has(node.id) && !classRoots.includes(node)) {
      queue.push(node);
    }
  }

  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentDepth = nodeDepth.get(parent.id)!;
    for (const child of childrenByParent.get(parent.id) || []) {
      if (!nodeDepth.has(child.id)) {
        nodeDepth.set(child.id, parentDepth + 1);
        queue.push(child);
      }
    }
  }

  let maxDepth = 0;
  for (const depth of nodeDepth.values()) maxDepth = Math.max(maxDepth, depth);

  // ---- Step 3: group nodes by depth ----
  const nodesByDepth = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const depth = nodeDepth.get(node.id);
    if (depth !== undefined) {
      const arr = nodesByDepth.get(depth) || [];
      arr.push(node);
      nodesByDepth.set(depth, arr);
    }
  }

  // Each depth level gets a ring; innermost ring is at `levelGap`.
  const radiusByDepth = new Map<number, number>();
  for (let d = 0; d <= maxDepth; d++) radiusByDepth.set(d, levelGap * (d + 1));

  // ---- Step 4: positioning ----
  if (constraintMode === 'equidistant') {
    _applyEquidistantRings(nodesByDepth, radiusByDepth, maxDepth, centerX, centerY, nodeSpacing);
  } else {
    _applyPhysicsAngularWidth(
      nodesByDepth, childrenByParent, radiusByDepth,
      maxDepth, centerX, centerY, nodeSpacing,
      nodeDepth,
    );
  }

  // ---- Step 5: orphans (nodes with no depth assignment) ----
  const orphans = nodes.filter(n => !nodeDepth.has(n.id));
  if (orphans.length > 0) {
    const orphanRadius = levelGap * (maxDepth + 2);
    orphans.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(orphans.length, 1) + Math.PI;
      node.targetX = centerX + orphanRadius * Math.cos(angle);
      node.targetY = centerY + orphanRadius * Math.sin(angle);
      (node as GraphNode & { _treeRadius?: number })._treeRadius = orphanRadius;
    });
  }
}

// ==================== Private helpers ====================

/** Sets node on ring, snapping position for brand-new nodes. */
function _placeOnRing(
  node: GraphNode,
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
): void {
  node.targetX = centerX + radius * Math.cos(angle);
  node.targetY = centerY + radius * Math.sin(angle);
  (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
  if (node.x == null && node.y == null) {
    node.x = node.targetX;
    node.y = node.targetY;
  }
}

/**
 * Equidistant mode: all nodes at the same depth share a ring
 * and are evenly spaced around it.
 */
function _applyEquidistantRings(
  nodesByDepth:  Map<number, GraphNode[]>,
  radiusByDepth: Map<number, number>,
  maxDepth:      number,
  centerX:       number,
  centerY:       number,
  nodeSpacing:   number,
): void {
  // Merge all nodes at the same nominal radius onto one ring set.
  const ringNodes = new Map<number, GraphNode[]>();
  for (let depth = 0; depth <= maxDepth; depth++) {
    const nodesAtDepth = nodesByDepth.get(depth);
    if (!nodesAtDepth || nodesAtDepth.length === 0) continue;
    const baseRadius = radiusByDepth.get(depth)!;
    const arr = ringNodes.get(baseRadius) || [];
    arr.push(...nodesAtDepth);
    ringNodes.set(baseRadius, arr);
  }

  for (const [baseRadius, nodesOnRing] of ringNodes) {
    const count = nodesOnRing.length;
    const minRadiusForCount = (count * nodeSpacing) / (2 * Math.PI);
    const radius = Math.max(baseRadius, minRadiusForCount);

    nodesOnRing.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / count - Math.PI / 2;
      _placeOnRing(node, centerX, centerY, radius, angle);
    });
  }
}

/**
 * Physics mode: each node's angular allocation is proportional to its
 * subtree's total arc width so children naturally cluster under their parent.
 *
 * Algorithm:
 *   1. Bottom-up pass — compute `subtreeAngularWidth` for every node.
 *   2. Top-down pass — allocate arc ranges to each depth level and place nodes.
 */
function _applyPhysicsAngularWidth(
  nodesByDepth:    Map<number, GraphNode[]>,
  childrenByParent: Map<string, GraphNode[]>,
  radiusByDepth:   Map<number, number>,
  maxDepth:        number,
  centerX:         number,
  centerY:         number,
  nodeSpacing:     number,
  nodeDepth:       Map<string, number>,
): void {
  // ---- Bottom-up: compute subtree angular width ----
  const subtreeAngularWidth = new Map<string, number>();

  for (let depth = maxDepth; depth >= 0; depth--) {
    const nodesAtDepth = nodesByDepth.get(depth) || [];
    for (const node of nodesAtDepth) {
      const children = (childrenByParent.get(node.id) || []).filter(c => nodeDepth.has(c.id));

      if (children.length === 0) {
        const radius = radiusByDepth.get(depth)!;
        subtreeAngularWidth.set(node.id, nodeSpacing / radius);
      } else {
        const childDepth  = depth + 1;
        const childRadius = radiusByDepth.get(childDepth)!;
        let totalChildrenWidth = 0;
        for (const child of children) {
          totalChildrenWidth += subtreeAngularWidth.get(child.id) ?? (nodeSpacing / childRadius);
        }
        const ownRadius   = radiusByDepth.get(depth)!;
        const ownMinWidth = nodeSpacing / ownRadius;
        subtreeAngularWidth.set(node.id, Math.max(ownMinWidth, totalChildrenWidth));
      }
    }
  }

  // ---- Top-down: allocate arc ranges and place nodes ----
  const nodeAngleRange = new Map<string, { start: number; end: number }>();

  // Depth 0 (innermost ring)
  const level0Nodes = nodesByDepth.get(0) || [];
  const radius0 = radiusByDepth.get(0)!;

  let totalLevel0Width = 0;
  for (const node of level0Nodes) {
    totalLevel0Width += subtreeAngularWidth.get(node.id) ?? (nodeSpacing / radius0);
  }
  const totalAngle0 = Math.max(2 * Math.PI, totalLevel0Width);
  const scale0 = totalAngle0 / (totalLevel0Width || 1);

  let currentAngle0 = -Math.PI / 2;
  for (const node of level0Nodes) {
    const rawWidth       = subtreeAngularWidth.get(node.id) ?? (nodeSpacing / radius0);
    const allocatedWidth = rawWidth * scale0;
    const angle          = currentAngle0 + allocatedWidth / 2;
    _placeOnRing(node, centerX, centerY, radius0, angle);
    nodeAngleRange.set(node.id, { start: currentAngle0, end: currentAngle0 + allocatedWidth });
    currentAngle0 += allocatedWidth;
  }

  // Depth 1…maxDepth
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nodesAtDepth = nodesByDepth.get(depth) || [];
    const radius       = radiusByDepth.get(depth)!;

    const nodesWithParent    = nodesAtDepth.filter(n => n.parentId !== null && nodeAngleRange.has(n.parentId));
    const rootNodesAtThisLevel = nodesAtDepth.filter(n => n.parentId === null || !nodeAngleRange.has(n.parentId));

    // Nodes at this depth that have no parent arc range — treat like depth-0 roots.
    if (rootNodesAtThisLevel.length > 0) {
      let totalRootWidth = 0;
      for (const node of rootNodesAtThisLevel) {
        totalRootWidth += subtreeAngularWidth.get(node.id) ?? (nodeSpacing / radius);
      }
      const totalAngleRoot = Math.max(2 * Math.PI, totalRootWidth);
      const scaleRoot      = totalAngleRoot / (totalRootWidth || 1);

      let currentAngleRoot = -Math.PI / 2;
      for (const node of rootNodesAtThisLevel) {
        const rawWidth       = subtreeAngularWidth.get(node.id) ?? (nodeSpacing / radius);
        const allocatedWidth = rawWidth * scaleRoot;
        const angle          = currentAngleRoot + allocatedWidth / 2;
        _placeOnRing(node, centerX, centerY, radius, angle);
        nodeAngleRange.set(node.id, { start: currentAngleRoot, end: currentAngleRoot + allocatedWidth });
        currentAngleRoot += allocatedWidth;
      }
    }

    // Group children by their parent and assign arcs inside the parent's arc.
    const siblingGroups = new Map<string, GraphNode[]>();
    for (const node of nodesWithParent) {
      const parentId = node.parentId!;
      const group    = siblingGroups.get(parentId) || [];
      group.push(node);
      siblingGroups.set(parentId, group);
    }

    for (const [parentId, siblings] of siblingGroups) {
      const parentRange  = nodeAngleRange.get(parentId)!;
      const parentCenter = (parentRange.start + parentRange.end) / 2;
      const parentSpan   = parentRange.end - parentRange.start;

      let totalSiblingWidth = 0;
      for (const sibling of siblings) {
        totalSiblingWidth += subtreeAngularWidth.get(sibling.id) ?? (nodeSpacing / radius);
      }

      const actualSpan  = Math.max(parentSpan, totalSiblingWidth);
      const startAngle  = parentCenter - actualSpan / 2;
      let currentAngle  = startAngle;

      for (const sibling of siblings) {
        const childWidth     = subtreeAngularWidth.get(sibling.id) ?? (nodeSpacing / radius);
        const allocatedWidth = (childWidth / (totalSiblingWidth || 1)) * actualSpan;
        const angle          = currentAngle + allocatedWidth / 2;
        _placeOnRing(sibling, centerX, centerY, radius, angle);
        nodeAngleRange.set(sibling.id, { start: currentAngle, end: currentAngle + allocatedWidth });
        currentAngle += allocatedWidth;
      }
    }
  }
}
