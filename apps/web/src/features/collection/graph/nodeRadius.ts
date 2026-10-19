/**
 * nodeRadius.ts — the pure node-sizing contract for the graph view (unit
 * tested without a canvas). The sizing modes and the radius curve are the
 * v1 register ported 1:1: uniform rides the base-radius slider; the
 * metric modes map their ratio through a power curve over the v1 bounds.
 */

import type { GraphEdge, GraphTopology } from "@notees/store";

export type NodeSizeMode = "uniform" | "connections" | "mass" | "content";
export type LinkDirection = "all" | "in" | "out";

export const NODE_RADIUS_MIN = 4;
export const NODE_RADIUS_MAX = 18;
/** Power-curve exponents (v1: connections/content 0.7, mass 0.8). */
export const NODE_RADIUS_CONN_SCALE = 0.7;
export const NODE_RADIUS_MASS_SCALE = 0.8;

/**
 * The v1 radius curve: MIN + (MAX − MIN)·pow(ratio, scale). Uniform nodes
 * take the base radius (the settings slider) directly.
 */
export function nodeRadius(
  mode: NodeSizeMode,
  baseRadius: number,
  node: { id: string; contentSize: number; mass: number },
  degrees: { all: number; in: number; out: number },
  maxima: { connections: number; mass: number; content: number },
  direction: LinkDirection,
): number {
  if (mode === "uniform") return baseRadius;
  if (mode === "connections") {
    const count = direction === "in" ? degrees.in : direction === "out" ? degrees.out : degrees.all;
    const ratio = maxima.connections > 0 ? Math.min(count / maxima.connections, 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }
  if (mode === "mass") {
    const ratio = maxima.mass > 1 ? Math.min((node.mass - 1) / (maxima.mass - 1), 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_MASS_SCALE);
  }
  const ratio = maxima.content > 0 ? Math.min(node.contentSize / maxima.content, 1) : 0;
  return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
}

/**
 * One pass over the display topology: directed degree maps, the maxima the
 * metric modes normalize against, and the final radius per node id. The
 * degrees ride along for the engine's link-count attraction.
 */
export function computeNodeSizing(
  topology: Pick<GraphTopology, "nodes" | "edges">,
  mode: NodeSizeMode,
  baseRadius: number,
  direction: LinkDirection,
): {
  radii: Map<string, number>;
  degrees: Map<string, { all: number; in: number; out: number }>;
} {
  const degrees = new Map<string, { all: number; in: number; out: number }>();
  const bump = (id: string, key: "all" | "in" | "out"): void => {
    let entry = degrees.get(id);
    if (entry === undefined) {
      entry = { all: 0, in: 0, out: 0 };
      degrees.set(id, entry);
    }
    entry[key] += 1;
  };
  for (const edge of topology.edges as GraphEdge[]) {
    bump(edge.source, "all");
    bump(edge.source, "out");
    bump(edge.target, "all");
    bump(edge.target, "in");
  }

  let maxConnections = 0;
  let maxMass = 0;
  let maxContent = 0;
  for (const node of topology.nodes) {
    const degree = degrees.get(node.id) ?? { all: 0, in: 0, out: 0 };
    const dirCount = direction === "in" ? degree.in : direction === "out" ? degree.out : degree.all;
    if (dirCount > maxConnections) maxConnections = dirCount;
    if (node.mass > maxMass) maxMass = node.mass;
    if (node.contentSize > maxContent) maxContent = node.contentSize;
  }
  const maxima = { connections: maxConnections, mass: maxMass, content: maxContent };

  const radii = new Map<string, number>();
  for (const node of topology.nodes) {
    radii.set(
      node.id,
      nodeRadius(mode, baseRadius, node, degrees.get(node.id) ?? { all: 0, in: 0, out: 0 }, maxima, direction),
    );
  }
  return { radii, degrees };
}
