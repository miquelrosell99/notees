/**
 * Color Utility Functions
 * 
 * Utilities for color manipulation, including:
 * - Hex to RGB conversion
 * - Color lightness detection
 * - Gradient border generation
 * - Theme-aware tint calculation
 */

/**
 * Parse a hex color to RGB components
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleanHex = hex.replace('#', '');
  
  if (cleanHex.length === 3) {
    return {
      r: parseInt(cleanHex[0] + cleanHex[0], 16),
      g: parseInt(cleanHex[1] + cleanHex[1], 16),
      b: parseInt(cleanHex[2] + cleanHex[2], 16),
    };
  }
  
  if (cleanHex.length === 6) {
    return {
      r: parseInt(cleanHex.slice(0, 2), 16),
      g: parseInt(cleanHex.slice(2, 4), 16),
      b: parseInt(cleanHex.slice(4, 6), 16),
    };
  }
  
  return null;
}

/**
 * Resolve a CSS variable reference to its computed value.
 * Returns the original color if it is not a var() reference or cannot be resolved.
 */
export function resolveCssColor(color: string): string {
  if (typeof document === 'undefined') return color;
  if (!color.startsWith('var(')) return color;
  
  const varName = color.slice(4, -1).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return resolved || color;
}

/**
 * Convert RGB to hex string
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Parse any CSS color to RGB (supports hex and rgb())
 */
export function parseColorToRgb(color: string): { r: number; g: number; b: number } | null {
  const resolved = resolveCssColor(color);
  
  if (resolved.startsWith('#')) {
    return hexToRgb(resolved);
  }
  
  if (resolved.startsWith('rgb')) {
    const match = resolved.match(/\d+/g);
    if (match && match.length >= 3) {
      return {
        r: parseInt(match[0]),
        g: parseInt(match[1]),
        b: parseInt(match[2]),
      };
    }
  }
  
  return null;
}

/**
 * Determine if a color is light or dark based on perceived brightness
 * Uses the YIQ formula for perceptual brightness
 */
export function isColorLight(color: string): boolean {
  const rgb = parseColorToRgb(color);
  if (!rgb) return true;
  
  // YIQ formula for perceived brightness
  const yiq = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return yiq >= 128;
}

/**
 * Generate CSS custom properties for node color styling
 * Creates a unified look with gradient left border and subtle background tint
 * 
 * @param color - The node's color (hex or rgb)
 * @param isDarkMode - Whether the app is in dark mode
 * @returns CSS properties object to apply to the element
 */
export function getNodeColorStyles(color: string, isDarkMode: boolean = false): React.CSSProperties {
  const rgb = parseColorToRgb(color);
  if (!rgb) return {};
  
  const { r, g, b } = rgb;
  
  // Tint opacity varies by theme - darker in light mode, lighter in dark mode
  // Light mode: 3-5% opacity works well
  // Dark mode: 4-7% opacity needed for visibility on dark backgrounds
  const tintOpacity = isDarkMode ? 0.06 : 0.04;

  return {
    '--node-color': color,
    '--node-color-rgb': `${r}, ${g}, ${b}`,
    '--node-tint': `rgba(${r}, ${g}, ${b}, ${tintOpacity})`,
    '--node-border-solid': color,
  } as React.CSSProperties;
}

/**
 * Check if the document is in dark mode
 */
export function isDarkModeActive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/**
 * Get node color styles with automatic theme detection
 */
export function getNodeColorStylesAuto(color: string): React.CSSProperties {
  return getNodeColorStyles(color, isDarkModeActive());
}

/**
 * Generate CSS custom properties for thick colored border only (no background)
 * Used for NodeView with colored border
 * 
 * @param color - The node's color (hex or rgb)
 * @returns CSS properties object to apply to the element
 */
export function getNodeBorderStyles(color: string): React.CSSProperties {
  const rgb = parseColorToRgb(color);
  if (!rgb) return {};
  
  const { r, g, b } = rgb;
  
  return {
    '--node-color': color,
    '--node-color-rgb': `${r}, ${g}, ${b}`,
    '--node-border-color': color,
  } as React.CSSProperties;
}
