/**
 * graphPhysicsCore.ts
 *
 * Main-thread graph physics step for SemanticGraphEngine (SGE).
 * Also handles post-integration position constraints
 * (ring projection, centre-of-mass recentering) and the equidistant stepping mode.
 *
 * All functions are pure (no React hooks) so they can be called from inside the
 * rAF loop without hook-ordering constraints.
 */

import type { MutableRefObject } from 'react';
import type { SemanticGraphEngine } from './SemanticGraphEngine';
import type { GraphNode, GraphLink, Dimensions, NodeSizeMode, LinkDirection } from './viewTypes';
import {
  RETURN_FORCE,
  LINKED_ATTRACTION_DISTANCE,
  DRAG_PULL_STRENGTH,
  REFERENCE_LINK_FORCE_MULTIPLIER,
  TANGENTIAL_OVERLAP_RESOLVE,
  pairKey,
  getGlareRadius,
} from './viewTypes';

// ==================== Refs Interface ====================

/** Subset of refs required by the main-thread physics step functions. */
export interface MainThreadPhysicsRefs {
  sgeRef:       MutableRefObject<SemanticGraphEngine | null>;
  dragNodeRef:  MutableRefObject<GraphNode | null>;
  dimensionsRef: MutableRefObject<Dimensions>;
}

// ==================== Main-Thread Physics Step ====================

/**
 * Executes the full SGE cycle:
 *   Phase 1 – compute core forces (repulsion, springs, clustering)
 *   Phase 2 – inject mode-specific external forces (return-to-target,
 *              tangential overlap, drag pull)
 *   Phase 3 – Verlet integration + position copy-back to GraphNode objects
 */
