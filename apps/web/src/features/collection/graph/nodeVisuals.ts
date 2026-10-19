/**
 * nodeVisuals.ts — the pure node-visual contract for the graph view (unit
 * tested without a canvas): which color a node paints (the query group
 * color — the list order IS first-match-wins — then the node's own color)
 * and the renderer visuals map assembly. Owner ruling (2026-10-13): the
 * retired per-class color list is gone — its entries migrated one-time into
 * query groups.
 */

import type { GraphTopology } from "@notees/store";

export interface NodeVisualSpec {
  radius: number;
  color?: Float32Array;
}

/** Resolved RGBA (0–1) for a node, or undefined for the renderer default. */
export function resolveNodeColorRgb(
  node: { id: string; color: string | null },
  groupColors: ReadonlyMap<string, string>,
  hexToRgba: (hex: string) => [number, number, number, number] | undefined,
  resolveCss: (color: string) => string,
): [number, number, number, number] | undefined {
  const raw = groupColors.get(node.id) ?? node.color;
  if (raw === null || raw === undefined) return undefined;
  return hexToRgba(resolveCss(raw));
}

/** The full visuals map for the renderer (radius + resolved color per node). */
export function buildNodeVisuals(
  topology: Pick<GraphTopology, "nodes">,
  radii: ReadonlyMap<string, number>,
  groupColors: ReadonlyMap<string, string>,
  hexToRgba: (hex: string) => [number, number, number, number] | undefined,
  resolveCss: (color: string) => string,
): Map<string, NodeVisualSpec> {
  const visuals = new Map<string, NodeVisualSpec>();
  for (const node of topology.nodes) {
    const rgba = resolveNodeColorRgb(node, groupColors, hexToRgba, resolveCss);
    visuals.set(node.id, {
      radius: radii.get(node.id) ?? 8,
      ...(rgba !== undefined ? { color: new Float32Array(rgba) } : {}),
    });
  }
  return visuals;
}
