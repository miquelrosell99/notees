/**
 * iconDom.ts
 *
 * Vanilla-DOM utilities for rendering node icons.
 * Used by BlockNode (Lexical custom node) which cannot use React components.
 */
import * as mdiIcons from '@mdi/js';

/**
 * Convert an icon name to its MDI SVG path string.
 * Accepts formats: "mdi-calendar-today", "mdiCalendarToday", "calendar-today".
 * Returns null when the name is not a recognised MDI icon (treated as emoji).
 */
export function getMdiPath(iconName: string): string | null {
  let normalized = iconName
    .replace(/^mdi[:_-]/i, '')                         // strip "mdi-", "mdi:", "mdi_" prefix
    .replace(/^mdi(?=[A-Z])/i, '')                     // strip bare mdi before CamelCase
    .replace(/^mdi$/i, '')                             // strip bare mdi
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()); // kebab → camelCase

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
  const mdiPath = getMdiPath(icon);

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
  span.textContent = icon;
  return span;
}