export function runMainThreadPhysicsStep(
  refs: MainThreadPhysicsRefs,
  nodes: GraphNode[],
  nodeMap: Map<number, GraphNode>,
  _links: GraphLink[],
  adjacency: Map<number, Set<number>>,
  connectedPairs: Map<number, GraphLink['type']>,
  massCache: Map<number, number>,
  _alpha: number,
  isConstrainedMode: boolean,
  useMass: boolean,
  currentNodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  maxContentSize: number,
  currentLinkDirection: LinkDirection,
): void {
  const { sgeRef, dragNodeRef, dimensionsRef } = refs;
  const sge = sgeRef.current!;

  // Sync pinned/dragged state into engine
  for (const node of nodes) {
    const isDragged = dragNodeRef.current?.id === node.id;
    if (isDragged || node.pinned) {
      sge.pinNode(node.id);
      sge.moveNode(node.id, node.x, node.y);
    } else {
      sge.unpinNode(node.id);
    }
  }

  // Phase 1: compute core forces (cluster repulsion, springs, centering)
  sge.computeForces();

  // Phase 2: inject mode-specific external forces via applyForce()

  // Return-to-target (constrained physics only)
  if (isConstrainedMode) {
    const returnStrength = RETURN_FORCE * 0.05;
    for (const node of nodes) {
      if (dragNodeRef.current?.id === node.id || node.pinned) continue;
      const dx = node.targetX - node.x;
      const dy = node.targetY - node.y;
      const connCount = node.connectionCount;
      const multiplier = connCount === 0 ? 10 : 1;
      sge.applyForce(node.id, dx * returnStrength * multiplier, dy * returnStrength * multiplier);
    }
  }

  // Tangential overlap prevention (constrained physics only)
  if (isConstrainedMode) {
    const cx = dimensionsRef.current.width  / 2;
    const cy = dimensionsRef.current.height / 2;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (dragNodeRef.current?.id === a.id || a.pinned) continue;
      const aRadius = (a as GraphNode & { _treeRadius?: number })._treeRadius;
      if (aRadius === undefined) continue;
      const aGlare = getGlareRadius(a, currentNodeSizeMode, maxConnections, maxMass, maxContentSize, currentLinkDirection);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (dragNodeRef.current?.id === b.id || b.pinned) continue;
        const bRadius = (b as GraphNode & { _treeRadius?: number })._treeRadius;
        if (bRadius === undefined) continue;
        const bGlare = getGlareRadius(b, currentNodeSizeMode, maxConnections, maxMass, maxContentSize, currentLinkDirection);
        const minGlareDist = (aGlare + bGlare) * 1.05;
        if (Math.abs(aRadius - bRadius) > minGlareDist) continue;
        const dx   = b.x - a.x;
        const dy   = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist >= minGlareDist) continue;
        const dax    = a.x - cx;
        const day    = a.y - cy;
        const daDist = Math.sqrt(dax * dax + day * day) || 1;
        const radialX = dax / daDist;
        const radialY = day / daDist;
        const cross = dx * radialY - dy * radialX;
        const sign  = cross >= 0 ? 1 : -1;
        const tangX =  -radialY * sign;
        const tangY =   radialX * sign;
        const overlap = minGlareDist - dist;
        const force   = overlap * TANGENTIAL_OVERLAP_RESOLVE;
        const aMovable = !a.pinned && dragNodeRef.current?.id !== a.id;
        const bMovable = !b.pinned && dragNodeRef.current?.id !== b.id;
        if (aMovable && bMovable) {
          sge.applyForce(a.id, -tangX * force * 0.5, -tangY * force * 0.5);
          sge.applyForce(b.id,  tangX * force * 0.5,  tangY * force * 0.5);
        } else if (aMovable) {
          sge.applyForce(a.id, -tangX * force, -tangY * force);
        } else if (bMovable) {
          sge.applyForce(b.id,  tangX * force,  tangY * force);
        }
      }
    }
  }

  // Dragged node pulls connected nodes (via SGE forces)
  if (dragNodeRef.current && dragNodeRef.current.visible) {
    const dragNode  = dragNodeRef.current;
    const connected = adjacency.get(dragNode.id);
    if (connected) {
      for (const connectedId of connected) {
        const connectedNode = nodeMap.get(connectedId);
        if (!connectedNode || connectedNode.pinned) continue;
        const dx   = dragNode.x - connectedNode.x;
        const dy   = dragNode.y - connectedNode.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist > LINKED_ATTRACTION_DISTANCE) {
          const rawM = useMass ? (massCache.get(connectedNode.id) ?? 1) : 1;
          const mass = rawM <= 1 ? 1 : 1 + Math.log(rawM);
          const linkType = connectedPairs.get(pairKey(dragNode.id, connectedId)) ?? null;
          let dragMultiplier = 1;
          if (linkType === 'property-reference') {
            dragMultiplier = REFERENCE_LINK_FORCE_MULTIPLIER;
          } else if (linkType === 'reference') {
            dragMultiplier = REFERENCE_LINK_FORCE_MULTIPLIER * REFERENCE_LINK_FORCE_MULTIPLIER;
          }
          const fx = (dx / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) * dragMultiplier / mass;
          const fy = (dy / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) * dragMultiplier / mass;
          sge.applyForce(connectedNode.id, fx, fy);
        }
      }
    }
  }

  // Phase 3: Verlet integration (all forces — core + external — integrated together)
  sge.integrate();

  // Copy positions back from SGE to GraphNode objects
  const sgeState = sge.getState();
  {
    const { posX, posY, velX, velY, nodeIdArr, nodeCount } = sgeState;
    for (let _i = 0; _i < nodeCount; _i++) {
      const graphNode = nodeMap.get(nodeIdArr[_i]);
      if (graphNode && !graphNode.pinned && dragNodeRef.current?.id !== graphNode.id) {
        graphNode.x  = posX[_i];
        graphNode.y  = posY[_i];
        graphNode.vx = velX[_i];
        graphNode.vy = velY[_i];
      }
    }
  }
}

// ==================== Ring Constraint Projection ====================

/**
 * Applied after integration in constrained modes (circle/tree layouts).
 * Projects each node back onto its target ring radius and removes the radial
 * velocity component, then syncs the corrected state back to the SGE.
 */
