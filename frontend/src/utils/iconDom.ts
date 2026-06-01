/**
 * iconDom.ts
 *
 * Vanilla-DOM utilities for rendering node icons via the shared MDI sprite sheet.
 */

function camelToKebab(name: string): string {
  if (!name.startsWith('mdi')) return name;
  const rest = name.slice(3);
  let result = rest[0]?.toLowerCase() ?? '';
  for (const char of rest.slice(1)) {
    result += char === char.toUpperCase() ? '-' + char.toLowerCase() : char;
  }
  return result;
}

function resolveMdiKebabName(iconName: string): string | null {
  if (!iconName) return null;

  // JSON-encoded icon field
  try {
    const parsed = JSON.parse(iconName) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.icon === 'string') {
        return resolveMdiKebabName(obj.icon);
      }
    }
  } catch {
    // not JSON
  }

  if (iconName.startsWith('mdi:')) {
    return iconName.slice(4);
  }

  if (iconName.match(/^mdi[A-Z]/)) {
    return camelToKebab(iconName);
  }

  return null;
}

/**
 * Convert a camelCase or Logseq/Python mdi name to a kebab-case name.
 * e.g. "mdiHeartOutline" → "heart-outline"
 * e.g. "mdi:heart-outline" → "heart-outline"
 *
 * Kept for backward compatibility — returns the kebab name prefixed with "mdi-"
 * so existing React consumers can pass it straight to `<Icon path={...} />`.
 */
export function getMdiClass(iconName: string): string | null {
  const kebab = resolveMdiKebabName(iconName);
  if (!kebab) return null;
  return 'mdi mdi-' + kebab;
}

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
      if (typeof obj.icon === 'string') {
        return { icon: obj.icon, color: (obj.color as string) || undefined };
      }
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
 */
export function formatIconField(icon: string, color?: string | null): string {
  if (!color) return icon || '';
  if (!icon) return JSON.stringify({ color });
  return JSON.stringify({ icon, color });
}

/**
 * Convert a Logseq/Python mdi:kebab-name icon to the kebab name.
 * e.g. "mdi:heart-outline" → "heart-outline"
 */
export function normalizeMdiIcon(icon: string): string {
  if (!icon.startsWith('mdi:')) return icon;
  return icon.slice(4);
}

/**
 * Create a DOM element that renders `icon` correctly:
 * - If `icon` is an MDI name  → returns an <svg> element with a <use> reference
 * - Otherwise (emoji / text)  → returns a <span> with the icon as textContent
 *
 * The returned element already has `bullet-icon` as its CSS class.
 */
export function createIconElement(icon: string): Element {
  const { icon: parsedIcon } = parseIconField(icon);
  const kebabName = resolveMdiKebabName(parsedIcon);

  if (kebabName) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('fill', 'currentColor');
    svg.classList.add('bullet-icon');

    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/mdi-sprite.svg#mdi-' + kebabName);
    svg.appendChild(use);
    return svg;
  }

  // Emoji / arbitrary text fallback
  const span = document.createElement('span');
  span.className = 'bullet-icon';
  span.textContent = parsedIcon;
  return span;
}
