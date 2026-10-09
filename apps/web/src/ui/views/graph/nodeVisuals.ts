/**
 * nodeVisuals.ts — the pure node-visual contract for the graph view (unit
 * tested without a canvas): which color a node paints (class color first —
 * the ordered list, first match wins — then the query group color, then the
 * node's own color) and the renderer visuals map assembly.
 */

import type { GraphTopology } from "@notees/store";

/** One ordered class-color entry (the v1 register: first match wins). */
export interface ClassColorEntry {
  classId: string;
  /** Preset token or #RRGGBB. */
  color: string;
}

export interface NodeVisualSpec {
  radius: number;
  color?: Float32Array;
}

/**
 * The class color for a node: the first entry in list order whose class the
 * node carries. A node with no listed class keeps its own/group color.
 */
export function classColorFor(
  node: { classIds: string[] },
  classColors: readonly ClassColorEntry[],
): string | undefined {
  for (const entry of classColors) {
    if (node.classIds.includes(entry.classId)) return entry.color;
  }
  return undefined;
}

/** Resolved RGBA (0–1) for a node, or undefined for the renderer default. */
export function resolveNodeColorRgb(
  node: { id: string; color: string | null; classIds: string[] },
  classColors: readonly ClassColorEntry[],
  groupColors: ReadonlyMap<string, string>,
  hexToRgba: (hex: string) => [number, number, number, number] | undefined,
  resolveCss: (color: string) => string,
): [number, number, number, number] | undefined {
  const classColor = classColorFor(node, classColors);
  const grouped = classColor ?? groupColors.get(node.id);
  const raw = grouped ?? node.color;
  if (raw === null || raw === undefined) return undefined;
  return hexToRgba(resolveCss(raw));
}

/** The full visuals map for the renderer (radius + resolved color per node). */
export function buildNodeVisuals(
  topology: Pick<GraphTopology, "nodes">,
  radii: ReadonlyMap<string, number>,
  classColors: readonly ClassColorEntry[],
  groupColors: ReadonlyMap<string, string>,
  hexToRgba: (hex: string) => [number, number, number, number] | undefined,
  resolveCss: (color: string) => string,
): Map<string, NodeVisualSpec> {
  const visuals = new Map<string, NodeVisualSpec>();
  for (const node of topology.nodes) {
    const rgba = resolveNodeColorRgb(node, classColors, groupColors, hexToRgba, resolveCss);
    visuals.set(node.id, {
      radius: radii.get(node.id) ?? 8,
      ...(rgba !== undefined ? { color: new Float32Array(rgba) } : {}),
    });
  }
  return visuals;
}
