/**
 * layouts.ts — the non-force layout modes (the parked §34.80 follow-ups):
 * deterministic radial placements that replace the simulation while active.
 *
 *  - `circle`: every node on one ring, ordered (classes first, then by id).
 *  - `tree`: concentric rings by parent depth — classes on the inner rings,
 *    regular roots after, children always one ring out from their parent,
 *    angular slots allocated bottom-up by subtree size (the v1 radial tree,
 *    compacted).
 *
 * Pure functions over the DISPLAY topology (post-filtering), so the orphan
 * and family filters compose with them.
 */

import type { GraphTopology } from "@notees/store";

export type GraphLayoutMode = "force" | "circle" | "tree";

export interface LayoutPoint {
  x: number;
  y: number;
}

/** Ring spacing constants (world units). */
const CIRCLE_SPACING = 26;
const TREE_LEVEL_GAP = 150;

export function computeFixedLayout(
  mode: "circle" | "tree",
  topology: GraphTopology,
): Map<string, LayoutPoint> {
  return mode === "circle" ? circleLayout(topology) : treeLayout(topology);
}

function circleLayout(topology: GraphTopology): Map<string, LayoutPoint> {
  const points = new Map<string, LayoutPoint>();
  const ordered = [...topology.nodes].sort((a, b) =>
    a.isClass === b.isClass ? a.id.localeCompare(b.id) : a.isClass ? -1 : 1,
  );
  const n = ordered.length;
  if (n === 0) return points;
  const radius = Math.max(240, (n * CIRCLE_SPACING) / (2 * Math.PI));
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    points.set(ordered[i]!.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return points;
}

function treeLayout(topology: GraphTopology): Map<string, LayoutPoint> {
  const points = new Map<string, LayoutPoint>();
  const visible = new Set(topology.nodes.map((n) => n.id));
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));

  // Parent edges restricted to visible nodes; roots are parentless or
  // parent-hidden nodes (classes and pages alike — identity doesn't matter
  // for placement, only adjacency).
  const childrenOf = new Map<string, string[]>();
  for (const node of topology.nodes) {
    if (node.parentId !== null && visible.has(node.parentId)) {
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node.id);
      childrenOf.set(node.parentId, list);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.localeCompare(b));

  const isRoot = (id: string): boolean => {
    const parent = byId.get(id)?.parentId ?? null;
    return parent === null || !visible.has(parent);
  };
  const roots = topology.nodes.filter((n) => isRoot(n.id));
  roots.sort((a, b) =>
    a.isClass === b.isClass ? a.id.localeCompare(b.id) : a.isClass ? -1 : 1,
  );

  // Depth by BFS (cycle-guarded).
  const depthOf = new Map<string, number>();
  let frontier = roots.map((r) => r.id);
  for (const id of frontier) depthOf.set(id, 0);
  let guard = 0;
  while (frontier.length > 0 && guard < 10_000) {
    guard += 1;
    const next: string[] = [];
    for (const id of frontier) {
      const depth = depthOf.get(id)!;
      for (const child of childrenOf.get(id) ?? []) {
        if (!depthOf.has(child)) {
          depthOf.set(child, depth + 1);
          next.push(child);
        }
      }
    }
    frontier = next;
  }

  // Subtree sizes bottom-up (arc allocation per leaf).
  const subtreeOf = new Map<string, number>();
  const computeSubtree = (id: string): number => {
    const cached = subtreeOf.get(id);
    if (cached !== undefined) return cached;
    let size = 0;
    for (const child of childrenOf.get(id) ?? []) size += computeSubtree(child);
    size = Math.max(size, 1); // a leaf still owns one arc slot
    subtreeOf.set(id, size);
    return size;
  };

  // Angular allocation: roots share the full circle; each parent centres its
  // children over its own slot, sized by subtree arc.
  const totalLeaves = roots.reduce((sum, r) => sum + computeSubtree(r.id), 0);
  if (totalLeaves === 0) return points;
  const assign = (
    id: string,
    startAngle: number,
    endAngle: number,
  ): void => {
    const depth = depthOf.get(id) ?? 0;
    const mid = (startAngle + endAngle) / 2;
    const radius = depth * TREE_LEVEL_GAP;
    points.set(id, {
      x: Math.cos(mid - Math.PI / 2) * radius,
      y: Math.sin(mid - Math.PI / 2) * radius,
    });
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return;
    const span = endAngle - startAngle;
    let cursor = startAngle;
    for (const child of children) {
      const childArc = (computeSubtree(child) / computeSubtree(id)) * span;
      assign(child, cursor, cursor + childArc);
      cursor += childArc;
    }
  };
  let cursor = 0;
  for (const root of roots) {
    const arc = (computeSubtree(root.id) / totalLeaves) * 2 * Math.PI;
    assign(root.id, cursor, cursor + arc);
    cursor += arc;
  }
  // Unreached nodes (cycles the BFS skipped) land on an outer ring.
  const maxDepth = Math.max(0, ...depthOf.values());
  const leftovers = topology.nodes.filter((n) => !points.has(n.id));
  leftovers.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, leftovers.length);
    const radius = (maxDepth + 1) * TREE_LEVEL_GAP;
    points.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return points;
}
