/**
 * Data-level semantic color presets.
 *
 * These are NOT design tokens — they are application data colors for
 * tags, statuses, node colors, property selections, and whiteboard tools.
 * The design-system tokens stay monochrome.
 *
 * Stored values are CSS variable references ('var(--color-preset-red)'):
 * the concrete hex lives in variables.css, so themes can remap the palette
 * without rewriting node data. Use `resolveCssColor` before computing with a
 * stored color (contrast, rgb channels) — pass the reference straight to CSS.
 */

export const PRESET_CSS_VARS = {
  red: "var(--color-preset-red)",
  orange: "var(--color-preset-orange)",
  yellow: "var(--color-preset-yellow)",
  green: "var(--color-preset-green)",
  teal: "var(--color-preset-teal)",
  blue: "var(--color-preset-blue)",
  purple: "var(--color-preset-purple)",
  pink: "var(--color-preset-pink)",
} as const;

export interface ColorEntry {
  /** Color value emitted when the swatch is selected ('var(--color-preset-*)'). */
  cssVar: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

export const PRESET_COLOR_ENTRIES: ColorEntry[] = [
  { cssVar: PRESET_CSS_VARS.red, label: "Red" },
  { cssVar: PRESET_CSS_VARS.orange, label: "Orange" },
  { cssVar: PRESET_CSS_VARS.yellow, label: "Yellow" },
  { cssVar: PRESET_CSS_VARS.green, label: "Green" },
  { cssVar: PRESET_CSS_VARS.teal, label: "Teal" },
  { cssVar: PRESET_CSS_VARS.blue, label: "Blue" },
  { cssVar: PRESET_CSS_VARS.purple, label: "Purple" },
  { cssVar: PRESET_CSS_VARS.pink, label: "Pink" },
] as const;

export const PRESET_VAR_NAMES = [
  "--color-preset-red",
  "--color-preset-orange",
  "--color-preset-yellow",
  "--color-preset-green",
  "--color-preset-teal",
  "--color-preset-blue",
  "--color-preset-purple",
  "--color-preset-pink",
] as const;

/**
 * Resolve a stored color to a concrete CSS value: 'var(--color-preset-red)'
 * becomes the variable's computed hex; plain hex (archived/custom data)
 * passes through unchanged.
 */
export function resolveCssColor(color: string): string {
  if (typeof document === "undefined") return color;
  if (!color.startsWith("var(")) return color;
  const varName = color.slice(4, -1).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return resolved || color;
}
