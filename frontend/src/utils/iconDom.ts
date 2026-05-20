/**
 * iconDom.ts
 *
 * Vanilla-DOM utilities for rendering node icons.
 * Uses @mdi/font CSS classes instead of inline SVG.
 */

function camelToKebab(name: string): string {
  if (!name.startsWith('mdi')) return name;
  const rest = name.slice(3);
  let result = rest[0]?.toLowerCase() ?? '';
  for (const char of rest.slice(1)) {
    result += char === char.toUpperCase() ? '-' + char.toLowerCase() : char;
  }
  return 'mdi-' + result;
}

/**
 * Convert a camelCase or Logseq/Python mdi name to a CSS class string.
 * e.g. "mdiHeartOutline" → "mdi mdi-heart-outline"
 * e.g. "mdi:heart-outline" → "mdi mdi-heart-outline"
 */
export function getMdiClass(iconName: string): string | null {
  if (!iconName) return null;

  // JSON-encoded icon field
  try {
    const parsed = JSON.parse(iconName) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.icon === 'string') {
        return getMdiClass(obj.icon);
      }
    }
  } catch {
    // not JSON
  }

  if (iconName.startsWith('mdi:')) {
    const name = iconName.slice(4);
    return 'mdi mdi-' + name;
  }

  if (iconName.match(/^mdi[A-Z]/)) {
    return 'mdi ' + camelToKebab(iconName);
  }

  return null;
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
 * Convert a Logseq/Python mdi:kebab-name icon to the CSS class string.
 * e.g. "mdi:heart-outline" → "mdi mdi-heart-outline"
 */
export function normalizeMdiIcon(icon: string): string {
  if (!icon.startsWith('mdi:')) return icon;
  return 'mdi mdi-' + icon.slice(4);
}

/**
 * Create a DOM element that renders `icon` correctly:
 * - If `icon` is an MDI name  → returns an <i> element with MDI font classes
 * - Otherwise (emoji / text)  → returns a <span> with the icon as textContent
 *
 * The returned element already has `bullet-icon` as its CSS class.
 */
export function createIconElement(icon: string): HTMLElement {
  const { icon: parsedIcon } = parseIconField(icon);
  const mdiClass = getMdiClass(parsedIcon);

  if (mdiClass) {
    const i = document.createElement('i');
    i.className = 'bullet-icon ' + mdiClass;
    return i;
  }

  // Emoji / arbitrary text fallback
  const span = document.createElement('span');
  span.className = 'bullet-icon';
  span.textContent = parsedIcon;
  return span;
}
