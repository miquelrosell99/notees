/**
 * Data-level semantic color presets.
 *
 * These are NOT design tokens — they are application data colors for
 * tags, statuses, node colors, property selections, and whiteboard tools.
 * The design-system tokens stay monochrome.
 */

export interface ColorEntry {
  /** Color value emitted when the swatch is selected (hex string). */
  cssVar: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

export const PRESET_COLOR_ENTRIES: ColorEntry[] = [
  { cssVar: '#c55a55', label: 'Red' },
  { cssVar: '#c98557', label: 'Orange' },
  { cssVar: '#b8a23a', label: 'Yellow' },
  { cssVar: '#4f8f6a', label: 'Green' },
  { cssVar: '#4a8a83', label: 'Teal' },
  { cssVar: '#5a79c9', label: 'Blue' },
  { cssVar: '#8a6cc9', label: 'Purple' },
  { cssVar: '#c06a9a', label: 'Pink' },
] as const;
