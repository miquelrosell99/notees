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
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).icon === 'string'
    ) {
      const obj = parsed as { icon: string; color?: string };
      return { icon: obj.icon, color: obj.color || undefined };
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
  if (!icon) return '';
  if (!color) return icon;
  return JSON.stringify({ icon, color });
}

/**
 * Convert an icon name to its MDI SVG path string.
 * Accepts formats: "mdi-calendar-today", "mdiCalendarToday", "calendar-today".
 * Also accepts JSON-encoded icon fields like `{"icon":"mdi:...","color":"..."}`.
 * Returns null when the name is not a recognised MDI icon (treated as emoji).
 */
export function getMdiPath(iconName: string): string | null {
  // Handle JSON-encoded icon field
  const { icon } = parseIconField(iconName);
  if (icon !== iconName) {
    // Was JSON — recurse with the plain icon name
    return getMdiPath(icon);
  }
  let normalized = iconName
    .replace(/^mdi[:_-]/i, '')                         // strip "mdi-", "mdi:", "mdi_" prefix
    .replace(/^mdi(?=[A-Z])/i, '')                     // strip bare mdi before CamelCase
    .replace(/^mdi$/i, '')                             // strip bare mdi
    .replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()); // kebab → camelCase (including digits)

  if (!normalized) return null;
  normalized = 'mdi' + normalized.charAt(0).toUpperCase() + normalized.slice(1);

  const path = (mdiIcons as Record<string, string>)[normalized];
  return path || null;
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