export function applyRingConstraints(
  sgeRef:       MutableRefObject<SemanticGraphEngine | null>,
  dragNodeRef:  MutableRefObject<GraphNode | null>,
  dimensionsRef: MutableRefObject<Dimensions>,
  nodes: GraphNode[],
): void {
  for (const node of nodes) {
    if (dragNodeRef.current?.id === node.id || node.pinned) continue;
    const treeRadius = (node as GraphNode & { _treeRadius?: number })._treeRadius;
    if (treeRadius === undefined) continue;
    const cx = dimensionsRef.current.width  / 2;
    const cy = dimensionsRef.current.height / 2;
    const ndx = node.x - cx;
    const ndy = node.y - cy;
    const distToCenter = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
    const radialX = ndx / distToCenter;
    const radialY = ndy / distToCenter;
    const radiusError = Math.abs(distToCenter - treeRadius);
    // Remove radial velocity component
    const radialV = node.vx * radialX + node.vy * radialY;
    node.vx -= radialV * radialX;
    node.vy -= radialV * radialY;
    // Blend position toward ring
    const blendRate = radiusError > 50 ? 0.08 : radiusError > 10 ? 0.5 : 1.0;
    const newDist = distToCenter + (treeRadius - distToCenter) * blendRate;
    node.x = cx + radialX * newDist;
    node.y = cy + radialY * newDist;
    // Sync corrected position + velocity back to SGE
    sgeRef.current!.syncPosition(node.id, node.x, node.y, node.vx, node.vy);
  }
}

// ==================== Centre-of-Mass Recentering ====================

/**
 * Keeps the graph centred on the canvas in normal (non-constrained) mode.
 * Translates all mobile nodes so their centroid stays at the canvas centre.
 */
export function applyCOMRecentering(
  dragNodeRef:   MutableRefObject<GraphNode | null>,
  dimensionsRef: MutableRefObject<Dimensions>,
  nodes: GraphNode[],
  comCount: number,
): void {
  if (comCount === 0) return;
  const cx = dimensionsRef.current.width  / 2;
  const cy = dimensionsRef.current.height / 2;
  let avgX = 0, avgY = 0, cnt = 0;
  for (const node of nodes) {
    if (!node.pinned && dragNodeRef.current?.id !== node.id) {
      avgX += node.x; avgY += node.y; cnt++;
    }
  }
  if (cnt > 0) {
    const driftX = cx - avgX / cnt;
    const driftY = cy - avgY / cnt;
    for (const node of nodes) {
      if (!node.pinned && dragNodeRef.current?.id !== node.id) {
        node.x += driftX;
        node.y += driftY;
      }
    }
  }
}

// ==================== Equidistant Step ====================

/**
 * Applies velocity additions for the equidistant stepping mode (no SGE physics engine).
 * Only computes force deltas — the actual Euler integration happens in the outer
 * simulate() loop so the KE can be computed after damping.
 */
export function runEquidistantStep(
  dragNodeRef: MutableRefObject<GraphNode | null>,
  nodes: GraphNode[],
  nodeMap: Map<number, GraphNode>,
  adjacency: Map<number, Set<number>>,
  massCache: Map<number, number>,
  isConstrainedMode: boolean,
  useMass: boolean,
): void {
  // Strong return-to-target spring (constrained equidistant)
  if (isConstrainedMode) {
    for (const node of nodes) {
      if (dragNodeRef.current?.id === node.id || node.pinned) continue;
      const dx = node.targetX - node.x;
      const dy = node.targetY - node.y;
      node.vx += dx * 0.5;
      node.vy += dy * 0.5;
    }
  }

  // Dragged node pulls connected nodes (direct velocity delta)
  if (dragNodeRef.current && dragNodeRef.current.visible) {
    const dragNode  = dragNodeRef.current;
    const connected = adjacency.get(dragNode.id);
    if (connected) {
      for (const connectedId of connected) {
        const connectedNode = nodeMap.get(connectedId);
        if (!connectedNode || connectedNode.pinned) continue;
        const dx   = dragNode.x - connectedNode.x;
        const dy   = dragNode.y - connectedNode.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist > LINKED_ATTRACTION_DISTANCE) {
          const rawM = useMass ? (massCache.get(connectedNode.id) ?? 1) : 1;
          const mass = rawM <= 1 ? 1 : 1 + Math.log(rawM);
          connectedNode.vx += (dx / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) / mass;
          connectedNode.vy += (dy / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) / mass;
        }
      }
    }
  }
}
