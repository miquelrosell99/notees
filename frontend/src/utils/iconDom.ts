/**
 * iconDom.ts
 *
 * Vanilla-DOM utilities for rendering node icons.
 * Used by BlockNode (Lexical custom node) which cannot use React components.
 */
import * as mdiIcons from '@mdi/js';

/**
 * Parse a raw icon field that may be a JSON-encoded object `{"icon":"...","color":"..."}`
 * or a plain icon name string.
 *
 * @returns `{ icon, color? }` - always has `icon`, optionally has `color`.
 */
export function parseIconField(raw: string | null | undefined): { icon: string; color?: string } {
  if (!raw) return { icon: '' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      // Full object: {icon, color?}
      if (typeof obj.icon === 'string') {
        return { icon: obj.icon, color: (obj.color as string) || undefined };
      }
      // Color-only: {color}
      if (typeof obj.color === 'string') {
        return { icon: '', color: obj.color || undefined };
      }
    }
  } catch {
    // Not JSON — treat as plain icon string
  }
  return { icon: raw };
}

/**
 * Encode an icon name and optional color into the stored field format.
 * If color is provided, returns `JSON.stringify({icon, color})`.
 * Otherwise returns the plain icon string.
 */
export function formatIconField(icon: string, color?: string | null): string {
  if (!color) return icon || '';
  if (!icon) return JSON.stringify({ color });
  return JSON.stringify({ icon, color });
}

/**
 * Convert an icon name to its MDI SVG path string.
 * Accepts:
 * - camelCase format as exported by `@mdi/js` (e.g. "mdiHeartOutline")
 * - Logseq/Python kebab format with prefix (e.g. "mdi:heart-outline")
 * - JSON-encoded icon fields like `{"icon":"mdiHeartOutline","color":"..."}`
 * Returns null for anything that is not a recognised MDI key (treated as emoji).
 */
export function getMdiPath(iconName: string): string | null {
  // Handle JSON-encoded icon field
  const { icon } = parseIconField(iconName);
  if (icon !== iconName) return getMdiPath(icon);
  if (!iconName) return null;
  // Handle Logseq/Python mdi:kebab-name format → @mdi/js mdiCamelName
  if (iconName.startsWith('mdi:')) {
    const name = iconName.slice(4);
    const camelName = 'mdi' + name.charAt(0).toUpperCase() + name.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const path = (mdiIcons as Record<string, string>)[camelName];
    return path || null;
  }
  const path = (mdiIcons as Record<string, string>)[iconName];
  return path || null;
}

/**
 * Convert a Logseq/Python mdi:kebab-name icon to the @mdi/js camelCase key.
 * e.g. "mdi:heart-outline" → "mdiHeartOutline"
 * Returns the input unchanged if it doesn't start with "mdi:".
 */
export function normalizeMdiIcon(icon: string): string {
  if (!icon.startsWith('mdi:')) return icon;
  const name = icon.slice(4);
  return 'mdi' + name.charAt(0).toUpperCase() + name.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Create a DOM element that renders `icon` correctly:
 * - If `icon` is an MDI name  → returns an <svg> element
 * - Otherwise (emoji / text)  → returns a <span> with the icon as textContent
 *
 * The returned element already has `bullet-icon` as its CSS class.
 */
export function createIconElement(icon: string): HTMLElement | SVGSVGElement {
  const { icon: parsedIcon } = parseIconField(icon);
  const mdiPath = getMdiPath(parsedIcon);

  if (mdiPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.classList.add('bullet-icon');

    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('fill', 'currentColor');
    pathEl.setAttribute('d', mdiPath);
    svg.appendChild(pathEl);

    return svg;
  }

  // Emoji / arbitrary text fallback
  const span = document.createElement('span');
  span.className = 'bullet-icon';
  span.textContent = parsedIcon;
  return span;
}
