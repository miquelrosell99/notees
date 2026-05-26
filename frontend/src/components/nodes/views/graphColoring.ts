/**
 * Graph Coloring Helpers
 *
 * Color resolution, palette generation, and conversion utilities
 * for graph node styling and class-based coloring.
 */

import type { GraphNode, ClassColor } from './graphTypes';
import { PRESET_VAR_NAMES } from '@/utils/colorPresets';

/** Resolve a CSS variable to its computed value */
const resolveCssColor = (varName: string, fallback: string): string => {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
};

/** Preset color CSS variable names in order */
const PRESET_COLOR_VARS = PRESET_VAR_NAMES;

/**
 * Get node color based on class or default
 */
export const getNodeColor = (
  node: GraphNode,
  classColors: ClassColor[],
  defaultColor: string
): string => {
  // Check if node has a color override
  if (node.color) return node.color;

  // Check class colors by type ID (node.types array)
  for (const classId of node.types || []) {
    const classColor = classColors.find(cc => cc.classId === classId);
    if (classColor) return classColor.color;
  }

  return defaultColor;
};

/**
 * Convert hex color to rgba (cached for hot-path rendering)
 */
const _hexToRgbaCache = new Map<string, string>();
export const hexToRgba = (hex: string, alpha: number): string => {
  // Quantize alpha to 2 decimal places to improve cache hit rate
  const a = Math.round(alpha * 100) / 100;
  const key = hex + a;
  let result = _hexToRgbaCache.get(key);
  if (result !== undefined) return result;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  result = `rgba(${r}, ${g}, ${b}, ${a})`;
  // Cap cache size to prevent unbounded growth
  if (_hexToRgbaCache.size > 2000) _hexToRgbaCache.clear();
  _hexToRgbaCache.set(key, result);
  return result;
};

/** Resolve class color palette from --color-preset-* CSS variables */
export const getClassColorPalette = (): string[] =>
  PRESET_COLOR_VARS.map(v => resolveCssColor(v, '#808080'));

/** Resolve node picker palette from --color-preset-* CSS variables (with null = no color) */
export const getNodePickerPalette = (): (string | null)[] => [
  null,
  ...getClassColorPalette(),
];

/** Resolve date lane palette (subset of preset colors) */
export const getDateLanePalette = (): string[] => {
  const vars = [
    PRESET_VAR_NAMES[0],  // red
    PRESET_VAR_NAMES[6],  // purple
    PRESET_VAR_NAMES[7],  // pink
    PRESET_VAR_NAMES[2],  // yellow
    PRESET_VAR_NAMES[1],  // orange
    PRESET_VAR_NAMES[4],  // teal
  ];
  return vars.map(v => resolveCssColor(v, '#808080'));
};
