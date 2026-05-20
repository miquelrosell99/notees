/**
 * Data-level semantic color presets.
 *
 * These are NOT design tokens — they are application data colors for
 * tags, statuses, node colors, property selections, and whiteboard tools.
 *
 * The matching CSS custom properties are defined in
 * ../styles/data-colors.css so that stored references like
 * 'var(--color-preset-red)' continue to resolve at runtime.
 */

export const PRESET_CSS_VARS = {
  red:    'var(--color-preset-red)',
  orange: 'var(--color-preset-orange)',
  yellow: 'var(--color-preset-yellow)',
  green:  'var(--color-preset-green)',
  teal:   'var(--color-preset-teal)',
  blue:   'var(--color-preset-blue)',
  purple: 'var(--color-preset-purple)',
  pink:   'var(--color-preset-pink)',
} as const;

export interface ColorEntry {
  /** CSS variable reference, e.g. 'var(--color-preset-red)' */
  cssVar: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

export const PRESET_COLOR_ENTRIES: ColorEntry[] = [
  { cssVar: PRESET_CSS_VARS.red,    label: 'Red' },
  { cssVar: PRESET_CSS_VARS.orange, label: 'Orange' },
  { cssVar: PRESET_CSS_VARS.yellow, label: 'Yellow' },
  { cssVar: PRESET_CSS_VARS.green,  label: 'Green' },
  { cssVar: PRESET_CSS_VARS.teal,   label: 'Teal' },
  { cssVar: PRESET_CSS_VARS.blue,   label: 'Blue' },
  { cssVar: PRESET_CSS_VARS.purple, label: 'Purple' },
  { cssVar: PRESET_CSS_VARS.pink,   label: 'Pink' },
] as const;

export const PRESET_VAR_NAMES = [
  '--color-preset-red',
  '--color-preset-orange',
  '--color-preset-yellow',
  '--color-preset-green',
  '--color-preset-teal',
  '--color-preset-blue',
  '--color-preset-purple',
  '--color-preset-pink',
] as const;
