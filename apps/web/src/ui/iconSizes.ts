/**
 * Shared icon size tokens.
 *
 * Both the low-level `<Icon>` component and the named icon wrappers in
 * `icons.tsx` use these presets so size strings like `"sm"` resolve to the
 * same multiplier everywhere.
 */
export const ICON_SIZE = {
  xs: 0.6,  // 14.4px at 24px base
  sm: 0.75, // 18px
  md: 1,    // 24px (default)
  lg: 1.25, // 30px
  xl: 1.5,  // 36px
} as const;

export type IconSize = keyof typeof ICON_SIZE | number;

/**
 * Resolve a size value to either a numeric multiplier or an explicit CSS
 * length string. Named tokens are mapped to multipliers; any other string
 * (e.g. `"14px"`) is returned as-is so it can be used directly as a CSS size.
 */
export function resolveIconSize(size: IconSize | string): number | string {
  if (typeof size === 'number') {
    return size;
  }
  if (size in ICON_SIZE) {
    return ICON_SIZE[size as keyof typeof ICON_SIZE];
  }
  return size;
}
